# 协议与传输约束

兼容基线：herdr TUI 0.9.5（protocol 22）、herdr-core 0.1.21（framed generation 1）、Alma 桌面端 4.5。依据 [TUI Socket API](https://herdr.dev/docs/socket-api)、`herdr api schema --json`、`hc schema`、[core API](https://github.com/herdrdev/herdr-core/blob/main/schema/README.md) 与 [endpoint 规则](https://github.com/herdrdev/herdr-core/blob/main/docs/security.md)。升级版本时应重新核对方法白名单、帧格式与事件名称。

## herdr socket

Unix socket 上的 NDJSON JSON-RPC。普通请求各占一条短连接，响应后关闭；客户端对普通请求设 5 秒截止，`agent.prompt` 保留 90 秒，超时即关闭短连接，避免无响应 TUI 阻塞统一快照。`events.subscribe` 使用单独长连接，不得在其上发送普通请求。

```jsonc
{"id":"r1","method":"pane.read","params":{"pane_id":"w9:p1","source":"visible","format":"ansi"}}
{"id":"r1","result":{"type":"pane_read","read":{"pane_id":"w9:p1","text":"...","revision":0,"truncated":false}}}
{"id":"subscribe","method":"events.subscribe","params":{"subscriptions":[{"type":"workspace.created"}]}}
```

- 订阅类型用点号（`workspace.created`），事件名用下划线（`workspace_created`）；`pane.agent_status_changed`、`pane.scroll_changed` 等必须带 `pane_id`。订阅集合改变时重建长连接。
- 事件表虽含 `pane_output_changed`，该版本无对应订阅类型；终端通过轮询 `pane.read` 更新。
- Web 用 `source: "recent_unwrapped"` 取带 SGR 样式的未折行内容。`recent` 的屏宽折行会膨胀空白行、拆断分隔线，不能用于页面重排。
- TUI 单次 `lines` 上限 1000；`truncated: false` 不等于整段会话已读取，pi 自管历史需应用翻页。
- `pane.send_keys` 不支持 PageUp/PageDown，改用 `pane.send_text` 传 VT 序列。读取结果在 `result.read`；`lines <= 0` 时应省略（Alma 桌面端收到 `lines: 0` 返回空内容）。

## herdr-core

- 自动模式（`HERDR_WEB_BACKEND=auto`）分别发现 TUI/core socket 并合并成功快照，单侧失败不让另一侧离线；`tui` / `core` 仅作可选覆盖。
- core 的 pane/tab/workspace/focused ID 统一加 `hc:`，按请求来源标识路由，去前缀后调原生适配。无目标的 `workspace.create` / `ping` 在仅 core 在线或指定 `backend: "hc"` 时走 core；输入必须有明确目标。`ping` 映射为原生 `hello`，不重新协商帧协议。
- 每种运行时首次成功的 socket 来源保持固定；失联后只重连原来源，不以另一 session 的同名终端替换原 ID，写入失败也不重发到另一运行时。
- 自动模式参考进程与登录 shell 的 endpoint 变量、core socket 配置、XDG 与已有命名 session，不执行 `hc connect` 或创建空服务；显式 core 覆盖才保留原生 endpoint 解析与按需启动。

协议：JSON-RPC 2.0，`hello {framed:true,generation:1}` 后切换为 `[channel u32le][kind u8][length u32le][payload]`。通道 0 承载 RPC，其余承载终端 DATA 与 CREDIT/CLOSE；关闭一次 attach 只关闭其通道。

- `terminal.list` 映射为工作区、标签、面板快照。机器前缀属于地址，`t1` 与 `vps/t1` 必须分开缓存与读写；远机创建映射为 `terminal.run {on:machine,cwd,...}`，不能退回本机。离线机器保留可见分组，读写和新建返回明确错误。
- 逐键输入经可写 attach 的 DATA 发送，不用会自动回车的 `terminal.send`。原生屏幕经只读 attach 获取，HTTP `read` 携带 `vt:true`、`cols`、`rows`，尺寸取自该次 attach 的元数据；浏览器用 Ghostty 按实际尺寸重放完整 VT 序列。TUI 与 Alma 的逐行 SGR 快照仍用原路径。原生 VT 需 WASM 内核，加载失败明确报错，不退回只理解 SGR 的解析器。
- core 不提供命名 Agent/续跑数据，客户端保留 unknown，不凭进程名推断可恢复会话。Agent 仅在已确认的空闲 shell 中启动，写入后有界检查前台进程名或入口脚本；无法确认返回 `start_unknown` 并保留终端。新建和重启只重试尚未发送启动命令的 `agent_pane_busy`，不自动重发结果不确定的启动。

## 本机 HTTP API

未列出的路径返回错误。

| 方法 | 路径                     | 参数或行为                                            |
| ---- | ------------------------ | ----------------------------------------------------- |
| GET  | `/api/state`             | 会话快照与连接状态                                    |
| GET  | `/api/pane/read`         | `pane`、`source`、`format`、`lines`                   |
| POST | `/api/pane/text`         | `pane.send_text {pane_id, text}`                      |
| POST | `/api/pane/keys`         | `pane.send_keys {pane_id, keys}`                      |
| POST | `/api/pane/focus`        | `pane.focus {pane_id}`                                |
| POST | `/api/agent/start`       | `agent.start {pane_id, name, kind, args}`             |
| POST | `/api/agent/prompt`      | `agent.prompt {target, text}`                         |
| POST | `/api/workspace/create`  | `workspace.create {cwd, label, focus}`                |
| POST | `/api/tab/create`        | `tab.create {workspace_id, cwd, label, focus}`        |
| POST | `/api/workspace/move`    | `workspace.move {workspace_id, insert_index}`         |
| POST | `/api/tab/move`          | `tab.move {tab_id, insert_index}`                     |
| POST | `/api/workspace/focus`   | `workspace.focus {workspace_id}`                      |
| POST | `/api/tab/focus`         | `tab.focus {tab_id}`                                  |
| WS   | `/api/events`            | `state`、`pane_output` 事件                           |
| GET  | `/api/relay/status`      | relay 状态与配对链接                                  |
| POST | `/api/relay/connect`     | `relayUrl`、可选 `relayKey`                           |
| POST | `/api/relay/disconnect`  | 断开注册连接                                          |
| POST | `/api/relay/rotate`      | 更换连接码                                            |
| GET  | `/api/relay/pairing`     | 配对载荷，仅回环地址可用                              |
| GET  | `/api/relay/pairing.svg` | 二维码，可选 `target=lan`，仅回环地址可用             |
| GET  | `/api/auth`              | `required` 为口令要求，`authenticated` 为当前会话状态 |
| POST | `/api/login`             | `password`，登录成功后设置会话 cookie                 |
| POST | `/api/logout`            | 作废会话并清除 cookie                                 |

- New Tab 以 `cwd: "~"` 请求电脑端主目录；继承目录时发送快照中的实际路径。本机 agent 创建前校验目录，避免 herdr 0.9.5 静默回退；Alma 直连由客户端核对创建后面板目录。
- 上表是传输层兼容接口，不代表 Web 界面提供全部管理入口；工作区创建在电脑端完成。
- 设置口令后，常规 API 与事件 WebSocket 需有效会话（`/api/auth`、`/api/login`、静态资源除外）。二维码 SVG 限制来源为回环地址；relay 状态接口含配对链接，按凭据处理。

## agent 重启与续跑

重启顺序：一次 `pane.send_keys` 发两个 `ctrl+c`，等待 shell 恢复，再调 `agent.start`（两次中断若经 relay 分开发送，间隔可能只清空输入而不退出）。`agent.start` 返回 `launch_pending` 不代表已就绪；续跑的 `agent.prompt` 仅对未就绪错误重试。`agent_session.kind` 区分会话 ID 与路径，续跑参数由 `web/src/agents.ts` 维护。

| agent    | 会话类型  | 续跑参数            |
| -------- | --------- | ------------------- |
| claude   | id        | `--resume <id>`     |
| codex    | id        | `resume <id>`       |
| pi       | id / path | `--session <value>` |
| opencode | id        | `--session <id>`    |
| omp      | id / path | `--resume=<value>`  |

## relay 外层协议

协议来源：[alma-relay](https://github.com/yetone/alma-relay/blob/main/docs/PROTOCOL.md)。本项目桌面端使用 protocol 1 的 JSON 帧。

| 方向          | 帧                                             | 用途              |
| ------------- | ---------------------------------------------- | ----------------- |
| agent → relay | `register {tokenHash, name, ver, key?, proto}` | 注册桌面端        |
| relay → agent | `registered` / `error`                         | 注册结果          |
| relay → agent | `hreq {id, method, path, headers, b?}`         | HTTP 请求         |
| agent → relay | `hres`、`hchunk`、`hend`                       | HTTP 响应         |
| relay → agent | `wopen {id, path}`                             | 建立 WebSocket 桥 |
| agent → relay | `wopened` / `werr`                             | 桥建立结果        |
| 双向          | `wmsg {id, s? , b?}` / `wclose`                | 转发消息与关闭    |

桌面端通过 `/agent?th=<tokenHash>` 注册，客户端用 `/c/<token>/…` 访问；桌面端必须先回复 `wopened`，relay 才投递缓存的客户端帧。开启 E2E 时桌面端只允许加密端点的 WebSocket 桥，明文 HTTP 仅提供静态资源，`/api/*` 返回 403。官方 relay 要求账号签发的注册令牌，浏览器配对客户端不参与令牌签发。

## 本项目 agent 的 E2E

与 Alma 官方握手分开维护：

- 路由令牌：`base64url(SHA256("herdr-web/relay/v1/" + code))`；连接码是预共享密钥，用于认证双方临时 P-256 公钥。
- 握手密钥 HKDF-SHA256 salt：`utf8("herdr-web/e2e/v1")`；会话密钥以 ECDH 共享秘密为 IKM、连接码 hex 解码原始字节为 salt，info 为 `session-c2a` / `session-a2c`。
- AES-256-GCM nonce 为 4 字节随机前缀 + 8 字节大端计数器，AAD 为 `herdr-web/e2e/v1/frame`。

```jsonc
{"t":"e2e-hello","n":"<nonce>","c":"<sealed public key>"}
{"t":"e2e-hello-ack","n":"...","c":"..."}
{"t":"e2e","c":"<sealed application frame>"}
```

握手后 `req` / `res` 承载 HTTP，`wsopen` / `wsopened` / `wsmsg` / `wsclose` 承载事件子流；关闭订阅只结束子流（桌面端兼容旧 `wscancel`）。Web 客户端串行加解密以保证帧顺序与 nonce 一致，通道或加密出错时立即关闭并拒绝所有挂起请求。

## Alma 桌面端的 E2E

配对深链 `alma://connect?u=<relay url>&k=<connect code>&e2e=1`，`k` 是连接码也是握手预共享密钥。

```text
routing = base64url(HKDF-SHA256(utf8(code), salt="alma-relay-e2e/v1/routing", info=空, 16B))
path = <relay>/c/<routing>/__alma_e2e__
tokenHash = sha256_hex(routing)

secret = ECDH(clientPriv, desktopPub)
digest = SHA256("alma-relay-e2e/v1" || clientPub || desktopPub || clientNonce || desktopNonce)
key = HKDF-SHA256(secret, salt=utf8(code), info=utf8("<tag>|") || digest, 32B)
tag = c2s / s2c / confirm-r / confirm-i
```

握手用明文 JSON：

```jsonc
{"t":"hi","epk":"<client P-256 public key>","n":"<client nonce>","bin":1}
{"t":"hi","epk":"<desktop public key>","n":"<desktop nonce>","cr":"<confirm-r>"}
{"t":"ok","ci":"<confirm-i>"}
```

加密帧为 `IV(12B) || ciphertext || tag`，无 AAD；IV 前 4 字节为零，后 8 字节为大端计数器。带二进制载荷的明文帧编码为 `[0x00][u32be headerLen][header JSON，含 $:"b"][payload]`，其余为 JSON。

- 应用层 `hreq` → `hres` → `hchunk` → `hend`，错误帧 `herr`；接收端须按到达顺序解密，不能让结束帧先于正文完成。
- RPC 发往 `/api/herdr/rpc`，正文 `{method, params}`，必须带 `content-type: application/json`。桌面端只允许白名单方法及部分 `list` / `get`；`pane.focus` 被拒，客户端不依赖它切换读写目标。HTTP 200 也可能携带 `error`，必须检查正文。
- 新版状态从 `/ws/herdr` 接收 `herdr` 在线状态与完整 `snapshot`（不启用 delta），使用 `wopen` / `wopened` / `wmsg` / `wclose` / `werr` 子流；关闭子流不能关闭承载 HTTP 的共享隧道。首次经 `/api/herdr/info` 探测，只有 404/405 才回退到旧版三列表 RPC，授权失败或临时错误不能伪装成旧版。终端输出仍通过 `pane.read` 获取。

## 连接与加密实现

官方握手首次连接失败按每次 10 秒、最多 5 次重试；桌面请求等待上限 15 秒，失败后关闭坏隧道由页面恢复，不重发未确认输入。浏览器在安全上下文用 WebCrypto，缺少 `crypto.subtle` 时用 noble 保持相同线格式（noble 的 P-256 共享点需去掉前缀取 X 坐标；WebCrypto HKDF 用 `deriveBits` 取原始密钥）。协议中的 salt、AAD 与派生前缀必须保持兼容，不能随项目重命名修改。
