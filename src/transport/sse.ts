/**
 * transport/sse：协议 N2 红线——fetch + ReadableStream 手写流解析。
 * 禁止 EventSource。特性：
 *  - 增量解析：CRLF / LF / CR 行结束、多行 data（\n 连接）、注释行丢弃、retry 字段；
 *  - 跨 chunk UTF-8（TextDecoder stream 模式 + 终结 flush）；
 *  - Last-Event-ID 断点续传（`<epoch>:<channel>:<seq>`）；
 *  - 字节级 idle 判活（服务端 15s keepalive 注释行也计为字节）；
 *  - 退避重连（指数 + 抖动），401/426 终结上抛。
 */
import { SSE_IDLE_TIMEOUT_MS } from '../protocol/types';

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

interface PendingMessage {
  event?: string;
  data: string[];
  id?: string;
  retry?: number;
}

/** 纯解析器：按字节块喂入，产出完整 SSE 消息 */
export class SseParser {
  private decoder = new TextDecoder('utf-8');
  private buf = '';
  private pending: PendingMessage | null = null;
  private lastId: string | undefined;

  /** 喂入一个字节块，返回其间完成的全部消息 */
  feed(chunk: Uint8Array): SseMessage[] {
    return this.feedText(this.decoder.decode(chunk, { stream: true }), false);
  }

  /** 流正常结束时调用：flush 解码器剩余字节、尾随行与未派发的消息 */
  end(): SseMessage[] {
    const tail = this.decoder.decode(); // flush
    const out = this.feedText(tail, true);
    const final = this.dispatch(); // 连接关闭时即使无空行也派发（规范）
    if (final) out.push(final);
    return out;
  }

  feedText(text: string, streamEnded: boolean): SseMessage[] {
    this.buf += text;
    const out: SseMessage[] = [];
    let start = 0;
    for (;;) {
      const found = findLineEnd(this.buf, start);
      if (!found) break;
      const { term, termLen } = found;
      // 行结束符可能被截断在 chunk 边界（CR 在缓冲区末尾，\n 未到）——等下一块
      if (term === this.buf.length - 1 && this.buf[term] === '\r' && !streamEnded) break;
      const line = this.buf.slice(start, term);
      start = term + termLen;
      const msg = this.handleLine(line);
      if (msg) out.push(msg);
    }
    if (streamEnded && start < this.buf.length) {
      // 流关闭时最后一段视为完整行（规范）
      const line = this.buf.slice(start);
      start = this.buf.length;
      const msg = this.handleLine(line);
      if (msg) out.push(msg);
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  private handleLine(line: string): SseMessage | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined; // 注释行（keepalive）：丢弃
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.ensurePending().event = value;
        break;
      case 'data':
        this.ensurePending().data.push(value);
        break;
      case 'id':
        // 规范：id 含 NUL 时忽略
        if (!value.includes('\0')) this.ensurePending().id = value;
        break;
      case 'retry': {
        const ms = Number.parseInt(value, 10);
        if (Number.isFinite(ms) && ms >= 0) this.ensurePending().retry = ms;
        break;
      }
      default:
        break; // 未知字段：忽略（向前兼容）
    }
    return undefined;
  }

  private ensurePending(): PendingMessage {
    return (this.pending ??= { data: [] });
  }

  private dispatch(): SseMessage | undefined {
    const pending = this.pending;
    this.pending = null;
    if (!pending || pending.data.length === 0) return undefined; // 仅注释行 → 不派发
    if (pending.id !== undefined) this.lastId = pending.id;
    return {
      event: pending.event ?? 'message',
      data: pending.data.join('\n'),
      id: pending.id ?? this.lastId,
      retry: pending.retry,
    };
  }
}

