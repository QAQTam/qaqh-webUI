/**
 * 设置（PLAN M5：服务面配置读写走 typed 方法常量）。
 * daemon config 为准，localStorage 仅作断连时的本地兜底镜像（不含任何 token）。
 */
import { createStore, type Store } from './store';
import type { RingingClient } from '../daemon/client';
import { READ_METHODS, WRITE_METHODS } from '../protocol/methods';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface SettingsState {
  theme: ThemeMode;
  timelinePageSize: number;
  autoScroll: boolean;
  showDiagnostics: boolean;
  rawToolOutput: boolean;
  hydrated: boolean;
  /** 最近一次 config.set 是否失败（断连降级提示） */
  syncError: string | null;
}

const LS_KEY = 'qaqh.ui.prefs.v1';

const DEFAULTS: SettingsState = {
  theme: 'system',
  timelinePageSize: 20,
  autoScroll: true,
  showDiagnostics: false,
  rawToolOutput: false,
  hydrated: false,
  syncError: null,
};

/** config 键位（与 daemon config 表约定） */
export const CONFIG_KEYS = {
  theme: 'ui.theme',
  timelinePageSize: 'ui.timeline_page_size',
  autoScroll: 'ui.auto_scroll',
  showDiagnostics: 'ui.show_diagnostics',
  rawToolOutput: 'ui.raw_tool_output',
} as const;

function toConfig(state: SettingsState): Record<string, unknown> {
  return {
    [CONFIG_KEYS.theme]: state.theme,
    [CONFIG_KEYS.timelinePageSize]: state.timelinePageSize,
    [CONFIG_KEYS.autoScroll]: state.autoScroll,
    [CONFIG_KEYS.showDiagnostics]: state.showDiagnostics,
    [CONFIG_KEYS.rawToolOutput]: state.rawToolOutput,
  };
}

function applyConfig(state: SettingsState, config: Record<string, unknown>): SettingsState {
  const next = { ...state };
  const theme = config[CONFIG_KEYS.theme];
  if (theme === 'system' || theme === 'light' || theme === 'dark') next.theme = theme;
  const size = config[CONFIG_KEYS.timelinePageSize];
  if (typeof size === 'number' && size >= 10 && size <= 100) next.timelinePageSize = Math.round(size);
  for (const key of [CONFIG_KEYS.autoScroll, CONFIG_KEYS.showDiagnostics, CONFIG_KEYS.rawToolOutput] as const) {
    if (typeof config[key] === 'boolean') {
      if (key === CONFIG_KEYS.autoScroll) next.autoScroll = config[key] as boolean;
      if (key === CONFIG_KEYS.showDiagnostics) next.showDiagnostics = config[key] as boolean;
      if (key === CONFIG_KEYS.rawToolOutput) next.rawToolOutput = config[key] as boolean;
    }
  }
  return next;
}

function readLocalFallback(): SettingsState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULTS;
    return applyConfig(DEFAULTS, JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return DEFAULTS;
  }
}

function writeLocalFallback(state: SettingsState): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(toConfig(state)));
  } catch {
    // 存储不可用（隐私模式等）：静默，内存态仍可用
  }
}

export const settingsStore: Store<SettingsState> = createStore<SettingsState>(readLocalFallback());

/** 启动时：本地兜底立即生效，再以服务面 config 覆盖（daemon 为准） */
export async function hydrateSettings(client: RingingClient): Promise<void> {
  try {
    const res = await client.service<{ config: Record<string, unknown> }>(READ_METHODS.configGet);
    settingsStore.set((s) => applyConfig({ ...s, hydrated: true, syncError: null }, res.config ?? {}));
  } catch {
    settingsStore.set((s) => ({ ...s, hydrated: true }));
  }
}

/** 局部更新：乐观本地生效 + config.set 落盘（失败则标记 syncError） */
export function updateSettings(patch: Partial<Pick<SettingsState, keyof typeof CONFIG_KEYS>>): void {
  let latest: SettingsState | null = null;
  settingsStore.set((s) => {
    latest = { ...s, ...patch };
    return latest;
  });
  if (latest) writeLocalFallback(latest);
  const client = boundClient;
  if (!client) return;
  const config: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as (keyof typeof CONFIG_KEYS)[]) {
    config[CONFIG_KEYS[key]] = patch[key];
  }
  void client
    .service(WRITE_METHODS.configSet, { patch: config })
    .then(() => settingsStore.set((s) => ({ ...s, syncError: null })))
    .catch((err: unknown) =>
      settingsStore.set((s) => ({
        ...s,
        syncError: err instanceof Error ? err.message : String(err),
      })),
    );
}

let boundClient: RingingClient | null = null;

/** App 启动后绑定 client 供异步持久化使用 */
export function bindSettingsClient(client: RingingClient): void {
  boundClient = client;
}
