# qaqh-webUI

QAQ-Harness 的浏览器 webUI（`qaqh.Ringing` 协议前端）。协议契约、
里程碑与验收标准见 [PLAN.md](./PLAN.md)；本 README 只覆盖工程使用。

**接入状态（2026-08-30）**：已对真实 daemon（F:\QAQ-Harness，Ringing V1）
完成 wire 格式镜像与全链路联调。`src/protocol/` 为 `qaqh-ringing` +
`qaqh-domain` 的手工镜像，对照实测取证重写，**改动须对照后端 PR**。

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
bun test           # SSE 解析器/连接器 + timeline reducer 单测
```

## 开发模式

- **内置 mock daemon（默认）**：`bun run dev` 后打开 http://localhost:5173/ 。
  mock 以 Vite 中间件形态按**真实 wire 格式**实现 `/ringing/v1/*` 全端点
  （open / /leases/renew / 双层 tag 命令信封与 ack / 三频道逐信封 SSE /
  timeline 快照分页 + timeline.entry 流 / bootstrap 三频道快照 / service 面 /
  content 上传 / load_more 422 / epoch 重置），状态持久化到 `.mock-state.json`。
- **真实 daemon**：`QAQH_DEV_DAEMON=http://127.0.0.1:<port> bun run dev`，
  vite 将 `/ringing` 与 `/__qaqh_bridge__.js`（重写到 daemon 的
  `/debug/__qaqh_bridge__.js`）代理到 daemon；token 仍由桥脚本注入，
  客户端代码路径两种模式完全一致。
- **托管形态**：`bun run build` 产物拷贝/同步到 daemon 的 `out/renderer`，
  由 daemon 在 `/debug/` 前缀下托管并注入桥脚本。

## 与真实后端的 wire 契约要点（实测取证）

- **open**：`POST /ringing/v1/clients/open`，请求 `{schema,version,client_instance_id}`；
  响应 `server_epoch` 为 hex **字符串**；426 = rejected ack（`unsupported_version`）。
- **续租**：`POST /ringing/v1/leases/renew`（TTL 30s / 间隔 10s；
  过期回 401 → 重新 open → `session_resume` 恢复会话）。
- **命令信封（双层 tag）**：`{schema,version,channel,command_id,client_instance_id,
  client_session_id,seed?,command:{channel,type:<snake_case>,...参数}}`；
  **除 `session_create` 外信封级必须带 seed**（`session_resume` 也要）；
  ack = `{command_id,status:accepted|rejected,code?,message?}`，rejected 载荷在
  HTTP 400/502 里。
- **SSE（逐信封，非 batch）**：`event` = 内层事件 type（如 `turn_started`）、
  `id` = `<epoch>:<channel>:<stream_seq>`、`data` = 完整 EventEnvelope；
  15s 注释行 keepalive；`ringing.reset_required` → 客户端全量重建（re-open）。
- **timeline face（transcript 权威）**：快照 `GET /sessions/{seed}/timeline
  ?before_turn=<turn_id>&limit`（尾窗语义，`has_more` 判上翻；`load_more`
  命令被设计性拒绝 422）+ `timeline.entry` SSE（`TimelineEntry` block 树增量）。
  `timeline_seq` 严格单调但**不连续**（watermark 为全局计数）——不能用跳号检测
  缺口，断流重连一律以快照 re-baseline。
- **服务面**：`config.load`/`config.save`（camelCase merge patch，`theme:""`=
  跟随系统）、`session.list`/`session.meta`（title 由 daemon 生成，无 rename 命令）、
  `workspace.get`、`daemon.version`。
- **附件**：multipart 字段 `seed`/`media_type`/`content` →
  `{content_id(=sha256), media_type, sha256, truncated}`；命令只传 ContentRef。

## 目录结构

```
src/
  protocol/    # qaqh-ringing/qaqh-domain 手工镜像（改动须对照后端 PR）
  transport/   # http（双头注入+错误分类+超时）、sse（fetch+ReadableStream 手写解析）
  daemon/      # bridge（__QAQH_DEBUG__ provider）、client（open/续租/resume/epoch 重建）
  state/       # store（useSyncExternalStore）、sessions/timeline（block 树 reducer）/settings
  features/
    conversations/  # 会话侧栏：新建/搜索/切换/归档/删除
    timeline/       # 聊天区：快照基底 + turn/block 渲染 + 上翻分页
    tools/          # 工具 result 卡片（状态徽标/进度流/参数输出折叠）
    composer/       # 输入框：Enter/IME/中止/附件上传
    settings/       # 设置页：外观/连接诊断/会话偏好/关于
mocks/             # 内置 mock daemon（真实 wire 格式，仅 dev）
public/            # PWA manifest + icons 占位
out/renderer/      # 构建产物（daemon 托管约定目录，不入库）
```

## 协议纪律实现位置（对照 webui-development-standard）

| 约束 | 实现 |
| --- | --- |
| N1 单协议（HTTP/SSE 同源直连） | 全部经 `transport/http.ts` + `transport/sse.ts` |
| N2 禁 EventSource，手写流解析 | `transport/sse.ts`（fetch + ReadableStream） |
| N3 token 仅内存、禁 query/日志/storage | `daemon/bridge.ts` + `transport/http.ts`（message 不带头内容） |
| N4 open 前不发命令 | `daemon/client.ts` sendCommand 前置 sessionId 检查 |
| N5 会话生命周期只走 commands 面 | `state/sessions.ts`（session_create/resume/archive/unarchive/delete） |
| N6 timeline 唯一真源，禁 load_more | `state/timeline.ts`（快照基底 + before_turn 上翻；不发 load_more） |
| 命令幂等（UUID v4，重试复用） | `daemon/client.ts` sendCommand `opts.commandId` |
| 收据查询（dispatch_failed/断线后） | `endpoints.ts` endpointCommandStatus |
| epoch 变化 / reset_required → 全量重建 | `daemon/client.ts` rebuild（re-open → resume → reattach） |

## 后端对照（裁决顺序：后端代码 > frontend-contract.md > 本文档）

镜像依据（2026-08-30 实测）：`qaqh-ringing/src/{capability,envelope,snapshot,reset}.rs`、
`qaqh-domain/src/{command,event,timeline}.rs`、`qaqh-daemon/src/axum_server.rs`
（SSE 发射为逐信封——frontend-contract §3.4 的 batch 信封描述与实现不符）、
`qaqh-runtime/src/ringing/service_methods.rs`、`qaqh-config-api/src/lib.rs`。
协议形状变化时改 `src/protocol/types.ts` 并核对 `methods.ts` 的 wire 名。
