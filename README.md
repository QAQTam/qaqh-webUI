# qaqh-webUI

QAQ-Harness 的浏览器 webUI（`qaqh.Ringing` 协议前端重写）。协议契约、
里程碑与验收标准见 [PLAN.md](./PLAN.md)；本 README 只覆盖工程使用。

## 技术栈（所有者指定，2026-08-29 锁定）

| 项 | 版本 | 说明 |
| --- | --- | --- |
| 运行时/包管理 | bun 1.4.0 | 脚本、测试（bun test）、依赖 |
| 构建 | Vite 8.2.2 | Rolldown 内核（Vite 8 起合并 rolldown-vite） |
| 语言 | TypeScript 7.0.2 | TS7 native 编译器（`tsc --noEmit` 类型检查） |
| UI | @fluentui/react-components 9.74.7 | Microsoft Fluent v9，全部控件严格遵守 |
| 图标 | @fluentui/react-icons 2.0.339 | Fluent System Icons |
| 视图 | React 19.2.8 | 未启用 StrictMode（SSE 连接防双发） |

## 常用命令

```bash
bun install        # 安装依赖
bun run dev        # 开发（默认内置 mock daemon，热重载）
bun run build      # 产物 → out/renderer（相对路径引用，可被 daemon 托管）
bun run preview    # 预览产物
bun run typecheck  # tsc --noEmit（TS7 native）
bun test           # SSE 解析器/连接器单测（PLAN M1 验收）
```

## 开发模式

- **内置 mock daemon（默认）**：`bun run dev` 后打开 http://localhost:5173/ 。
  mock 以 Vite 中间件形态实现完整 `/ringing/v1/*` 端点（open/续租/三频道 SSE
  重放/命令面/服务面/附件上传/epoch 重置），状态持久化到 `.mock-state.json`。
  桥脚本 `./__qaqh_bridge__.js` 由 mock 提供，注入 `window.__QAQH_DEBUG__`。
- **真实 daemon**：`QAQH_DEV_DAEMON=http://127.0.0.1:<port> bun run dev`，
  vite 将 `/ringing` 与 `/__qaqh_bridge__.js` 代理到 daemon；token 仍由桥脚本
  提供（客户端代码路径两种模式完全一致）。
- **托管形态**：`bun run build` 产物拷贝/同步到 daemon 的 `out/renderer`，
  由 daemon 在 `/debug/` 前缀下托管并注入桥脚本。

## 目录结构

```
src/
  protocol/    # qaqh-ringing 手工镜像（改动须对照后端 PR）：types/methods/endpoints
  transport/   # http（双头注入+401/426 分类+超时）、sse（fetch+ReadableStream 手写解析）
  daemon/      # bridge（__QAQH_DEBUG__ provider）、client（open/续租/epoch 重建）
  state/       # store（useSyncExternalStore）、sessions/timeline 投影、settings
  features/
    conversations/  # 会话侧栏：新建/搜索/切换/重命名/删除
    timeline/       # 聊天区：bootstrap+分页+流式 overlay
    tools/          # 工具 result 卡片（状态徽标/时长/参数输出折叠）
    composer/       # 输入框：Enter/IME/中止/附件上传
    settings/       # 设置页：外观/连接诊断/会话偏好/关于
mocks/             # 内置 mock daemon（仅 dev，vite 中间件）
public/            # PWA manifest + icons 占位
out/renderer/      # 构建产物（daemon 托管约定目录，不入库）
```

## 协议纪律实现位置（对照 PLAN §2）

| 约束 | 实现 |
| --- | --- |
| open 握手 + 426 代差 | `daemon/client.ts` open()；UI 阻断式"需更新" |
| 双头鉴权 / token 仅内存 | `transport/http.ts` authHeaders；`daemon/bridge.ts` |
| SSE 手写解析（禁 EventSource） | `transport/sse.ts`（N2 红线） |
| Last-Event-ID 续传 + 字节级判活 | `transport/sse.ts` connectSse（默认 45s 阈值） |
| 会话生命周期只走 commands 面 | `state/sessions.ts`（N5） |
| timeline 唯一真源 / gap 重建 | `state/timeline.ts`（N6，严格 +1 光标） |
| 附件只传 ContentRef | `daemon/client.ts` uploadContent + composer |
| 产物 out/renderer + 相对路径 | `vite.config.ts`（base:'./'） |

## 接入真实后端前的对照清单

`src/protocol/` 是对本仓不可见的 `qaqh-ringing` 的**镜像猜测**，接入时逐项对照
后端 `service_methods.rs` / 事件定义修正（文件内均有 `TODO(对照后端)` 标注）：

1. 命令信封的命令名字段名（当前用 `type`）；
2. `POST /ringing/v1/clients/renew` 端点路径与响应体；
3. timeline 条目 / 事件的具体字段名（当前镜像：`kind/seq/turn/tool_call_id/...`）；
4. 服务面方法名（`session.list`、`config.get` 等 22R+19W 子集）；
5. `window.__QAQH_DEBUG__` 的实际字段（当前消费 `token`、`base_url`）；
6. `ringing.reset_required` 的载体（当前为 control 频道事件名）。
