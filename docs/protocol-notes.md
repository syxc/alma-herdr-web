# 协议与传输约束

兼容基线为 herdr 0.9.5、protocol 22。herdr socket 事实依据 [Socket API](https://herdr.dev/docs/socket-api) 和 `herdr api schema --json`；Alma 协议依据 Alma 4.3 客户端及桌面端实现。版本升级时应重新核对方法白名单、帧格式和事件名称。

## herdr socket

传输使用 Unix socket 上的 NDJSON JSON-RPC。每个普通请求独占一条短连接，响应后服务端关闭连接；`events.subscribe` 使用单独的长连接。不得在订阅连接上发送普通请求。

```jsonc
{"id":"r1","method":"pane.read","params":{"pane_id":"w9:p1","source":"visible","format":"ansi"}}
{"id":"r1","result":{"type":"pane_read","read":{"pane_id":"w9:p1","text":"...","revision":0,"truncated":false}}}
{"id":"subscribe","method":"events.subscribe","params":{"subscriptions":[{"type":"workspace.created"}]}}
```

订阅类型使用点号，如 `workspace.created`；收到的事件名使用下划线，如 `workspace_created`。`pane.agent_status_changed` 和 `pane.scroll_changed` 等订阅必须带 `pane_id`。订阅集合改变时重建长连接，并按当前面板补充对应订阅。

虽然事件表包含 `pane_output_changed`，该版本没有对应订阅类型。终端通过轮询 `pane.read` 更新。返回文本是带 SGR 样式的屏幕快照，读取结果位于 `result.read`；`lines` 不大于零时应省略，Alma 桌面端收到 `lines: 0` 会返回空内容。

## 本机 HTTP API

Node agent 将以下接口映射为 herdr 请求。未列出的路径返回错误。

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

New Tab 显式以 `cwd: "~"` 请求电脑端用户主目录；继承目录时发送桌面快照中的实际路径。本机 agent 创建前校验目录，避免 herdr 0.9.5 对不可访问目录静默回退。Alma 直连由客户端核对创建后面板目录，不在回退目录中启动 Agent。

上述列表说明传输层兼容接口，不表示 Web 界面提供全部管理入口。`workspace.create` 保留在本机 agent 的接口映射中；Web 界面只提供已有工作区中的 New Tab，工作区创建在电脑端完成。

设置口令后，常规 API 与事件 WebSocket 要求有效会话，`/api/auth`、`/api/login` 和静态资源除外。二维码 SVG 单独限制请求来源为回环地址。relay 状态接口包含配对链接，也应按凭据处理。

## agent 重启与续跑

重启顺序为：一次 `pane.send_keys` 发送两个 `ctrl+c`，等待 shell 恢复，调用 `agent.start`。两次中断若分开经 relay 发送，间隔可能使 agent 只清空输入而不退出。

`agent.start` 返回 `launch_pending`，不代表 agent 已就绪。续跑后发送 `agent.prompt` 时，仅对未就绪错误重试。`agent_session` 的 `kind` 区分会话 ID 与路径，续跑参数由 `web/src/agents.ts` 维护。

| agent    | 会话类型  | 续跑参数            |
| -------- | --------- | ------------------- |
| claude   | id        | `--resume <id>`     |
| codex    | id        | `resume <id>`       |
| pi       | id / path | `--session <value>` |
| opencode | id        | `--session <id>`    |
| omp      | id / path | `--resume=<value>`  |

## relay 外层协议

relay 负责路由桌面端与浏览器之间的 HTTP 和 WebSocket 流量。协议来源：[alma-relay](https://github.com/yetone/alma-relay/blob/main/docs/PROTOCOL.md)。本项目桌面端使用 protocol 1 的 JSON 帧。

| 方向          | 帧                                             | 用途              |
| ------------- | ---------------------------------------------- | ----------------- |
| agent → relay | `register {tokenHash, name, ver, key?, proto}` | 注册桌面端        |
| relay → agent | `registered` / `error`                         | 注册结果          |
| relay → agent | `hreq {id, method, path, headers, b?}`         | HTTP 请求         |
| agent → relay | `hres`、`hchunk`、`hend`                       | HTTP 响应         |
| relay → agent | `wopen {id, path}`                             | 建立 WebSocket 桥 |
| agent → relay | `wopened` / `werr`                             | 桥建立结果        |
| 双向          | `wmsg {id, s? , b?}` / `wclose`                | 转发消息与关闭    |

桌面端通过 `/agent?th=<tokenHash>` 注册，客户端使用 `/c/<token>/…` 访问。桌面端必须先回复 `wopened`，relay 才会投递此前缓存的客户端帧。

开启 E2E 时，桌面端只允许加密端点的 WebSocket 桥。明文 HTTP 仅提供静态资源，访问 `/api/*` 返回 403。官方 relay 要求桌面端提供账号签发的注册令牌；浏览器配对客户端不参与令牌签发。

## 本项目 agent 的 E2E

本项目 agent 与 Web 客户端共享如下线格式，与 Alma 官方握手分开维护：

- 路由令牌：`base64url(SHA256("herdr-web/relay/v1/" + code))`。
- 连接码是预共享密钥，用于认证双方临时 P-256 公钥。
- ECDH 派生共享秘密，HKDF-SHA256 的 salt 为 `herdr-web/e2e/v1`，方向标签为 `session-c2a`、`session-a2c`。
- AES-256-GCM 的 nonce 为 4 字节随机前缀和 8 字节大端计数器，AAD 为 `herdr-web/e2e/v1/frame`。

```jsonc
{"t":"e2e-hello","n":"<nonce>","c":"<sealed public key>"}
{"t":"e2e-hello-ack","n":"...","c":"..."}
{"t":"e2e","c":"<sealed application frame>"}
```

握手后，`req` / `res` 承载 HTTP 请求响应，`wsopen` / `wsopened` / `wsmsg` / `wsclose` 承载事件子流。请求与事件共用加密通道，但关闭事件订阅只能结束子流。关闭帧使用 `wsclose`，桌面端同时兼容旧 `wscancel`。Web 客户端串行加密发送与解密回调，保证帧顺序和 nonce 计数器一致；通道或加密出错时立即关闭并拒绝所有挂起请求。

## Alma 桌面端的 E2E

配对深链为 `alma://connect?u=<relay url>&k=<connect code>&e2e=1`。`k` 是连接码，也是握手的预共享密钥。路由地址由它派生：

```text
routing = base64url(HKDF-SHA256(utf8(code), salt="alma-relay-e2e/v1/routing", info=空, 16B))
path = <relay>/c/<routing>/__alma_e2e__
tokenHash = sha256_hex(routing)
```

握手使用明文 JSON：

```jsonc
{"t":"hi","epk":"<client P-256 public key>","n":"<client nonce>","bin":1}
{"t":"hi","epk":"<desktop public key>","n":"<desktop nonce>","cr":"<confirm-r>"}
{"t":"ok","ci":"<confirm-i>"}
```

```text
secret = ECDH(clientPriv, desktopPub)
digest = SHA256("alma-relay-e2e/v1" || clientPub || desktopPub || clientNonce || desktopNonce)
key = HKDF-SHA256(secret, salt=utf8(code), info=utf8("<tag>|") || digest, 32B)
tag = c2s / s2c / confirm-r / confirm-i
```

加密帧为 `IV(12B) || ciphertext || tag`，不使用 AAD。IV 的前 4 字节为零，后 8 字节是大端计数器。带二进制载荷的明文帧编码为 `[0x00][u32be headerLen][header JSON，含 $:"b"][payload]`，其余为 JSON。

应用层使用 `hreq` → `hres` → `hchunk` → `hend`，错误帧为 `herr`。接收端必须按到达顺序解密和处理，不能让结束帧先于正文完成。RPC 请求发往 `/api/herdr/rpc`，正文为 `{method, params}`，必须带 `content-type: application/json`。

桌面端只允许白名单方法及部分 `list` / `get` 方法。本客户端通过它读取会话和终端、输入、在已有工作区中新建 Agent 标签及管理 agent；`pane.focus` 被拒，客户端不依赖它切换读写目标。该模式没有事件推送。

## 连接与加密实现

官方握手按每次 10 秒、最多 5 次尝试处理首次连接失败。桌面请求等待上限为 15 秒，失败后关闭坏隧道并由页面恢复连接，不重发未确认的输入。

浏览器在安全上下文使用 WebCrypto；缺少 `crypto.subtle` 时使用 noble，保持相同线格式。noble 的 P-256 共享点需去掉前缀以取得 X 坐标；WebCrypto 的 HKDF 使用 `deriveBits` 取得原始密钥。协议中的 salt、AAD 和派生前缀必须保持兼容，不能随项目重命名修改。
