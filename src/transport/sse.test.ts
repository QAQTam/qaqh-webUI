/**
 * M1 单测（PLAN 验收）：多行 data / CRLF / 跨 chunk UTF-8 / 注释行丢弃 / 断线续传。
 * 运行：bun test
 */
import { describe, expect, test } from 'bun:test';
import { SseParser, connectSse, SseError } from './sse';

const enc = new TextEncoder();

function feedAll(p: SseParser, s: string) {
  return p.feed(enc.encode(s));
}

describe('SseParser', () => {
  test('基本 event/data/id 解析', () => {
    const p = new SseParser();
    const msgs = feedAll(p, 'event: turn.started\ndata: {"a":1}\nid: 1:control:7\n\n');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].event).toBe('turn.started');
    expect(msgs[0].data).toBe('{"a":1}');
    expect(msgs[0].id).toBe('1:control:7');
  });

  test('多行 data 以 \\n 连接；空 data 行产出空行（W3C 规范）', () => {
    const p = new SseParser();
    const msgs = feedAll(p, 'data: first\ndata: second\ndata:\ndata: third\n\n');
    expect(msgs).toHaveLength(1);
    // 规范：每行 data 追加 value+'\n'，派发时去掉最后一个 '\n'
    expect(msgs[0].data).toBe('first\nsecond\n\nthird');
  });

  test('CRLF / LF / CR 行结束混用（流关闭时末尾 CR 触发派发）', () => {
    const p = new SseParser();
    expect(feedAll(p, 'data: a\r\ndata: b\ndata: c\r\r')).toHaveLength(0); // 末尾 \r 需等待
    const msgs = p.end();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data).toBe('a\nb\nc');
  });

  test('CRLF 被 chunk 边界截断时不误派发空行', () => {
    const p = new SseParser();
    let msgs = p.feed(enc.encode('data: x\r'));
    expect(msgs).toHaveLength(0); // \r 后是否 \n 未知，必须等待
    msgs = p.feed(enc.encode('\n\n'));
    expect(msgs).toHaveLength(1); // 第一个 \n 补全 CRLF，第二个 \n 为空行 → 派发
    expect(msgs[0].data).toBe('x');
    const rest = feedAll(p, 'data: y\n\n');
    expect(rest).toHaveLength(1);
    expect(rest[0].data).toBe('y');
  });

  test('注释行（keepalive）被丢弃且不派发', () => {
    const p = new SseParser();
    const msgs = feedAll(p, ': keepalive\n:\n\n');
    expect(msgs).toHaveLength(0);
  });

  test('跨 chunk UTF-8：多字节字符被正确拼接', () => {
    const p = new SseParser();
    // "你好，世界" 每字 3 字节，逐字节切开
    const full = enc.encode('data: 你好，世界 🌏\n\n');
    let msgs: ReturnType<SseParser['feed']> = [];
    for (let i = 0; i < full.length; i++) {
      msgs = msgs.concat(p.feed(full.subarray(i, i + 1)));
    }
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data).toBe('你好，世界 🌏');
  });

  test('跨 chunk 的字段名/值拼接', () => {
    const p = new SseParser();
    let msgs = p.feed(enc.encode('even'));
    msgs = msgs.concat(p.feed(enc.encode('t: hi')));
    msgs = msgs.concat(p.feed(enc.encode('\ndata: 4')));
    msgs = msgs.concat(p.feed(enc.encode('2\n\n')));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].event).toBe('hi');
    expect(msgs[0].data).toBe('42');
  });

  test('默认 event 为 message；retry 被解析', () => {
    const p = new SseParser();
    const msgs = feedAll(p, 'retry: 2500\ndata: hi\n\n');
    expect(msgs[0].event).toBe('message');
    expect(msgs[0].retry).toBe(2500);
  });

  test('end() 派发未以空行结尾的尾随消息', () => {
    const p = new SseParser();
    let msgs = feedAll(p, 'data: tail');
    expect(msgs).toHaveLength(0);
    msgs = p.end();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data).toBe('tail');
  });

  test('无 data 行时不派发（仅有 event）', () => {
    const p = new SseParser();
    const msgs = feedAll(p, 'event: noop\n\n');
    expect(msgs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 连接器：Last-Event-ID 续传 + idle 判活重连
// ---------------------------------------------------------------------------

function sseResponse(chunks: (string | Uint8Array)[], opts?: { delayMs?: number }): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('connectSse', () => {
  test('Last-Event-ID 断点续传：重连时携带最后 id', async () => {
    const seenIds: (string | undefined)[] = [];
    let call = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init?: RequestInit) => {
      seenIds.push(init?.headers && (init.headers as Record<string, string>)['Last-Event-ID']);
      call += 1;
      if (call === 1) {
        return sseResponse(['event: a\ndata: 1\nid: 1:conversation:5\n\n'], { delayMs: 5 });
      }
      return sseResponse(['event: b\ndata: 2\nid: 1:conversation:6\n\n'], { delayMs: 5 });
    }) as typeof fetch;

    try {
      const controller = new AbortController();
      const messages: string[] = [];
      connectSse({
        url: 'http://mock/ringing/v1/events/conversation',
        headers: {},
        signal: controller.signal,
        backoffBaseMs: 5,
        backoffMaxMs: 10,
        onMessage: (m) => {
          messages.push(`${m.event}:${m.data}`);
          if (m.data === '2') controller.abort(); // 收到续传消息即停，避免无限重连
        },
      });
      await new Promise((r) => setTimeout(r, 120));
      controller.abort();
      expect(messages).toEqual(['a:1', 'b:2']);
      expect(seenIds[0]).toBeUndefined();
      expect(seenIds[1]).toBe('1:conversation:5'); // 断线重连自动续传
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('字节级 idle 判活：无字节超时 → 重连', async () => {
    let call = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        // 永不输出字节的流
        return new Response(
          new ReadableStream<Uint8Array>({ start() {} }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      return sseResponse(['data: revived\n\n'], { delayMs: 5 });
    }) as typeof fetch;

    try {
      const controller = new AbortController();
      const messages: string[] = [];
      let statusSeen = '';
      connectSse({
        url: 'http://mock/x',
        headers: {},
        signal: controller.signal,
        idleTimeoutMs: 80,
        backoffBaseMs: 5,
        backoffMaxMs: 10,
        onMessage: (m) => messages.push(m.data),
        onStatus: (s) => (statusSeen = s),
      });
      await new Promise((r) => setTimeout(r, 400));
      controller.abort();
      expect(call).toBeGreaterThanOrEqual(2);
      expect(messages).toContain('revived');
      expect(['open', 'reconnecting', 'connecting']).toContain(statusSeen);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('426 → 终结不重连（代差：需更新）', async () => {
    let call = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      call += 1;
      return new Response('{"error":"unsupported_version"}', { status: 426 });
    }) as typeof fetch;
    try {
      const controller = new AbortController();
      let terminal: SseError | undefined;
      connectSse({
        url: 'http://mock/x',
        headers: {},
        signal: controller.signal,
        backoffBaseMs: 5,
        onMessage: () => undefined,
        onError: (e) => {
          terminal = e;
          return { retry: false };
        },
      });
      await new Promise((r) => setTimeout(r, 80));
      controller.abort();
      expect(call).toBe(1);
      expect(terminal?.kind).toBe('version');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
