/**
 * qaqh.Ringing 协议类型镜像。
 *
 * 单一来源纪律（PLAN §4）：本文件为 `qaqh-ringing` + `qaqh-domain` 的手工镜像，
 * **改动须对照后端 PR**；事件变体按需增量镜像，不一次性搬全。
 * 全部协议字面量只能从这里 import，禁止散落。
 *
 * 镜像依据（2026-08-30 对 F:\QAQ-Harness 实测取证）：
 * - crates/qaqh-ringing/src/{capability,envelope,snapshot,reset}.rs
 * - crates/qaqh-domain/src/{command,event,timeline}.rs
 * - crates/qaqh-daemon/src/axum_server.rs（SSE 发射 = 逐信封，非 batch）
 * - crates/qaqh-config-api/src/lib.rs（ConfigPatch，camelCase merge patch）
 */

export const RINGING_SCHEMA = 'qaqh.Ringing' as const;
export const RINGING_VERSION = 1 as const;

export type Uuid = string;

// ---------------------------------------------------------------------------
// 握手（capability.rs：ClientOpenRequest / ClientOpenResponse）
// ---------------------------------------------------------------------------

export interface OpenRequest {
  schema: typeof RINGING_SCHEMA;
  version: typeof RINGING_VERSION;
  client_instance_id: Uuid;
}

export interface OpenAccepted {
  schema: typeof RINGING_SCHEMA;
  version: number;
  accepted: true;
  client_session_id: string;
  /** 服务端 epoch（64 位 hex 字符串，SSE cursor 基准） */
  server_epoch: string;
  lease_ttl_ms: number;
  renew_interval_ms: number;
}

/** 代差拒绝 → HTTP 426，载荷为 rejected ack（code=unsupported_version） */
export interface OpenRejected {
  command_id: string;
  status: 'rejected';
  code: 'unsupported_version';
  message?: string;
  retry_after_ms?: number;
}

export type OpenResponse = OpenAccepted | OpenRejected;

/** POST /ringing/v1/leases/renew → { ok: true, lease_ttl_ms, renew_interval_ms } */
export interface RenewResponse {
  ok: boolean;
  lease_ttl_ms: number;
  renew_interval_ms: number;
}

// ---------------------------------------------------------------------------
// 频道（qaqh-domain/src/channel.rs）
// ---------------------------------------------------------------------------

export type Channel = 'control' | 'conversation' | 'tool';
export const CHANNELS: readonly Channel[] = ['control', 'conversation', 'tool'] as const;

// ---------------------------------------------------------------------------
// 命令信封（envelope.rs：RingingCommandEnvelope）与 ack
// ---------------------------------------------------------------------------

/**
 * 命令信封：外层 channel tag + 内层 command{channel,type} 双层判别。
 * 线上形状：
 * { schema, version, channel, command_id, client_instance_id,
 *   client_session_id, seed?, expected_revision?,
 *   command: { channel: <同 path>, type: "<snake_case 命令名>", ...参数 } }
 *
 * 本地校验（envelope.validate，不过则不发）：
 * - 除 session_create 外信封级必须带 seed（session_resume 亦然）
 * - command.channel === envelope.channel === path channel
 * - command_id / client_instance_id / client_session_id 非空
 */
export interface CommandEnvelope {
  schema: typeof RINGING_SCHEMA;
  version: typeof RINGING_VERSION;
  channel: Channel;
  /** 幂等键：uuid-v4；同一逻辑命令重试必须复用同一 id */
  command_id: Uuid;
  client_instance_id: Uuid;
  client_session_id: string;
  /** 除 session_create 外必带（daemon 401 missing_seed 拒绝） */
  seed?: string;
  expected_revision?: number;
  command: { channel: Channel; type: string } & Record<string, unknown>;
}

/** 命令确认：accepted 仅代表进入正确 actor，业务终态以事件为准 */
export interface CommandAck {
  command_id: Uuid;
  status: 'accepted' | 'rejected';
  code?: string;
  message?: string;
  retry_after_ms?: number;
}

/** GET /ringing/v1/commands/{command_id} 收据（ack 丢失/断线后查终态） */
export interface CommandStatus {
  command_id: Uuid;
  state: 'accepted' | 'running' | 'succeeded' | 'failed' | 'rejected';
  payload_fingerprint: string;
  terminal_event_id?: string;
  error_code?: string;
}

