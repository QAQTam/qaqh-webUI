/**
 * 设置页（PLAN M5 服务面 CRUD）：外观 / 连接 / 会话 / 关于。
 * 配置读写走服务面 config.get/config.set（typed 常量）；
 * 连接页展示三频道 SSE 诊断（光标、重连数、字节级 idle 计时），
 * 并提供"重新连接"与"模拟 epoch 重置"（仅 mock daemon 支持）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  Button,
  Divider,
  Field,
  MessageBar,
  MessageBarBody,
  Radio,
  RadioGroup,
  SpinButton,
  Switch,
  Tab,
  TabList,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowClockwiseRegular, ArrowLeftRegular, WarningRegular } from '@fluentui/react-icons';
import type { RingingClient } from '../../daemon/client';
import { useStore } from '../../state/store';
import { settingsStore, updateSettings, type ThemeMode } from '../../state/settings';
import { READ_METHODS, WRITE_METHODS, MOCK_ONLY_METHODS } from '../../protocol/methods';
import { RINGING_SCHEMA as PROTO_SCHEMA, RINGING_VERSION as PROTO_VERSION } from '../../protocol/types';
import { ConnectionBadge } from '../../ui/ConnectionBadge';
import { APP_INFO, APP_VERSION } from '../../utils/version';
import { shortId } from '../../utils/format';

const TABS = ['appearance', 'connection', 'sessions', 'about'] as const;
type TabValue = (typeof TABS)[number];

const TAB_LABELS: Record<TabValue, string> = {
  appearance: '外观',
  connection: '连接',
  sessions: '会话',
  about: '关于',
};

const useClasses = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  sectionTitle: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    padding: '8px 4px 2px',
  },
  themePreview: {
    height: '64px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    fontSize: '13px',
  },
});

export function SettingsPage({ client, onBack }: { client: RingingClient; onBack: () => void }) {
  const cls = useClasses();
  const [tab, setTab] = useState<TabValue>('appearance');
  return (
    <div className="settings-page">
      <div className={cls.header}>
        <Button appearance="subtle" icon={<ArrowLeftRegular />} onClick={onBack} aria-label="返回会话">
          返回
        </Button>
        <Text size={400} weight="semibold">
          设置
        </Text>
      </div>
      <div className="settings-scroll">
        <div className="settings-inner">
          <TabList
            selectedValue={tab}
            onTabSelect={(_, data) => setTab(data.value as TabValue)}
            appearance="transparent"
          >
            {TABS.map((t) => (
              <Tab key={t} value={t}>
                {TAB_LABELS[t]}
              </Tab>
            ))}
          </TabList>
          <Divider />
          {tab === 'appearance' && <AppearanceSection />}
          {tab === 'connection' && <ConnectionSection client={client} />}
          {tab === 'sessions' && <SessionsSection />}
          {tab === 'about' && <AboutSection client={client} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 外观
// ---------------------------------------------------------------------------

function AppearanceSection() {
  const cls = useClasses();
  const theme = useStore(settingsStore, (s) => s.theme);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  const effective = theme === 'system' ? (systemDark ? '深色' : '浅色') : theme === 'dark' ? '深色' : '浅色';

  return (
    <div className="settings-section">
      <Text className={cls.sectionTitle}>主题</Text>
      <div className="settings-row">
        <div>
          <Text>选择界面主题</Text>
          <div className="settings-row-desc">跟随系统将实时响应操作系统的深浅色切换</div>
        </div>
        <RadioGroup
          value={theme}
          onChange={(_, data) => updateSettings({ theme: data.value as ThemeMode })}
        >
          <Radio value="system" label="跟随系统" />
          <Radio value="light" label="浅色" />
          <Radio value="dark" label="深色" />
        </RadioGroup>
      </div>
      <div className="kv-list">
        <KvRow k="主题预览" v={`当前生效：${effective}（跟随系统实时切换`} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 连接
// ---------------------------------------------------------------------------

function ConnectionSection({ client }: { client: RingingClient }) {
  const cls = useClasses();
  const snap = useStore(client.store, (s) => s);
  const [, tick] = useState(0);
  // idle 计时需要每秒刷新
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="settings-section">
      <Text className={cls.sectionTitle}>连接状态</Text>
      {snap.lastError && (
        <MessageBar intent="warning" icon={<WarningRegular />}>
          <MessageBarBody>{snap.lastError}</MessageBarBody>
        </MessageBar>
      )}
      <div className="kv-list">
        <KvRow k="状态" v={<ConnectionBadge client={client} />} />
        <KvRow k="server epoch" v={String(snap.epoch)} />
        <KvRow k="client_session_id" v={snap.sessionId ? shortId(snap.sessionId, 12) : '—'} />
        <KvRow k="lease TTL" v={snap.leaseTtlMs ? `${snap.leaseTtlMs / 1000}s` : '—'} />
        <KvRow k="renew 间隔" v={snap.renewIntervalMs ? `${snap.renewIntervalMs / 1000}s` : '—'} />
      </div>

      <Text className={cls.sectionTitle}>SSE 频道诊断</Text>
      <div className="kv-list">
        {(['control', 'conversation', 'tool'] as const).map((ch) => {
          const d = snap.channels[ch];
          const idleSec = d.lastByteAt ? Math.round((performance.now() - d.lastByteAt) / 1000) : null;
          return (
            <KvRow
              key={ch}
              k={ch}
              v={`光标 ${d.lastSeq} · ${d.status} · 重连 ${d.reconnects} 次${idleSec !== null ? ` · idle ${idleSec}s` : ''}`}
            />
          );
        })}
      </div>
      <div className="settings-row">
        <div>
          <Text>重建连接</Text>
          <div className="settings-row-desc">重新执行 open 握手并重放三个频道（Last-Event-ID 续传）</div>
        </div>
        <Button
          appearance="secondary"
          icon={<ArrowClockwiseRegular />}
          onClick={() => void client.rebuild('手动重建')}
        >
          重新连接
        </Button>
      </div>
      <div className="settings-row">
        <div>
          <Text>模拟 epoch 重置</Text>
          <div className="settings-row-desc">
            触发 ringing.reset_required → 全频道重置重放（仅内置 mock daemon 支持）
          </div>
        </div>
        <Button
          appearance="secondary"
          onClick={() => void client.service(MOCK_ONLY_METHODS.debugResetEpoch).catch(() => undefined)}
        >
          触发
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

function SessionsSection() {
  const cls = useClasses();
  const s = useStore(settingsStore, (x) => x);
  return (
    <div className="settings-section">
      <Text className={cls.sectionTitle}>timeline 与滚动</Text>
      {s.syncError && (
        <MessageBar intent="warning">
          <MessageBarBody>配置同步失败（离线降级为本地保存）：{s.syncError}</MessageBarBody>
        </MessageBar>
      )}
      <div className="settings-row">
        <div>
          <Text>历史分页大小</Text>
          <div className="settings-row-desc">向上滚动加载更早回合时每页条数（10–100）</div>
        </div>
        <Field>
          <SpinButton
            value={s.timelinePageSize}
            min={10}
            max={100}
            step={5}
            onChange={(_, data) => {
              const v = typeof data.value === 'number' ? data.value : Number(data.displayValue ?? NaN);
              if (Number.isFinite(v)) {
                updateSettings({ timelinePageSize: Math.min(100, Math.max(10, Math.round(v))) });
              }
            }}
            aria-label="历史分页大小"
          />
        </Field>
      </div>
      <div className="settings-row">
        <div>
          <Text>自动滚动</Text>
          <div className="settings-row-desc">新消息到达且位于底部附近时自动跟随</div>
        </div>
        <Switch
          checked={s.autoScroll}
          onChange={(_, data) => updateSettings({ autoScroll: data.checked })}
          aria-label="自动滚动"
        />
      </div>
      <div className="settings-row">
        <div>
          <Text>工具卡片原始视图</Text>
          <div className="settings-row-desc">以 JSON 原文展示工具参数与输出，而非分块格式化视图</div>
        </div>
        <Switch
          checked={s.rawToolOutput}
          onChange={(_, data) => updateSettings({ rawToolOutput: data.checked })}
          aria-label="工具卡片原始视图"
        />
      </div>
      <div className="settings-row">
        <div>
          <Text>显示连接诊断</Text>
          <div className="settings-row-desc">在侧栏底部显示 SSE 频道光标摘要</div>
        </div>
        <Switch
          checked={s.showDiagnostics}
          onChange={(_, data) => updateSettings({ showDiagnostics: data.checked })}
          aria-label="显示连接诊断"
        />
      </div>
      <div className="settings-row-desc" style={{ padding: '0 4px' }}>
        主题经服务面 {READ_METHODS.configLoad} / {WRITE_METHODS.configSave} 持久化到 daemon 配置；
        其余为本地 UI 偏好（不包含任何凭据）。
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 关于
// ---------------------------------------------------------------------------

function AboutSection({ client }: { client: RingingClient }) {
  const cls = useClasses();
  const [daemonVersion, setDaemonVersion] = useState('…');
  useEffect(() => {
    client
      .service<string>(READ_METHODS.daemonVersion)
      .then((v) => setDaemonVersion(typeof v === 'string' ? v : JSON.stringify(v)))
      .catch(() => setDaemonVersion('不可用'));
  }, [client]);

  return (
    <div className="settings-section">
      <Text className={cls.sectionTitle}>版本信息</Text>
      <div className="kv-list">
        <KvRow k="前端" v={`qaqh-webui ${APP_VERSION}`} />
        <KvRow k="daemon" v={daemonVersion} />
        <KvRow k="协议" v={`${PROTO_SCHEMA} v${PROTO_VERSION}`} />
        <KvRow
          k="技术栈"
          v={`Vite ${APP_INFO.vite} · TypeScript ${APP_INFO.ts} · React ${APP_INFO.react} · Fluent UI v9 (${APP_INFO.fluent})`}
        />
        <KvRow k="SSE" v="fetch + ReadableStream 手写解析（N2，无 EventSource）" />
      </div>
      <div className="settings-row-desc" style={{ padding: '0 4px' }}>
        本客户端遵循 qaqh.Ringing 协议纪律：双头鉴权、token 仅内存持有、命令幂等键、
        timeline 唯一历史真源、SSE 断线 Last-Event-ID 续传。
      </div>
    </div>
  );
}

function KvRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="kv-row">
      <span className="kv-key">{k}</span>
      <span className="kv-val">{v}</span>
    </div>
  );
}
