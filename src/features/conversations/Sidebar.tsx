/**
 * 对话管理侧栏（PLAN M5）：服务面 session.list + 生命周期命令（N5）。
 * 新建 / 搜索 / 切换 / 归档 / 删除；标题由 daemon 自动生成（协议无 rename 命令）。
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Spinner,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  AddRegular,
  ArchiveRegular,
  ChatMultipleRegular,
  DeleteRegular,
  MoreHorizontalRegular,
  SearchRegular,
  SettingsRegular,
} from '@fluentui/react-icons';
import type { RingingClient } from '../../daemon/client';
import {
  archiveSession,
  createSession,
  deleteSession,
  setActiveSeed,
  sessionsStore,
  unarchiveSession,
} from '../../state/sessions';
import { useStore } from '../../state/store';
import { formatRelativeTime } from '../../utils/format';

const useClasses = makeStyles({
  newBtn: {
    width: '100%',
  },
  empty: {
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    padding: '24px 12px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '8px',
  },
  meta: {
    marginLeft: 'auto',
    flex: 'none',
  },
});

export function Sidebar(props: {
  client: RingingClient;
  activeSeed: string | null;
  onSelect: (seed: string) => void;
  onOpenSettings: () => void;
  onCloseMobile?: () => void;
  footer?: ReactNode;
}) {
  const { client, activeSeed, onSelect, onOpenSettings, onCloseMobile } = props;
  const cls = useClasses();
  const list = useStore(sessionsStore, (s) => s.list);
  const loading = useStore(sessionsStore, (s) => s.loading);
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<{ seed: string; title: string } | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (s) => (s.title ?? '').toLowerCase().includes(q) || s.last_summary.toLowerCase().includes(q),
    );
  }, [list, query]);

  const handleNew = (): void => {
    void createSession(client).then((seed) => {
      if (seed) {
        setActiveSeed(seed);
        onSelect(seed);
        onCloseMobile?.();
      }
    });
  };

  return (
    <>
      <div className="sidebar-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <ChatMultipleRegular fontSize={16} />
          </span>
          <Text weight="semibold" size={300}>
            QAQH 控制台
          </Text>
        </div>
        <Tooltip content="设置" relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={<SettingsRegular />}
            aria-label="打开设置"
            onClick={onOpenSettings}
          />
        </Tooltip>
      </div>

      <div className="sidebar-actions">
        <Button
          className={cls.newBtn}
          appearance="primary"
          icon={<AddRegular />}
          onClick={handleNew}
          disabled={!client.isReady}
        >
          新建会话
        </Button>
        <Input
          size="small"
          contentBefore={<SearchRegular fontSize={14} />}
          placeholder="搜索会话"
          value={query}
          onChange={(_, data) => setQuery(data.value)}
          aria-label="搜索会话"
        />
      </div>

      <nav className="conv-list" aria-label="会话列表">
        {loading && list.length === 0 && (
          <div className={cls.empty}>
            <Spinner size="small" />
            <Text size={200}>正在加载会话…</Text>
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div className={cls.empty}>
            <ChatMultipleRegular fontSize={28} />
            <Text size={200}>{query ? '没有匹配的会话' : '暂无会话，点击上方新建'}</Text>
          </div>
        )}
        {filtered.map((s) => (
          <ConversationItem
            key={s.seed}
            seed={s.seed}
            title={s.title ?? s.last_summary.split('\n')[0] ?? ''}
            updatedAt={s.updated_at}
            archived={s.archived}
            running={s.running}
            active={s.seed === activeSeed}
            onSelect={() => {
              setActiveSeed(s.seed);
              onSelect(s.seed);
              onCloseMobile?.();
            }}
            onArchive={() => void archiveSession(client, s.seed)}
            onUnarchive={() => void unarchiveSession(client, s.seed)}
            onDelete={() => setDeleting({ seed: s.seed, title: s.title ?? s.seed })}
          />
        ))}
      </nav>

      <div className="sidebar-footer">{props.footer}</div>

      {/* 删除确认 */}
      <Dialog
        open={deleting !== null}
        onOpenChange={(_, data) => {
          if (!data.open) setDeleting(null);
        }}
      >
        <DialogSurface aria-modal="true">
          <DialogBody>
            <DialogTitle>删除会话</DialogTitle>
            <DialogContent>
              确定删除「{deleting?.title}」？该会话的 transcript 将从磁盘移除，不可恢复。
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDeleting(null)}>
                取消
              </Button>
              <Button
                appearance="primary"
                icon={<DeleteRegular />}
                onClick={() => {
                  if (!deleting) return;
                  void deleteSession(client, deleting.seed);
                  setDeleting(null);
                }}
              >
                删除
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

function ConversationItem(props: {
  seed: string;
  title: string;
  updatedAt: number;
  archived: boolean;
  running: boolean;
  active: boolean;
  onSelect: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
}) {
  const cls = useClasses();
  const [menuOpen, setMenuOpen] = useState(false);
  // 注意：不能 button 嵌 button（非法 HTML）——外层用 div[role=button] 承载选择行为
  return (
    <div
      role="button"
      tabIndex={0}
      className={`conv-item ${props.active ? 'active' : ''} ${menuOpen ? 'menu-open' : ''}`}
      onClick={props.onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onSelect();
        }
      }}
      title={props.title}
      aria-current={props.active ? 'true' : undefined}
    >
      <ChatMultipleRegular fontSize={16} />
      <span className="conv-text">
        <span className="conv-title">
          {props.title || '未命名会话'}
          {props.running ? ' ·' : ''}
        </span>
        <span className="conv-meta">
          {props.archived ? '已归档 · ' : ''}
          {formatRelativeTime(props.updatedAt)}
        </span>
      </span>
      <span
        className="conv-menu"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        <Menu open={menuOpen} onOpenChange={(_, d) => setMenuOpen(d.open)}>
          <MenuTrigger disableButtonEnhancement>
            <Button
              appearance="subtle"
              size="small"
              icon={<MoreHorizontalRegular />}
              aria-label={`会话操作：${props.title}`}
              className={cls.meta}
            />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {props.archived ? (
                <MenuItem icon={<ChatMultipleRegular />} onClick={props.onUnarchive}>
                  恢复会话
                </MenuItem>
              ) : (
                <MenuItem icon={<ArchiveRegular />} onClick={props.onArchive}>
                  归档
                </MenuItem>
              )}
              <MenuItem icon={<DeleteRegular />} onClick={props.onDelete}>
                删除
              </MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      </span>
    </div>
  );
}
