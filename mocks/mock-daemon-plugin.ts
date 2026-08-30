/**
 * 内置 mock daemon（仅 dev）：按真实后端 wire 格式实现 qaqh.Ringing 全端点，
 * 供无后端开发与冒烟测试。所有形状对照 F:\QAQ-Harness 实测取证（2026-08-30）：
 *  - open（426 = rejected ack；epoch 为 hex 字符串）
 *  - /leases/renew 续租；lease 表 + owns_seed 归属校验（bootstrap/timeline 前置）
 *  - 命令信封双层 tag；除 session_create 外信封级必须带 seed；ack {command_id,status}
 *  - conversation_load_more → 422 unsupported_command（N6 设计性拒绝）
 *  - 三频道 SSE 逐信封发射：event=内层 type、id=<epoch>:<channel>:<stream_seq>、
 *    data=完整 EventEnvelope；15s keepalive 注释行
 *  - timeline 快照分页（before_turn 尾窗语义）+ timeline.entry SSE
 *  - bootstrap 三频道快照（transcript 以 /timeline 为准，conversation.state 只给 aux）
 *  - service 面：session.list / session.meta / config.load / config.save /
 *    daemon.version / debug.reset_epoch（mock 专属）
 *  - content 附件上传 → {content_id(=sha256), media_type, sha256, truncated}
 * 状态持久化到 .mock-state.json（v2 格式，gitignored），重启 vite 不丢会话。
 */
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RINGING_SCHEMA,
  RINGING_VERSION,
  type CommandAck,
  type EventEnvelope,
  type SessionSummary,
  type TimelineBlock,
  type TimelineEntry,
  type TimelineEventFrame,
  type TimelineSnapshotResponse,
  type TimelineTool,
  type TimelineTurn,
} from '../src/protocol/types.ts';

const TOKEN = 'qaqh-dev-mock-token';
const KEEPALIVE_MS = 15_000;
const LEASE_TTL_MS = 30_000;
const RENEW_INTERVAL_MS = 10_000;
const STATE_FILE = resolve(process.cwd(), '.mock-state.json');
const MODEL = 'mock-glm';
const CONTEXT_LIMIT = 128_000;

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

interface MockSession {
  seed: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  archived: boolean;
  /** 流式终止 flag（conversation_cancel 命令置位） */
  abortFlag: boolean;
  /** 权威 transcript（旧 → 新） */
  turns: TimelineTurn[];
  /** timeline 权威变更日志（timeline SSE 重放源） */
  entries: TimelineEntry[];
  timelineSeq: number;
  turnCount: number;
  messageCount: number;
  lastSummary: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface PersistShape {
  v: 2;
  epoch: string;
  sessions: MockSession[];
  config: Record<string, unknown>;
}

function defaultConfig(): Record<string, unknown> {
  return { theme: null, lang: null, fontFamily: '', notificationsEnabled: true };
}

const state: PersistShape = loadState();

function loadState(): PersistShape {
  try {
    if (existsSync(STATE_FILE)) {
      const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as PersistShape;
      if (parsed && parsed.v === 2 && Array.isArray(parsed.sessions)) return parsed;
    }
  } catch {
    // 损坏的 state 文件：重新开始
  }
  return { v: 2, epoch: randomBytes(16).toString('hex'), sessions: [], config: defaultConfig() };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persist(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch {
      // 忽略磁盘写入失败（只影响 dev 持久化）
    }
  }, 300);
}

// lease 表：client_session_id → 实例与归属 seeds
const leases = new Map<string, { instanceId: string; seeds: Set<string>; renewedAt: number }>();

// ---------------------------------------------------------------------------
// 频道 SSE 基础设施（逐信封发射，与 axum_server envelope_to_event 对齐）
// ---------------------------------------------------------------------------

interface Subscriber {
  res: ServerResponse;
  keepalive: ReturnType<typeof setInterval>;
}

const channels: Record<string, { seq: number; subs: Set<Subscriber> }> = {
  control: { seq: 0, subs: new Set() },
  conversation: { seq: 0, subs: new Set() },
  tool: { seq: 0, subs: new Set() },
};
const timelineSubs = new Map<string, Set<Subscriber>>();

