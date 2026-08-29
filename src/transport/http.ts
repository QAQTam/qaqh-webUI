/**
 * transport/http：双头注入（Authorization + X-QAQH-Client-Session-Id）+ 401 拦截 + 超时。
 * token 仅内存持有（N3）：由 daemon/bridge 注入，禁止进 URL/query/日志/storage。
 */
import type { ServiceErrorCode, ServiceErrorBody } from '../protocol/types';

export interface AuthHeaders {
  /** Bearer token（来自 __QAQH_DEBUG__，内存持有） */
  token: string | null;
  /** open 握手完成后才有 */
  clientSessionId: string | null;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ServiceErrorCode | undefined,
    message?: string,
  ) {
    // 注意：message 不携带任何请求头内容（N3 禁止 token 进日志）
    super(message ?? `HTTP ${status}${code ? ` (${code})` : ''}`);
    this.name = 'HttpError';
  }
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`请求超时（${ms}ms）`);
    this.name = 'TimeoutError';
  }
}

export const DEFAULT_TIMEOUT_MS = 15_000;

/** 组装双头；clientSessionId 仅在会话建立后存在 */
export function authHeaders(auth: AuthHeaders, extra?: HeadersInit): Record<string, string> {
  const headers: Record<string, string> = { ...(extra as Record<string, string> | undefined) };
  if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
  if (auth.clientSessionId) headers['X-QAQH-Client-Session-Id'] = auth.clientSessionId;
  return headers;
}

export interface RequestOptions extends Omit<RequestInit, 'headers' | 'signal'> {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function ringingFetch(
  url: string,
  options: RequestOptions,
  auth: AuthHeaders,
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, headers, ...rest } = options;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: authHeaders(auth, headers),
      signal: combined,
    });
  } catch (err) {
    if (timeoutSignal.aborted) throw new TimeoutError(timeoutMs);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw err;
  }
  if (res.ok) return res;
  await res.body?.cancel().catch(() => undefined);
  throw await toHttpError(res);
}

async function toHttpError(res: Response): Promise<HttpError> {
  let code: ServiceErrorCode | undefined;
  let message: string | undefined;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      const body = (await res.json()) as Partial<ServiceErrorBody>;
      code = body.error;
      message = body.message;
    } catch {
      // 错误体非 JSON：仅用状态码
    }
  }
  return new HttpError(res.status, code, message);
}

export async function postJson<T>(url: string, body: unknown, auth: AuthHeaders, options?: RequestOptions): Promise<T> {
  const res = await ringingFetch(
    url,
    {
      ...options,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: JSON.stringify(body),
    },
    auth,
  );
  return (await res.json()) as T;
}

export async function getJson<T>(url: string, auth: AuthHeaders, options?: RequestOptions): Promise<T> {
  const res = await ringingFetch(url, { ...options, method: 'GET' }, auth);
  return (await res.json()) as T;
}
