/**
 * 聊天区（PLAN M3）：timeline 投影渲染 + 吸底滚动 + 顶部翻页
 * （分页走 before_turn 服务端分页，禁止本地"加载更多"猜测 N6）+ 流式 overlay。
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Spinner, Text } from '@fluentui/react-components';
import { ArrowDownRegular, ChatRegular } from '@fluentui/react-icons';
import { getController, useTimelineState } from '../../state/timeline';
import { useStore } from '../../state/store';
import { settingsStore } from '../../state/settings';
import { MessageBubble, StreamingAssistantBubble } from './MessageBubble';
import { ToolCard } from '../tools/ToolCard';

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
    // 顶部翻页（服务端 before_turn 分页）
    const el = scrollRef.current;
    if (el && el.scrollTop < 64 && tl && tl.hasMore && !tl.loadingOlder && tl.items.length > 0) {
      void getController(seed)?.loadOlder(pageSize);
    }
  };

  // 新内容到达时按需吸底
  const lastSeq = tl?.items.length ? tl.items[tl.items.length - 1]!.seq : 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickRef.current && autoScroll) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lastSeq, tl?.streamingText, autoScroll]);

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

          {tl.items.map((item) =>
            item.kind === 'message' ? (
              <MessageBubble key={item.seq} item={item} />
            ) : (
              <ToolCard key={item.seq} item={item} rawOutput={rawToolOutput} />
            ),
          )}

          {tl.streamingText.length > 0 && <StreamingAssistantBubble text={tl.streamingText} />}

          {tl.abortedNote && tl.activeTurn === null && tl.streamingText.length === 0 && (
            <div className="load-older">
              <Text size={200}>⏹ 该回合已被中止</Text>
            </div>
          )}

          {tl.items.length === 0 && tl.streamingText.length === 0 && tl.status === 'ready' && <EmptyHint />}
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
        <Text size={200}>
          发送任意消息开始；包含「搜索」「文件」「失败」「长」的消息会触发不同形态的工具卡片与长文本流式渲染。
        </Text>
      </div>
    </div>
  );
}
