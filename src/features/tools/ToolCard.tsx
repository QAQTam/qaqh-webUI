/**
 * 工具 result 卡片：原生 timeline tool 块（TimelineTool）投影。
 * 状态徽标（prepared/running/succeeded/failed）、实时进度流、参数与输出折叠视图；
 * 失败自动展开；"原始输出"设置切换原文视图；diff 块（文件变更工具）展示。
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
  DocumentRegular,
  ErrorCircleRegular,
  GlobeRegular,
  SearchRegular,
  WrenchRegular,
} from '@fluentui/react-icons';
import type { TimelineTool } from '../../protocol/types';

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
  summary: {
    color: tokens.colorNeutralForeground3,
    fontSize: '12px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '320px',
  },
  progress: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    maxHeight: '72px',
    overflowY: 'auto',
    padding: '0 12px 8px',
  },
  cardFailed: {
    ...shorthands.borderColor(tokens.colorPaletteRedBorder1),
  },
});

function toolIcon(name: string) {
  const lower = name.toLowerCase();
  if (/search|web/.test(lower)) return <SearchRegular fontSize={16} />;
  if (/file|read|write|edit|patch|glob/.test(lower)) return <DocumentRegular fontSize={16} />;
  if (/command|shell|code|run|exec|pwsh/.test(lower)) return <CodeRegular fontSize={16} />;
  if (/browse|http|url/.test(lower)) return <GlobeRegular fontSize={16} />;
  return <WrenchRegular fontSize={16} />;
}

function StatusBadge({ tool }: { tool: TimelineTool }) {
  switch (tool.state) {
    case 'prepared':
      return (
        <Badge appearance="tint" color="informative" size="small">
          准备中
        </Badge>
      );
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
  }
}

function parseArgs(argsJson?: string): unknown {
  if (!argsJson) return undefined;
  try {
    return JSON.parse(argsJson) as unknown;
  } catch {
    return argsJson;
  }
}

export function ToolCard({ tool, rawOutput }: { tool: TimelineTool; rawOutput: boolean }) {
  const cls = useClasses();
  const [open, setOpen] = useState(tool.state === 'failed');

  // 失败时自动展开
  useEffect(() => {
    if (tool.state === 'failed') setOpen(true);
  }, [tool.state]);

  const args = parseArgs(tool.args_json);
  const failure = tool.failure;
  const hasDetail =
    args !== undefined || tool.output || failure || tool.diff || tool.permission;

  return (
    <div className="msg-row tool-card-wrap">
      <Card size="small" className={`tool-card ${tool.state === 'failed' ? cls.cardFailed : ''}`}>
        <button
          type="button"
          className={cls.header}
          onClick={() => hasDetail && setOpen((v) => !v)}
          aria-expanded={open}
        >
          {toolIcon(tool.name)}
          <Text className={cls.name}>{tool.name}</Text>
          {tool.summary && !open && <span className={cls.summary}>{tool.summary.split('\n')[0]}</span>}
          <StatusBadge tool={tool} />
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

        {tool.progress && !open && <div className={cls.progress}>{tool.progress}</div>}

        {open && hasDetail && (
          <div className="tool-card-body">
            {tool.permission && (
              <div className="tool-kv">
                <span className="tool-kv-label">权限请求</span>
                <pre>
                  {tool.permission.reason}
                  {tool.permission.paths.length > 0 ? `\n路径: ${tool.permission.paths.join(', ')}` : ''}
                </pre>
              </div>
            )}
            {rawOutput ? (
              <pre>{JSON.stringify({ args, tool }, null, 2)}</pre>
            ) : (
              <>
                {args !== undefined && (
                  <div className="tool-kv">
                    <span className="tool-kv-label">参数</span>
                    <pre>{typeof args === 'string' ? args : JSON.stringify(args, null, 2)}</pre>
                  </div>
                )}
                {tool.output && (
                  <div className="tool-kv">
                    <span className="tool-kv-label">输出</span>
                    <pre>{tool.output}</pre>
                  </div>
                )}
                {tool.diff && (
                  <div className="tool-kv">
                    <span className="tool-kv-label">变更</span>
                    <pre>{tool.diff}</pre>
                  </div>
                )}
                {failure && (
                  <div className="tool-kv">
                    <span className="tool-kv-label">错误</span>
                    <pre>
                      {failure.code ? `${failure.code}: ` : ''}
                      {failure.message}
                    </pre>
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