// ---------------------------------------------------------------------------
// 事件信封（envelope.rs：RingingEventEnvelope）与 SSE 帧
// ---------------------------------------------------------------------------

/** delivery 等级：reliable=追加/幂等应用，replaceable=覆盖合并 */
export type Delivery = 'reliable' | 'replaceable';

/**
 * daemon axum SSE 发射（axum_server.rs envelope_to_event，实测确认）：
 * - `event:` = 内层事件 type（snake_case，如 turn_started）
 * - `id:`    = `<epoch>:<channel>:<stream_seq>`
 * - `data:`  = 本信封完整 JSON（逐信封，非 batch）
 */
export interface EventEnvelope<E = DomainEvent> {
  delivery: Delivery;
  seed: string;
  /** 每 (server_epoch, channel) 全局递增，SSE 断点续传基准 */
  stream_seq: number;
  /** 每 (seed, channel) 递增，领域状态乱序检测 */
  channel_seq: number;
  /** 每 session/channel 因果序（legacy 语义保留） */
  session_seq: number;
  /** 事件唯一 id：同 id 至少一次投递但只应用一次（幂等） */
  event_id: string;
  causation_id?: string;
  correlation_id?: string;
  state_revision?: number;
  /** unix 毫秒 */
  server_ts?: number;
  event: E;
}

/** timeline 频道 SSE 帧 data（timeline_entry_to_event） */
export interface TimelineEventFrame {
  schema: typeof RINGING_SCHEMA;
  version: number;
  server_epoch: string;
  seed: string;
  entry: TimelineEntry;
}

/** ringing.reset_required（SSE 恢复指令，非领域事件） */
export interface ResetRequired {
  channel: Channel;
  seed: string;
  earliest_available_seq: number;
}

// ---------------------------------------------------------------------------
// 领域事件（qaqh-domain/src/event.rs，按需增量镜像）
// ---------------------------------------------------------------------------

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens: number;
  prompt_cache_miss_tokens: number;
  reasoning_tokens: number;
  cache_usage_reported?: boolean;
}

export type DomainError = {
  code?: string;
  message?: string;
} & Record<string, unknown>;

export type ConversationEvent =
  | { type: 'turn_started'; turn_id: string; user_text: string }
  | { type: 'turn_completed'; turn_id: string; stop_reason?: string; usage?: UsageInfo }
  | { type: 'turn_failed'; turn_id: string; error: DomainError }
  | {
      type: 'round_delta';
      turn_id: string;
      round_num: number;
      kind: 'reasoning' | 'text';
      delta: string;
    }
  | {
      type: 'block_checkpoint';
      turn_id: string;
      round_num: number;
      kind: 'reasoning' | 'text';
      text: string;
      char_count: number;
    }
  | {
      type: 'round_completed';
      turn_id: string;
      round_num: number;
      thinking?: string;
      answer?: string;
      output_ref?: ContentRef;
      is_final: boolean;
    }
  | {
      type: 'provider_retrying';
      turn_id: string;
      round_num: number;
      attempt: number;
      max_retries: number;
      delay_secs: number;
      error_message: string;
    }
  | {
      type: 'usage_updated';
      turn_id: string;
      round_num: number;
      usage: UsageInfo;
      context_limit: number;
      model: string;
    }
  | { type: 'conversation_cancelled'; turn_id?: string };

export type ToolLifecycleState = 'prepared' | 'running' | 'succeeded' | 'failed';

export type ToolResultPayload = {
  output?: string;
  success?: boolean;
  truncated?: boolean;
} & Record<string, unknown>;

export type ToolEvent =
  | {
      type: 'tool_call_prepared';
      tool_call_id: string;
      turn_id: string;
      round_num: number;
      name: string;
      args_so_far: string;
    }
  | { type: 'tool_started'; tool_call_id: string; turn_id: string; round_num: number; name: string }
  | {
      type: 'tool_finished';
      tool_call_id: string;
      turn_id: string;
      round_num: number;
      result: ToolResultPayload;
    }
  | {
      type: 'tool_permission_requested';
      tool_call_id: string;
      turn_id: string;
      round_num: number;
      tool_name: string;
      reason: string;
      paths: string[];
      category: string;
      level: number;
      risk: string;
      consequence: string;
    }
  | { type: 'tool_notice'; tool_call_id?: string; level: string; message: string };

