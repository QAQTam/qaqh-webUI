/**
 * timeline 投影（PLAN M3，唯一历史真源 N6）——按真实后端原生 transcript 模型重写：
 * - 权威基底：GET /sessions/{seed}/timeline 快照（尾窗，TimelineTurn[]）
 * - 增量：timeline SSE `timeline.entry`（TimelineEntry，严格 +1 光标；gap → re-baseline）
 * - 上翻：GET /timeline?before_turn=<最旧 turn_id>&limit（快照分页，禁 load_more 命令）
 * - conversation 频道事件仅作流式辅助信号（turn 开始/取消/usage/retry），
 *   工具频道事件仅驱动权限横幅；transcript 一律以 timeline face 为准。
 */
import { useSyncExternalStore } from 'react';
import { createStore, type Store } from './store';
import type { RingingClient } from '../daemon/client';
import { endpointTimelinePage, endpointTimelineEvents, endpointBootstrap } from '../protocol/endpoints';
import { getJson, authHeaders } from '../transport/http';
import { connectSse } from '../transport/sse';
import type {
  BootstrapResponse,
  ConversationAuxState,
  TimelineTurn,
  TimelineTurnState,
  TimelineBlock,
  TimelineRound,
  TimelineEntry,
  TimelineSnapshotResponse,
  TimelineEventFrame,
  UsageInfo,
  ResetRequired,
} from '../protocol/types';
import { CONVERSATION_COMMANDS } from '../protocol/methods';
import type { SendMessageParams } from '../protocol/methods';
import type { EventEnvelope } from '../protocol/types';

export const TIMELINE_PAGE_SIZE = 50;

export interface ProviderRetryInfo {
  attempt: number;
  maxRetries: number;
  delaySecs: number;
  message: string;
}

export interface TimelineState {
  seed: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** 权威 transcript：旧 → 新 */
  turns: TimelineTurn[];
  watermark: number;
  totalTurns: number;
  hasMore: boolean;
  loadingOlder: boolean;
  /** 活跃回合（conversation turn_started 起、turn_sealed/turn_completed 止） */
  activeTurnId: string | null;
  /** 命令在途（发送中） */
  pendingSend: boolean;
  /** 最近一个回合被中止（展示"已中止"提示，下一回合开始时清除） */
  abortedNote: boolean;
  /** provider 重试中（非终态提示） */
  providerRetry: ProviderRetryInfo | null;
  /** conversation 快照辅助信息 */
  model: string | null;
  contextLimit: number | null;
  usage: UsageInfo | null;
  usageTotals: UsageInfo | null;
  /** tool 频道权限请求（横幅） */
  pendingPermission: {
    tool_call_id: string;
    tool_name: string;
    reason: string;
    risk: string;
    consequence: string;
    paths: string[];
  } | null;
}

type TimelineMap = Record<string, TimelineState>;

export const timelineStore: Store<TimelineMap> = createStore<TimelineMap>({});

function emptyState(seed: string): TimelineState {
  return {
    seed,
    status: 'idle',
    error: null,
    turns: [],
    watermark: 0,
    totalTurns: 0,
    hasMore: false,
    loadingOlder: false,
    activeTurnId: null,
    pendingSend: false,
    abortedNote: false,
    providerRetry: null,
    model: null,
    contextLimit: null,
    usage: null,
    usageTotals: null,
    pendingPermission: null,
  };
}

/** 订阅某会话的 timeline 状态（未挂载时返回 null，保持快照稳定） */
export function useTimelineState(seed: string | null): TimelineState | null {
  return useSyncExternalStore(
    timelineStore.subscribe,
    () => (seed ? timelineStore.get()[seed] ?? null : null),
    () => (seed ? timelineStore.get()[seed] ?? null : null),
  );
}

function patch(seed: string, fn: (s: TimelineState) => TimelineState): void {
  timelineStore.set((map) => {
    const cur = map[seed] ?? emptyState(seed);
    return { ...map, [seed]: fn(cur) };
  });
}

// ---------------------------------------------------------------------------
// reducer：TimelineEntry → block 树（唯一写入口，不可变更新）
// ---------------------------------------------------------------------------

