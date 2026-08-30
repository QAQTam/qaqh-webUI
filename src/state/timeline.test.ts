/**
 * block 树 reducer 单测：事件形状取自对 F:\QAQ-Harness 真实 daemon 的
 * 实测帧（2026-08-30 probe）与 timeline.rs 类型镜像。
 */
import { describe, expect, test } from 'bun:test';
import { applyTimelineEntry } from './timeline.ts';
import type { TimelineEntry, TimelineTurn } from '../protocol/types.ts';

function entry(
  timelineSeq: number,
  turnId: string,
  event: TimelineEntry['event'],
  roundNum?: number,
): TimelineEntry {
  return {
    timeline_seq: timelineSeq,
    turn_id: turnId,
    ...(roundNum !== undefined ? { round_num: roundNum } : {}),
    event,
  };
}

const turnOpened: TimelineEntry['event'] = { type: 'turn_opened', user_text: '帮我搜索 v9 迁移要点' };
const toolBlock = {
  block_id: 'tool:call_06c42ae6',
  block_order: 0,
  kind: 'tool' as const,
  state: 'open' as const,
  text: '',
  tool: {
    tool_call_id: 'call_06c42ae6',
    name: 'glob',
    state: 'running' as const,
    args_json: '{"pattern":"*"}',
    progress: '',
  },
};

describe('applyTimelineEntry（block 树 reducer）', () => {
  test('turn_opened 建 turn；timeline_seq 不连续也照常应用', () => {
    let turns = applyTimelineEntry([], entry(1, 't1', turnOpened));
    // 真实 daemon watermark 为全局计数（如 272430），seq 允许跳号
    turns = applyTimelineEntry(turns, entry(272430, 't1', {
      type: 'block_sealed',
      block_id: 'round-0:text:0',
    }, 0));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.user_text).toBe('帮我搜索 v9 迁移要点');
    expect(turns[0]!.state).toBe('running');
  });

  test('block_opened → text_delta 追加 → block_checkpoint 覆盖 → block_sealed', () => {
    let turns = applyTimelineEntry([], entry(1, 't1', turnOpened));
    turns = applyTimelineEntry(turns, entry(2, 't1', {
      type: 'block_opened',
      block: { block_id: 'round-0:text:0', block_order: 0, kind: 'text', state: 'open', text: '' },
    }, 0));
    turns = applyTimelineEntry(turns, entry(3, 't1', {
      type: 'text_delta', block_id: 'round-0:text:0', fragment_seq: 1, delta: '你',
    }, 0));
    turns = applyTimelineEntry(turns, entry(4, 't1', {
      type: 'text_delta', block_id: 'round-0:text:0', fragment_seq: 2, delta: '好',
    }, 0));
    expect(turns[0]!.rounds[0]!.blocks[0]!.text).toBe('你好');
    // checkpoint 自愈：整值覆盖（乱序/丢 delta 后由下一次 checkpoint 修复）
    turns = applyTimelineEntry(turns, entry(5, 't1', {
      type: 'block_checkpoint', block_id: 'round-0:text:0', text: '你好，世界',
    }, 0));
    expect(turns[0]!.rounds[0]!.blocks[0]!.text).toBe('你好，世界');
    turns = applyTimelineEntry(turns, entry(6, 't1', {
      type: 'block_sealed', block_id: 'round-0:text:0',
    }, 0));
    expect(turns[0]!.rounds[0]!.blocks[0]!.state).toBe('sealed');
  });

  test('tool 块：block_opened → tool_progress 追加 → tool_updated 终态', () => {
    let turns = applyTimelineEntry([], entry(1, 't1', turnOpened));
    turns = applyTimelineEntry(turns, entry(2, 't1', { type: 'block_opened', block: toolBlock }, 0));
    turns = applyTimelineEntry(turns, entry(3, 't1', {
      type: 'tool_progress', block_id: 'tool:call_06c42ae6', chunk: 'Cargo.toml\n',
    }, 0));
    turns = applyTimelineEntry(turns, entry(4, 't1', {
      type: 'tool_progress', block_id: 'tool:call_06c42ae6', chunk: 'src/',
    }, 0));
    expect(turns[0]!.rounds[0]!.blocks[0]!.tool!.progress).toBe('Cargo.toml\nsrc/');
    turns = applyTimelineEntry(turns, entry(5, 't1', {
      type: 'tool_updated',
      block_id: 'tool:call_06c42ae6',
      tool: {
        tool_call_id: 'call_06c42ae6',
        name: 'glob',
        state: 'succeeded',
        summary: 'Cargo.toml',
        args_json: '{"pattern":"*"}',
        output: 'Cargo.toml\nsrc/',
        progress: 'Cargo.toml\nsrc/',
      },
    }, 0));
    const tool = turns[0]!.rounds[0]!.blocks[0]!.tool!;
    expect(tool.state).toBe('succeeded');
    expect(tool.output).toBe('Cargo.toml\nsrc/');
    turns = applyTimelineEntry(turns, entry(6, 't1', { type: 'block_sealed', block_id: 'tool:call_06c42ae6' }, 0));
    turns = applyTimelineEntry(turns, entry(7, 't1', { type: 'round_sealed', is_final: true }, 0));
    turns = applyTimelineEntry(turns, entry(8, 't1', { type: 'turn_sealed', state: 'completed' }));
    expect(turns[0]!.sealed).toBe(true);
    expect(turns[0]!.state).toBe('completed');
  });

  test('重复条目幂等；未知 turn 的变更被忽略', () => {
    let turns = applyTimelineEntry([], entry(1, 't1', turnOpened));
    const once = applyTimelineEntry(turns, entry(2, 't1', {
      type: 'block_opened',
      block: { block_id: 'round-0:text:0', block_order: 0, kind: 'text', state: 'open', text: 'a' },
    }, 0));
    const twice = applyTimelineEntry(once, entry(2, 't1', {
      type: 'block_opened',
      block: { block_id: 'round-0:text:0', block_order: 0, kind: 'text', state: 'open', text: 'a' },
    }, 0));
    expect(twice).toEqual(once);
    const untouched = applyTimelineEntry(twice, entry(3, 't-unknown', {
      type: 'text_delta', block_id: 'round-0:text:0', fragment_seq: 1, delta: 'x',
    }, 0));
    expect(untouched).toBe(twice); // 引用相等：不产生新数组
  });

  test('block_order 排序稳定；failed turn 携带 failure', () => {
    let turns: TimelineTurn[] = applyTimelineEntry([], entry(1, 't1', turnOpened));
    turns = applyTimelineEntry(turns, entry(2, 't1', {
      type: 'block_opened',
      block: { block_id: 'round-0:text:1', block_order: 1, kind: 'text', state: 'open', text: '' },
    }, 0));
    turns = applyTimelineEntry(turns, entry(3, 't1', {
      type: 'block_opened',
      block: { block_id: 'round-0:reasoning:0', block_order: 0, kind: 'reasoning', state: 'open', text: 'think' },
    }, 0));
    expect(turns[0]!.rounds[0]!.blocks.map((b: { block_id: string }) => b.block_id)).toEqual([
      'round-0:reasoning:0',
      'round-0:text:1',
    ]);
    turns = applyTimelineEntry(turns, entry(4, 't1', {
      type: 'turn_sealed',
      state: 'failed',
      failure: { code: 'provider', message: 'upstream 429' },
    }));
    expect(turns[0]!.state).toBe('failed');
    expect(turns[0]!.failure?.code).toBe('provider');
  });
});
