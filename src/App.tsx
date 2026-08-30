/**
 * App 编排：桥等待 → open 握手 → 续租循环 → 会话列表 → 选中会话
 * resume（seed 归属 lease）→ timeline 快照 + 增量流。
 * 视图：聊天 / 设置；窄屏侧栏走 Drawer；协议代差展示阻断式"需更新"。
 */
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Drawer,
  FluentProvider,
  Spinner,
  Text,
  webDarkTheme,
  webLightTheme,
} from '@fluentui/react-components';
import { LineHorizontal3Regular, NavigationRegular } from '@fluentui/react-icons';
import { RingingClient, type ConnectionState } from './daemon/client';
import { waitForBridge } from './daemon/bridge';
import { settingsStore, bindSettingsClient, hydrateSettings } from './state/settings';
import { createStore, useStore } from './state/store';
import { refreshSessions, sessionsStore, setActiveSeed } from './state/sessions';
import { attachTimeline, bindTimelineToClient, listenTimelineReload } from './state/timeline';
import { Sidebar } from './features/conversations/Sidebar';
import { ChatArea } from './features/timeline/ChatArea';
import { Composer } from './features/composer/Composer';
import { SettingsPage } from './features/settings/SettingsPage';
import { ConnectionBadge } from './ui/ConnectionBadge';

type BootPhase = 'waiting' | 'no_bridge' | 'ready';
type View = 'chat' | 'settings';

/** client 尚未创建时的稳定 store（保证 useStore 无条件调用，Rules of Hooks） */
const PENDING_CONNECTION_STORE = createStore<{ state: ConnectionState }>({ state: 'idle' });

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = (e: MediaQueryListEvent): void => setMatches(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [query]);
  return matches;
}

