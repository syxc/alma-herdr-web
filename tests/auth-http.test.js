import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import WebSocket from "ws"

const root = fileURLToPath(new URL("../", import.meta.url))
// Keep identities inside a disposable build directory and never read the real home.
const bootstrap = [
  "import os from 'node:os';",
  "import http from 'node:http';",
  "import { syncBuiltinESMExports } from 'node:module';",
  "os.homedir = () => process.argv[1];",
  "const createServer = http.createServer;",
  "http.createServer = (...args) => {",
  "  const server = createServer(...args);",
  "  server.on('listening', () => process.send({ port: server.address().port }));",
  "  return server;",
  "};",
  "syncBuiltinESMExports();",
  "await import(process.argv[2]);",
].join("\n")

for (const password of ["", "test-only-passphrase"]) {
  test(`real local agent access contract: ${password ? "protected" : "open"}`, { timeout: 10000 }, async (t) => {
    await mkdir(join(root, "dist"), { recursive: true })
    const home = await mkdtemp(join(root, "dist", "auth-http-"))
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", bootstrap, home, pathToFileURL(join(root, "agent/dist/index.js")).href],
      {
        cwd: root,
        env: {
          ...process.env,
          HERDR_WEB_BACKEND: "tui",
          HERDR_WEB_HOST: "127.0.0.1",
          HERDR_WEB_PORT: "0",
          HERDR_WEB_PASSWORD: password,
          HERDR_WEB_RELAY_URL: "",
          HERDR_SOCKET_PATH: join(home, "absent.sock"),
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    )
    const stopped = once(child, "exit")
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await stopped
      await rm(home, { recursive: true, force: true })
    })
    const [{ port }] = await once(child, "message")
    const base = `http://127.0.0.1:${port}`
    const status = async (cookie = "") => (await fetch(`${base}/api/auth`, { headers: { cookie } })).json()
    const access = await fetch(`${base}/api/auth`)
    assert.equal(access.headers.get("cache-control"), "no-store")
    const required = password.length > 0
    assert.deepEqual(await status(), { ok: true, required, authenticated: !required })
    assert.equal((await fetch(`${base}/api/state`)).status, required ? 401 : 200)
    const bad = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ password: "wrong" }) })
    assert.equal(bad.status, required ? 400 : 200)
    const login = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ password }) })
    assert.equal(login.status, 200)
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]
    assert.deepEqual(await status(cookie), { ok: true, required, authenticated: true })
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie } })).status, 200)
    const events = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { headers: { cookie } })
    t.after(() => events.terminate())
    const [message] = await once(events, "message")
    assert.equal(JSON.parse(String(message)).type, "state")
    events.close()
    const logout = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie } })
    assert.equal(logout.status, 200)
    assert.deepEqual(await status(cookie), { ok: true, required, authenticated: !required })
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie } })).status, required ? 401 : 200)
    if (required) {
      const refused = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { headers: { cookie } })
      t.after(() => refused.terminate())
      const [code] = await once(refused, "close")
      assert.equal(code, 4401)
    }
  })
}
