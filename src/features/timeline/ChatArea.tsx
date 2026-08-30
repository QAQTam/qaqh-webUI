/**
 * 聊天区（PLAN M3）：原生 timeline turn 序列渲染 + 吸底滚动 + 顶部上翻
 * （before_turn 快照分页，禁 load_more 命令 N6）+ provider 重试/中止提示。
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Spinner, Text } from '@fluentui/react-components';
import { ArrowDownRegular, ChatRegular } from '@fluentui/react-icons';
import { getController, useTimelineState } from '../../state/timeline';
import { useStore } from '../../state/store';
import { settingsStore } from '../../state/settings';
import { TurnView } from './MessageBubble';

const STICK_THRESHOLD_PX = 64;

export function ChatArea({ seed }: { seed: string }) {
  const tl = useTimelineState(seed);
  const autoScroll = useStore(settingsStore, (s) => s.autoScroll);
  const rawToolOutput = useStore(settingsStore, (s) => s.rawToolOutput);
  const pageSize = useStore(settingsStore, (s) => s.timelinePageSize);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const atBottom = (): boolean => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  };

  const onScroll = (): void => {
    stickRef.current = atBottom();
    setShowJump(!stickRef.current);
    // 顶部上翻（服务端 before_turn 快照分页）
    const el = scrollRef.current;
    if (el && el.scrollTop < 64 && tl && tl.hasMore && !tl.loadingOlder && tl.turns.length > 0) {
      void getController(seed)?.loadOlder(pageSize);
    }
  };

  // 新内容到达时按需吸底：turn 数或最后一个 turn 的块结构变化都触发
  const turnsLen = tl?.turns.length ?? 0;
  const lastTurn = tl?.turns[turnsLen - 1];
  const lastSignature = lastTurn
    ? `${lastTurn.turn_id}:${lastTurn.rounds.length}:${
        lastTurn.rounds[lastTurn.rounds.length - 1]?.blocks.length ?? 0
      }:${lastTurn.rounds[lastTurn.rounds.length - 1]?.blocks.map((b) => b.text.length).join(',')}`
    : '';
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickRef.current && autoScroll) {
      el.scrollTop = el.scrollHeight;
    }
  }, [turnsLen, lastSignature, autoScroll]);

  if (!tl || tl.status === 'loading') {
    return (
      <div className="chat-main">
        <div className="splash">
          <Spinner size="medium" />
          <Text size={200}>正在加载会话…</Text>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-main">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-scroll-inner">
          {tl.status === 'error' && (
            <div className="load-older">
              <Text size={200} role="alert">
                timeline 加载失败：{tl.error}
              </Text>
              <Button
                size="small"
                appearance="secondary"
                onClick={() => {
                  stickRef.current = true;
                  window.dispatchEvent(new CustomEvent('qaqh.timeline.reload', { detail: seed }));
                }}
              >
                重试
              </Button>
            </div>
          )}
          {tl.loadingOlder && (
            <div className="load-older">
              <Spinner size="extra-tiny" />
            </div>
          )}

          {tl.turns.map((turn) => (
            <TurnView key={turn.turn_id} turn={turn} rawToolOutput={rawToolOutput} />
          ))}

          {tl.providerRetry && (
            <div className="load-older">
              <Text size={200}>
                模型请求重试中（{tl.providerRetry.attempt}/{tl.providerRetry.maxRetries}，将等待{' '}
                {tl.providerRetry.delaySecs}s）：{tl.providerRetry.message}
              </Text>
            </div>
          )}

          {tl.abortedNote && tl.activeTurnId === null && (
            <div className="load-older">
              <Text size={200}>⏹ 该回合已被中止</Text>
            </div>
          )}

          {tl.turns.length === 0 && tl.status === 'ready' && <EmptyHint />}
        </div>
      </div>

      {showJump && (
        <Button
          className="jump-btn"
          shape="circular"
          appearance="primary"
          icon={<ArrowDownRegular />}
          aria-label="回到底部"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            stickRef.current = true;
            setShowJump(false);
          }}
        />
      )}
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="empty-state" style={{ flex: 'none', padding: '48px 0' }}>
      <div className="empty-state-inner">
        <ChatRegular fontSize={40} />
        <Text size={300} weight="semibold">
          开始对话
        </Text>
        <Text size={200}>发送任意消息开始与 agent 对话；工具调用会以卡片形式实时展示进度与结果。</Text>
      </div>
    </div>
  );
}
