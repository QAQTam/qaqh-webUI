/**
 * 会话列表状态（对话管理）：服务面 session.list 为准，
 * 生命周期命令（N5：只走 commands 面）后主动刷新。
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
    const res = await client.service<{ sessions: SessionSummary[] }>(READ_METHODS.sessionList);
    const list = [...(res.sessions ?? [])].sort((a, b) =>
      b.updated_at.localeCompare(a.updated_at),
    );
    sessionsStore.set((s) => ({ ...s, list, loading: false }));
  } catch (err) {
    sessionsStore.set((s) => ({
      ...s,
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

export async function createSession(client: RingingClient, title?: string): Promise<string | null> {
  const ack = await client.sendCommand<{ seed: string }>(
    'control',
    CONTROL_COMMANDS.sessionNew,
    { title },
  );
  await refreshSessions(client);
  return ack.result?.seed ?? null;
}

export async function renameSession(client: RingingClient, seed: string, title: string): Promise<void> {
  // 会话生命周期命令：seed 走信封级字段（PLAN §2.4 会话域命令必带）
  await client.sendCommand('control', CONTROL_COMMANDS.sessionRename, { title }, { seed });
  sessionsStore.set((s) => ({
    ...s,
    list: s.list.map((x) => (x.seed === seed ? { ...x, title, updated_at: new Date().toISOString() } : x)),
  }));
  void refreshSessions(client);
}

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
