/**
 * 设置（PLAN M5）：daemon config.load / config.save（camelCase merge patch）为准。
 * daemon 可持久化字段：theme（"dark"/"light"/""=跟随系统，null 同跟随）、
 * lang、fontFamily、notificationsEnabled（qaqh-config-api ConfigPatch）。
 * 纯 UI 偏好（分页大小、自动滚动等 daemon 配置没有的字段）存 localStorage，
 * 不含任何 token（N3）。
 */
import { createStore, type Store } from './store';
import type { RingingClient } from '../daemon/client';
import { READ_METHODS, WRITE_METHODS } from '../protocol/methods';
import type { DaemonConfigView, DaemonConfigPatch } from '../protocol/types';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface SettingsState {
  theme: ThemeMode;
  timelinePageSize: number;
  autoScroll: boolean;
  showDiagnostics: boolean;
  rawToolOutput: boolean;
  hydrated: boolean;
  /** 最近一次 config.save 是否失败（断连降级提示） */
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

const UI_KEYS = [
  'theme',
  'timelinePageSize',
  'autoScroll',
  'showDiagnostics',
  'rawToolOutput',
] as const;
type UiPrefKey = (typeof UI_KEYS)[number];

function readLocalFallback(): SettingsState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<SettingsState>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

function writeLocalFallback(state: SettingsState): void {
  const subset: Partial<Record<UiPrefKey, unknown>> = {};
  for (const key of UI_KEYS) subset[key] = state[key];
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(subset));
  } catch {
    // 存储不可用（隐私模式等）：静默，内存态仍可用
  }
}

export const settingsStore: Store<SettingsState> = createStore<SettingsState>(readLocalFallback());

function normalizeTheme(value: unknown): ThemeMode {
  if (value === 'dark' || value === 'light') return value;
  return 'system'; // null / "" / 其他 = 跟随系统
}

/** 启动时：本地兜底立即生效，再以 daemon config.load 覆盖（daemon 为准） */
export async function hydrateSettings(client: RingingClient): Promise<void> {
  try {
    const res = await client.service<DaemonConfigView>(READ_METHODS.configLoad);
    const theme = normalizeTheme(res.theme);
    settingsStore.set((s) => ({ ...s, theme, hydrated: true, syncError: null }));
  } catch {
    settingsStore.set((s) => ({ ...s, hydrated: true }));
  }
}

/** 局部更新：乐观本地生效 + config.save 落盘（失败则标记 syncError） */
export function updateSettings(patch: Partial<Pick<SettingsState, UiPrefKey>>): void {
  let latest: SettingsState | null = null;
  settingsStore.set((s) => {
    latest = { ...s, ...patch };
    return latest;
  });
  if (latest) writeLocalFallback(latest);
  const client = boundClient;
  if (!client) return;
  const configPatch: DaemonConfigPatch = {};
  if (patch.theme !== undefined) {
    // "" = 跟随系统（ConfigPatch 冻结语义）
    configPatch.theme = patch.theme === 'system' ? '' : patch.theme;
  }
  if (Object.keys(configPatch).length === 0) return;
  void client
    .service(WRITE_METHODS.configSave, configPatch)
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