export type ControlEvent =
  | { type: 'session_state_changed'; seed: string; state: string }
  | { type: 'config_changed'; rev: number }
  | {
      type: 'session_activity_changed';
      seed: string;
      state: string;
      turn_id?: string;
      seq: number;
      updated_at: number;
    }
  | { type: 'session_meta_changed'; seed: string; title?: string }
  | { type: 'agent_lifecycle_changed'; state: string }
  | {
      type: 'interaction_requested';
      interaction_id: string;
      turn_id: string;
      mode: string;
      questions: unknown[];
    }
  | { type: 'interaction_resolved'; interaction_id: string; resolution: unknown };

/** SSE data 信封内 event 字段：内层自带 channel + type 双 tag */
export type DomainEvent =
  | ({ channel: 'control' } & ControlEvent)
  | ({ channel: 'conversation' } & ConversationEvent)
  | ({ channel: 'tool' } & ToolEvent);

// ---------------------------------------------------------------------------
// timeline（qaqh-domain/src/timeline.rs，transcript 权威 N6）
// ---------------------------------------------------------------------------

export type TimelineBlockKind = 'reasoning' | 'text' | 'tool' | 'notice';
export type TimelineBlockState = 'open' | 'sealed';
export type TimelineToolState = 'prepared' | 'running' | 'succeeded' | 'failed';
export type TimelineTurnState = 'running' | 'completed' | 'failed' | 'cancelled';

export interface TimelineFailure {
  code: string;
  message: string;
}

export interface TimelineToolPermission {
  reason: string;
  paths: string[];
  category: string;
  level: number;
  risk: string;
  consequence: string;
}

export interface TimelineTool {
  tool_call_id: string;
  name: string;
  state: TimelineToolState;
  summary?: string;
  args_json?: string;
  output?: string;
  diff?: string;
  progress: string;
  failure?: TimelineFailure;
  permission?: TimelineToolPermission;
}

export interface TimelineBlock {
  block_id: string;
  /** 同一 round 内稳定序，更新不改变位置 */
  block_order: number;
  kind: TimelineBlockKind;
  state: TimelineBlockState;
  text: string;
  tool?: TimelineTool;
}

export interface TimelineRound {
  round_num: number;
  sealed: boolean;
  is_final: boolean;
  blocks: TimelineBlock[];
}

export interface TimelineTurn {
  turn_id: string;
  /** TurnOpened 条目的 timeline_seq（跨快照时间序；0=legacy 回退 turn_id 数字后缀） */
  created_seq: number;
  user_text: string;
  sealed: boolean;
  state: TimelineTurnState;
  failure?: TimelineFailure;
  rounds: TimelineRound[];
}

/** /timeline 快照（handle_timeline_snapshot） */
export interface TimelineSnapshotResponse {
  schema: typeof RINGING_SCHEMA;
  version: number;
  server_epoch: string;
  seed: string;
  snapshot: { watermark: number; turns: TimelineTurn[] };
  /** true = 还有更早的 turn（上翻用 before_turn） */
  has_more: boolean;
  total_turns: number;
}

/** timeline 权威变更条目（timeline.entry SSE + 快照共用） */
export interface TimelineEntry {
  /** 每 (server epoch, seed) 严格单调 */
  timeline_seq: number;
  turn_id: string;
  round_num?: number;
  event: TimelineEventPayload;
}

export type TimelineEventPayload =
  | { type: 'turn_opened'; user_text: string }
  | { type: 'block_opened'; block: TimelineBlock }
  | { type: 'text_delta'; block_id: string; fragment_seq: number; delta: string }
  | { type: 'block_checkpoint'; block_id: string; text: string }
  | { type: 'tool_updated'; block_id: string; tool: TimelineTool }
  | { type: 'tool_progress'; block_id: string; chunk: string }
  | { type: 'block_sealed'; block_id: string }
  | { type: 'round_sealed'; is_final: boolean }
  | { type: 'turn_sealed'; state: TimelineTurnState; failure?: TimelineFailure };

// ---------------------------------------------------------------------------
// bootstrap（snapshot.rs：RingingSessionBootstrap 三频道快照）
// ---------------------------------------------------------------------------

