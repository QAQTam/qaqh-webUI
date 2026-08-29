/**
 * 输入框（PLAN M4）：
 *  - Enter 发送 / Shift+Enter 换行 / IME 组合期不误发（compositionstart/end）
 *  - 流式期间切换为"中止"按钮（turn.abort，conversation 频道）
 *  - 附件：POST /ringing/v1/content（multipart）→ ContentRef，命令中只传 ref（§2.7）
 *  - 草稿按会话保留（内存）；断连时禁用
 */
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  shorthands,
  Spinner,
  Text,
  Textarea,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AttachRegular, DismissRegular, SendFilled, SendRegular, StopRegular } from '@fluentui/react-icons';
import type { RingingClient } from '../../daemon/client';
import { isTurnActive, sendUserMessage, abortActiveTurn, useTimelineState } from '../../state/timeline';
import { useStore } from '../../state/store';
import type { ContentRef } from '../../protocol/types';
import { formatBytes } from '../../utils/format';

const useClasses = makeStyles({
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    padding: '4px 8px',
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
  },
  chipError: {
    color: tokens.colorPaletteRedForeground1,
    ...shorthands.borderColor(tokens.colorPaletteRedBorder1),
  },
  sendBtn: {
    flex: 'none',
  },
  hint: {
    marginLeft: 'auto',
  },
});

interface AttachmentItem {
  key: string;
  name: string;
  size: number;
  state: 'uploading' | 'done' | 'error';
  ref?: ContentRef;
  error?: string;
}

export function Composer({ client, seed }: { client: RingingClient; seed: string }) {
  const cls = useClasses();
  const connState = useStore(client.store, (s) => s.state);
  const tl = useTimelineState(seed);
  const connected = connState === 'ready' || connState === 'attached';
  const active = isTurnActive(tl);
  const pendingSend = tl?.pendingSend ?? false;

  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [composing, setComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftsRef = useRef(new Map<string, string>());

  // 切换会话时恢复该会话草稿
  useEffect(() => {
    setDraft(draftsRef.current.get(seed) ?? '');
  }, [seed]);

  const updateDraft = (value: string): void => {
    setDraft(value);
    draftsRef.current.set(seed, value);
  };

  // 自动伸缩（Fluent Textarea 根元素即 <textarea>）
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  const canSend = connected && !active && (draft.trim().length > 0 || attachments.some((a) => a.state === 'done'));

  const doSend = async (): Promise<void> => {
    if (!canSend || pendingSend) return;
    const text = draft.trim();
    const refs = attachments.filter((a) => a.state === 'done' && a.ref).map((a) => a.ref!);
    setDraft('');
    setAttachments([]);
    draftsRef.current.set(seed, '');    try {
      await sendUserMessage(client, seed, text, refs);
    } catch {
      // 发送失败：恢复草稿避免内容丢失
      setDraft(text);
      setAttachments(attachments);
    }
    textareaRef.current?.focus();
  };

  const doStop = (): void => {
    void abortActiveTurn(client, seed).catch(() => undefined);
  };

  const onFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const key = `${file.name}-${Date.now()}-${Math.random()}`;
      setAttachments((list) => [...list, { key, name: file.name, size: file.size, state: 'uploading' }]);
      try {
        const ref = await client.uploadContent(file);
        setAttachments((list) => list.map((a) => (a.key === key ? { ...a, state: 'done', ref } : a)));
      } catch (err) {
        setAttachments((list) =>
          list.map((a) => (a.key === key ? { ...a, state: 'error', error: err instanceof Error ? err.message : '上传失败' } : a)),
        );
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        {attachments.length > 0 && (
          <div className={cls.chips}>
            {attachments.map((a) => (
              <span key={a.key} className={`${cls.chip} ${a.state === 'error' ? cls.chipError : ''}`}>
                {a.state === 'uploading' && <Spinner size="extra-tiny" />}
                <span title={a.ref?.content_id}>
                  {a.name} · {formatBytes(a.size)}
                </span>
                {a.state === 'error' && <span>（{a.error}）</span>}
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<DismissRegular />}
                  aria-label={`移除附件 ${a.name}`}
                  onClick={() => setAttachments((list) => list.filter((x) => x.key !== a.key))}
                />
              </span>
            ))}
          </div>
        )}

        <div className="composer">
          <Tooltip content="添加附件" relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<AttachRegular />}
              aria-label="添加附件"
              disabled={!connected || active}
              onClick={() => fileInputRef.current?.click()}
            />
          </Tooltip>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => void onFiles(e.target.files)}
          />

          <Textarea
            className="composer-textarea"
            ref={textareaRef}
            rows={1}
            resize="none"
            placeholder={
              connected
                ? active
                  ? '正在生成回复…'
                  : '输入消息，Enter 发送，Shift+Enter 换行'
                : '未连接到 daemon…'
            }
            disabled={!connected}
            value={draft}
            onChange={(_, data) => updateDraft(data.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !composing) {
                e.preventDefault();
                void doSend();
              }
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            aria-label="消息输入框"
          />

          {active ? (
            <Tooltip content="中止当前回合" relationship="label">
              <Button
                className={cls.sendBtn}
                appearance="primary"
                shape="circular"
                icon={<StopRegular />}
                onClick={doStop}
                disabled={!connected}
                aria-label="中止"
              />
            </Tooltip>
          ) : (
            <Tooltip content="发送" relationship="label">
              <Button
                className={cls.sendBtn}
                appearance="primary"
                shape="circular"
                icon={pendingSend ? <SendRegular /> : <SendFilled />}
                disabled={!canSend}
                onClick={() => void doSend()}
                aria-label="发送"
              />
            </Tooltip>
          )}
        </div>

        <div className="composer-hints">
          <Text size={200}>
            {draft.length > 0 && `已输入 ${draft.length} 字 · `}
            {active ? '生成中，可中止' : 'Enter 发送 · Shift+Enter 换行'}
          </Text>
        </div>
      </div>
    </div>
  );
}
