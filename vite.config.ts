import { defineConfig } from 'vite';
import { mockDaemon } from './mocks/mock-daemon-plugin.ts';

// QAQH_DEV_DAEMON=http://127.0.0.1:PORT 时走真实 daemon（/ringing 与桥脚本代理），
// 否则默认启用内置 mock daemon（mocks/mock-daemon-plugin.ts），便于无后端开发与冒烟。
const daemonUrl = process.env.QAQH_DEV_DAEMON;

export default defineConfig({
  // 协议约束：产物内部资源引用必须相对（daemon 在 /debug/ 前缀下托管）
  base: './',
  plugins: daemonUrl ? [] : [mockDaemon()],
  server: {
    port: Number(process.env.QAQH_DEV_PORT ?? 5173),
    proxy: daemonUrl
      ? {
          '/ringing': { target: daemonUrl, changeOrigin: false },
          // daemon 把桥脚本挂在 /debug/ 前缀下；dev 代理模式页面在根路径，
          // bridge.ts 相对注入 ./__qaqh_bridge__.js → 重写到 daemon 的真实路径
          '/__qaqh_bridge__.js': {
            target: daemonUrl,
            changeOrigin: false,
            rewrite: () => '/debug/__qaqh_bridge__.js',
          },
        }
      : undefined,
  },
  build: {
    // 协议约束：构建产物落在 out/renderer（build.rs 同步与安装器收集均以此为准）
    outDir: 'out/renderer',
    emptyOutDir: true,
    target: 'es2022',
  },
});
