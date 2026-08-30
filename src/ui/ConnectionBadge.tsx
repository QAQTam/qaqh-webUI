/** 连接状态徽标：消费 RingingClient.store 快照 */
import { Badge, Text, Spinner, makeStyles, tokens } from '@fluentui/react-components';
import { useStore } from '../state/store';
import type { RingingClient } from '../daemon/client';
import type { ConnectionState } from '../daemon/client';

const LABELS: Record<ConnectionState, string> = {
  idle: '未连接',
  opening: '连接中',
  ready: '已连接',
  attached: '已连接',
  reopening: '重连中',
  needs_update: '需更新',
  unauthorized: '未授权',
};

const COLORS: Record<ConnectionState, 'success' | 'brand' | 'danger' | 'severe' | 'informative'> = {
  idle: 'informative',
  opening: 'brand',
  ready: 'success',
  attached: 'success',
  reopening: 'severe',
  needs_update: 'danger',
  unauthorized: 'danger',
};

const useClasses = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  epoch: {
    color: tokens.colorNeutralForeground3,
    fontSize: '11px',
  },
});

export function ConnectionBadge({ client }: { client: RingingClient }) {
  const cls = useClasses();
  const state = useStore(client.store, (s) => s.state);
  const epoch = useStore(client.store, (s) => s.epoch);
  const pending = state === 'opening' || state === 'reopening';
  return (
    <div className={cls.root}>
      {pending && <Spinner size="extra-tiny" />}
      <Badge appearance="filled" color={COLORS[state]} size="small">
        {LABELS[state]}
      </Badge>
      {epoch && (
        <Text size={200} className={cls.epoch}>
          epoch {epoch.slice(0, 8)}
        </Text>
      )}
    </div>
  );
}
