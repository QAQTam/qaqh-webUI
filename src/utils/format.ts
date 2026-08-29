/** 展示格式化工具 */

export function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(t);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatClock(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return '';
  const s = Date.parse(startedAt);
  const e = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return '';
  const ms = Math.max(0, e - s);
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 截短 uuid 类 id 便于展示 */
export function shortId(id: string, head = 8): string {
  return id.length <= head + 4 ? id : `${id.slice(0, head)}…`;
}
