/**
 * timeline 投影（PLAN M3，唯一历史真源 N6）：
 * bootstrap 全量 + 分页（before_turn）+ timeline SSE（严格 +1 光标）。
 * gap → 全量 re-baseline，禁止本地"加载更多"猜测。
 * 对话/工具频道事件只作为活跃回合的流式 overlay（输入指示、工具运行态）。
 */
import { useSyncExternalStore } from 'react';
import { createStore, type Store } from './store';
import type { RingingClient } from '../daemon/client';
import {
  endpointBootstrap,
  endpointTimeline,
  endpointTimelineEvents,
} from '../protocol/endpoints';
import { getJson, authHeaders } from '../transport/http';
import { connectSse } from '../transport/sse';
import type {
  BootstrapResponse,
  TimelineItem,
  TimelinePage,
  TimelineItemEvent,
} from '../protocol/types';
import { CONVERSATION_COMMANDS } from '../protocol/methods';
import type { UserSendPayload } from '../protocol/methods';

export interface TimelineState {
  seed: string;
  title: string;
  status: 'idle' | 'loading' | 'ready' | 'error' | 'rebasing';
  error: string | null;
  items: TimelineItem[];
  cursor: { epoch: number; seq: number } | null;
  hasMore: boolean;
  loadingOlder: boolean;
  /** 活跃回合（流式 overlay） */
  activeTurn: number | null;
  streamingText: string;
  /** 命令在途（发送中） */
  pendingSend: boolean;
  /** 最近一个回合被中止（展示"已中止"提示，下一回合开始时清除） */
  abortedNote: boolean;
}

type TimelineMap = Record<string, TimelineState>;

export const timelineStore: Store<TimelineMap> = createStore<TimelineMap>({});

