/**
 * transcript 渲染：原生 TimelineTurn → 用户气泡 + round 内 block 序列
 * （reasoning 折叠思考 / text 正文 / tool 卡片 / notice 提示）。
 * 渲染顺序以 timeline writer 为准（block_order），不按事件到达序。
 * Markdown 只在块 sealed 后渲染为正文（open 态按纯文本流式展示）。
 */
import { useState } from 'react';
import { Badge, makeStyles, tokens } from '@fluentui/react-components';
import { ChevronDownRegular, ChevronRightRegular, InfoRegular } from '@fluentui/react-icons';
import type { TimelineBlock, TimelineTool, TimelineTurn } from '../../protocol/types';
import { ToolCard } from '../tools/ToolCard';

const useClasses = makeStyles({
  details: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    color: tokens.colorNeutralForeground3,
    fontSize: '11px',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    font: 'inherit',
    padding: '2px 0',
    textAlign: 'left',
  },
  thinkingBody: {
    margin: '4px 0 0',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: '12px',
    lineHeight: '1.6',
  },
});

export function TurnView(props: { turn: TimelineTurn; rawToolOutput: boolean }) {
  const { turn, rawToolOutput } = props;
  const failed = turn.state === 'failed';
  return (
    <div className="turn-view">
      <div className="msg-row user">
        <div className={`bubble user ${failed ? 'turn-failed' : ''}`}>{turn.user_text}</div>
      </div>
      {turn.rounds.map((round) => (
        <div key={round.round_num} className="round-view">
          {round.blocks.map((block) => (
            <BlockView key={block.block_id} block={block} rawToolOutput={rawToolOutput} />
          ))}
        </div>
      ))}
      {failed && turn.failure && (
        <div className="msg-row">
          <div className="bubble assistant turn-failed">回合失败：{turn.failure.message}</div>
        </div>
      )}
    </div>
  );
}

function BlockView({ block, rawToolOutput }: { block: TimelineBlock; rawToolOutput: boolean }) {
  switch (block.kind) {
    case 'reasoning':
      return <ReasoningBlock block={block} />;
    case 'tool':
      return block.tool ? (
        <ToolCard tool={block.tool} rawOutput={rawToolOutput} />
      ) : null;
    case 'notice':
      return <NoticeBlock block={block} />;
    case 'text':
    default:
      return <TextBlock block={block} />;
  }
}

/** 正文块：open 态纯文本 + 流式光标；sealed 态同 Markdown 视图 */
function TextBlock({ block }: { block: TimelineBlock }) {
  const streaming = block.state === 'open';
  return (
    <div className="msg-row">
      <div className={`bubble assistant ${streaming ? 'streaming' : ''}`}>{block.text}</div>
    </div>
  );
}

/** 思考块：可折叠，默认收起（sealed 后）；流式进行中默认展开 */
function ReasoningBlock({ block }: { block: TimelineBlock }) {
  const cls = useClasses();
  const streaming = block.state === 'open';
  const [open, setOpen] = useState(false);
  const expanded = open || streaming;
  if (!block.text && !streaming) return null;
  return (
    <div className="msg-row thinking-wrap">
      <div className={`thinking ${streaming ? 'streaming' : ''}`}>
        <button
          type="button"
          className={cls.details}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDownRegular fontSize={12} /> : <ChevronRightRegular fontSize={12} />}
          思考过程{streaming ? '（生成中）' : ''}
        </button>
        {expanded && <div className={cls.thinkingBody}>{block.text}</div>}
      </div>
    </div>
  );
}

function NoticeBlock({ block }: { block: TimelineBlock }) {
  return (
    <div className="msg-row">
      <div className="notice-row">
        <InfoRegular fontSize={14} />
        <span>{block.text}</span>
      </div>
    </div>
  );
}

/** 回合终止态徽标（cancelled 展示提示，completed/failed 由 turn 内块自明） */
export function TurnStateBadge({ turn }: { turn: TimelineTurn }) {
  if (turn.state === 'cancelled') {
    return (
      <Badge appearance="tint" color="informative" size="small">
        已取消
      </Badge>
    );
  }
  if (turn.state === 'failed') {
    return (
      <Badge appearance="tint" color="danger" size="small">
        失败
      </Badge>
    );
  }
  return null;
}

/** 兼容旧导出名的工具类型 re-export（ToolCard 消费） */
export type { TimelineTool };
