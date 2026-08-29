/**
 * 内置 mock daemon（仅 dev）：按 PLAN §2 契约实现 qaqh.Ringing 全端点，
 * 供无后端开发与冒烟测试。行为参照物：
 *  - open 握手（426 代差 / 401 token 校验）
 *  - 三频道 SSE（15s keepalive 注释行、Last-Event-ID 重放、reset_required）
 *  - commands 面（信封校验、幂等 command_id、会话生命周期）
 *  - bootstrap / timeline 分页 / timeline SSE（严格 +1 seq）
 *  - service 面（22R+19W 的已用子集；未知 → 404 unknown_method）
 *  - content 附件上传（multipart → ContentRef）
 * 状态持久化到 .mock-state.json（gitignored），重启 vite 不丢会话。
 *
 * 注意：mock 的命令/事件字段名为本仓对 qaqh-ringing 的镜像猜测，
 * 接入真实后端时以 protocol/ 镜像对照修正。
 */
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RINGING_SCHEMA, RINGING_VERSION, type ContentRef, type MessageItem, type SessionSummary, type TimelineItem, type ToolItem } from '../src/protocol/types';

type NewTimelineItem = Omit<MessageItem, 'seq'> | Omit<ToolItem, 'seq'>;

const TOKEN = 'qaqh-dev-mock-token';
const KEEPALIVE_MS = 15_000;
const STATE_FILE = resolve(process.cwd(), '.mock-state.json');

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

interface MockEvent {
  id: string; // <epoch>:<channel>:<seq>
  event: string;
  seq: number;
  data: unknown;
}

interface Subscriber {
  res: ServerResponse;
  keepalive: ReturnType<typeof setInterval>;
}

interface MockSession {
  seed: string;
  title: string;
  created_at: string;
  updated_at: string;
  turn: number;
  abortFlag: boolean;
  items: TimelineItem[]; // seq 单调递增（跨 epoch 不重置）
  itemSeq: number;
}

interface PersistShape {
  epoch: number;
  sessions: MockSession[];
  config: Record<string, unknown>;
}

const state: PersistShape = loadState();
state.epoch ??= 1;

const channels: Record<string, { log: MockEvent[]; seq: number; subs: Set<Subscriber> }> = {
  control: { log: [], seq: 0, subs: new Set() },
  conversation: { log: [], seq: 0, subs: new Set() },
  tool: { log: [], seq: 0, subs: new Set() },
};
const timelineSubs = new Map<string, Set<Subscriber>>();

function loadState(): PersistShape {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as PersistShape;
  } catch {
    // 损坏的 state 文件：重新开始
  }
  return { epoch: 1, sessions: [], config: defaultConfig() };
}

function defaultConfig(): Record<string, unknown> {
  return {
    'ui.theme': 'system',
    'ui.timeline_page_size': 20,
    'ui.auto_scroll': true,
    'ui.show_diagnostics': false,
    'ui.raw_tool_output': false,
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persist(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch {
      // 忽略磁盘写入失败（只影响 dev 持久化）
    }
  }, 300);
}

