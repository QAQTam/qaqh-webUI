/**
 * 浏览器模式 provider（PLAN M2）：token 只来自 `window.__QAQH_DEBUG__`，
 * 该值由 daemon 注入的 `./__qaqh_bridge__.js` 写入（N3：仅内存持有，
 * 禁止写入 storage / 日志 / URL）。
 */

/** TODO(对照后端)：以 __qaqh_bridge__.js 实际写入字段为准 */
export interface DebugBridge {
  token: string;
  /** daemon 非同源托管时的 API 前缀；缺省 = 同源（/debug/ 托管形态） */
  base_url?: string;
}

declare global {
  interface Window {
    __QAQH_DEBUG__?: DebugBridge;
  }
}

function injectBridgeScript(): Promise<boolean> {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = './__qaqh_bridge__.js';
    script.async = false;
    const done = (ok: boolean) => {
      script.onload = null;
      script.onerror = null;
      script.remove();
      resolve(ok);
    };
    script.onload = () => done(!!window.__QAQH_DEBUG__);
    script.onerror = () => done(false);
    document.head.appendChild(script);
  });
}

/**
 * 等待桥脚本就绪：daemon 托管形态下注入发生在页面加载期，
 * 这里兜底动态注入一次（开发模式 / 直开产物均适用）。
 */
export async function waitForBridge(timeoutMs = 5000): Promise<DebugBridge | null> {
  if (window.__QAQH_DEBUG__) return window.__QAQH_DEBUG__;
  const start = performance.now();
  await injectBridgeScript();
  while (!window.__QAQH_DEBUG__ && performance.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return window.__QAQH_DEBUG__ ?? null;
}
