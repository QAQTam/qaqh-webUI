/**
 * 端点路径 builder：全部协议 URL 字面量集中于此（禁止散落）。
 * base 由 daemon 托管形态决定：同源（/debug/ 前缀）或 bridge 提供的 base_url。
 */
import type { Channel } from './types';

export function endpointOpen(base: string): string {
  return `${base}/ringing/v1/clients/open`;
}

export function endpointRenew(base: string): string {
  return `${base}/ringing/v1/leases/renew`;
}

export function endpointEvents(base: string, channel: Channel): string {
  return `${base}/ringing/v1/events/${channel}`;
}

export function endpointCommands(base: string, channel: Channel): string {
  return `${base}/ringing/v1/commands/${channel}`;
}

export function endpointBootstrap(base: string, seed: string): string {
  return `${base}/ringing/v1/sessions/${encodeURIComponent(seed)}/bootstrap`;
}

export function endpointTimeline(base: string, seed: string): string {
  return `${base}/ringing/v1/sessions/${encodeURIComponent(seed)}/timeline`;
}

/** timeline 快照分页：before_turn=<turn_id>&limit（默认 30，上限 200） */
export function endpointTimelinePage(
  base: string,
  seed: string,
  opts: { beforeTurn?: string; limit?: number } = {},
): string {
  const q = new URLSearchParams();
  if (opts.beforeTurn) q.set('before_turn', opts.beforeTurn);
  if (opts.limit != null) q.set('limit', String(opts.limit));
  const qs = q.toString();
  return endpointTimeline(base, seed) + (qs ? `?${qs}` : '');
}

/** 命令收据（ack 丢失/断线后查终态） */
export function endpointCommandStatus(base: string, commandId: string): string {
  return `${base}/ringing/v1/commands/${encodeURIComponent(commandId)}`;
}

export function endpointTimelineEvents(base: string, seed: string): string {
  return `${base}/ringing/v1/sessions/${encodeURIComponent(seed)}/timeline/events`;
}

export function endpointContent(base: string): string {
  return `${base}/ringing/v1/content`;
}

export function endpointService(base: string, method: string): string {
  return `${base}/ringing/v1/service/${method}`;
}
