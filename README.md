# alma-herdr-web

Alma herdr 的手机 Web 终端客户端：查看电脑上已打开的 Agent 和终端，切换面板、查看输出并发送文字与控制键。支持 herdr TUI 与 herdr-core，可连接本机 agent，也可经 Alma 桌面端和 relay 访问目标机器。工作区与运行环境由电脑端管理，Web 端只在已有工作区中快速启动 Agent。

[公开客户端](https://alma-herdr-web.nian1.workers.dev) · [协议说明](docs/protocol-notes.md) · [界面与交互](docs/ui-design.md) · [第三方资源](docs/third-party.md)

## 连接目标机器上的 herdr

在目标机器的 Alma 中打开「设置 › 远程访问」，获取配对链接或二维码，然后在公开客户端粘贴链接或扫码连接：

```text
alma://connect?u=<relay url>&k=<connect code>&e2e=1
```

桌面端需开启远程访问并保持在线。浏览器经 relay 与桌面端建立端到端加密连接，无需向静态站点提供账号或注册令牌；页面内扫码需要 HTTPS 或 localhost 及相机权限。配对资料保存在当前标签页的 `sessionStorage`，刷新自动重连并恢复选中的终端；关闭标签页或 Forget paired herdr 后需重新配对。

## 本机运行

需要 Node.js 22.12.0+ 与已运行的 herdr TUI 或 herdr-core。

```bash
npm ci
npm run build
npm start
```

打开 <http://127.0.0.1:7331>。agent 自动发现 TUI 与 core，两侧同时运行时合并展示；core 标识统一加 `hc:` 前缀，读写按标识路由回原运行时。自动模式只读取相关 endpoint 变量，不采集整个 shell 环境，也不依赖 `hc` CLI。

| 变量                  | 默认值                       | 用途                               |
| --------------------- | ---------------------------- | ---------------------------------- |
| `HERDR_WEB_BACKEND`   | `auto`                       | 自动兼容；可选 `tui` / `core` 覆盖 |
| `HERDR_WEB_HOST`      | `127.0.0.1`                  | HTTP 监听地址                      |
| `HERDR_WEB_PORT`      | `7331`                       | HTTP 端口                          |
| `HERDR_SOCKET_PATH`   | `~/.config/herdr/herdr.sock` | herdr socket 路径                  |
| `HERDR_SESSION`       | 未设置                       | 使用命名会话的 socket              |
| `HERDR_WEB_RELAY_URL` | 未设置                       | 启动时注册的 relay                 |
| `HERDR_WEB_PASSWORD`  | 未设置                       | 本机 HTTP API 的登录口令           |

默认只监听回环地址。将 `HERDR_WEB_HOST` 设为 `0.0.0.0` 前必须配置 `HERDR_WEB_PASSWORD`；只有设置口令时才显示登录与退出入口。会话使用 HttpOnly、SameSite=Strict cookie，刷新后继续有效。

## 终端操作

- 列表按 Working、Needs input、Settled、Terminals 分组；侧栏按工作区 → 标签 → 面板导航。
- 列表右上角 `+` 在已有工作区中新建 Agent 标签，继承目录且不移动电脑端焦点。
- 文字与控制键按序实时发送；输出支持拖选、长按与系统复制。
- 显示方式：Wrap to Phone、Original Width、Shrink to Fit；外观与显示方式保存在本地。
- 更多菜单提供连接详情、外观、Restart <agent> 与 Restart & Continue。

完整契约见[界面与交互](docs/ui-design.md)。Alma 桌面端限制部分 RPC（如 `pane.focus`），客户端按面板 ID 读写，不依赖桌面焦点。

## 通过本机 agent 远程访问

本机页面通过列表更多菜单的 Share this desktop 注册 relay；静态客户端与已配对的远端会话不显示该入口。连接另一台电脑使用 Join a remote session：填写 relay 地址并 Connect（官方 relay 需注册令牌），在手机打开 Anywhere 二维码链接或粘贴链接，同一网络可用 On this network 链接。二维码接口仅允许回环地址访问。

New code 更换连接码并使旧配对失效。agent 身份保存在 `~/.config/alma-herdr-web/relay.json`，浏览器配对资料只存于标签页会话；两者都不应进入仓库、日志或截图。

自建 relay 参见 [alma-relay](https://github.com/yetone/alma-relay) 及其[协议文档](https://github.com/yetone/alma-relay/blob/main/docs/PROTOCOL.md)。本项目 agent 使用自有 E2E 握手，需搭配本 Web 客户端；连接 Alma 桌面端时使用官方 E2E 协议。

## 静态部署

静态站点只托管客户端，通过现有 relay 连接桌面端，打开后直接显示配对入口。无需部署 Node agent、KV、D1 或 Durable Objects。

```bash
npm ci
npm run build:worker
```

将 `dist/worker/` 上传到静态托管平台。**不存在的路径必须返回 404**（尤其是 `/api/state`），不能回退到 `index.html`；客户端据此识别静态托管。本地模式需要页面与 agent API 同源。

### Cloudflare Workers

配置位于 `wrangler.jsonc`。

```bash
npm run dev              # 本地预览与自动刷新
npm run check:worker     # 构建并检查，不发布
npm run deploy:worker    # 发布或更新同名 Worker
```

`npm run dev` 在 <http://127.0.0.1:8787> 本地运行，不需要 Cloudflare 登录；修改源码或资源后自动重建刷新。自动部署由 `.github/workflows/ci.yml` 在代码变更的 PR 合并到 `master` 后执行，纯文档变更不触发；验证与部署均检出同一个 `merge_commit_sha`，全部检查通过后才部署。手动发布需先 `npx wrangler login`。

在 GitHub 的 Settings › Secrets and variables › Actions 添加：

- `CLOUDFLARE_API_TOKEN`：有目标 Worker 部署权限的 API token。
- `CLOUDFLARE_ACCOUNT_ID`：目标 Cloudflare account ID。

缺少 Secrets 时部署明确失败，不回退到个人登录身份。使用此流程时应关闭同一 Worker 的 Workers Builds 自动触发，避免重复发布。无文件名哈希的资源应使用可重新验证的缓存策略，详见[官方说明](https://developers.cloudflare.com/workers/static-assets/headers/)。

## 开发与检查

Biome 2.6.7 统一检查 JS/TS/JSON/JSONC/CSS/HTML 与 Markdown（两空格缩进、120 列宽、按需分号）。

| 命令                   | 用途                                       |
| ---------------------- | ------------------------------------------ |
| `npm run format`       | 格式化代码和 Markdown                      |
| `npm run format:check` | 只检查格式                                 |
| `npm run lint`         | 检查 lint，警告也视为失败                  |
| `npm run check`        | 一次检查格式、lint 和导入顺序              |
| `npm run check:fix`    | 应用格式化和安全修复                       |
| `npm run typecheck`    | 检查 agent、Web 和 mock 的 TypeScript 类型 |

完整检查：

```bash
npm run check
npm run build
npm test
npm run privacy-check
```

自动测试使用模拟 herdr、core 与 relay，不依赖真实桌面端；已安装 `hc` 时可用 `HC_TEST_REAL=1` 检查真实 core。浏览器检查入口：

| 命令                                       | 检查内容                                                |
| ------------------------------------------ | ------------------------------------------------------- |
| `node scripts/check-icon-font-browser.mjs` | Canvas 回退的字体按需加载、失败恢复、补绘和字形比较     |
| `node scripts/check-recovery-browser.mjs`  | 完整应用的刷新配对恢复、无响应和断线重连                |
| `node scripts/check-auth-browser.mjs`      | 静态配对、本机免口令与口令解锁、退出及刷新恢复          |
| `node scripts/e2e-check.mjs`               | 使用本机身份，经真实 relay 读取面板、输入命令并检查回显 |

前三项输出仅监听回环地址的检查页面；`e2e-check.mjs` 会实际向第一个面板输入命令，需在可操作的测试面板上运行。手机软键盘、中文 IME 和键盘遮挡需按[界面验收步骤](docs/ui-design.md#验收)在真机检查。

`npm run privacy-check` 默认检查工作区，`-- --staged` 检查暂存区快照，`-- --install` 安装提交钩子；日志只报告文件、行号与规则，不回显敏感值。仓库不保存连接码、路由令牌、二维码截图、本机配置或私有路径。资源维护见[第三方资源](docs/third-party.md)。

## 代码导航

| 目录或模块                                                                       | 职责                                                    |
| -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `agent/src/`                                                                     | herdr socket、状态缓存、HTTP 服务、relay 注册与加密桥接 |
| `web/src/main.ts`、`detail.ts`                                                   | 页面状态、配对、会话选择与终端交互                      |
| `web/src/api.ts`、`alma.ts`、`tunnel.ts`                                         | 本地 API 与两种远端协议                                 |
| `web/src/terminal.ts`、`ghostty-vt.ts`、`layout.ts`                              | 渲染、VT 绑定与窄屏重排                                 |
| `web/src/input.ts`、`key-toolbar.ts`、`line-edit.ts`、`send-queue.ts`、`keys.ts` | 终端输入与按序发送                                      |
| `mock/`、`tests/`、`scripts/`                                                    | 模拟服务、回归与构建检查                                |

## 限制

客户端读取 herdr 屏幕快照，不能让桌面程序按手机宽度重排。core 没有 TUI 的命名 Agent 会话与续跑元数据，未上报状态的 shell 显示 unknown；Nerd Font 与播放符号之外的缺字取决于系统字体。文件浏览、上传、mutes、open-url、安装管理与推送通知未实现。