export interface ChannelSnapshot {
  schema: typeof RINGING_SCHEMA;
  version: number;
  channel: Channel;
  seed: string;
  /** 快照覆盖到的 stream_seq 基线（其后的可靠事件从 cursor 回放） */
  baseline_stream_seq: number;
  state_revision: number;
  snapshot_version: number;
  state: Record<string, unknown>;
}

export interface BootstrapResponse {
  schema: typeof RINGING_SCHEMA;
  version: number;
  server_epoch: string;
  seed: string;
  control: ChannelSnapshot;
  conversation: ChannelSnapshot;
  tool: ChannelSnapshot;
}

/** conversation 快照 state 中 renderer 消费的辅助字段（实测确认） */
export interface ConversationAuxState {
  active_turn?: { turn_id?: string } | null;
  cancelled?: unknown;
  usage?: UsageInfo | null;
  usage_totals?: UsageInfo;
  usage_requests?: number;
  model?: string;
  context_limit?: number;
  last_round?: { turn_id: string; round_num: number; final: boolean };
  last_completed_turn?: string;
  compact_status?: string;
}

// ---------------------------------------------------------------------------
// 附件（§3.9：ContentRef；sha256 === content_id）
// ---------------------------------------------------------------------------

export interface ContentRef {
  content_id: string;
  sha256: string;
  media_type: string;
}

export interface ContentUploadResponse {
  content_id: string;
  media_type: string;
  sha256: string;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// 会话 / 服务面（service_methods.rs 实测：session.list / session.meta）
// ---------------------------------------------------------------------------

export interface SessionContextStats {
  chat_text: number;
  thinking: number;
  tool_calls: number;
  tool_results: number;
  tools_schema: number;
  system_prompt: number;
  thinking_blocks: number;
  tool_call_blocks: number;
  messages: number;
}

export interface SessionSummary {
  seed: string;
  created_at: number;
  updated_at: number;
  model: string;
  effort: string;
  message_count: number;
  turn_count: number;
  last_summary: string;
  compact_skip: number;
  mode: number;
  archived: boolean;
  ephemeral: boolean;
  usage_totals: UsageInfo;
  usage_requests: number;
  title: string | null;
  context_stats: SessionContextStats;
  running: boolean;
  workspace_id: string | null;
}

// ---------------------------------------------------------------------------
// 服务面配置（qaqh-config-api：ConfigView / ConfigPatch，camelCase merge patch）
// ---------------------------------------------------------------------------

export interface DaemonConfigView {
  model: string;
  baseUrl: string;
  providerId: string;
  endpoint: string;
  maxTokens: number;
  contextLimit: number;
  reasoningEffort: string;
  autoCompactThreshold: number;
  permissionLevel: number;
  lang: string | null;
  fontFamily: string;
  /** null=跟随系统，"dark"/"light" 固定 */
  theme: string | null;
  notificationsEnabled: boolean;
  activeProfile: string;
  profiles: string[];
}

/**
 * config.save 载荷（ConfigPatch 子集）。特殊语义：
 * theme: "" = 跟随系统；api_key: "****"/"" = 保持现值。
 */
export interface DaemonConfigPatch {
  theme?: string;
  lang?: string;
  fontFamily?: string;
  notificationsEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// 错误码（§4 字典）
// ---------------------------------------------------------------------------

export type ServiceErrorCode =
  | 'query_failed'
  | 'action_failed'
  | 'unknown_method'
  | 'lease_required'
  | 'missing_seed'
  | 'invalid_envelope'
  | 'invalid_body'
  | 'duplicate_command_mismatch'
  | 'unsupported_command'
  | 'unsupported_version'
  | 'content_forbidden'
  | 'attachment_mismatch'
  | 'command_not_found'
  | 'dispatch_failed';

export interface ServiceErrorBody {
  code?: ServiceErrorCode | string;
  message?: string;
}

// ---------------------------------------------------------------------------
// SSE 游标（`<epoch>:<channel>:<seq>` / `<epoch>:timeline:<seq>`）
// ---------------------------------------------------------------------------

export function lastEventIdHeader(epoch: string, channel: string, seq: number): string {
  return `${epoch}:${channel}:${seq}`;
}

/** 服务端每 15s 注释行 keepalive；客户端判活按字节计（阈值参考后端 45s） */
export const KEEPALIVE_INTERVAL_MS = 15_000;
/** 字节级 idle 判活阈值（PLAN：参考后端 45s 阈值） */
export const SSE_IDLE_TIMEOUT_MS = 45_000;
