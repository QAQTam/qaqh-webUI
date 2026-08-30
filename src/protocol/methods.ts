/**
 * 服务面方法与频道命令 typed 常量。
 * 对照 `qaqh_runtime::ringing::service_methods` 与
 * `qaqh_domain::command.rs`（serde rename_all=snake_case 后的 wire 名）。
 * 禁止散落字面量；扩充时对照后端 PR。
 */

// ---------------------------------------------------------------------------
// 服务面（Read 无副作用 / Write 变更）
// ---------------------------------------------------------------------------

export const READ_METHODS = {
  daemonVersion: 'daemon.version',
  sessionList: 'session.list',
  sessionMeta: 'session.meta',
  configLoad: 'config.load',
  workspaceGet: 'workspace.get',
} as const;

export const WRITE_METHODS = {
  configSave: 'config.save',
} as const;

export type ReadMethodName = (typeof READ_METHODS)[keyof typeof READ_METHODS];
export type WriteMethodName = (typeof WRITE_METHODS)[keyof typeof WRITE_METHODS];
export type ServiceMethodName = ReadMethodName | WriteMethodName;

// ---------------------------------------------------------------------------
// 频道命令 wire 名（command.type，snake_case）
// 会话生命周期只走 commands 面（N5）：service 面没有 session.new/resume
// ---------------------------------------------------------------------------

export const CONTROL_COMMANDS = {
  sessionCreate: 'session_create',
  sessionResume: 'session_resume',
  sessionClose: 'session_close',
  sessionArchive: 'session_archive',
  sessionUnarchive: 'session_unarchive',
  sessionDelete: 'session_delete',
} as const;

export const CONVERSATION_COMMANDS = {
  sendMessage: 'conversation_send_message',
  cancel: 'conversation_cancel',
} as const;

export const TOOL_COMMANDS = {
  toolPermissionRespond: 'tool_permission_respond',
} as const;

export type ControlCommandName = (typeof CONTROL_COMMANDS)[keyof typeof CONTROL_COMMANDS];
export type ConversationCommandName =
  (typeof CONVERSATION_COMMANDS)[keyof typeof CONVERSATION_COMMANDS];
export type ToolCommandName = (typeof TOOL_COMMANDS)[keyof typeof TOOL_COMMANDS];

/** 仅内置 mock daemon 支持（开发期演示 epoch 重置）；真实后端返回 404 unknown_method */
export const MOCK_ONLY_METHODS = {
  debugResetEpoch: 'debug.reset_epoch',
} as const;

// ---------------------------------------------------------------------------
// 命令参数（qaqh_domain::command.rs 镜像）
// ---------------------------------------------------------------------------

export interface SessionCreateParams {
  close_current?: boolean;
  cwd?: string;
  tool_mode?: string;
  custom_tools?: string[];
}

export interface SessionResumeParams {
  seed: string;
}

export interface SessionCloseParams {
  seed: string;
}

export interface SessionDeleteParams {
  seed: string;
}

export interface SendMessageParams {
  text: string;
  images?: { mime_type: string; data: string }[];
  attachments?: import('./types').ContentRef[];
  as_system?: boolean;
}

export interface CancelParams {
  turn_id?: string;
}
