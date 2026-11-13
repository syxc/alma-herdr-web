# alma-herdr-web

Alma herdr 的手机 Web 终端客户端，用于查看电脑上已打开的 Agent 和终端，切换面板、查看输出并发送文字及常用控制键。可连接本机 herdr，也可通过 Alma 桌面端和 relay 访问目标机器上的 herdr。

工作区、项目目录与运行环境由电脑端管理。Web 端只保留在已有工作区中快速启动 Agent 的 New Tab，不提供 New Workspace、目录浏览或重复的原生弹窗创建入口。

[公开客户端](https://alma-herdr-web.nian1.workers.dev) · [协议说明](docs/protocol-notes.md) · [界面与交互](docs/ui-design.md) · [第三方资源](docs/third-party.md)

## 连接目标机器上的 herdr

在目标机器的 Alma 中打开“设置 › 远程访问”，登录 Alma 官方中继，或部署并使用自己的中继。在该页面获取配对链接或二维码，然后打开公开客户端，粘贴配对链接或使用 Scan QR code 扫码连接：

```text
alma://connect?u=<relay url>&k=<connect code>&e2e=1
```

桌面端需开启远程访问并保持在线。浏览器直接经 relay 与桌面端建立端到端加密连接，无需向静态站点提供 Alma 账号或 relay 注册令牌。页面内扫码需要 HTTPS 或 localhost，并需授予相机权限。

配对成功后，连接资料保存在当前标签页的 `sessionStorage` 中。刷新会自动重连并恢复选中的终端；关闭标签页或选择 Forget paired herdr 后需重新配对。断线期间保留画面，超时后自动重连，未确认的输入不会重发。

## 本机运行

需要 Node.js 22.12.0 或更新版本，以及已运行的 herdr。运行 `herdr status` 确认服务状态。

```bash
npm ci
npm run build
npm start
```

打开 <http://127.0.0.1:7331>。本机 agent 直接连接 herdr 的 Unix socket，使用同源 HTTP API 和 WebSocket 提供状态与终端操作。

| 变量                  | 默认值                       | 用途                     |
| --------------------- | ---------------------------- | ------------------------ |
| `HERDR_WEB_HOST`      | `127.0.0.1`                  | HTTP 监听地址            |
| `HERDR_WEB_PORT`      | `7331`                       | HTTP 端口                |
| `HERDR_SOCKET_PATH`   | `~/.config/herdr/herdr.sock` | herdr socket 路径        |
| `HERDR_SESSION`       | 未设置                       | 使用命名会话的 socket    |
| `HERDR_WEB_RELAY_URL` | 未设置                       | 启动时注册的 relay       |
| `HERDR_WEB_PASSWORD`  | 未设置                       | 本机 HTTP API 的登录口令 |

socket 路径优先使用 `HERDR_SOCKET_PATH`，其次是 `HERDR_SESSION` 对应的 `~/.config/herdr/sessions/<name>/herdr.sock`，最后使用默认路径。

默认只监听回环地址。设置 `HERDR_WEB_HOST=0.0.0.0` 前应配置 `HERDR_WEB_PASSWORD`，因为未设口令时，能访问 HTTP 服务的设备即可调用本机 API。只有配置访问口令时才显示口令输入与退出入口；未设置时直接进入本机终端。登录会话使用 HttpOnly、SameSite=Strict cookie，有效会话刷新后继续使用。

## 终端操作

- 列表按 Working、Blocked、Settled 分组，侧栏按工作区、标签和面板组织会话。工作区右侧箭头独立展开或收起，状态刷新保留当前折叠选择；点名称仍进入其活动终端。
- 详情页可切换面板，文字与控制键直接发送到所选面板。
- 列表右上角 `+` 是唯一的 New Tab 入口，依次选择 Claude Code、Codex 或 pi 和已有工作区；优先沿用该工作区内首个可继承的面板目录，没有目录时使用电脑端用户主目录，不移动电脑端焦点。目录不可访问时明确报错；直连 Alma 若已回退创建 shell，不再启动 Agent。目标 Agent 须已安装在电脑端；启动失败保留已创建的终端并显示原因，切换到详情后提示仍可见。没有工作区时引导用户在电脑端打开工作区。
- 输入按顺序合并发送；切换面板前会发送原面板队列。默认快捷栏参照 Alma 排列，包含 Ctrl、Esc、反引号、Ctrl+C、Shift+Tab、Tab、方向键、退格和 Paste，其余按需添加。上下方向键浏览远端历史，回车提交。
- 终端输出支持桌面拖选、手机长按选择和系统复制；选中后使用 Cmd+C / Ctrl+C 或浏览器复制菜单。复制为无 ANSI 的源文本，保留代码缩进和原始换行；选取期间保留画面，清除选区后恢复最新输出。没有选区时 Ctrl+C 仍中断远端程序。
- 显示方式包括 Wrap to Phone、Original Width 和 Shrink to Fit。窄屏默认按屏宽重排，宽屏默认保留原宽度；选择保存在本地。
- 终端保持 14px 字号、21px 行高。向上滚动时保留阅读位置，回到底部后继续跟随输出。终端使用 Ghostty VT 处理宽字符与样式，图标字体按需加载并补绘。连续同色背景合并绘制；终端固定的黑白灰文字与消息底色随页面外观适配，彩色高亮保持原样。
- 连接成功后收起常驻说明，连接详情收入更多菜单；连接中、重连和错误提示仍直接显示。
- Restart <agent> 停止当前 agent 并开启新会话；Restart & Continue 恢复原会话并发送“继续”。没有可恢复会话时，该项不可用。

Alma 桌面端限制部分 RPC，如 `pane.focus`。客户端仍按面板 ID 读取和输入，不依赖桌面焦点。状态与终端内容通过轮询更新。

## 通过本机 agent 远程访问

本机页面通过列表更多菜单的 Share this desktop 打开设置，将 agent 注册到 relay。该设置不占用工作区侧栏；静态客户端和已配对的远端会话不显示这个本机配置入口。连接另一台电脑仍使用 Join a remote session：

1. 填写 relay 地址并选择 Connect。官方 `https://relay.alma.now` 需要 Alma relay 注册令牌，填入 Relay token；自建 relay 可按服务端配置留空。
2. 在手机打开 Anywhere 二维码中的链接，或把链接粘贴到 Web 客户端。
3. 同一网络内可使用 On this network 链接。配对二维码接口仅允许回环地址访问，应在桌面端显示二维码。

New code 会更换连接码并使旧配对失效。agent 的连接身份保存在本机 `~/.config/alma-herdr-web/relay.json`，浏览器的配对资料只保存在标签页会话中；两者都不应进入仓库、日志或截图。

自建 relay 参见 [alma-relay](https://github.com/yetone/alma-relay) 及其[协议文档](https://github.com/yetone/alma-relay/blob/main/docs/PROTOCOL.md)。本项目 agent 使用自己的 E2E 握手，需要本 Web 客户端；连接 Alma 桌面端时使用官方 E2E 协议。

## 静态部署

静态站点只托管客户端，通过现有 relay 连接桌面端。打开后直接显示扫码或粘贴链接的配对入口，不显示网站登录和退出登录。已有配对在当前标签页刷新后恢复。无需部署 Node agent、KV、D1 或 Durable Objects。

```bash
npm ci
npm run build:worker
```

将 `dist/worker/` 上传到静态托管平台。目录包含 HTML、CSS、JS、WASM、图标分包与许可证，不含源码、source map、本机状态或凭据。

不存在的路径必须返回 404，尤其是 `/api/state`，不能统一回退到 `index.html`。客户端据此识别静态托管并显示配对入口。本地模式需要页面与 agent API 同源。

### Cloudflare Workers

配置位于 `wrangler.jsonc`，默认 Worker 名为 `alma-herdr-web`。Wrangler 已包含在开发依赖中。

```bash
npm run dev:worker        # 本地预览
npm run check:worker      # 构建并检查，不发布
npx wrangler login       # 首次使用时登录
npm run deploy:worker    # 发布或更新同名 Worker
```

预览和部署会自动构建。Workers Builds 的部署命令可设为 `npm run deploy:worker`；所需 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 只放在部署平台的 Secret 或环境变量中。

无文件名哈希的资源应使用可重新验证的缓存策略。Workers 的静态资源缓存行为见[官方说明](https://developers.cloudflare.com/workers/static-assets/headers/)。

## 开发与检查

Biome 2.6.7 统一检查 JavaScript、TypeScript、JSON/JSONC、CSS、HTML 和 Markdown。`biome.json` 参考 [pi 的配置](https://github.com/earendil-works/pi/blob/main/biome.json)，使用两空格缩进、120 列宽和按需分号。依赖、构建产物、第三方字体及生成的图标清单不参与检查。

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

GitHub Actions 在推送到 `master`、提交 Pull Request 或手动触发时运行同一套检查，使用 Ubuntu 和 Node.js 22。工作流先检查提交快照中的隐私信息，再安装锁定依赖，执行 Biome 检查、构建和测试；构建已包含 agent、Web 和 mock 的类型检查。CI 无需桌面端或部署凭据。

自动测试使用模拟 herdr 与 relay，不依赖真实桌面端。浏览器检查入口：

| 命令                                       | 检查内容                                                |
| ------------------------------------------ | ------------------------------------------------------- |
| `node scripts/check-icon-font-browser.mjs` | 字体按需加载、失败恢复、Canvas 补绘和字形比较           |
| `node scripts/check-recovery-browser.mjs`  | 完整应用的刷新配对恢复、无响应和断线重连                |
| `node scripts/check-auth-browser.mjs`      | 静态配对、本机免口令与口令解锁、退出及刷新恢复          |
| `node scripts/e2e-check.mjs`               | 使用本机身份，经真实 relay 读取面板、输入命令并检查回显 |

前三项输出仅监听回环地址的检查页面。认证服务在 7344、7345、7346 端口的 `/check/auth` 分别检查静态站、本机免口令和本机有口令模式，使用模拟桌面与隔离会话，不读取真实配对。字体服务的 `/terminal` 页面另检查 Canvas 明暗切换、静止快照重绘和三种模式的滚动；恢复服务的 `/check/phone` 提供 390 × 844 的应用预览，`/check/activity` 以受控可见性事件检查前后台读取及刷新恢复，`/check/input` 检查真实 DOM 中的 Unicode 编辑、光标与受控组合输入事件；`/check/ui` 使用原始页面与样式，在隔离页面检查明暗主题、320/390/1024px 布局、菜单位置、按钮形状、触摸区域与焦点，不连接桌面。`e2e-check.mjs` 会实际向第一个面板输入命令，需在可操作的测试面板上运行。手机软键盘、中文 IME 和键盘遮挡需按[界面验收步骤](docs/ui-design.md#验收)在真机检查，桌面测试不覆盖这些行为。

`npm run privacy-check` 检查工作区文件；`npm run privacy-check -- --staged` 检查完整暂存区快照。`npm run privacy-check -- --install` 安装或更新提交钩子，使其检查暂存区，避免工作区的后续修改掩盖已暂存内容。检查日志只报告文件、行号和规则，不回显敏感值。仓库不保存连接码、路由令牌、二维码截图、本机配置或私有路径。第三方字体、WASM 与许可证按[资源说明](docs/third-party.md)维护。

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

客户端读取的是 herdr 屏幕快照，不能让桌面程序按手机宽度重新排版。Alma 模式没有事件流，终端内容约每 1.5 秒轮询；Nerd Font 与播放符号之外的缺字仍取决于系统字体。文件浏览、上传、mutes、open-url、安装管理和推送通知未实现。
