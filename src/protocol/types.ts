/**
 * qaqh.Ringing 协议类型镜像。
 *
 * 单一来源纪律（PLAN §4）：本文件为 `qaqh-ringing` 的手工镜像，
 * **改动须对照后端 PR**；事件变体按需增量镜像，不一次性搬全。
 * 全部协议字面量只能从这里 import，禁止散落。
 */

export const RINGING_SCHEMA = 'qaqh.Ringing' as const;
export const RINGING_VERSION = 1 as const;

export type Uuid = string;

// ---------------------------------------------------------------------------
// 握手（§2.1）
// ---------------------------------------------------------------------------

export interface OpenRequest {
  schema: typeof RINGING_SCHEMA;
  version: typeof RINGING_VERSION;
  client_instance_id: Uuid;
}

export interface OpenAccepted {
  accepted: true;
  client_session_id: Uuid;
  server_epoch: number;
  lease_ttl_ms: number;
  renew_interval_ms: number;
}

/** 代差拒绝 → HTTP 426，客户端展示"需更新"并停止重试 */
export interface OpenRejected {
  accepted: false;
  reason: 'unsupported_version';
  schema: string;
  version: number;
  min_version?: number;
  max_version?: number;
}

export type OpenResponse = OpenAccepted | OpenRejected;

export interface RenewResponse {
  accepted: boolean;
  lease_ttl_ms?: number;
  renew_interval_ms?: number;
}

// ---------------------------------------------------------------------------
// 频道与命令信封（§2.3 / §2.4）
// ---------------------------------------------------------------------------

export type Channel = 'control' | 'conversation' | 'tool';
export const CHANNELS: readonly Channel[] = ['control', 'conversation', 'tool'] as const;

/**
 * 命令信封：command_id 为幂等键（uuid-v4）。
 * 会话生命周期命令只走 commands 面（N5），服务面没有 session.new/resume。
 */
export interface CommandEnvelope<T extends string = string, P = unknown> {
  command_id: Uuid;
  client_instance_id: Uuid;
  client_session_id: Uuid;
  /** 会话域命令必带 */
  seed?: string;
  expected_revision?: number;
  /** TODO(对照后端 qaqh-ringing)：命令名字段名以后端实际定义为准 */
  type: T;
  payload: P;
}

export interface CommandAck<R = unknown> {
  accepted: boolean;
  command_id: Uuid;
  result?: R;
}

// ---------------------------------------------------------------------------
// SSE 事件通用信封（§2.3）
// ---------------------------------------------------------------------------

/** `Last-Event-ID: <epoch>:<channel>:<seq>` */
export function lastEventIdHeader(epoch: number, channel: string, seq: number): string {
  return `${epoch}:${channel}:${seq}`;
}

/** 服务端每 15s 注释行 keepalive；客户端判活按字节计（阈值参考后端 45s） */
export const KEEPALIVE_INTERVAL_MS = 15_000;
/** 字节级 idle 判活阈值（PLAN：参考后端 45s 阈值） */
export const SSE_IDLE_TIMEOUT_MS = 45_000;

export interface SseEventBase {
  /** 频道内严格 +1 的序号（timeline 流亦然；gap → 全量 re-baseline） */
  seq: number;
  epoch: number;
}

// ---------------------------------------------------------------------------
// 附件（§2.7）
// ---------------------------------------------------------------------------

export interface ContentRef {
  content_id: string;
  sha256: string;
  media_type: string;
}

// ---------------------------------------------------------------------------
// timeline（§2.5，唯一历史真源 N6）
// ---------------------------------------------------------------------------

/**
 * timeline 规范条目：bootstrap / 分页 / timeline SSE 三条路径共享同一形态，
 * 客户端投影 = 按 seq upsert。
 * TODO(对照后端 qaqh-ringing)：字段名以后端实际定义为准。
 */
export type TimelineItem = MessageItem | ToolItem;

export interface MessageItem {
  kind: 'message';
  seq: number;
  turn: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
  attachments?: ContentRef[];
  created_at: string;
}

export type ToolStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ToolItem {
  kind: 'tool';
  seq: number;
  turn: number;
  tool_call_id: string;
  name: string;
  args?: unknown;
  status: ToolStatus;
  output?: string;
  error?: string;
  started_at?: string;
  finished_at?: string;
}

export interface TimelineItemEvent extends SseEventBase {
  item: TimelineItem;
}

export interface BootstrapResponse {
  seed: string;
  title: string;
  items: TimelineItem[];
  cursor: { epoch: number; seq: number };
  has_more: boolean;
}

export interface TimelinePage {
  items: TimelineItem[];
  cursor: { epoch: number; seq: number };
  has_more: boolean;
}

// ---------------------------------------------------------------------------
// 会话 / 服务面（§2.6）
// ---------------------------------------------------------------------------

export interface SessionSummary {
  seed: string;
  title: string;
  created_at: string;
  updated_at: string;
  turn_count?: number;
  status?: 'active' | 'running' | 'archived';
}

// ---------------------------------------------------------------------------
// 错误码（§2.6：Read→query_failed、Write→action_failed、未知→404 unknown_method）
// ---------------------------------------------------------------------------

export type ServiceErrorCode =
  | 'query_failed'
  | 'action_failed'
  | 'unknown_method'
  | 'unauthorized'
  | 'unsupported_version'
  | 'invalid_request';

export interface ServiceErrorBody {
  error: ServiceErrorCode;
  message?: string;
}