function updateBlock(
  turn: TimelineTurn,
  roundNum: number,
  blockId: string,
  fn: (b: TimelineBlock) => TimelineBlock,
): TimelineTurn {
  const ri = turn.rounds.findIndex((r) => r.round_num === roundNum);
  if (ri < 0) return turn;
  const round = turn.rounds[ri];
  const bi = round.blocks.findIndex((b) => b.block_id === blockId);
  if (bi < 0) return turn;
  const blocks = round.blocks.slice();
  blocks[bi] = fn(blocks[bi]);
  const rounds = turn.rounds.slice();
  rounds[ri] = { ...round, blocks };
  return { ...turn, rounds };
}

/** block_opened：按 block_id upsert，新块按 block_order 稳定插入 */
function upsertBlock(
  turn: TimelineTurn,
  roundNum: number,
  block: TimelineBlock,
): TimelineTurn {
  const ri = turn.rounds.findIndex((r) => r.round_num === roundNum);
  if (ri < 0) return turn;
  const round = turn.rounds[ri];
  const bi = round.blocks.findIndex((b) => b.block_id === block.block_id);
  const rounds = turn.rounds.slice();
  if (bi >= 0) {
    const blocks = round.blocks.slice();
    blocks[bi] = block;
    rounds[ri] = { ...round, blocks };
  } else {
    const blocks = [...round.blocks, block].sort((a, b) => a.block_order - b.block_order);
    rounds[ri] = { ...round, blocks };
  }
  return { ...turn, rounds };
}

/**
 * 应用一条 timeline 权威变更。幂等：同一 entry 重复应用结果一致。
 * 返回值复用未触及的 turn 引用（结构共享，长历史可承受）。
 */
export function applyTimelineEntry(turns: TimelineTurn[], entry: TimelineEntry): TimelineTurn[] {
  const { turn_id, round_num = 0, event } = entry;
  const ti = turns.findIndex((t) => t.turn_id === turn_id);
  const ev = event as TimelineEntry['event'] & { type: string };

  if (ev.type === 'turn_opened') {
    if (ti >= 0) {
      const next = turns.slice();
      next[ti] = { ...turns[ti], user_text: ev.user_text };
      return next;
    }
    return [
      ...turns,
      {
        turn_id,
        created_seq: entry.timeline_seq,
        user_text: ev.user_text,
        sealed: false,
        state: 'running',
        rounds: [],
      },
    ];
  }

  if (ti < 0) return turns; // 无关 turn（防御：不应发生）
  const turn = turns[ti];
  let next: TimelineTurn = turn;

  const ensureRound = (): TimelineTurn => {
    if (next.rounds.some((r) => r.round_num === round_num)) return next;
    const round: TimelineRound = { round_num, sealed: false, is_final: false, blocks: [] };
    next = { ...next, rounds: [...next.rounds, round].sort((a, b) => a.round_num - b.round_num) };
    return next;
  };

  switch (ev.type) {
    case 'block_opened': {
      ensureRound();
      next = upsertBlock(next, round_num, ev.block);
      break;
    }
    case 'text_delta': {
      next = updateBlock(next, round_num, ev.block_id, (b) => ({ ...b, text: b.text + ev.delta }));
      break;
    }
    case 'block_checkpoint': {
      next = updateBlock(next, round_num, ev.block_id, (b) => ({ ...b, text: ev.text }));
      break;
    }
    case 'tool_updated': {
      ensureRound();
      const round = next.rounds.find((r) => r.round_num === round_num)!;
      const existing = round.blocks.find((b) => b.block_id === ev.block_id);
      if (existing) {
        next = updateBlock(next, round_num, ev.block_id, (b) => ({
          ...b,
          kind: 'tool',
          tool: ev.tool,
        }));
      } else {
        // 防御：writer 总是先 block_opened；缺序时补建 tool 块
        next = upsertBlock(next, round_num, {
          block_id: ev.block_id,
          block_order: round.blocks.length,
          kind: 'tool',
          state: 'open',
          text: '',
          tool: ev.tool,
        });
      }
      break;
    }
    case 'tool_progress': {
      next = updateBlock(next, round_num, ev.block_id, (b) => ({
        ...b,
        tool: b.tool ? { ...b.tool, progress: (b.tool.progress ?? '') + ev.chunk } : b.tool,
      }));
      break;
    }
    case 'block_sealed': {
      next = updateBlock(next, round_num, ev.block_id, (b) => ({ ...b, state: 'sealed' }));
      break;
    }
    case 'round_sealed': {
      const ri = next.rounds.findIndex((r) => r.round_num === round_num);
      if (ri >= 0) {
        const rounds = next.rounds.slice();
        rounds[ri] = { ...rounds[ri], sealed: true, is_final: ev.is_final };
        next = { ...next, rounds };
      }
      break;
    }
    case 'turn_sealed': {
      next = { ...next, sealed: true, state: ev.state as TimelineTurnState, failure: ev.failure };
      break;
    }
    default:
      break;
  }
  if (next === turn) return turns;
  const out = turns.slice();
  out[ti] = next;
  return out;
}