// 种子数据：首次启动预置两个会话（含一个完整工具回合）
function seedIfEmpty(): void {
  if (state.sessions.length > 0) return;
  const now = new Date().toISOString();
  const toolId = randomUUID();
  const s1: MockSession = {
    seed: randomUUID(),
    title: '搜索 Fluent v9 迁移要点',
    created_at: now,
    updated_at: now,
    turn: 1,
    abortFlag: false,
    itemSeq: 0,
    items: [],
  };
  appendItem(s1, {
    kind: 'message', role: 'user', turn: 1, created_at: now,
    text: '帮我搜索 Fluent UI React v9 的迁移要点',
  });
  appendItem(s1, {
    kind: 'tool', turn: 1, tool_call_id: toolId, name: 'web_search',
    args: { query: 'Fluent UI React v9 migration guide' }, status: 'succeeded',
    output: '1. v9 以 @fluentui/react-components 为统一入口\n2. 样式方案为 Griffel（CSS-in-TS）\n3. 主题通过 FluentProvider 注入\n4. 图标独立包 @fluentui/react-icons',
    started_at: now, finished_at: now,
  });
  appendItem(s1, {
    kind: 'message', role: 'assistant', turn: 1, created_at: now,
    text: '已完成检索。Fluent v9 的关键迁移要点如下：\n\n1. 统一从 @fluentui/react-components 导入组件；\n2. 样式使用 Griffel，运行时零依赖注入；\n3. 在应用根部用 FluentProvider 提供主题；\n4. 图标改用 @fluentui/react-icons 独立包。\n\n需要我继续整理组件对照表吗？',
  });
  state.sessions.push(s1, {
    seed: randomUUID(),
    title: '新会话',
    created_at: now,
    updated_at: now,
    turn: 0,
    abortFlag: false,
    itemSeq: 0,
    items: [],
  });
  persist();
}
seedIfEmpty();

function appendItem(session: MockSession, item: NewTimelineItem): TimelineItem {
  const full = { ...item, seq: ++session.itemSeq } as TimelineItem;
  session.items.push(full);
  return full;
}

// ---------------------------------------------------------------------------
// SSE 基础设施
// ---------------------------------------------------------------------------

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
      if (!sseWrite(res, ': keepalive\n\n')) removeSubscriber(subs, sub);
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

function publish(channel: string, event: string, data: unknown): void {
  const ch = channels[channel];
  const seq = ++ch.seq;
  const id = `${state.epoch}:${channel}:${seq}`;
  const entry: MockEvent = { id, event, seq, data };
  ch.log.push(entry);
  const frame = `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const sub of [...ch.subs]) if (!sseWrite(sub.res, frame)) removeSubscriber(ch.subs, sub);
}

function publishTimeline(session: MockSession, item: TimelineItem): void {
  const subs = timelineSubs.get(session.seed);
  if (!subs || subs.size === 0) return;
  const id = `${state.epoch}:timeline:${item.seq}`;
  const frame = `event: timeline.item\nid: ${id}\ndata: ${JSON.stringify({ seq: item.seq, epoch: state.epoch, item })}\n\n`;
  for (const sub of [...subs]) if (!sseWrite(sub.res, frame)) removeSubscriber(subs, sub);
}

function replay(res: ServerResponse, headerId: string | undefined, log: MockEvent[]): void {
  let fromSeq = 0;
  if (headerId) {
    const parts = headerId.split(':');
    const epoch = Number.parseInt(parts[0] ?? '', 10);
    if (epoch === state.epoch) fromSeq = Number.parseInt(parts[2] ?? '0', 10) || 0;
    // epoch 不匹配 → 全量重放（客户端按 seq 去重）
  }
  for (const entry of log) {
    if (entry.seq <= fromSeq) continue;
    const data = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data);
    sseWrite(res, `event: ${entry.event}\nid: ${entry.id}\ndata: ${data}\n\n`);
  }
}

// ---------------------------------------------------------------------------
// 模拟回合（对话流式 + 工具演示）
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PlannedTool {
  toolId: string;
  name: string;
  args: Record<string, unknown>;
  output: string;
  fail: boolean;
}

function planTool(text: string): PlannedTool | null {
  const lower = text.toLowerCase();
  if (/搜索|search/.test(text + lower)) {
    return {
      toolId: randomUUID(), name: 'web_search', args: { query: text.slice(0, 40) },
      output: '[1] Fluent UI React v9 官方文档 — react.fluent2.microsoft.design\n[2] 迁移指南 v8→v9：组件更名与 Griffel 样式要点\n[3] Fluent 2 设计令牌一览（颜色/圆角/阴影）',
      fail: false,
    };
  }
  if (/文件|file|代码|code/.test(text + lower)) {
    return {
      toolId: randomUUID(), name: 'read_file', args: { path: 'src/main.tsx' },
      output: "import { FluentProvider, webLightTheme } from '@fluentui/react-components';\nimport { createRoot } from 'react-dom/client';\n\ncreateRoot(document.getElementById('root')!).render(\n  <FluentProvider theme={webLightTheme}><App /></FluentProvider>,\n);",
      fail: false,
    };
  }
  if (/失败|fail|错误/.test(text + lower)) {
    return {
      toolId: randomUUID(), name: 'run_command', args: { command: 'bun test --failing' },
      output: '', fail: true,
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
    return Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 段：这是用于验证流式渲染与自动滚动的一段较长的模拟回复内容，包含了中文、English 与数字 12345 的混合文本。`).join('\n\n');
  }
  return `收到：「${text.slice(0, 40)}」。\n\n这是 mock daemon 的流式回复：当前走 conversation 频道 message.delta 逐块推送，完成后由 message.finalized 收束，timeline 落为规范条目。试试包含「搜索」「文件」「失败」「长」的消息体验不同的工具卡片与长文本渲染。`;
}