function emptyState(seed: string): TimelineState {
  return {
    seed,
    title: '',
    status: 'idle',
    error: null,
    items: [],
    cursor: null,
    hasMore: false,
    loadingOlder: false,
    activeTurn: null,
    streamingText: '',
    pendingSend: false,
    abortedNote: false,
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

function upsertItems(seed: string, incoming: TimelineItem[]): void {
  patch(seed, (s) => {
    const bySeq = new Map(s.items.map((i) => [i.seq, i]));
    for (const item of incoming) bySeq.set(item.seq, item);
    const items = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    return { ...s, items };
  });
}

// ---------------------------------------------------------------------------
// TimelineController：bootstrap + 分页 + timeline SSE（严格 +1）
// ---------------------------------------------------------------------------

export class TimelineController {
  private client: RingingClient;
  private seed: string;
  private abort = new AbortController();
  private lastSeq = 0;
  private running = false;

  constructor(client: RingingClient, seed: string) {
    this.client = client;
    this.seed = seed;
  }

  async start(): Promise<void> {
    this.stop();
    this.abort = new AbortController();
    this.running = true;
    this.client.setCurrentSeed(this.seed);
    patch(this.seed, (s) => ({ ...s, status: 'loading', error: null }));
    try {
      const snap = await getJson<BootstrapResponse>(
        endpointBootstrap(this.client.baseUrl, this.seed),
        this.client.auth,
        { signal: this.abort.signal },
      );
      if (!this.running) return;
      this.lastSeq = snap.cursor?.seq ?? 0;
      patch(this.seed, (s) => ({
        ...s,
        status: 'ready',
        title: snap.title || s.title,
        items: snap.items,
        cursor: snap.cursor,
        hasMore: snap.has_more,
        activeTurn: null,
        streamingText: '',
      }));
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

  private connectEvents(): void {
    connectSse({
      url: endpointTimelineEvents(this.client.baseUrl, this.seed),
      headers: authHeaders(this.client.auth),
      lastEventId: `0:timeline:${this.lastSeq}`,
      signal: this.abort.signal,
      idleTimeoutMs: 45_000,
      backoffBaseMs: 500,
      backoffMaxMs: 10_000,
      onMessage: (m) => {
        let ev: TimelineItemEvent;
        try {
          ev = JSON.parse(m.data) as TimelineItemEvent;
        } catch {
          return;
        }
        if (!ev || typeof ev.seq !== 'number') return;
        if (ev.seq <= this.lastSeq) return; // 重复
        if (ev.seq > this.lastSeq + 1) {
          // gap → 全量 re-baseline（N6）
          void this.start();
          return;
        }
        this.lastSeq = ev.seq;
        upsertItems(this.seed, [ev.item]);
      },
    });
  }

  /** 向上翻页：before_turn = 当前最旧 turn */
  async loadOlder(limit: number): Promise<void> {
    const s = timelineStore.get()[this.seed];
    if (!s || !s.hasMore || s.loadingOlder || s.items.length === 0) return;
    const oldestTurn = s.items[0].turn;
    patch(this.seed, (x) => ({ ...x, loadingOlder: true }));
    try {
      const page = await getJson<TimelinePage>(
        `${endpointTimeline(this.client.baseUrl, this.seed)}?before_turn=${oldestTurn}&limit=${limit}`,
        this.client.auth,
        { signal: this.abort.signal },
      );
      upsertItems(this.seed, page.items);
      patch(this.seed, (x) => ({ ...x, hasMore: page.has_more, loadingOlder: false }));
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

/** App 监听：timeline 重载事件（错误重试） */
export function listenTimelineReload(): () => void {
  const handler = (e: Event): void => {
    const seed = (e as CustomEvent<string>).detail;
    if (typeof seed === 'string' && controllers.has(seed)) void controllers.get(seed)!.start();
  };
  window.addEventListener('qaqh.timeline.reload', handler);
  return () => window.removeEventListener('qaqh.timeline.reload', handler);
}

// ---------------------------------------------------------------------------
// 会话内命令与流式事件投影
// ---------------------------------------------------------------------------

export function bindTimelineToClient(client: RingingClient): () => void {
  return client.onServerEvent((channel, event, data) => {
    if (channel === 'conversation') {
      const d = data as { seed?: string; turn?: number; delta?: string; text?: string; status?: string; item?: TimelineItem };
      const seed = d?.seed;
      if (!seed) return;
      switch (event) {
        case 'turn.started':
          patch(seed, (s) => ({ ...s, activeTurn: d.turn ?? null, streamingText: '', abortedNote: false }));
          break;
        case 'message.delta':
          patch(seed, (s) => ({
            ...s,
            activeTurn: d.turn ?? s.activeTurn,
            streamingText: s.streamingText + (d.delta ?? ''),
          }));
          break;
        case 'message.finalized':
          // 规范条目由 timeline 流 upsert；此处清空 overlay
          patch(seed, (s) => ({ ...s, streamingText: '' }));
          break;
        case 'turn.finished':
          patch(seed, (s) => ({
            ...s,
            activeTurn: null,
            streamingText: '',
            abortedNote: d.status === 'aborted',
          }));
          break;
        default:
          break;
      }
    }
    if (channel === 'tool') {
      const d = data as { seed?: string; tool_call_id?: string };
      // 工具卡片数据以 timeline 规范条目为准；tool 频道仅驱动运行态指示
      void d;
    }
  });
}

export async function sendUserMessage(
  client: RingingClient,
  seed: string,
  text: string,
  attachments?: import('../protocol/types').ContentRef[],
): Promise<void> {
  patch(seed, (s) => ({ ...s, pendingSend: true }));
  try {
    await client.sendCommand<{ turn: number }>(
      'conversation',
      CONVERSATION_COMMANDS.userSend,
      { text, attachments } satisfies UserSendPayload,
      { seed },
    );
  } finally {
    patch(seed, (s) => ({ ...s, pendingSend: false }));
  }
}

export async function abortActiveTurn(client: RingingClient, seed: string): Promise<void> {
  await client.sendCommand('conversation', CONVERSATION_COMMANDS.turnAbort, {}, { seed });
}

/** 取会话当前是否处于生成中（用于 composer 切换发送/中止） */
export function isTurnActive(state: TimelineState | null): boolean {
  return !!state && (state.activeTurn !== null || state.streamingText.length > 0 || state.pendingSend);
}
