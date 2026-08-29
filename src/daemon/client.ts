/**
 * RingingClient（PLAN M2）：open → READY(leased) → 续租循环 → epoch 重建。
 * 状态机：OPENING → READY(leased) → ATTACHED；连续续租失败 → 重新 OPEN；
 * server_epoch 变化 / ringing.reset_required → 全频道重置重放 + 重挂载当前会话。
 */
import { createStore, type Store } from '../state/store';
import {
  RINGING_SCHEMA,
  RINGING_VERSION,
  lastEventIdHeader,
  CHANNELS,
  type Channel,
  type CommandEnvelope,
  type CommandAck,
  type ContentRef,
  type OpenResponse,
  type RenewResponse,
} from '../protocol/types';
import {
  endpointOpen,
  endpointRenew,
  endpointEvents,
  endpointCommands,
  endpointContent,
  endpointService,
} from '../protocol/endpoints';
import { postJson, authHeaders, HttpError, type AuthHeaders } from '../transport/http';
import { connectSse, type SseMessage, type SseStatus } from '../transport/sse';

export const RENEW_MAX_FAILURES = 3;

export type ConnectionState =
  | 'idle'
  | 'opening'
  | 'ready'
  | 'attached'
  | 'reopening'
  | 'needs_update'
  | 'unauthorized';

export interface ChannelDiag {
  status: SseStatus;
  lastSeq: number;
  lastByteAt: number;
  reconnects: number;
}

export interface ClientSnapshot {
  state: ConnectionState;
  epoch: number;
  sessionId: string | null;
  leaseTtlMs: number | null;
  renewIntervalMs: number | null;
  lastError: string | null;
  channels: Record<Channel, ChannelDiag>;
}

export type ServerEventListener = (
  channel: Channel,
  event: string,
  data: unknown,
  msg: SseMessage,
) => void;

export class UnsupportedVersionError extends Error {
  constructor() {
    super('协议代差：客户端需要更新');
    this.name = 'UnsupportedVersionError';
  }
}

function parseSeqFromId(id: string): { epoch: number; seq: number } | null {
  const parts = id.split(':');
  if (parts.length !== 3) return null;
  const epoch = Number.parseInt(parts[0], 10);
  const seq = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(epoch) || !Number.isFinite(seq)) return null;
  return { epoch, seq };
}

export class RingingClient {
  /** 实例 id：同一浏览器标签页生命周期内稳定（幂等键的一半） */
  readonly instanceId: string = crypto.randomUUID();

  readonly store: Store<ClientSnapshot>;

  private readonly base: string;
  private token: string;
  private sessionId: string | null = null;
  private epoch = 0;
  private leaseTtlMs: number | null = null;
  private renewIntervalMs = 10_000;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private renewFailures = 0;
  private readonly lifecycle = new AbortController(); // close() 全生命周期
  private readonly channelControllers = new Map<Channel, AbortController>();
  private readonly listeners = new Set<ServerEventListener>();
  private readonly reattachCallbacks = new Set<() => void>();
  private currentSeed: string | null = null;
  private reopenQueued = false;

  private channels: Record<Channel, ChannelDiag> = {
    control: { status: 'stopped', lastSeq: 0, lastByteAt: 0, reconnects: 0 },
    conversation: { status: 'stopped', lastSeq: 0, lastByteAt: 0, reconnects: 0 },
    tool: { status: 'stopped', lastSeq: 0, lastByteAt: 0, reconnects: 0 },
  };

  constructor(bridge: { token: string; base_url?: string }) {
    this.token = bridge.token;
    this.base = bridge.base_url ?? '';
    this.store = createStore<ClientSnapshot>(this.snapshot('idle'));
  }

  // -------------------------------------------------------------------------
  // 快照
  // -------------------------------------------------------------------------

  private snapshot(state: ConnectionState): ClientSnapshot {
    return {
      state,
      epoch: this.epoch,
      sessionId: this.sessionId,
      leaseTtlMs: this.leaseTtlMs,
      renewIntervalMs: this.renewIntervalMs,
      lastError: null,
      channels: { ...this.channels },
    };
  }