function findLineEnd(buf: string, from: number): { term: number; termLen: number } | undefined {
  for (let i = from; i < buf.length; i++) {
    const c = buf[i];
    if (c === '\n') return { term: i, termLen: 1 };
    if (c === '\r') return { term: i, termLen: buf[i + 1] === '\n' ? 2 : 1 };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 连接器
// ---------------------------------------------------------------------------

export type SseErrorKind = 'unauthorized' | 'version' | 'http' | 'network' | 'closed' | 'idle';

export class SseError extends Error {
  constructor(
    public readonly kind: SseErrorKind,
    public readonly status?: number,
    cause?: unknown,
  ) {
    super(`SSE ${kind}${status ? ` (HTTP ${status})` : ''}`, cause ? { cause } : undefined);
    this.name = 'SseError';
  }
}

export type SseStatus = 'connecting' | 'open' | 'reconnecting' | 'stopped';

export interface SseConnectOptions {
  url: string;
  headers: Record<string, string>;
  /** 续传起点（不含时从最新开始） */
  lastEventId?: string;
  signal: AbortSignal;
  /** 字节级判活阈值（N2：按字节计，参考后端 45s） */
  idleTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  onMessage(m: SseMessage): void;
  onBytes?(n: number): void;
  onStatus?(s: SseStatus): void;
  /** 返回 {retry:false} 可终结重连循环（如 401 → 上层重新 open；426 → 展示需更新） */
  onError?(e: SseError): { retry: boolean };
}

export function connectSse(options: SseConnectOptions): void {
  const idleTimeoutMs = options.idleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS;
  const backoffBaseMs = options.backoffBaseMs ?? 500;
  const backoffMaxMs = options.backoffMaxMs ?? 15_000;
  const signal = options.signal;
  let stopped = false;
  let attempt = 0;
  let lastEventId = options.lastEventId;

  void (async () => {
    signal.addEventListener('abort', () => (stopped = true), { once: true });
    while (!stopped && !signal.aborted) {
      // 每轮独立的 controller：idle watchdog / 服务端断流 只中断本轮
      const controller = new AbortController();
      const onOuterAbort = () => controller.abort();
      signal.addEventListener('abort', onOuterAbort, { once: true });
      try {
        options.onStatus?.(attempt === 0 ? 'connecting' : 'reconnecting');
        const headers: Record<string, string> = { ...options.headers, Accept: 'text/event-stream' };
        if (lastEventId) headers['Last-Event-ID'] = lastEventId;
        const res = await fetch(options.url, { headers, signal: controller.signal });
        if (res.status === 401) throw new SseError('unauthorized', 401);
        if (res.status === 426) throw new SseError('version', 426);
        if (!res.ok) throw new SseError('http', res.status);
        const contentType = res.headers.get('content-type') ?? '';
        if (!contentType.includes('text/event-stream')) throw new SseError('http', res.status);
        const body = res.body;
        if (!body) throw new SseError('network');

        options.onStatus?.('open');
        attempt = 0;
        const parser = new SseParser();
        let lastByteAt = performance.now();
        const watchdog = setInterval(() => {
          if (performance.now() - lastByteAt > idleTimeoutMs) {
            controller.abort(new SseError('idle'));
          }
        }, Math.min(1000, Math.max(50, idleTimeoutMs / 10)));
        try {
          const reader = body.getReader();
          for (;;) {
            // readWithAbort：不依赖运行时对 abort 的 read() 即时唤醒
            const { done, value } = await readWithAbort(reader, controller);
            if (done) break;
            if (value && value.byteLength > 0) {
              lastByteAt = performance.now();
              options.onBytes?.(value.byteLength);
              for (const m of parser.feed(value)) {
                if (m.id) lastEventId = m.id;
                options.onMessage(m);
              }
            }
          }
          for (const m of parser.end()) {
            if (m.id) lastEventId = m.id;
            options.onMessage(m);
          }
          throw new SseError('closed'); // 服务端干净关闭 → 仍需续传重连
        } finally {
          clearInterval(watchdog);
        }
      } catch (err) {
        if (stopped || signal.aborted) {
          options.onStatus?.('stopped');
          return;
        }
        const e = normalizeError(err, controller);
        const decision = options.onError?.(e) ?? { retry: true };
        if (e.kind === 'unauthorized' || e.kind === 'version') decision.retry = false;
        if (!decision.retry || stopped || signal.aborted) {
          options.onStatus?.('stopped');
          if (e.kind === 'unauthorized' || e.kind === 'version') options.onError?.(e);
          return;
        }
      } finally {
        signal.removeEventListener('abort', onOuterAbort);
      }
      attempt += 1;
      const backoff = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.min(attempt, 10));
      try {
        await sleep(backoff * (0.5 + Math.random() * 0.5), signal);
      } catch {
        break; // 外层 signal 中止
      }
    }
    options.onStatus?.('stopped');
  })();
}

type ReadResult<T> = Awaited<ReturnType<ReadableStreamDefaultReader<T>['read']>>;

/** reader.read() 与 controller 中止的竞速：abort 时必定及时返回 */
async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
): Promise<ReadResult<Uint8Array>> {
  return await new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      const reason = controller.signal.reason;
      reject(reason instanceof SseError ? reason : new SseError('closed'));
    };
    const cleanup = () => controller.signal.removeEventListener('abort', onAbort);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (r) => {
        cleanup();
        resolve(r);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}

function normalizeError(err: unknown, controller: AbortController): SseError {
  if (err instanceof SseError) return err;
  if (err instanceof DOMException && err.name === 'AbortError') {
    const reason = controller.signal.reason;
    if (reason instanceof SseError) return reason;
    return new SseError('closed');
  }
  return new SseError('network', undefined, err);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
