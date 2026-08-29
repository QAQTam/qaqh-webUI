/**
 * 工具 result 卡片：tool 频道事件 + timeline 规范条目投影。
 * 状态徽标（running/succeeded/failed/cancelled）、时长、参数与输出折叠视图；
 * 失败自动展开；"原始输出"设置切换 JSON 原文视图。
 */
import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  shorthands,
  Spinner,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  CheckmarkCircleRegular,
  ChevronDownRegular,
  ChevronRightRegular,
  CodeRegular,
  DismissCircleRegular,
  DocumentRegular,
  ErrorCircleRegular,
  GlobeRegular,
  SearchRegular,
  WrenchRegular,
} from '@fluentui/react-icons';
import type { ToolItem } from '../../protocol/types';
import { formatDuration } from '../../utils/format';

const useClasses = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '10px 12px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    font: 'inherit',
    color: 'inherit',
    textAlign: 'left',
    borderRadius: tokens.borderRadiusLarge,
  },
  name: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: '13px',
  },
  duration: {
    color: tokens.colorNeutralForeground3,
    fontSize: '11px',
    marginLeft: 'auto',
  },
  errorText: {
    color: tokens.colorPaletteRedForeground1,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  cardFailed: {
    ...shorthands.borderColor(tokens.colorPaletteRedBorder1),
  },
});

function toolIcon(name: string) {
  const lower = name.toLowerCase();
  if (/search|web/.test(lower)) return <SearchRegular fontSize={16} />;
  if (/file|read|write|edit|patch/.test(lower)) return <DocumentRegular fontSize={16} />;
  if (/command|shell|code|run|exec/.test(lower)) return <CodeRegular fontSize={16} />;
  if (/browse|http|url/.test(lower)) return <GlobeRegular fontSize={16} />;
  return <WrenchRegular fontSize={16} />;
}

function StatusBadge({ item }: { item: ToolItem }) {
  switch (item.status) {
    case 'running':
      return (
        <>
          <Spinner size="extra-tiny" />
          <Badge appearance="tint" color="brand" size="small">
            运行中
          </Badge>
        </>
      );
    case 'succeeded':
      return (
        <Badge appearance="tint" color="success" size="small" icon={<CheckmarkCircleRegular />}>
          成功
        </Badge>
      );
    case 'failed':
      return (
        <Badge appearance="tint" color="danger" size="small" icon={<ErrorCircleRegular />}>
          失败
        </Badge>
      );
    case 'cancelled':
      return (
        <Badge appearance="tint" color="informative" size="small" icon={<DismissCircleRegular />}>
          已取消
        </Badge>
      );
  }
}

export function ToolCard({ item, rawOutput }: { item: ToolItem; rawOutput: boolean }) {
  const cls = useClasses();
  const [open, setOpen] = useState(item.status === 'failed');

  // 失败/取消时自动展开；完成时若未展开则保持收起
  useEffect(() => {
    if (item.status === 'failed') setOpen(true);
  }, [item.status]);

  const hasDetail = item.args !== undefined || item.output || item.error;

  return (
    <div className="msg-row tool-card-wrap">
      <Card size="small" className={`tool-card ${item.status === 'failed' ? cls.cardFailed : ''}`}>
        <button
          type="button"
          className={cls.header}
          onClick={() => hasDetail && setOpen((v) => !v)}
          aria-expanded={open}
        >
          {toolIcon(item.name)}
          <Text className={cls.name}>{item.name}</Text>
          <StatusBadge item={item} />
          <span className={cls.duration}>{formatDuration(item.started_at, item.finished_at)}</span>
          {hasDetail && (
            <Tooltip content={open ? '收起详情' : '展开详情'} relationship="label">
              <Button
                appearance="subtle"
                size="small"
                icon={open ? <ChevronDownRegular /> : <ChevronRightRegular />}
                aria-label={open ? '收起详情' : '展开详情'}
              />
            </Tooltip>
          )}
        </button>

        {open && hasDetail && (
          <div className="tool-card-body">
            {rawOutput ? (
              <pre>{JSON.stringify({ args: item.args, output: item.output, error: item.error }, null, 2)}</pre>
            ) : (
              <>
                {item.args !== undefined && (
                  <div className="tool-kv">
                    <span className="tool-kv-label">参数</span>
                    <pre>{JSON.stringify(item.args, null, 2)}</pre>
                  </div>
                )}
                {item.output && (
                  <div className="tool-kv">
                    <span className="tool-kv-label">输出</span>
                    <pre>{item.output}</pre>
                  </div>
                )}
                {item.error && (
                  <div className="tool-kv">
                    <span className="tool-kv-label">错误</span>
                    <span className={cls.errorText}>{item.error}</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