function writeSseHead(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function sseWrite(res: ServerResponse, chunk: string): boolean {
  try {
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function addSubscriber(subs: Set<Subscriber>, res: ServerResponse): void {
  const sub: Subscriber = {
    res,
    keepalive: setInterval(() => {
      // 注释行 keepalive（axum KeepAlive.text）
      if (!sseWrite(res, ': keep-alive\n\n')) removeSubscriber(subs, sub);
    }, KEEPALIVE_MS),
  };
  subs.add(sub);
  res.on('close', () => removeSubscriber(subs, sub));
}

function removeSubscriber(subs: Set<Subscriber>, sub: Subscriber): void {
  if (!subs.has(sub)) return;
  clearInterval(sub.keepalive);
  subs.delete(sub);
}

function eventEnvelope(
  channel: string,
  seed: string,
  eventName: string,
  event: Record<string, unknown>,
  causationId?: string,
): { id: string; event: string; data: string } {
  const ch = channels[channel];
  ch.seq += 1;
  const envelope: EventEnvelope = {
    delivery: 'reliable',
    seed,
    stream_seq: ch.seq,
    channel_seq: ch.seq,
    session_seq: ch.seq,
    event_id: `${state.epoch}-${channel}-${seed}-${ch.seq}`,
    ...(causationId ? { causation_id: causationId } : {}),
    state_revision: ch.seq,
    server_ts: Date.now(),
    event: { channel, type: eventName, ...event } as EventEnvelope['event'],
  };
  return {
    id: `${state.epoch}:${channel}:${ch.seq}`,
    event: eventName,
    data: JSON.stringify(envelope),
  };
}

/** 发布到频道并投递给所有订阅者 */
function publish(
  channel: string,
  seed: string,
  eventName: string,
  event: Record<string, unknown>,
  causationId?: string,
): void {
  const frame = eventEnvelope(channel, seed, eventName, event, causationId);
  const ch = channels[channel];
  const text = `event: ${frame.event}\nid: ${frame.id}\ndata: ${frame.data}\n\n`;
  for (const sub of [...ch.subs]) if (!sseWrite(sub.res, text)) removeSubscriber(ch.subs, sub);
}

/** timeline 权威变更：落日志 + 应用到 turns + 推 timeline.entry 帧 */
function commitEntry(session: MockSession, entry: Omit<TimelineEntry, 'timeline_seq'>): TimelineEntry {
  session.timelineSeq += 1;
  const full: TimelineEntry = { ...entry, timeline_seq: session.timelineSeq };
  session.entries.push(full);
  applyEntryToTurns(session, full);
  const frame: TimelineEventFrame = {
    schema: RINGING_SCHEMA,
    version: RINGING_VERSION,
    server_epoch: state.epoch,
    seed: session.seed,
    entry: full,
  };
  const text = `event: timeline.entry\nid: ${state.epoch}:timeline:${full.timeline_seq}\ndata: ${JSON.stringify(frame)}\n\n`;
  const subs = timelineSubs.get(session.seed);
  for (const sub of [...(subs ?? [])]) if (!sseWrite(sub.res, text)) removeSubscriber(subs!, sub);
  return full;
}

// ---------------------------------------------------------------------------
// timeline 树操作（mock 侧 writer）
// ---------------------------------------------------------------------------

function findTurn(session: MockSession, turnId: string): TimelineTurn | undefined {
  return session.turns.find((t) => t.turn_id === turnId);
}

function pushTimelineTurn(
  session: MockSession,
  turnId: string,
  userText: string,
  causationId?: string,
): void {
  session.turnCount += 1;
  commitEntry(session, {
    turn_id: turnId,
    event: { type: 'turn_opened', user_text: userText },
  });
  publish('conversation', session.seed, 'turn_started', { turn_id: turnId, user_text: userText }, causationId);
}

function pushBlock(session: MockSession, turnId: string, roundNum: number, block: TimelineBlock): void {
  commitEntry(session, { turn_id: turnId, round_num: roundNum, event: { type: 'block_opened', block } });
}

function pushTextDelta(session: MockSession, turnId: string, roundNum: number, blockId: string, delta: string): void {
  commitEntry(session, {
    turn_id: turnId,
    round_num: roundNum,
    event: { type: 'text_delta', block_id: blockId, fragment_seq: 0, delta },
  });
}

function pushToolUpdate(
  session: MockSession,
  turnId: string,
  roundNum: number,
  blockId: string,
  tool: TimelineTool,
): void {
  commitEntry(session, {
    turn_id: turnId,
    round_num: roundNum,
    event: { type: 'tool_updated', block_id: blockId, tool },
  });
}

function pushToolProgress(session: MockSession, turnId: string, roundNum: number, blockId: string, chunk: string): void {
  commitEntry(session, {
    turn_id: turnId,
    round_num: roundNum,
    event: { type: 'tool_progress', block_id: blockId, chunk },
  });
}

function pushBlockSealed(session: MockSession, turnId: string, roundNum: number, blockId: string): void {
  commitEntry(session, { turn_id: turnId, round_num: roundNum, event: { type: 'block_sealed', block_id: blockId } });
}

function pushTurnSealed(
  session: MockSession,
  turnId: string,
  roundNum: number,
  sealedState: 'completed' | 'failed' | 'cancelled',
): void {
  commitEntry(session, {
    turn_id: turnId,
    round_num: roundNum,
    event: { type: 'round_sealed', is_final: true },
  });
  commitEntry(session, {
    turn_id: turnId,
    round_num: roundNum,
    event: { type: 'turn_sealed', state: sealedState },
  });
  publish(
    'conversation',
    session.seed,
    sealedState === 'completed' ? 'turn_completed' : 'turn_failed',
    { turn_id: turnId },
  );
  session.updated_at = Date.now() / 1000;
  publish('control', session.seed, 'session_state_changed', { seed: session.seed, state: 'idle' });
}

// ---------------------------------------------------------------------------
// 模拟回合
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PlannedTool {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  output: string;
  fail: boolean;
}

function planTool(text: string): PlannedTool | null {
  const lower = text.toLowerCase();
  if (/搜索|search/.test(text + lower)) {
    return {
      callId: `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      name: 'web_search',
      args: { query: text.slice(0, 40) },
      output: '[1] Fluent UI React v9 官方文档 — react.fluent2.microsoft.design\n[2] 迁移指南 v8→v9：组件更名与 Griffel 样式要点\n[3] Fluent 2 设计令牌一览（颜色/圆角/阴影）',
      fail: false,
    };
  }
  if (/文件|file|代码|code/.test(text + lower)) {
    return {
      callId: `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      name: 'read_file',
      args: { path: 'src/main.tsx' },
      output:
        "import { FluentProvider, webLightTheme } from '@fluentui/react-components';\nimport { createRoot } from 'react-dom/client';\n\ncreateRoot(document.getElementById('root')!).render(\n  <FluentProvider theme={webLightTheme}><App /></FluentProvider>,\n);",
      fail: false,
    };
  }
  if (/失败|fail|错误/.test(text + lower)) {
    return {
      callId: `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      name: 'run_command',
      args: { command: 'bun test --failing' },
      output: '',
      fail: true,
    };
  }
  return null;
}

function assistantReply(text: string, tool: PlannedTool | null): string {
  const lower = text.toLowerCase();
  if (tool?.fail) {
    return '工具执行失败了：run_command 返回非零退出码（详情见上方工具卡片）。常见的排查路径是先看 stderr 输出，再核对工作目录与依赖版本。要我重试一次吗？';
  }
  if (tool?.name === 'web_search') {
    return `已检索到 3 条与「${text.slice(0, 24)}」相关的结果（见工具卡片）：\n\n1. 官方文档是唯一权威来源；\n2. v9 的样式体系与 v8 完全不同，建议先读迁移指南；\n3. 设计令牌可以直接在 CSS 变量里消费。\n\n需要我把要点整理成清单吗？`;
  }
  if (tool?.name === 'read_file') {
    return '已读取目标文件（内容见工具卡片）。这个入口文件做三件事：挂载 FluentProvider、注入主题、渲染根组件。要我继续分析某个具体部分吗？';
  }
  if (/长|long/.test(text + lower)) {
    return Array.from(
      { length: 10 },
      (_, i) =>
        `第 ${i + 1} 段：这是用于验证流式渲染与自动滚动的一段较长的模拟回复内容，包含了中文、English 与数字 12345 的混合文本。`,
    ).join('\n\n');
  }
  return `收到：「${text.slice(0, 40)}」。\n\n这是 mock daemon 的流式回复：timeline 面以 block_opened / text_delta / block_sealed 逐块推进，conversation 频道同步 turn_started / turn_completed 信号。试试包含「搜索」「文件」「失败」「长」的消息体验不同的工具卡片与长文本渲染。`;
}

function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function runTurn(session: MockSession, commandId: string, text: string): Promise<void> {
  const turnId = `t${session.turnCount + 1}`;
  const roundNum = 0;
  session.abortFlag = false;
  if (!session.title && text.trim()) {
    session.title = text.trim().slice(0, 24);
    publish('control', session.seed, 'session_meta_changed', { seed: session.seed, title: session.title });
  }
  session.messageCount += 1;

  // 1) turn_opened + turn_started
  pushTimelineTurn(session, turnId, text, commandId);
  persist();

  const tool = planTool(text);

  // 2) 工具块演示
  if (tool) {
    const blockId = `tool:${tool.callId}`;
    const baseTool: TimelineTool = {
      tool_call_id: tool.callId,
      name: tool.name,
      state: 'running',
      args_json: JSON.stringify(tool.args),
      progress: '',
    };
    publish('tool', session.seed, 'tool_started', {
      tool_call_id: tool.callId,
      turn_id: turnId,
      round_num: roundNum,
      name: tool.name,
    }, commandId);
    pushBlock(session, turnId, roundNum, {
      block_id: blockId,
      block_order: 0,
      kind: 'tool',
      state: 'open',
      text: '',
      tool: baseTool,
    });

    const chunks = tool.fail ? [] : chunkText(tool.output, 24);
    let acc = '';
    for (const c of chunks) {
      if (session.abortFlag) break;
      await sleep(90);
      acc += c;
      pushToolProgress(session, turnId, roundNum, blockId, c);
      pushToolUpdate(session, turnId, roundNum, blockId, {
        ...baseTool,
        summary: acc.split('\n')[0],
        output: acc,
      });
    }

    const finished: TimelineTool = {
      ...baseTool,
      state: session.abortFlag ? 'failed' : tool.fail ? 'failed' : 'succeeded',
      output: tool.fail ? undefined : acc || undefined,
      summary: tool.fail ? 'exit code 1' : acc.split('\n')[0],
      progress: acc,
      failure: tool.fail && !session.abortFlag ? { code: 'exit_code', message: 'exit code 1: bun: no tests matching --failing filter' } : undefined,
    };
    pushToolUpdate(session, turnId, roundNum, blockId, finished);
    pushBlockSealed(session, turnId, roundNum, blockId);
    publish('tool', session.seed, 'tool_finished', {
      tool_call_id: tool.callId,
      turn_id: turnId,
      round_num: roundNum,
      result: { output: finished.output ?? '', success: finished.state === 'succeeded' },
    }, commandId);
    persist();
    if (session.abortFlag) {
      session.abortFlag = false;
      pushTurnSealed(session, turnId, roundNum, 'cancelled');
      publish('conversation', session.seed, 'conversation_cancelled', { turn_id: turnId });
      persist();
      return;
    }
  }

  // 3) 正文块流式
  const reply = assistantReply(text, tool);
  const textBlockId = `round-${roundNum}:text:${tool ? 1 : 0}`;
  pushBlock(session, turnId, roundNum, {
    block_id: textBlockId,
    block_order: tool ? 1 : 0,
    kind: 'text',
    state: 'open',
    text: '',
  });
  for (const c of chunkText(reply, 18)) {
    if (session.abortFlag) break;
    await sleep(70);
    pushTextDelta(session, turnId, roundNum, textBlockId, c);
  }
  pushBlockSealed(session, turnId, roundNum, textBlockId);

  // 4) 收束
  const aborted = session.abortFlag;
  session.abortFlag = false;
  if (aborted) {
    pushTurnSealed(session, turnId, roundNum, 'cancelled');
    publish('conversation', session.seed, 'conversation_cancelled', { turn_id: turnId });
  } else {
    session.lastSummary = reply.split('\n')[0].slice(0, 80);
    session.usage = {
      prompt_tokens: session.usage.prompt_tokens + 12,
      completion_tokens: session.usage.completion_tokens + reply.length,
      total_tokens: session.usage.total_tokens + reply.length + 12,
    };
    pushTurnSealed(session, turnId, roundNum, 'completed');
  }
  persist();
}

// ---------------------------------------------------------------------------
// 会话摘要 / 快照投影
// ---------------------------------------------------------------------------

function sessionSummary(s: MockSession): SessionSummary {
  return {
    seed: s.seed,
    created_at: Math.round(s.created_at),
    updated_at: Math.round(s.updated_at),
    model: MODEL,
    effort: 'standard',
    message_count: s.messageCount,
    turn_count: s.turnCount,
    last_summary: s.lastSummary,
    compact_skip: 0,
    mode: 0,
    archived: s.archived,
    ephemeral: false,
    usage_totals: { ...s.usage, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0, reasoning_tokens: 0 },
    usage_requests: s.turnCount,
    title: s.title,
    context_stats: {
      chat_text: 0, thinking: 0, tool_calls: 0, tool_results: 0,
      tools_schema: 0, system_prompt: 0, thinking_blocks: 0, tool_call_blocks: 0, messages: 0,
    },
    running: false,
    workspace_id: null,
  };
}

/** /timeline 快照分页（对照 axum_server paginate_turns：默认尾窗，before_turn 取更早一页） */
function paginateTurns(
  turns: TimelineTurn[],
  beforeTurn: string | null,
  limit: number,
): { page: TimelineTurn[]; hasMore: boolean } {
  if (turns.length === 0) return { page: [], hasMore: false };
  let start: number;
  let end: number;
  if (beforeTurn) {
    const idx = turns.findIndex((t) => t.turn_id === beforeTurn);
    const i = idx === -1 ? turns.length : idx;
    start = Math.max(0, i - limit);
    end = i;
  } else {
    start = Math.max(0, turns.length - limit);
    end = turns.length;
  }
  return { page: turns.slice(start, end), hasMore: start > 0 };
}

function timelineSnapshotResponse(session: MockSession, beforeTurn: string | null, limit: number): TimelineSnapshotResponse {
  const { page, hasMore } = paginateTurns(session.turns, beforeTurn, limit);
  const watermark = page.length > 0 ? session.timelineSeq : 0;
  return {
    schema: RINGING_SCHEMA,
    version: RINGING_VERSION,
    server_epoch: state.epoch,
    seed: session.seed,
    snapshot: { watermark, turns: page },
    has_more: hasMore,
    total_turns: session.turns.length,
  };
}

// ---------------------------------------------------------------------------
// HTTP 帮助函数
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function unauthorized(res: ServerResponse): void {
  json(res, 401, { code: 'unauthorized', message: 'bridge token 校验失败' });
}

function leaseRequired(res: ServerResponse, message = 'client session header required'): void {
  json(res, 401, { code: 'lease_required', message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authed(req: IncomingMessage): boolean {
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function sessionHeader(req: IncomingMessage): string | null {
  const v = req.headers['x-qaqh-client-session-id'];
  const s = Array.isArray(v) ? v[0] : v;
  return s ?? null;
}

function ownsSeed(csid: string | null, seed: string): boolean {
  return csid != null && leases.get(csid)?.seeds.has(seed) === true;
}

function ackRejected(commandId: string, code: string, message: string): CommandAck {
  return { command_id: commandId, status: 'rejected', code, message };
}

// ---------------------------------------------------------------------------
// 种子数据：首次启动预置会话（原生 TimelineTurn 结构）
// ---------------------------------------------------------------------------

function seedIfEmpty(): void {
  if (state.sessions.length > 0) return;
  const now = Date.now() / 1000;
  const s1: MockSession = {
    seed: randomBytes(4).toString('hex'),
    title: '搜索 Fluent v9 迁移要点',
    created_at: now - 3600,
    updated_at: now - 600,
    archived: false,
    abortFlag: false,
    turns: [],
    entries: [],
    timelineSeq: 0,
    turnCount: 0,
    messageCount: 0,
    lastSummary: '已完成检索。Fluent v9 的关键迁移要点如下。',
    usage: { prompt_tokens: 48, completion_tokens: 1024, total_tokens: 1072 },
  };
  const callId = `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const toolId = `tool:${callId}`;
  const textId = 'round-0:text:1';
  const entries: TimelineEntry[] = [
    { timeline_seq: 1, turn_id: 't1', event: { type: 'turn_opened', user_text: '帮我搜索 Fluent UI React v9 的迁移要点' } },
    { timeline_seq: 2, turn_id: 't1', round_num: 0, event: { type: 'block_opened', block: { block_id: toolId, block_order: 0, kind: 'tool', state: 'open', text: '', tool: { tool_call_id: callId, name: 'web_search', state: 'running', args_json: '{"query":"Fluent UI React v9 migration guide"}', progress: '' } } } },
    { timeline_seq: 3, turn_id: 't1', round_num: 0, event: { type: 'tool_updated', block_id: toolId, tool: { tool_call_id: callId, name: 'web_search', state: 'succeeded', summary: '[1] Fluent UI React v9 官方文档', args_json: '{"query":"Fluent UI React v9 migration guide"}', output: '1. v9 以 @fluentui/react-components 为统一入口\n2. 样式方案为 Griffel（CSS-in-TS）\n3. 主题通过 FluentProvider 注入\n4. 图标独立包 @fluentui/react-icons', progress: '' } } },
    { timeline_seq: 4, turn_id: 't1', round_num: 0, event: { type: 'block_sealed', block_id: toolId } },
    { timeline_seq: 5, turn_id: 't1', round_num: 0, event: { type: 'block_opened', block: { block_id: textId, block_order: 1, kind: 'text', state: 'open', text: '' } } },
    { timeline_seq: 6, turn_id: 't1', round_num: 0, event: { type: 'text_delta', block_id: textId, fragment_seq: 0, delta: '已完成检索。Fluent v9 的关键迁移要点如下：\n\n1. 统一从 @fluentui/react-components 导入组件；\n2. 样式使用 Griffel，运行时零依赖注入；\n3. 在应用根部用 FluentProvider 提供主题；\n4. 图标改用 @fluentui/react-icons 独立包。\n\n需要我继续整理组件对照表吗？' } },
    { timeline_seq: 7, turn_id: 't1', round_num: 0, event: { type: 'block_sealed', block_id: textId } },
    { timeline_seq: 8, turn_id: 't1', round_num: 0, event: { type: 'round_sealed', is_final: true } },
    { timeline_seq: 9, turn_id: 't1', event: { type: 'turn_sealed', state: 'completed' } },
  ];
  s1.entries = entries;
  s1.timelineSeq = 9;
  s1.turnCount = 1;
  s1.messageCount = 2;
  // 由 entries 重放出 turns（走与 reducer 相同的语义）
  for (const e of entries) applyEntryToTurns(s1, e);

  state.sessions.push(s1, {
    seed: randomBytes(4).toString('hex'),
    title: null,
    created_at: now - 60,
    updated_at: now - 60,
    archived: false,
    abortFlag: false,
    turns: [],
    entries: [],
    timelineSeq: 0,
    turnCount: 0,
    messageCount: 0,
    lastSummary: '',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
  persist();
}

/** 极简 entry → turns 重建（mock 内部使用；与前端 reducer 语义一致） */
function applyEntryToTurns(session: MockSession, entry: TimelineEntry): void {
  const roundNum = entry.round_num ?? 0;
  let turn = findTurn(session, entry.turn_id);
  if (entry.event.type === 'turn_opened') {
    if (!turn) {
      turn = {
        turn_id: entry.turn_id,
        created_seq: entry.timeline_seq,
        user_text: entry.event.user_text,
        sealed: false,
        state: 'running',
        rounds: [],
      };
      session.turns.push(turn);
      return;
    }
    turn.user_text = entry.event.user_text;
    return;
  }
  if (!turn) return;
  let round = turn.rounds.find((r) => r.round_num === roundNum);
  if (!round) {
    round = { round_num: roundNum, sealed: false, is_final: false, blocks: [] };
    turn.rounds.push(round);
  }
  const ev = entry.event as TimelineEntry['event'] & { type: string; block_id?: string; block?: TimelineBlock; text?: string; delta?: string; tool?: TimelineTool; state?: string };
  switch (ev.type) {
    case 'block_opened':
      round.blocks.push(ev.block!);
      break;
    case 'text_delta': {
      const b = round.blocks.find((x) => x.block_id === ev.block_id);
      if (b) b.text += ev.delta ?? '';
      break;
    }
    case 'tool_updated': {
      const b = round.blocks.find((x) => x.block_id === ev.block_id);
      if (b) b.tool = ev.tool!;
      break;
    }
    case 'tool_progress': {
      const b = round.blocks.find((x) => x.block_id === ev.block_id);
      if (b?.tool) b.tool.progress = (b.tool.progress ?? '') + String(ev.chunk ?? '');
      break;
    }
    case 'block_sealed': {
      const b = round.blocks.find((x) => x.block_id === ev.block_id);
      if (b) b.state = 'sealed';
      break;
    }
    case 'round_sealed':
      round.sealed = true;
      round.is_final = Boolean(ev.is_final ?? true);
      break;
    case 'turn_sealed':
      turn.sealed = true;
      turn.state = (ev.state as TimelineTurn['state']) ?? 'completed';
      break;
    default:
      break;
  }
}

seedIfEmpty();

// ---------------------------------------------------------------------------
// 命令处理（信封校验 + 双层 tag 分发）
// ---------------------------------------------------------------------------

async function handleCommand(
  channel: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: CommandAck }> {
  const commandId = String(body.command_id ?? '');
  const clientSessionId = String(body.client_session_id ?? '');
  const cmd = body.command as { channel?: string; type?: string } | undefined;
  if (!commandId || !clientSessionId || !cmd?.type) {
    return {
      status: 400,
      body: ackRejected(commandId, 'invalid_envelope', '命令信封缺少必需字段'),
    };
  }
  if (cmd.channel !== channel || body.channel !== channel) {
    return { status: 400, body: ackRejected(commandId, 'channel_mismatch', 'channel 与 path 不一致') };
  }
  const seed = typeof body.seed === 'string' ? body.seed : undefined;
  if (!seed && cmd.type !== 'session_create') {
    return { status: 400, body: ackRejected(commandId, 'missing_seed', '信封级 seed 必带') };
  }
  const lease = leases.get(clientSessionId);
  if (!lease) {
    return { status: 401, body: ackRejected(commandId, 'lease_required', 'lease 已失效') };
  }
  const type = cmd.type;
  const params = cmd as Record<string, unknown>;

  if (channel === 'control') {
    if (type === 'session_create') {
      const now = Date.now() / 1000;
      const session: MockSession = {
        seed: randomBytes(4).toString('hex'),
        title: null,
        created_at: now,
        updated_at: now,
        archived: false,
        abortFlag: false,
        turns: [],
        entries: [],
        timelineSeq: 0,
        turnCount: 0,
        messageCount: 0,
        lastSummary: '',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      state.sessions.push(session);
      lease.seeds.add(session.seed);
      persist();
      // 对照 axum_server publish_session_created：state=created，causation=command_id
      publish('control', session.seed, 'session_state_changed', { seed: session.seed, state: 'created' }, commandId);
      return { status: 200, body: { command_id: commandId, status: 'accepted' } };
    }
    const session = state.sessions.find((s) => s.seed === seed);
    if (!session) {
      return { status: 400, body: ackRejected(commandId, 'dispatch_failed', `会话不存在: ${seed}`) };
    }
    if (type === 'session_resume') {
      lease.seeds.add(session.seed);
      publish('control', session.seed, 'session_state_changed', { seed: session.seed, state: 'resumed' }, commandId);
      return { status: 200, body: { command_id: commandId, status: 'accepted' } };
    }
    if (type === 'session_close') {
      publish('control', session.seed, 'session_state_changed', { seed: session.seed, state: 'closed' }, commandId);
      return { status: 200, body: { command_id: commandId, status: 'accepted' } };
    }
    if (type === 'session_archive') {
      session.archived = true;
      persist();
      publish('control', session.seed, 'session_state_changed', { seed: session.seed, state: 'archived' }, commandId);
      return { status: 200, body: { command_id: commandId, status: 'accepted' } };
    }
    if (type === 'session_unarchive') {
      session.archived = false;
      persist();
      publish('control', session.seed, 'session_state_changed', { seed: session.seed, state: 'resumed' }, commandId);
      return { status: 200, body: { command_id: commandId, status: 'accepted' } };
    }
    if (type === 'session_delete') {
      const idx = state.sessions.findIndex((s) => s.seed === seed);
      if (idx >= 0) state.sessions.splice(idx, 1);
      timelineSubs.delete(session.seed);
      persist();
      publish('control', session.seed, 'session_state_changed', { seed: session.seed, state: 'deleted' }, commandId);
      return { status: 200, body: { command_id: commandId, status: 'accepted' } };
    }
    return { status: 400, body: ackRejected(commandId, 'unsupported_command', `未知 control 命令: ${type}`) };
  }

  if (channel === 'conversation') {
    const session = state.sessions.find((s) => s.seed === seed);
    if (!session) {
      return { status: 400, body: ackRejected(commandId, 'dispatch_failed', `会话不存在: ${seed}`) };
    }
    if (type === 'conversation_send_message') {
      const text = String(params.text ?? '');
      void runTurn(session, commandId, text);
      return { status: 200, body: { command_id: commandId, status: 'accepted' } };
    }
    if (type === 'conversation_cancel') {
      session.abortFlag = true;
      return { status: 200, body: { command_id: commandId, status: 'accepted' } };
    }
    if (type === 'conversation_load_more') {
      // N6：daemon 设计性拒绝 load_more（§7 清单 ⑥ 验证点）
      return { status: 422, body: ackRejected(commandId, 'unsupported_command', 'load_more 已废弃：翻页用 timeline 快照分页') };
    }
    return { status: 400, body: ackRejected(commandId, 'unsupported_command', `未知 conversation 命令: ${type}`) };
  }

  return { status: 400, body: ackRejected(commandId, 'unsupported_command', `未知频道: ${channel}`) };
}

// ---------------------------------------------------------------------------
// 服务面
// ---------------------------------------------------------------------------

function handleService(method: string, payload: Record<string, unknown>): { status: number; body: unknown } {
  switch (method) {
    case 'daemon.version':
      return { status: 200, body: '1.0.0-mock' };
    case 'session.list':
      return {
        status: 200,
        body: [...state.sessions]
          .sort((a, b) => b.updated_at - a.updated_at)
          .map(sessionSummary),
      };
    case 'session.meta': {
      const session = state.sessions.find((s) => s.seed === payload.seed);
      return session
        ? { status: 200, body: sessionSummary(session) }
        : { status: 404, body: { code: 'query_failed', message: '会话不存在' } };
    }
    case 'config.load':
      return { status: 200, body: { model: MODEL, baseUrl: '', providerId: 'mock', endpoint: 'openai', maxTokens: 8192, contextLimit: CONTEXT_LIMIT, reasoningEffort: 'standard', autoCompactThreshold: 0.75, permissionLevel: 1, ...state.config, activeProfile: 'default', profiles: ['default'] } };
    case 'config.save': {
      state.config = { ...state.config, ...payload };
      persist();
      return { status: 200, body: null };
    }
    case 'workspace.get': {
      const session = state.sessions.find((s) => s.seed === payload.seed);
      return { status: 200, body: session ? 'F:\\mock-workspace' : null };
    }
    case 'debug.reset_epoch': {
      state.epoch = randomBytes(16).toString('hex');
      for (const [, ch] of Object.entries(channels)) {
        ch.seq = 0;
        for (const sub of [...ch.subs]) {
          // 对照 RingingResetRequired：{channel, seed, earliest_available_seq}
          sseWrite(sub.res, `event: ringing.reset_required\ndata: ${JSON.stringify({ channel: 'control', seed: '', earliest_available_seq: 0 })}\n\n`);
          sub.res.end();
          removeSubscriber(ch.subs, sub);
        }
      }
      for (const [seed, subs] of timelineSubs) {
        for (const sub of [...subs]) {
          sseWrite(sub.res, `event: ringing.reset_required\ndata: ${JSON.stringify({ channel: 'timeline', seed, earliest_available_seq: 0 })}\n\n`);
          sub.res.end();
          removeSubscriber(subs, sub);
        }
        timelineSubs.delete(seed);
      }
      persist();
      return { status: 200, body: { epoch: state.epoch } };
    }
    default:
      return { status: 404, body: { code: 'unknown_method', message: `未知服务方法: ${method}` } };
  }
}

// ---------------------------------------------------------------------------
// multipart（附件）
// ---------------------------------------------------------------------------

async function handleUpload(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
  const raw = await readBody(req);
  const contentType = String(req.headers['content-type'] ?? '');
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return { status: 400, body: { code: 'invalid_body', message: '缺少 multipart boundary' } };
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  // 逐 part 扫描：找 name="content" 的文件 part；seed/media_type 取自表单字段
  let partStart = raw.indexOf(boundary);
  let seed = '';
  let mediaType = 'application/octet-stream';
  let fileBytes: Buffer | null = null;
  while (partStart !== -1) {
    const headStart = partStart + boundary.length + 2;
    const headEnd = raw.indexOf('\r\n\r\n', headStart);
    if (headEnd === -1) break;
    const headers = raw.subarray(headStart, headEnd).toString('utf8');
    const next = raw.indexOf(boundary, headEnd + 4);
    const bodyBytes = raw.subarray(headEnd + 4, next === -1 ? raw.length : next - 2);
    const nameMatch = /name="([^"]*)"/i.exec(headers);
    const partName = nameMatch?.[1] ?? '';
    if (partName === 'seed') {
      seed = bodyBytes.toString('utf8').trim();
    } else if (partName === 'media_type') {
      mediaType = bodyBytes.toString('utf8').trim() || mediaType;
    } else if (partName === 'content') {
      const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
      if (typeMatch) mediaType = typeMatch[1].trim();
      fileBytes = bodyBytes;
    }
    partStart = next;
  }
  if (!fileBytes || !seed) {
    return { status: 400, body: { code: 'invalid_body', message: 'multipart 需要 seed 与 content 字段' } };
  }
  const sha256 = createHash('sha256').update(fileBytes).digest('hex');
  return { status: 200, body: { content_id: sha256, media_type: mediaType, sha256, truncated: false } };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://mock.local');
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  // 开发桥脚本（等价 daemon 注入）
  if (path === '/__qaqh_bridge__.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(`window.__QAQH_DEBUG__ = { token: '${TOKEN}', base_url: '' };\n`);
    return;
  }
  if (!path.startsWith('/ringing/')) return;

  // ① open（§7 清单验证点）
  if (path === '/ringing/v1/clients/open' && method === 'POST') {
    if (!authed(req)) return unauthorized(res);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      return json(res, 400, { code: 'invalid_body', message: 'invalid open request' });
    }
    if (body.schema !== RINGING_SCHEMA || body.version !== RINGING_VERSION) {
      return json(res, 426, {
        command_id: '',
        status: 'rejected',
        code: 'unsupported_version',
        message: 'unsupported Ringing schema/version',
      });
    }
    const csid = randomBytes(32).toString('hex');
    leases.set(csid, { instanceId: String(body.client_instance_id ?? ''), seeds: new Set(), renewedAt: Date.now() });
    json(res, 200, {
      schema: RINGING_SCHEMA,
      version: RINGING_VERSION,
      accepted: true,
      client_session_id: csid,
      server_epoch: state.epoch,
      lease_ttl_ms: LEASE_TTL_MS,
      renew_interval_ms: RENEW_INTERVAL_MS,
    });
    return;
  }

  // 续租
  if (path === '/ringing/v1/leases/renew' && method === 'POST') {
    if (!authed(req)) return unauthorized(res);
    const csid = sessionHeader(req);
    if (!csid || !leases.has(csid)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('lease expired or unknown');
      return;
    }
    leases.get(csid)!.renewedAt = Date.now();
    json(res, 200, { ok: true, lease_ttl_ms: LEASE_TTL_MS, renew_interval_ms: RENEW_INTERVAL_MS });
    return;
  }

  // 事件频道 SSE（逐信封）
  const eventsMatch = /^\/ringing\/v1\/events\/(control|conversation|tool)$/.exec(path);
  if (eventsMatch && method === 'GET') {
    if (!authed(req)) return unauthorized(res);
    const csid = sessionHeader(req);
    if (!csid || !leases.has(csid)) return leaseRequired(res);
    const channel = eventsMatch[1];
    // mock 事件日志不持久化：重启后 seq 从 0 重来，Last-Event-ID 只在进程内有效
    writeSseHead(res);
    addSubscriber(channels[channel].subs, res);
    return;
  }

  // 命令面（信封校验 + ack）
  const commandsMatch = /^\/ringing\/v1\/commands\/(control|conversation|tool)$/.exec(path);
  if (commandsMatch && method === 'POST') {
    if (!authed(req)) return unauthorized(res);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      return json(res, 400, { code: 'invalid_body', message: 'body 不是合法 JSON' });
    }
    const out = await handleCommand(commandsMatch[1], body);
    json(res, out.status, out.body);
    return;
  }

  // timeline 面：bootstrap / timeline 快照 / timeline SSE
  const tlMatch = /^\/ringing\/v1\/sessions\/([^/]+)\/(bootstrap|timeline|timeline\/events)$/.exec(path);
  if (tlMatch) {
    if (!authed(req)) return unauthorized(res);
    const seed = decodeURIComponent(tlMatch[1]);
    const session = state.sessions.find((s) => s.seed === seed);
    if (!session) return json(res, 404, { code: 'query_failed', message: '会话不存在' });
    const csid = sessionHeader(req);
    const what = tlMatch[2];

    if (what === 'bootstrap' && method === 'GET') {
      if (!ownsSeed(csid, seed)) return leaseRequired(res, 'attach the session seed before bootstrap');
      json(res, 200, {
        schema: RINGING_SCHEMA,
        version: RINGING_VERSION,
        server_epoch: state.epoch,
        seed,
        control: {
          schema: RINGING_SCHEMA, version: RINGING_VERSION, channel: 'control', seed,
          baseline_stream_seq: channels.control.seq, state_revision: 1, snapshot_version: 1,
          state: { seed, channel: 'control', revision: 1, session_state: 'created', agent_lifecycle: 'ready', activity: 'idle', dashboard_snapshot: { seed, documents: [], recent_edits: [], tasks: [] } },
        },
        conversation: {
          schema: RINGING_SCHEMA, version: RINGING_VERSION, channel: 'conversation', seed,
          baseline_stream_seq: channels.conversation.seq, state_revision: 1, snapshot_version: 1,
          state: {
            seed, channel: 'conversation', revision: 1,
            turns: [], total_turns: session.turns.length, has_more: false,
            usage: null, usage_totals: { ...session.usage, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0, reasoning_tokens: 0 },
            usage_requests: session.turnCount, cache_reported_requests: 0,
            model: MODEL, context_limit: CONTEXT_LIMIT,
          },
        },
        tool: {
          schema: RINGING_SCHEMA, version: RINGING_VERSION, channel: 'tool', seed,
          baseline_stream_seq: channels.tool.seq, state_revision: 1, snapshot_version: 1,
          state: { seed, channel: 'tool', revision: 1, last_finished: null, pending_permission: null, running: null },
        },
      });
      return;
    }

    if (what === 'timeline' && method === 'GET') {
      if (!ownsSeed(csid, seed)) return leaseRequired(res, 'attach the session seed before reading timeline');
      const beforeTurn = url.searchParams.get('before_turn');
      const limit = Math.min(200, Number.parseInt(url.searchParams.get('limit') ?? '30', 10) || 30);
      json(res, 200, timelineSnapshotResponse(session, beforeTurn, limit));
      return;
    }

    if (what === 'timeline/events' && method === 'GET') {
      if (!ownsSeed(csid, seed)) return leaseRequired(res);
      writeSseHead(res);
      const subs = timelineSubs.get(seed) ?? new Set<Subscriber>();
      timelineSubs.set(seed, subs);
      // 重放：cursor = <epoch>:timeline:<seq>；epoch 不匹配 → 全量
      const headerId = req.headers['last-event-id'];
      const headerStr = Array.isArray(headerId) ? headerId[0] : headerId;
      const parts = String(headerStr ?? '').split(':');
      const fromSeq = parts.length === 3 && parts[0] === state.epoch && parts[1] === 'timeline'
        ? Number.parseInt(parts[2] ?? '0', 10) || 0
        : 0;
      for (const entry of session.entries) {
        if (entry.timeline_seq <= fromSeq) continue;
        const frame: TimelineEventFrame = {
          schema: RINGING_SCHEMA,
          version: RINGING_VERSION,
          server_epoch: state.epoch,
          seed,
          entry,
        };
        sseWrite(res, `event: timeline.entry\nid: ${state.epoch}:timeline:${entry.timeline_seq}\ndata: ${JSON.stringify(frame)}\n\n`);
      }
      addSubscriber(subs, res);
      return;
    }
  }

  // 附件
  if (path === '/ringing/v1/content' && method === 'POST') {
    if (!authed(req)) return unauthorized(res);
    const csid = sessionHeader(req);
    if (!csid) return leaseRequired(res);
    const out = await handleUpload(req);
    json(res, out.status, out.body);
    return;
  }

  // 服务面
  const serviceMatch = /^\/ringing\/v1\/service\/(.+)$/.exec(path);
  if (serviceMatch && method === 'POST') {
    if (!authed(req)) return unauthorized(res);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      return json(res, 400, { code: 'invalid_body', message: 'body 不是合法 JSON' });
    }
    const out = handleService(serviceMatch[1], body);
    json(res, out.status, out.body);
    return;
  }

  json(res, 404, { code: 'unknown_method', message: `无匹配端点: ${method} ${path}` });
}

export function mockDaemon(): Plugin {
  return {
    name: 'qaqh-mock-daemon',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        // 仅接管协议端点与桥脚本；其余交还 vite（静态资源 / SPA）
        if (url.startsWith('/ringing/') || url.startsWith('/__qaqh_bridge__.js')) {
          void handle(req as IncomingMessage, res as ServerResponse).catch((err: unknown) => {
            if (!(res as ServerResponse).headersSent) {
              json(res as ServerResponse, 500, { code: 'internal', message: String(err) });
            }
          });
          return; // 已接管，绝不调用 next（避免 SPA fallback 抢答）
        }
        next();
      });
    },
  };
}
