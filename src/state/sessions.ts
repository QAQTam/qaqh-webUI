/**
 * 会话列表状态（对话管理）：服务面 session.list 为准（真实字段：seed 8hex、
 * title|null、updated_at unix 秒、archived/running 等）。
 * 生命周期命令（N5：只走 commands 面）后主动刷新。
 *
 * session_create 的 ack 不携带 seed：新 seed 经 control SSE
 * `session_state_changed`(state=created, causation_id=command_id) 广播，
 * 且 daemon 在命令路径上同步 attach 到本 lease。发送后等待该事件或轮询列表。
 */
import { createStore, type Store } from './store';
import type { RingingClient } from '../daemon/client';
import type { SessionSummary } from '../protocol/types';
import { READ_METHODS, CONTROL_COMMANDS } from '../protocol/methods';

export interface SessionsState {
  list: SessionSummary[];
  activeSeed: string | null;
  loading: boolean;
  error: string | null;
}

export const sessionsStore: Store<SessionsState> = createStore<SessionsState>({
  list: [],
  activeSeed: null,
  loading: false,
  error: null,
});

export async function refreshSessions(client: RingingClient): Promise<void> {
  sessionsStore.set((s) => ({ ...s, loading: true, error: null }));
  try {
    const list = await client.service<SessionSummary[]>(READ_METHODS.sessionList);
    const sorted = [...list].sort((a, b) => b.updated_at - a.updated_at);
    sessionsStore.set((s) => ({ ...s, list: sorted, loading: false }));
  } catch (err) {
    sessionsStore.set((s) => ({
      ...s,
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * 新建会话（close_current=false：保留当前会话并切换）。返回新 seed。
 * ack 不携带 seed：新 seed 经 control SSE `session_state_changed`
 * (state=created) 广播，其 causation_id = 本次 command_id（实测确认）。
 */
export async function createSession(client: RingingClient): Promise<string | null> {
  const commandId = crypto.randomUUID();
  const seedPromise = waitForCreatedSeed(client, commandId, 8_000);
  const ack = await client.sendCommand(
    'control',
    CONTROL_COMMANDS.sessionCreate,
    { close_current: false },
    { commandId },
  );
  if (ack.status === 'rejected') return null;
  const seed = await seedPromise;
  void refreshSessions(client);
  return seed;
}

/** 订阅 control 频道等 created 事件；超时则回退到列表里最新创建的会话 */
function waitForCreatedSeed(
  client: RingingClient,
  commandId: string,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (seed: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      resolve(seed);
    };
    const off = client.onServerEvent((channel, eventName, data) => {
      if (channel !== 'control' || eventName !== 'session_state_changed') return;
      const env = data as { seed?: string; causation_id?: string; event?: { state?: string } };
      if (env?.causation_id !== commandId) return;
      finish(env.seed ?? null);
    });
    const timer = setTimeout(() => {
      // 兜底：daemon 在 ack 前同步持久化新会话，取列表最新 created_at
      const list = sessionsStore.get().list;
      const newest = [...list].sort((a, b) => b.created_at - a.created_at)[0];
      finish(newest?.seed ?? null);
    }, timeoutMs);
  });
}

/** 归档（标签 ×，磁盘保留可恢复） */
export async function archiveSession(client: RingingClient, seed: string): Promise<void> {
  await client.sendCommand('control', CONTROL_COMMANDS.sessionArchive, {}, { seed });
  void refreshSessions(client);
}

export async function unarchiveSession(client: RingingClient, seed: string): Promise<void> {
  await client.sendCommand('control', CONTROL_COMMANDS.sessionUnarchive, {}, { seed });
  void refreshSessions(client);
}

/** 彻底删除（先关实例再删磁盘目录）。标题由 daemon 自动生成，无 rename 命令 */
export async function deleteSession(client: RingingClient, seed: string): Promise<void> {
  await client.sendCommand('control', CONTROL_COMMANDS.sessionDelete, {}, { seed });
  sessionsStore.set((s) => ({
    ...s,
    list: s.list.filter((x) => x.seed !== seed),
    activeSeed: s.activeSeed === seed ? null : s.activeSeed,
  }));
  void refreshSessions(client);
}

export function setActiveSeed(seed: string | null): void {
  sessionsStore.set((s) => ({ ...s, activeSeed: seed }));
}

export function applySessionSummary(summary: SessionSummary): void {
  sessionsStore.set((s) => {
    const exists = s.list.some((x) => x.seed === summary.seed);
    return {
      ...s,
      list: exists
        ? s.list.map((x) => (x.seed === summary.seed ? { ...x, ...summary } : x))
        : [summary, ...s.list],
    };
  });
}