async function runTurn(session: MockSession, text: string, attachments: ContentRef[]): Promise<void> {
  const turn = session.turn + 1;
  session.turn = turn;
  session.updated_at = new Date().toISOString();
  if (session.title === '新会话' && text.trim()) {
    session.title = text.trim().slice(0, 24);
  }

  // 1) 用户消息落 timeline
  const userItem = appendItem(session, {
    kind: 'message', role: 'user', turn,
    text,
    attachments: attachments.length ? attachments : undefined,
    created_at: new Date().toISOString(),
  });
  publishTimeline(session, userItem);
  persist();

  // 2) 回合开始
  publish('conversation', 'turn.started', { seed: session.seed, turn });
  session.abortFlag = false;

  const tool = planTool(text);

  // 3) 工具演示（tool 频道 + timeline 规范条目）
  if (tool) {
    publish('tool', 'tool.started', { seed: session.seed, turn, tool_call_id: tool.toolId, name: tool.name, args: tool.args });
    const item = appendItem(session, {
      kind: 'tool', turn, tool_call_id: tool.toolId, name: tool.name,
      args: tool.args, status: 'running',
      started_at: new Date().toISOString(),
    }) as ToolItem;
    publishTimeline(session, item);

    const chunks = tool.fail ? [] : chunkText(tool.output, 24);
    let acc = '';
    for (const c of chunks) {
      if (session.abortFlag) break;
      await sleep(110);
      acc += c;
      publish('tool', 'tool.output.delta', { tool_call_id: tool.toolId, delta: c });
      item.output = acc;
      publishTimeline(session, { ...item });
    }

    if (session.abortFlag) {
      item.status = 'cancelled';
    } else if (tool.fail) {
      await sleep(400);
      item.status = 'failed';
      item.error = 'exit code 1: bun: no tests matching --failing filter';
    } else {
      item.status = 'succeeded';
    }
    item.finished_at = new Date().toISOString();
    publish('tool', 'tool.finished', { tool_call_id: tool.toolId, status: item.status, output: item.output, error: item.error });
    publishTimeline(session, { ...item });
    if (session.abortFlag) {
      publish('conversation', 'turn.finished', { seed: session.seed, turn, status: 'aborted' });
      persist();
      return;
    }
  }

  // 4) 助手回复流式
  const reply = assistantReply(text, tool);
  for (const c of chunkText(reply, 18)) {
    if (session.abortFlag) break;
    await sleep(80);
    publish('conversation', 'message.delta', { seed: session.seed, turn, role: 'assistant', delta: c });
  }

  // 5) 收束
  const aborted = session.abortFlag;
  const finalText = aborted ? reply.slice(0, Math.floor(reply.length / 2)) + '\n\n（已中止）' : reply;
  if (!aborted) {
    const assistantItem = appendItem(session, {
      kind: 'message', role: 'assistant', turn, text: finalText,
      created_at: new Date().toISOString(),
    });
    publishTimeline(session, assistantItem);
  }
  publish('conversation', 'message.finalized', { seed: session.seed, turn, role: 'assistant', text: finalText });
  publish('conversation', 'turn.finished', { seed: session.seed, turn, status: aborted ? 'aborted' : 'completed' });
  session.updated_at = new Date().toISOString();
  publish('control', 'session.changed', sessionSummary(session));
  persist();
}