// ---------------------------------------------------------------------------
// TimelineController：快照基底 + timeline SSE 增量 + 上翻分页
// ---------------------------------------------------------------------------

export class TimelineController {
  private client: RingingClient;
  private seed: string;
  private abort = new AbortController();
  private lastSeq = 0;
  private running = false;
  /** 已成功建立过 timeline 流（用于重连时触发 re-baseline） */
  private everConnected = false;

  constructor(client: RingingClient, seed: string) {
    this.client = client;
    this.seed = seed;
  }

  /** 快照 re-baseline：拉尾窗 + aux，随后接 timeline SSE 增量 */
  async start(): Promise<void> {
    this.stop();
    this.abort = new AbortController();
    this.running = true;
    patch(this.seed, (s) => ({ ...s, status: 'loading', error: null }));
    try {
      const page = await getJson<TimelineSnapshotResponse>(
        endpointTimelinePage(this.client.baseUrl, this.seed, { limit: TIMELINE_PAGE_SIZE }),
        this.client.auth,
        { signal: this.abort.signal },
      );
      if (!this.running) return;
      this.lastSeq = page.snapshot.watermark;
      patch(this.seed, (s) => ({
        ...s,
        status: 'ready',
        turns: page.snapshot.turns,
        watermark: page.snapshot.watermark,
        totalTurns: page.total_turns,
        hasMore: page.has_more,
        loadingOlder: false,
        activeTurnId: null,
        providerRetry: null,
      }));
      // aux：bootstrap conversation 快照（model/usage/active_turn 等）
      void this.loadAux();
      this.connectEvents();
    } catch (err) {
      if (!this.running || (err instanceof DOMException && err.name === 'AbortError')) return;
      patch(this.seed, (s) => ({
        ...s,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  /** bootstrap 辅助状态（非 transcript 权威，仅 model/usage/上下文水位） */
  private async loadAux(): Promise<void> {
    try {
      const boot = await getJson<BootstrapResponse>(
        endpointBootstrap(this.client.baseUrl, this.seed),
        this.client.auth,
        { signal: this.abort.signal },
      );
      if (!this.running) return;
      const conv = boot.conversation.state as ConversationAuxState;
      patch(this.seed, (s) => ({
        ...s,
        model: conv.model ?? s.model,
        contextLimit: conv.context_limit ?? s.contextLimit,
        usage: conv.usage ?? s.usage,
        usageTotals: conv.usage_totals ?? s.usageTotals,
        // bootstrap 里 active_turn 非空 = 恢复时回合仍在跑
        activeTurnId: conv.active_turn?.turn_id ?? s.activeTurnId,
      }));
    } catch {
      // aux 失败不阻断 transcript
    }
  }

  private connectEvents(): void {
    connectSse({
      url: endpointTimelineEvents(this.client.baseUrl, this.seed),
      headers: authHeaders(this.client.auth),
      lastEventId: `${this.client.store.get().epoch}:timeline:${this.lastSeq}`,
      signal: this.abort.signal,
      idleTimeoutMs: 45_000,
      backoffBaseMs: 500,
      backoffMaxMs: 10_000,
      onStatus: (s) => {
        // timeline_seq 跨 (epoch, seed) 严格单调但**不连续**（watermark 为
        // 全局计数），无法用跳号检测缺口；且 daemon 端 timeline 重放只覆盖
        // 内存 journal 窗口（重启/压缩后为空）。因此断流重连一律以快照
        // re-baseline（快照是唯一权威，N6），禁止依赖 SSE 重放补洞。
        if (s === 'open') this.everConnected = true;
        if (s === 'reconnecting' && this.everConnected) {
          void this.start();
        }
      },
      onMessage: (m) => {
        let frame: TimelineEventFrame;
        try {
          frame = JSON.parse(m.data) as TimelineEventFrame;
        } catch {
          return;
        }
        const entry = frame?.entry;
        if (!entry || typeof entry.timeline_seq !== 'number') return;
        if (entry.timeline_seq <= this.lastSeq) return; // 重复（幂等忽略）
        this.lastSeq = Math.max(this.lastSeq, entry.timeline_seq);
        patch(this.seed, (s) => {
          const turns = applyTimelineEntry(s.turns, entry);
          const sealedTurn = entry.event.type === 'turn_sealed' ? entry.turn_id : null;
          return {
            ...s,
            turns,
            watermark: Math.max(s.watermark, entry.timeline_seq),
            activeTurnId:
              entry.event.type === 'turn_opened'
                ? entry.turn_id
                : sealedTurn && sealedTurn === s.activeTurnId
                  ? null
                  : s.activeTurnId,
          };
        });
      },
    });
  }

  /** 向上翻页：before_turn = 当前最旧 turn_id（快照分页，非 load_more 命令） */
  async loadOlder(limit: number): Promise<void> {
    const s = timelineStore.get()[this.seed];
    if (!s || !s.hasMore || s.loadingOlder || s.turns.length === 0) return;
    const oldestTurnId = s.turns[0].turn_id;
    patch(this.seed, (x) => ({ ...x, loadingOlder: true }));
    try {
      const page = await getJson<TimelineSnapshotResponse>(
        endpointTimelinePage(this.client.baseUrl, this.seed, {
          beforeTurn: oldestTurnId,
          limit,
        }),
        this.client.auth,
        { signal: this.abort.signal },
      );
      patch(this.seed, (x) => {
        const known = new Set(x.turns.map((t) => t.turn_id));
        const older = page.snapshot.turns.filter((t) => !known.has(t.turn_id));
        return {
          ...x,
          turns: [...older, ...x.turns],
          hasMore: page.has_more,
          loadingOlder: false,
          totalTurns: page.total_turns,
        };
      });
    } catch {
      patch(this.seed, (x) => ({ ...x, loadingOlder: false }));
    }
  }

  stop(): void {
    this.running = false;
    this.abort.abort();
  }
}

// ---------------------------------------------------------------------------
// 控制器注册表：同一时刻仅附着一个会话；epoch 重建后由 onReattach 重新 start
// ---------------------------------------------------------------------------

const controllers = new Map<string, TimelineController>();

export function attachTimeline(client: RingingClient, seed: string): void {
  for (const [s, c] of controllers) {
    if (s !== seed) {
      c.stop();
      controllers.delete(s);
    }
  }
  let controller = controllers.get(seed);
  if (!controller) {
    controller = new TimelineController(client, seed);
    controllers.set(seed, controller);
  }
  void controller.start();
}

export function getController(seed: string): TimelineController | undefined {
  return controllers.get(seed);
}

/** App 监听：timeline 重载事件（错误重试 / reset_required re-baseline） */
export function listenTimelineReload(): () => void {
  const handler = (e: Event): void => {
    const seed = (e as CustomEvent<string>).detail;
    if (typeof seed === 'string' && controllers.has(seed)) void controllers.get(seed)!.start();
  };
  window.addEventListener('qaqh.timeline.reload', handler);
  return () => window.removeEventListener('qaqh.timeline.reload', handler);
}

// ---------------------------------------------------------------------------
// conversation/tool 频道事件 → 流式辅助信号
// ---------------------------------------------------------------------------

function eventOf(data: unknown): { seed: string; event: Record<string, unknown> } | null {
  const env = data as Partial<EventEnvelope> | null;
  if (!env || typeof env.seed !== 'string' || !env.event) return null;
  return { seed: env.seed, event: env.event as Record<string, unknown> };
}

export function bindTimelineToClient(client: RingingClient): () => void {
  return client.onServerEvent((channel, eventName, data) => {
    // reset_required：cursor 超出保留窗口 → re-baseline + 重拉列表
    if (eventName === 'ringing.reset_required') {
      const reset = data as ResetRequired;
      if (reset?.seed) {
        window.dispatchEvent(new CustomEvent('qaqh.timeline.reload', { detail: reset.seed }));
      }
      return;
    }
    if (channel !== 'conversation' && channel !== 'tool') return;
    const parsed = eventOf(data);
    if (!parsed) return;
    const { seed, event } = parsed;
    const type = event.type as string;

    if (channel === 'conversation') {
      switch (type) {
        case 'turn_started': {
          patch(seed, (s) => ({
            ...s,
            activeTurnId: String(event.turn_id ?? ''),
            abortedNote: false,
            providerRetry: null,
          }));
          break;
        }
        case 'turn_completed':
        case 'turn_failed': {
          // 终态以 timeline turn_sealed 为权威；此处仅提前收敛指示
          patch(seed, (s) => ({
            ...s,
            activeTurnId: s.activeTurnId === String(event.turn_id) ? null : s.activeTurnId,
            providerRetry: null,
          }));
          break;
        }
        case 'conversation_cancelled': {
          patch(seed, (s) => ({
            ...s,
            activeTurnId: null,
            abortedNote: true,
            providerRetry: null,
          }));
          break;
        }
        case 'provider_retrying': {
          patch(seed, (s) => ({
            ...s,
            providerRetry: {
              attempt: Number(event.attempt ?? 0),
              maxRetries: Number(event.max_retries ?? 0),
              delaySecs: Number(event.delay_secs ?? 0),
              message: String(event.error_message ?? ''),
            },
          }));
          break;
        }
        case 'usage_updated': {
          patch(seed, (s) => ({ ...s, usage: event.usage as UsageInfo }));
          break;
        }
        default:
          break;
      }
    }

    if (channel === 'tool') {
      switch (type) {
        case 'tool_permission_requested': {
          patch(seed, (s) => ({
            ...s,
            pendingPermission: {
              tool_call_id: String(event.tool_call_id ?? ''),
              tool_name: String(event.tool_name ?? ''),
              reason: String(event.reason ?? ''),
              risk: String(event.risk ?? ''),
              consequence: String(event.consequence ?? ''),
              paths: Array.isArray(event.paths) ? (event.paths as string[]) : [],
            },
          }));
          break;
        }
        case 'tool_started':
        case 'tool_finished': {
          // 权限已裁决（或工具完成）→ 收横幅；卡片态以 timeline tool_updated 为准
          patch(seed, (s) => (s.pendingPermission ? { ...s, pendingPermission: null } : s));
          break;
        }
        default:
          break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 会话内命令
// ---------------------------------------------------------------------------

export async function sendUserMessage(
  client: RingingClient,
  seed: string,
  text: string,
  attachments?: import('../protocol/types').ContentRef[],
): Promise<void> {
  patch(seed, (s) => ({ ...s, pendingSend: true, error: null }));
  try {
    const params: SendMessageParams = { text };
    if (attachments && attachments.length > 0) params.attachments = attachments;
    const ack = await client.sendCommand('conversation', CONVERSATION_COMMANDS.sendMessage, params, {
      seed,
    });
    if (ack.status === 'rejected') {
      patch(seed, (s) => ({
        ...s,
        error: ack.message ?? ack.code ?? '消息被拒绝',
      }));
    }
  } finally {
    patch(seed, (s) => ({ ...s, pendingSend: false }));
  }
}

export async function abortActiveTurn(client: RingingClient, seed: string): Promise<void> {
  await client.sendCommand('conversation', CONVERSATION_COMMANDS.cancel, {}, { seed });
}

/** 取会话当前是否处于生成中（用于 composer 切换发送/中止） */
export function isTurnActive(state: TimelineState | null): boolean {
  return !!state && (state.activeTurnId !== null || state.pendingSend);
}
