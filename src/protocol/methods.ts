/**
 * 服务面方法 typed 常量（PLAN §4）：
 * 对照 `qaqh_runtime::ringing::service_methods` 生成，禁止散落字面量。
 * 本仓按需镜像子集（22 Read + 19 Write 中的已用部分）；扩充时对照后端 PR。
 * TODO(对照后端)：以下命名以 service_methods.rs 实际方法名为准后修正。
 */

export const READ_METHODS = {
  sessionList: 'session.list',
  sessionGet: 'session.get',
  configGet: 'config.get',
  workspaceInfo: 'workspace.info',
} as const;

export const WRITE_METHODS = {
  configSet: 'config.set',
} as const;

export type ReadMethodName = (typeof READ_METHODS)[keyof typeof READ_METHODS];
export type WriteMethodName = (typeof WRITE_METHODS)[keyof typeof WRITE_METHODS];
export type ServiceMethodName = ReadMethodName | WriteMethodName;

/** Read 方法错误码为 query_failed，Write 为 action_failed */
export function isReadMethod(m: ServiceMethodName): boolean {
  return Object.values(READ_METHODS).includes(m as ReadMethodName);
}

// ---------------------------------------------------------------------------
// 命令面 typed 常量（§2.4；会话生命周期只走此面 N5）
// ---------------------------------------------------------------------------

export const CONVERSATION_COMMANDS = {
  userSend: 'user.send',
  turnAbort: 'turn.abort',
} as const;

export const CONTROL_COMMANDS = {
  sessionNew: 'session.new',
  sessionRename: 'session.rename',
  sessionDelete: 'session.delete',
  sessionResume: 'session.resume',
} as const;

export type ConversationCommandName =
  (typeof CONVERSATION_COMMANDS)[keyof typeof CONVERSATION_COMMANDS];
export type ControlCommandName = (typeof CONTROL_COMMANDS)[keyof typeof CONTROL_COMMANDS];

// ---------------------------------------------------------------------------
// 命令 / 事件 payload（按需增量镜像）
// ---------------------------------------------------------------------------

export interface UserSendPayload {
  text: string;
  attachments?: import('./types').ContentRef[];
}

export interface SessionNewResult {
  seed: string;
}

export interface SessionRenamePayload {
  seed: string;
  title: string;
}

export interface SessionDeletePayload {
  seed: string;
}