function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function sessionSummary(s: MockSession): SessionSummary {
  return {
    seed: s.seed,
    title: s.title,
    created_at: s.created_at,
    updated_at: s.updated_at,
    turn_count: s.turn,
    status: 'active',
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
  json(res, 401, { error: 'unauthorized', message: 'bridge token 校验失败' });
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

// ---------------------------------------------------------------------------
// 命令处理
// ---------------------------------------------------------------------------

async function handleCommand(channel: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const { command_id, client_instance_id, client_session_id, type } = body as Record<string, string>;
  if (!command_id || !client_instance_id || !client_session_id || !type) {
    return { status: 400, body: { error: 'invalid_request', message: '命令信封缺少必需字段' } };
  }
  const seed = body.seed as string | undefined;
  const payload = (body.payload ?? {}) as Record<string, unknown>;

  if (channel === 'conversation') {
    const session = state.sessions.find((s) => s.seed === seed);
    if (!session) return { status: 404, body: { error: 'action_failed', message: '会话不存在' } };
    if (type === 'user.send') {
      void runTurn(session, String(payload.text ?? ''), (payload.attachments as ContentRef[]) ?? []);
      return { status: 202, body: { accepted: true, command_id, result: { turn: session.turn + 1 } } };
    }
    if (type === 'turn.abort') {
      session.abortFlag = true;
      return { status: 202, body: { accepted: true, command_id, result: null } };
    }
    return { status: 404, body: { error: 'unknown_command', message: `未知 conversation 命令: ${type}` } };
  }

  if (channel === 'control') {
    if (type === 'session.new') {
      const now = new Date().toISOString();
      const session: MockSession = {
        seed: randomUUID(), title: String(payload.title ?? '新会话'), created_at: now,
        updated_at: now, turn: 0, abortFlag: false, itemSeq: 0, items: [],
      };
      state.sessions.push(session);
      persist();
      return { status: 202, body: { accepted: true, command_id, result: { seed: session.seed } } };
    }
    if (type === 'session.rename') {
      const session = state.sessions.find((s) => s.seed === seed);
      if (!session) return { status: 404, body: { error: 'action_failed', message: '会话不存在' } };
      session.title = String(payload.title ?? session.title);
      session.updated_at = new Date().toISOString();
      persist();
      publish('control', 'session.changed', sessionSummary(session));
      return { status: 202, body: { accepted: true, command_id, result: null } };
    }
    if (type === 'session.delete') {
      const idx = state.sessions.findIndex((s) => s.seed === seed);
      if (idx === -1) return { status: 404, body: { error: 'action_failed', message: '会话不存在' } };
      state.sessions.splice(idx, 1);
      if (seed) timelineSubs.delete(seed);
      persist();
      return { status: 202, body: { accepted: true, command_id, result: null } };
    }
    if (type === 'session.resume') {
      const session = state.sessions.find((s) => s.seed === seed);
      if (!session) return { status: 404, body: { error: 'action_failed', message: '会话不存在' } };
      return { status: 202, body: { accepted: true, command_id, result: { seed: session.seed } } };
    }
    return { status: 404, body: { error: 'unknown_command', message: `未知 control 命令: ${type}` } };
  }

  return { status: 404, body: { error: 'unknown_command', message: `未知频道: ${channel}` } };
}

// ---------------------------------------------------------------------------
// 服务面
// ---------------------------------------------------------------------------

function handleService(method: string, payload: Record<string, unknown>): { status: number; body: unknown } {
  switch (method) {
    case 'session.list':
      return {
        status: 200,
        body: { sessions: [...state.sessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(sessionSummary) },
      };
    case 'session.get': {
      const session = state.sessions.find((s) => s.seed === payload.seed);
      return session ? { status: 200, body: { session: sessionSummary(session) } } : { status: 404, body: { error: 'query_failed', message: '会话不存在' } };
    }
    case 'config.get':
      return { status: 200, body: { config: state.config } };
    case 'config.set': {
      const patch = (payload.patch ?? {}) as Record<string, unknown>;
      state.config = { ...state.config, ...patch };
      persist();
      return { status: 200, body: { config: state.config } };
    }
    case 'workspace.info':
      return { status: 200, body: { name: 'QAQ-Harness (mock)', version: '0.0.0-dev', platform: process.platform } };
    case 'debug.reset_epoch': {
      state.epoch += 1;
      for (const ch of Object.values(channels)) {
        ch.log = [];
        ch.seq = 0;
        for (const sub of [...ch.subs]) {
          sseWrite(sub.res, `event: ringing.reset_required\ndata: ${JSON.stringify({ epoch: state.epoch })}\n\n`);
          sub.res.end();
          removeSubscriber(ch.subs, sub);
        }
      }
      for (const subs of timelineSubs.values()) {
        for (const sub of [...subs]) {
          sub.res.end();
          removeSubscriber(subs, sub);
        }
      }
      persist();
      return { status: 200, body: { epoch: state.epoch } };
    }
    default:
      return { status: 404, body: { error: 'unknown_method', message: `未知服务方法: ${method}` } };
  }
}

// ---------------------------------------------------------------------------
// multipart（附件）
// ---------------------------------------------------------------------------

async function handleUpload(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
  const raw = await readBody(req);
  const contentType = String(req.headers['content-type'] ?? '');
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return { status: 400, body: { error: 'invalid_request', message: '缺少 multipart boundary' } };
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  // 提取第一个 part 的头部与体
  const start = raw.indexOf(boundary);
  if (start === -1) return { status: 400, body: { error: 'invalid_request', message: 'multipart 结构无效' } };
  const headStart = start + boundary.length + 2; // 跳过 \r\n
  const headEnd = raw.indexOf('\r\n\r\n', headStart);
  if (headEnd === -1) return { status: 400, body: { error: 'invalid_request', message: 'multipart 结构无效' } };
  const headers = raw.subarray(headStart, headEnd).toString('utf8');
  const next = raw.indexOf(boundary, headEnd + 4);
  const fileBytes = raw.subarray(headEnd + 4, next === -1 ? raw.length : next - 2);
  const nameMatch = /filename="([^"]*)"/i.exec(headers);
  const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
  const sha256 = createHash('sha256').update(fileBytes).digest('hex');
  const ref: ContentRef = {
    content_id: `c_${randomUUID()}`,
    sha256,
    media_type: (typeMatch?.[1] ?? 'application/octet-stream').trim(),
  };
  return { status: 200, body: { ...ref, filename: nameMatch?.[1] ?? 'file', size: fileBytes.length } };
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

  if (path === '/ringing/v1/clients/open' && method === 'POST') {
    if (!authed(req)) return unauthorized(res);
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as Record<string, unknown>;
    if (body.schema !== RINGING_SCHEMA || body.version !== RINGING_VERSION) {
      res.writeHead(426, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: false, reason: 'unsupported_version', schema: RINGING_SCHEMA, version: RINGING_VERSION }));
      return;
    }
    json(res, 200, {
      accepted: true,
      client_session_id: randomUUID(),
      server_epoch: state.epoch,
      lease_ttl_ms: 30_000,
      renew_interval_ms: 10_000,
    });
    return;
  }

  if (path === '/ringing/v1/clients/renew' && method === 'POST') {
    if (!authed(req)) return unauthorized(res);
    await readBody(req);
    json(res, 200, { accepted: true, lease_ttl_ms: 30_000, renew_interval_ms: 10_000 });
    return;
  }

  // 事件频道 SSE
  const eventsMatch = /^\/ringing\/v1\/events\/(control|conversation|tool)$/.exec(path);
  if (eventsMatch && method === 'GET') {
    if (!authed(req)) return unauthorized(res);
    const channel = eventsMatch[1];
    const headerId = req.headers['last-event-id'];
    writeSseHead(res);
    replay(res, Array.isArray(headerId) ? headerId[0] : headerId, channels[channel].log);
    addSubscriber(channels[channel].subs, res);
    return;
  }

  // 命令面
  const commandsMatch = /^\/ringing\/v1\/commands\/(control|conversation|tool)$/.exec(path);
  if (commandsMatch && method === 'POST') {
    if (!authed(req)) return unauthorized(res);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: 'invalid_request', message: 'body 不是合法 JSON' });
    }
    const out = await handleCommand(commandsMatch[1], body);
    json(res, out.status, out.body);
    return;
  }

  // timeline
  const tlMatch = /^\/ringing\/v1\/sessions\/([^/]+)\/(bootstrap|timeline|timeline\/events)$/.exec(path);
  if (tlMatch) {
    if (!authed(req)) return unauthorized(res);
    const seed = decodeURIComponent(tlMatch[1]);
    const session = state.sessions.find((s) => s.seed === seed);
    if (!session) return json(res, 404, { error: 'query_failed', message: '会话不存在' });
    const what = tlMatch[2];
    if (what === 'bootstrap' && method === 'GET') {
      const cursor = { epoch: state.epoch, seq: session.itemSeq };
      const limit = 200;
      const visible = session.items.slice(-limit);
      json(res, 200, {
        seed: session.seed,
        title: session.title,
        items: visible,
        cursor,
        has_more: session.items.length > limit,
      });
      return;
    }
    if (what === 'timeline' && method === 'GET') {
      const beforeTurn = Number.parseInt(url.searchParams.get('before_turn') ?? '', 10);
      const limit = Math.min(200, Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20);
      let items = session.items;
      if (Number.isFinite(beforeTurn)) {
        const cutoff = items.findIndex((i) => i.turn >= beforeTurn);
        items = cutoff === -1 ? items : items.slice(0, Math.max(cutoff, 0));
      }
      const page = items.slice(-limit);
      json(res, 200, {
        items: page,
        cursor: { epoch: state.epoch, seq: page.at(-1)?.seq ?? 0 },
        has_more: items.length > page.length,
      });
      return;
    }
    if (what === 'timeline/events' && method === 'GET') {
      writeSseHead(res);
      const subs = timelineSubs.get(session.seed) ?? new Set<Subscriber>();
      timelineSubs.set(session.seed, subs);
      const headerId = req.headers['last-event-id'];
      const headerStr = Array.isArray(headerId) ? headerId[0] : headerId;
      const parts = String(headerStr ?? '').split(':');
      const fromSeq = Number.parseInt(parts[2] ?? '0', 10) || 0;
      for (const item of session.items) {
        if (item.seq <= fromSeq) continue;
        const id = `${state.epoch}:timeline:${item.seq}`;
        sseWrite(res, `event: timeline.item\nid: ${id}\ndata: ${JSON.stringify({ seq: item.seq, epoch: state.epoch, item })}\n\n`);
      }
      addSubscriber(subs, res);
      return;
    }
  }

  // 附件
  if (path === '/ringing/v1/content' && method === 'POST') {
    if (!authed(req)) return unauthorized(res);
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
      return json(res, 400, { error: 'invalid_request', message: 'body 不是合法 JSON' });
    }
    const out = handleService(serviceMatch[1], body);
    json(res, out.status, out.body);
    return;
  }

  json(res, 404, { error: 'unknown_method', message: `无匹配端点: ${method} ${path}` });
}

export function mockDaemon(): Plugin {
  return {
    name: 'qaqh-mock-daemon',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void handle(req as IncomingMessage, res as ServerResponse).catch((err: unknown) => {
          if (!(res as ServerResponse).headersSent) {
            json(res as ServerResponse, 500, { error: 'internal', message: String(err) });
          }
        });
        next();
      });
    },
  };
}
