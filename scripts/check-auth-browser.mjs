import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { dirname, extname, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocketServer } from "ws"
import { createAuth, SESSION_COOKIE } from "../agent/dist/auth.js"
import { AlmaMock } from "../mock/dist/alma-mock.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const web = resolve(root, "web")
const mock = new AlmaMock()
await mock.start()
const pairing = `alma://connect?u=${encodeURIComponent(mock.url)}&k=${mock.code}&e2e=1`
const state = {
  workspaces: [
    { workspace_id: "w1", label: "Auth check", number: 1, agent_status: "done", active_tab_id: "t1", tab_count: 1 },
  ],
  tabs: [{ tab_id: "t1", workspace_id: "w1", label: "Test terminal", number: 1, agent_status: "done" }],
  panes: [
    {
      pane_id: "p1",
      workspace_id: "w1",
      tab_id: "t1",
      agent_status: "done",
      agent: null,
      title: "Auth check",
      viewport_rows: 24,
    },
  ],
  focused_pane_id: "p1",
}
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
}
const servers = []
const sockets = []
for (const [index, mode] of ["static", "open", "protected"].entries()) {
  const password = mode === "protected" ? "test-only-passphrase" : ""
  let auth = createAuth(password)
  let fail = false
  let logouts = 0
  let reads = 0
  const json = (response, status, body) =>
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store")
    const path = new URL(request.url, "http://localhost").pathname
    if (path === "/check/auth") {
      const fixture = await readFile(resolve(root, "tests/auth-browser.html"), "utf8")
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(fixture.replace('"__MODE__"', JSON.stringify(mode)).replace('"__PAIRING__"', JSON.stringify(pairing)))
      return
    }
    if (path === "/check/stats") return json(response, 200, { logouts, reads, connections: wss.clients.size })
    if (request.method === "POST" && path.startsWith("/check/")) {
      if (path === "/check/expire") auth = createAuth(password)
      if (path === "/check/fail") fail = true
      if (path === "/check/reset") fail = false
      return json(response, 200, { ok: true })
    }
    if (path.startsWith("/api/")) {
      if (path === "/api/auth" && fail) return json(response, 503, { error: "test unavailable" })
      if (mode === "static") return json(response, 404, {})
      if (path === "/api/auth")
        return json(response, 200, { ok: true, required: auth.required, authenticated: auth.verify(request.headers) })
      if (path === "/api/login") {
        let data = ""
        for await (const chunk of request) data += chunk
        const result = auth.signIn(JSON.parse(data).password)
        if (result.token)
          response.setHeader("set-cookie", `${SESSION_COOKIE}=${result.token}; HttpOnly; SameSite=Strict; Path=/`)
        return json(response, result.ok ? 200 : 400, { ok: result.ok, required: auth.required, error: result.error })
      }
      if (!auth.verify(request.headers)) return json(response, 401, { ok: false, error: "sign in first" })
      if (path === "/api/logout") {
        logouts += 1
        auth.signOut(request.headers)
        response.setHeader("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
      }
      if (path === "/api/state") return json(response, 200, { ok: true, state, connected: true })
      if (path === "/api/pane/read") {
        reads += 1
        return json(response, 200, { ok: true, result: { text: "auth-check terminal output", revision: reads } })
      }
      return json(response, 200, { ok: true })
    }
    const file = resolve(web, path === "/" ? "index.html" : `.${path}`)
    if (!file.startsWith(web + sep)) return response.writeHead(404).end()
    try {
      const data = await readFile(file)
      response.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" }).end(data)
    } catch {
      response.writeHead(404).end()
    }
  })
  const wss = new WebSocketServer({ server, path: "/api/events" })
  wss.on("connection", (socket, request) => {
    if (mode === "static" || !auth.verify(request.headers)) return socket.close(4401, "sign in first")
    socket.send(JSON.stringify({ type: "state", state, connected: true }))
  })
  const port = 7344 + index
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve))
  console.log(`${mode} auth check: http://127.0.0.1:${port}/check/auth`)
  servers.push(server)
  sockets.push(wss)
}
async function stop() {
  for (const wss of sockets) {
    for (const socket of wss.clients) socket.terminate()
    wss.close()
  }
  for (const server of servers) server.close()
  await mock.stop()
  process.exit()
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
