/** 消息气泡：user / assistant，支持流式光标与附件 chips（样式见 styles.css .bubble） */
import { DocumentRegular } from '@fluentui/react-icons';
import type { ContentRef, MessageItem } from '../../protocol/types';
import { formatClock } from '../../utils/format';

export interface StreamingBubbleProps {
  text: string;
}

export function MessageBubble({ item }: { item: MessageItem }) {
  const isUser = item.role === 'user';
  return (
    <div className={`msg-row ${isUser ? 'user' : ''}`}>
      <div className={`bubble ${isUser ? 'user' : 'assistant'}`}>
        {item.text}
        {item.attachments && item.attachments.length > 0 && (
          <div className="attach-row">
            {item.attachments.map((ref) => (
              <AttachmentChip key={ref.content_id} ref_={ref} />
            ))}
          </div>
        )}
        <div className="msg-meta">
          <span>{formatClock(item.created_at)}</span>
          {item.turn > 0 && <span>turn {item.turn}</span>}
        </div>
      </div>
    </div>
  );
}

export function StreamingAssistantBubble({ text }: StreamingBubbleProps) {
  return (
    <div className="msg-row">
      <div className="bubble assistant streaming">{text}</div>
    </div>
  );
}

function AttachmentChip({ ref_ }: { ref_: ContentRef }) {
  const name = ref_.media_type.split('/').pop() ?? 'file';
  return (
    <span className="attach-chip" title={`content_id: ${ref_.content_id}`}>
      <DocumentRegular fontSize={14} />
      {name} · {ref_.sha256.slice(0, 8)}
    </span>
  );
}