  private setState(state: ConnectionState, lastError?: string): void {
    this.store.set({ ...this.snapshot(state), lastError: lastError ?? null });
  }

  private pushChannels(): void {
    const snap = this.store.get();
    this.store.set({ ...snap, channels: { ...this.channels } });
  }

  get auth(): AuthHeaders {
    return { token: this.token, clientSessionId: this.sessionId };
  }

  get baseUrl(): string {
    return this.base;
  }

  get activeSeed(): string | null {
    return this.currentSeed;
  }

  get isReady(): boolean {
    const s = this.store.get().state;
    return s === 'ready' || s === 'attached';
  }

  // -------------------------------------------------------------------------
  // 事件订阅
  // -------------------------------------------------------------------------

  onServerEvent(listener: ServerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** epoch 重建完成后回调（重新 bootstrap + 重挂 timeline 流） */
  onReattach(cb: () => void): () => void {
    this.reattachCallbacks.add(cb);
    return () => this.reattachCallbacks.delete(cb);
  }

  setCurrentSeed(seed: string | null): void {
    this.currentSeed = seed;
    if (seed && this.store.get().state === 'ready') this.setState('attached');
  }

  // -------------------------------------------------------------------------
  // open / 续租 / 重建
  // -------------------------------------------------------------------------

  async open(): Promise<void> {
    this.setState('opening');
    try {
      const res = await postJson<OpenResponse>(
        endpointOpen(this.base),
        { schema: RINGING_SCHEMA, version: RINGING_VERSION, client_instance_id: this.instanceId },
        { token: this.token, clientSessionId: null },
        { timeoutMs: 10_000, signal: this.lifecycle.signal },
      );
      if (!res.accepted) throw new UnsupportedVersionError();
      this.sessionId = res.client_session_id;
      this.epoch = res.server_epoch;
      this.leaseTtlMs = res.lease_ttl_ms;
      this.renewIntervalMs = res.renew_interval_ms;
      // epoch 变化 → 全频道序号重置重放（§2.9）
      for (const c of CHANNELS) this.channels[c] = { status: 'stopped', lastSeq: 0, lastByteAt: performance.now(), reconnects: 0 };
      this.setState('ready');
      this.startChannels();
      this.scheduleRenew(res.renew_interval_ms);
      if (this.currentSeed) {
        for (const cb of this.reattachCallbacks) cb();
      }
    } catch (err) {
      if (err instanceof UnsupportedVersionError) {
        this.setState('needs_update', '协议代差：客户端需要更新');
        throw err;
      }
      if (err instanceof HttpError && err.status === 401) {
        this.setState('unauthorized', '鉴权失败：桥 token 无效或已过期');
        throw err;
      }
      this.setState('idle', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private startChannels(): void {
    for (const channel of CHANNELS) {
      const controller = new AbortController();
      this.channelControllers.set(channel, controller);
      connectSse({
        url: endpointEvents(this.base, channel),
        headers: authHeaders(this.auth),
        lastEventId: lastEventIdHeader(this.epoch, channel, this.channels[channel].lastSeq),
        signal: controller.signal,
        onMessage: (m) => this.handleChannelMessage(channel, m),
        onBytes: () => {
          this.channels[channel].lastByteAt = performance.now();
        },
        onStatus: (s) => {
          this.channels[channel].status = s;
          this.pushChannels();
        },
        onError: (e) => {
          this.channels[channel].reconnects += 1;
          if (e.kind === 'unauthorized') {
            void this.rebuild('鉴权失效');
            return { retry: false };
          }
          if (e.kind === 'version') {
            this.setState('needs_update', '协议代差：客户端需要更新');
            return { retry: false };
          }
          return { retry: true };
        },
      });
    }
  }

  private handleChannelMessage(channel: Channel, msg: SseMessage): void {
    if (msg.id) {
      const parsed = parseSeqFromId(msg.id);
      if (parsed && parsed.epoch === this.epoch) this.channels[channel].lastSeq = parsed.seq;
    }
    let data: unknown = msg.data;
    try {
      data = JSON.parse(msg.data);
    } catch {
      // 非 JSON data：原样传递
    }
    if (channel === 'control' && msg.event === 'ringing.reset_required') {
      void this.rebuild('reset_required');
      return;
    }
    for (const l of this.listeners) l(channel, msg.event, data, msg);
  }

  private scheduleRenew(intervalMs: number): void {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.renewTimer = setTimeout(() => void this.renew(), Math.max(1000, intervalMs));
  }

  private async renew(): Promise<void> {
    if (this.lifecycle.signal.aborted || !this.sessionId) return;
    try {
      const res = await postJson<RenewResponse>(
        endpointRenew(this.base),
        {},
        this.auth,
        { timeoutMs: 8_000 },
      );
      if (!res.accepted) throw new HttpError(401, 'unauthorized', '租约被拒绝');
      this.renewFailures = 0;
      this.scheduleRenew(res.renew_interval_ms ?? this.renewIntervalMs);
    } catch (err) {
      if (this.lifecycle.signal.aborted) return;
      this.renewFailures += 1;
      if (err instanceof HttpError && (err.status === 401 || err.status === 426)) {
        void this.rebuild(err.status === 426 ? '协议代差' : '鉴权失效');
        return;
      }
      if (this.renewFailures >= RENEW_MAX_FAILURES) {
        void this.rebuild('续租连续失败');
        return;
      }
      this.scheduleRenew(Math.min(this.renewIntervalMs, 3_000));
    }
  }

  /** 重新 OPEN：中止全部频道与续租，重建后重放（currentSeed 自动重挂） */
  async rebuild(reason: string): Promise<void> {
    if (this.reopenQueued) return;
    this.reopenQueued = true;
    try {
      this.setState('reopening', reason);
      this.teardownStreams();
      await new Promise((r) => setTimeout(r, 300)); // 避免紧密循环
      await this.open();
    } catch {
      // open 失败已落状态；退避后重试
      setTimeout(() => {
        this.reopenQueued = false;
        void this.rebuild(reason);
      }, 2000);
      return;
    }
    this.reopenQueued = false;
  }

  private teardownStreams(): void {
    if (this.renewTimer) {
      clearTimeout(this.renewTimer);
      this.renewTimer = null;
    }
    // 逐频道中止当前连接，避免重建后出现双份流
    for (const [, controller] of this.channelControllers) controller.abort();
    this.channelControllers.clear();
    for (const c of CHANNELS) {
      this.channels[c] = { ...this.channels[c], status: 'stopped' };
    }
  }

  close(): void {
    this.lifecycle.abort();
    this.teardownStreams();
    this.setState('idle');
  }

  // -------------------------------------------------------------------------
  // 命令面 / 服务面 / 附件
  // -------------------------------------------------------------------------

  async sendCommand<R = unknown>(
    channel: Channel,
    type: string,
    payload: unknown,
    opts?: { seed?: string; expectedRevision?: number; timeoutMs?: number },
  ): Promise<CommandAck<R>> {
    if (!this.sessionId) throw new Error('未建立客户端会话');
    const envelope: CommandEnvelope = {
      command_id: crypto.randomUUID(),
      client_instance_id: this.instanceId,
      client_session_id: this.sessionId,
      seed: opts?.seed,
      expected_revision: opts?.expectedRevision,
      type,
      payload,
    };
    return postJson<CommandAck<R>>(
      endpointCommands(this.base, channel),
      envelope,
      this.auth,
      { timeoutMs: opts?.timeoutMs ?? 10_000 },
    );
  }

  /** 服务面调用（typed 方法名由调用方从 protocol/methods 传入） */
  async service<R = unknown>(method: string, payload?: Record<string, unknown>): Promise<R> {
    return postJson<R>(endpointService(this.base, method), payload ?? {}, this.auth);
  }

  async uploadContent(file: File, signal?: AbortSignal): Promise<ContentRef> {
    const form = new FormData();
    form.append('file', file, file.name);
    const res = await fetch(endpointContent(this.base), {
      method: 'POST',
      headers: authHeaders(this.auth),
      body: form,
      signal,
    });
    if (!res.ok) throw new HttpError(res.status, undefined);
    return (await res.json()) as ContentRef;
  }
}
