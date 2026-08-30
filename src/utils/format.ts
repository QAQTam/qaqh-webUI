/** 展示格式化工具 */

/** 相对时间：接受 unix 秒 / unix 毫秒 / ISO 字符串 */
export function formatRelativeTime(input: string | number): string {
  let t: number;
  if (typeof input === 'number') {
    // unix 秒（daemon session.list 约定）自动放大为毫秒
    t = input < 1e12 ? input * 1000 : input;
  } else {
    t = Date.parse(input);
  }
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(t);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 时钟：接受 unix 秒 / unix 毫秒 / ISO 字符串 */
export function formatClock(input: string | number): string {
  const t = typeof input === 'number' ? (input < 1e12 ? input * 1000 : input) : Date.parse(input);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 毫秒时长展示 */
export function formatDurationMs(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
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