export default function App() {
  const clientRef = useRef<RingingClient | null>(null);
  const [boot, setBoot] = useState<BootPhase>('waiting');
  const [view, setView] = useState<View>('chat');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [needsUpdate, setNeedsUpdate] = useState(false);
  const [, forceRender] = useState(0);

  const themeMode = useStore(settingsStore, (s) => s.theme);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const fluentTheme = themeMode === 'dark' || (themeMode === 'system' && systemDark) ? webDarkTheme : webLightTheme;

  const activeSeed = useStore(sessionsStore, (s) => s.activeSeed);
  const sessions = useStore(sessionsStore, (s) => s.list);
  const activeTitle = sessions.find((s) => s.seed === activeSeed)?.title ?? '';
  const connState = useStore(
    clientRef.current?.store ?? PENDING_CONNECTION_STORE,
    (s) => s.state,
  );

  useEffect(() => {
    if (clientRef.current) return; // React 18 dev 双调用防抖（未启用 StrictMode，双保险）
    let cancelled = false;
    void (async () => {
      const bridge = await waitForBridge();
      if (cancelled) return;
      if (!bridge) {
        setBoot('no_bridge');
        return;
      }
      const client = new RingingClient(bridge);
      clientRef.current = client;
      bindSettingsClient(client);
      bindTimelineToClient(client);
      listenTimelineReload();

      // control 频道（session_state_changed / session_meta_changed /
      // session_activity_changed）→ 防抖刷新列表（标题由 daemon 生成）
      let refreshTimer: ReturnType<typeof setTimeout> | null = null;
      client.onServerEvent((channel, eventName) => {
        if (channel !== 'control') return;
        if (
          eventName !== 'session_state_changed' &&
          eventName !== 'session_meta_changed' &&
          eventName !== 'session_activity_changed' &&
          eventName !== 'agent_lifecycle_changed'
        ) {
          return;
        }
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          void refreshSessions(client);
        }, 400);
      });

      // epoch 重建（open 内自动 resume）后重新挂载当前会话 timeline
      client.onReattach(() => {
        const seed = sessionsStore.get().activeSeed;
        if (seed) attachTimeline(client, seed);
      });

      setBoot('ready');
      forceRender((n) => n + 1);

      try {
        await client.open();
        await hydrateSettings(client);
        await refreshSessions(client);
        const first = sessionsStore.get().list[0];
        if (first) {
          setActiveSeed(first.seed);
          await client.attachSession(first.seed);
          attachTimeline(client, first.seed);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'UnsupportedVersionError') setNeedsUpdate(true);
        // 其余失败：连接徽标展示错误，用户可手动重连
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const narrow = useMediaQuery('(max-width: 900px)');

  if (boot === 'waiting') {
    return (
      <FluentProvider theme={fluentTheme} className="app-root">
        <div className="splash">
          <div className="splash-inner">
            <Spinner size="medium" />
            <Text size={300}>正在等待 daemon 桥…</Text>
          </div>
        </div>
      </FluentProvider>
    );
  }

  if (boot === 'no_bridge') {
    return (
      <FluentProvider theme={fluentTheme} className="app-root">
        <div className="splash">
          <div className="splash-inner">
            <NavigationRegular fontSize={36} />
            <Text size={300} weight="semibold">
              未检测到 daemon 桥
            </Text>
            <Text size={200} style={{ maxWidth: 380, textAlign: 'center' }}>
              请通过 daemon 的 /debug/ 页面打开本应用（daemon 会注入 __qaqh_bridge__.js），
              或使用 `bun run dev` 启动内置 mock daemon 的开发模式。
            </Text>
            <Button appearance="primary" onClick={() => location.reload()}>
              重试
            </Button>
          </div>
        </div>
      </FluentProvider>
    );
  }

  const client = clientRef.current;
  if (!client) return null;

  const disconnected = connState !== 'ready' && connState !== 'attached';

  /** 切换会话：resume（seed 归属 lease）→ timeline 快照 + 流 */
  const selectSession = (seed: string): void => {
    setActiveSeed(seed);
    void client
      .attachSession(seed)
      .then(() => attachTimeline(client, seed))
      .catch(() => attachTimeline(client, seed)); // resume 失败时 timeline 会以 401 暴露错误
  };

  const sidebar = (
    <Sidebar
      client={client}
      activeSeed={activeSeed}
      onSelect={selectSession}
      onOpenSettings={() => setView('settings')}
      onCloseMobile={narrow ? () => setDrawerOpen(false) : undefined}
      footer={<ConnectionBadge client={client} />}
    />
  );

  return (
    <FluentProvider theme={fluentTheme} className="app-root">
      <div className="app-shell">
        {narrow ? (
          <Drawer open={drawerOpen} position="start" onOpenChange={(_, d) => setDrawerOpen(d.open)}>
            {sidebar}
          </Drawer>
        ) : (
          <aside className="sidebar">{sidebar}</aside>
        )}

        <main className="main">
          {view === 'settings' ? (
            <SettingsPage client={client} onBack={() => setView('chat')} />
          ) : (
            <>
              <header className="chat-header">
                {narrow && (
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<LineHorizontal3Regular />}
                    aria-label="打开会话列表"
                    onClick={() => setDrawerOpen(true)}
                  />
                )}
                <Text className="chat-title" weight="semibold" size={300}>
                  {activeTitle || 'QAQH 控制台'}
                </Text>
                {disconnected && (
                  <Button size="small" appearance="secondary" onClick={() => void client.rebuild('手动重连')}>
                    重新连接
                  </Button>
                )}
                <ConnectionBadge client={client} />
              </header>

              {activeSeed ? (
                <>
                  <ChatArea seed={activeSeed} />
                  <Composer client={client} seed={activeSeed} />
                </>
              ) : (
                <div className="empty-state" style={{ flex: 1 }}>
                  <div className="empty-state-inner">
                    <NavigationRegular fontSize={40} />
                    <Text size={300} weight="semibold">
                      选择或新建一个会话
                    </Text>
                    <Text size={200}>左侧列表选择历史会话，或新建会话开始对话。</Text>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* 协议代差：阻断式提示（426 → 展示"需更新"，停重试） */}
      <Dialog modalType="alert" open={needsUpdate}>
        <DialogSurface aria-modal="true">
          <DialogBody>
            <DialogTitle>客户端需要更新</DialogTitle>
            <DialogContent>
              daemon 返回 426 unsupported_version：当前前端与 qaqh.Ringing 协议存在代差。
              请更新 webUI 后重新打开。
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setNeedsUpdate(false)}>
                知道了
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </FluentProvider>
  );
}
