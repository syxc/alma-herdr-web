import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { CoreClient, encodeCoreKeys } from "../agent/dist/core.js"
import { SessionState } from "../agent/dist/state.js"

const exec = promisify(execFile)
const cache = resolve(".cache")

function terminal(address, overrides = {}) {
  return {
    address,
    argv: ["/bin/sh"],
    cwd: "/project",
    labels: {},
    state: "live",
    rows: 24,
    cols: 80,
    pid: 42,
    foreground: { name: "sh", pid: 42, argv: ["/bin/sh"], cwd: "/project" },
    ...overrides,
  }
}

function frame(channel, kind, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(9)
  header.writeUInt32LE(channel)
  header[4] = kind
  header.writeUInt32LE(payload.length, 5)
  return Buffer.concat([header, payload])
}

async function fixture(t, paintParts = [Buffer.from("\x1b[31mcolor\x1b[0m\x1b[?9001l")]) {
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, "core-test-"))
  const path = join(root, "s")
  const requests = []
  const input = []
  const sockets = new Set()
  const channels = new Map()
  let terminals = [terminal("t1"), terminal("vps/t1", { status: { app: "claude", state: "working" } })]
  let machines = [{ name: "vps", state: "connected" }]
  let channelId = 0
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("error", () => {})
    socket.on("close", () => sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    let framed = false
    function request(message) {
      requests.push(message)
      let result = {}
      if (message.method === "hello") result = { framed: true, generation: 1 }
      else if (message.method === "terminal.list") result = { terminals, machines }
      else if (message.method === "terminal.get")
        result = terminals.find((entry) => entry.address === message.params.terminal) ?? {}
      else if (message.method === "terminal.run") {
        result = terminal(`${message.params.on ? `${message.params.on}/` : ""}t${terminals.length + 1}`, {
          cwd: message.params.cwd ?? "/project",
          labels: message.params.labels,
        })
        terminals.push(result)
      } else if (message.method === "terminal.attach") {
        const channel = ++channelId
        channels.set(channel, message.params.terminal)
        result = { channel }
      } else if (message.method === "terminal.read") result = { text: "plain output", complete: false }
      const response = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
      if (message.method === "hello" && !framed) {
        socket.write(Buffer.concat([response, Buffer.from("\n")]))
        framed = true
      } else if (message.method === "terminal.attach") {
        const paint = frame(result.channel, 0, paintParts[0])
        const bytes = Buffer.concat([frame(0, 0, response), paint])
        // A split header plus reply and paint in the same read exercise buffering.
        socket.write(bytes.subarray(0, 5))
        socket.write(bytes.subarray(5))
        paintParts.slice(1).forEach((part, index) => {
          setTimeout(
            () => {
              if (!socket.destroyed) socket.write(frame(result.channel, 0, part))
            },
            10 * (index + 1),
          )
        })
      } else socket.write(frame(0, 0, response))
    }
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!framed) {
        const newline = buffer.indexOf(10)
        if (newline < 0) return
        const message = JSON.parse(buffer.subarray(0, newline))
        buffer = buffer.subarray(newline + 1)
        request(message)
      }
      while (framed && buffer.length >= 9) {
        const channel = buffer.readUInt32LE(0)
        const kind = buffer[4]
        const size = buffer.readUInt32LE(5)
        if (buffer.length < size + 9) return
        const payload = buffer.subarray(9, size + 9)
        buffer = buffer.subarray(size + 9)
        if (channel === 0 && kind === 0) request(JSON.parse(payload))
        else if (kind === 0) {
          input.push({ terminal: channels.get(channel), payload })
          const credit = Buffer.alloc(4)
          credit.writeUInt32LE(payload.length)
          socket.write(frame(channel, 1, credit))
        } else if (kind === 2) socket.write(frame(channel, 2))
      }
    })
  })
  await new Promise((done) => server.listen(path, done))
  const client = new CoreClient({ socketPath: path, timeoutMs: 1000, pollIntervalMs: 20 })
  t.after(async () => {
    client.close()
    for (const socket of sockets) socket.destroy()
    await new Promise((done) => server.close(done))
  })
  return {
    client,
    requests,
    input,
    sockets,
    root,
    socketPath: path,
    setMachines: (value) => {
      machines = value
    },
    setTerminals: (value) => {
      terminals = value
    },
  }
}

test("core ping uses native hello before and after snapshot on the same framed connection", async (t) => {
  const { client, requests, sockets } = await fixture(t)
  assert.equal((await client.request("ping")).generation, 1)
  await client.request("session.snapshot")
  assert.equal((await client.request("ping")).generation, 1)
  assert.deepEqual(
    requests.filter((entry) => entry.method === "hello").map((entry) => entry.params),
    [{ framed: true, generation: 1 }, {}, {}],
  )
  assert.equal(sockets.size, 1)
})

test("core snapshot keeps colliding local and remote addresses in separate machine/cwd groups", async (t) => {
  const { client } = await fixture(t)
  const result = await client.request("session.snapshot")
  const snapshot = result.snapshot
  assert.deepEqual(
    snapshot.panes.map((pane) => pane.pane_id),
    ["t1", "vps/t1"],
  )
  assert.notEqual(snapshot.panes[0].workspace_id, snapshot.panes[1].workspace_id)
  assert.equal(snapshot.panes[0].agent_status, "unknown")
  assert.equal(snapshot.panes[1].agent_status, "working")
  const state = new SessionState()
  state.applySnapshot(result)
  assert.equal(state.snapshot().panes.length, 2)
  const created = await client.request("tab.create", {
    workspace_id: snapshot.panes[1].workspace_id,
    cwd: "/remote/project",
  })
  assert.equal(created.pane_id.startsWith("vps/"), true)
})

test("remote NewTab routes terminal.run to its machine and blocks disconnected writes", async (t) => {
  const { client, requests, setMachines, setTerminals } = await fixture(t)
  const { snapshot } = await client.request("session.snapshot")
  const workspace = snapshot.panes[1].workspace_id
  await client.request("tab.create", { workspace_id: workspace, cwd: "/remote/project" })
  const run = requests.find((entry) => entry.method === "terminal.run")
  assert.equal(run.params.on, "vps")
  assert.equal(run.params.cwd, "/remote/project")
  await client.request("tab.create", { workspace_id: workspace, cwd: "~" })
  const homeRun = requests.filter((entry) => entry.method === "terminal.run").at(-1)
  assert.equal(homeRun.params.on, "vps")
  assert.equal(homeRun.params.cwd, undefined)
  setMachines([{ name: "vps", state: "unreachable", why: "offline" }])
  setTerminals([terminal("t1")])
  const offline = (await client.request("session.snapshot")).snapshot
  assert.equal(offline.panes.find((pane) => pane.pane_id === "vps/t1").connected, false)
  assert.equal(offline.machines[0].state, "unreachable")
  await assert.rejects(
    client.request("pane.send_text", { pane_id: "vps/t1", text: "x" }),
    (error) => error.code === "machine_unavailable",
  )
  await assert.rejects(
    client.request("tab.create", { workspace_id: workspace }),
    (error) => error.code === "machine_unavailable",
  )
})

test("raw text and keys use framed DATA without automatic Enter; closing streams keeps the shared socket", async (t) => {
  const { client, input, requests, sockets } = await fixture(t)
  await client.request("pane.send_text", { pane_id: "vps/t1", text: "hello" })
  await client.request("pane.send_keys", { pane_id: "vps/t1", keys: ["ctrl+c", "shift+tab", "up", "enter"] })
  await client.request("session.snapshot")
  assert.equal(sockets.size, 1)
  assert.equal(input[0].terminal, "vps/t1")
  assert.equal(input[0].payload.toString(), "hello")
  assert.equal(input[1].payload.toString(), "\x03\x1b[Z\x1b[A\r")
  assert.equal(
    requests.some((entry) => ["terminal.send", "terminal.keys"].includes(entry.method)),
    false,
  )
  const paint = await client.request("pane.read", { pane_id: "t1", format: "ansi" })
  assert.equal(paint.read.text, "\x1b[31mcolor\x1b[0m\x1b[?9001l")
  assert.equal(paint.read.vt, true)
  assert.equal(paint.read.cols, 80)
  assert.equal(paint.read.rows, 24)
  const plain = await client.request("pane.read", { pane_id: "t1", format: "text" })
  assert.equal(plain.read.truncated, true)
  assert.equal(plain.read.vt, undefined)
  await client.request("agent.prompt", { target: "vps/t1", text: "task" })
  assert.equal(requests.at(-1).method, "terminal.send")
})

test("large raw input obeys channel credit without truncation", async (t) => {
  const { client, input } = await fixture(t)
  const value = "x".repeat(600000)
  await client.request("pane.send_text", { pane_id: "t1", text: value })
  await client.request("session.snapshot")
  assert.equal(Buffer.concat(input.map((entry) => entry.payload)).toString(), value)
})

test("agent start safely quotes supported commands and refuses an existing program", async (t) => {
  const { client, input, setTerminals, requests } = await fixture(t)
  for (const kind of ["claude", "codex", "pi"]) {
    await client.request("agent.start", { pane_id: "t1", kind, name: "builder", args: ["a'b", "$(echo unsafe)"] })
    await client.request("session.snapshot")
    const command = input.at(-1).payload.toString()
    assert.equal(command, `'${kind}' 'a'\\''b' '$(echo unsafe)'\r`)
  }
  setTerminals([terminal("t1", { argv: ["vim"], foreground: { name: "vim", pid: 42 } })])
  await assert.rejects(client.request("agent.start", { pane_id: "t1", kind: "codex", args: [] }), {
    code: "agent_pane_busy",
  })
  assert.equal(
    requests.some((entry) => entry.method === "terminal.kill"),
    false,
  )
  await assert.rejects(client.request("pane.close"), (error) => error.code === "unsupported_method")
  await assert.rejects(client.request("agent.start", { pane_id: "t1", kind: "codex", args: ["bad\rcommand"] }), {
    code: "invalid_params",
  })
})

test("subscription invalidates snapshots, survives reconnect and stops at close", async (t) => {
  const { client, sockets } = await fixture(t)
  const events = []
  client.onEvent((type) => events.push(type))
  client.subscribe([])
  await client.request("session.snapshot")
  for (const socket of sockets) socket.destroy()
  await new Promise((done) => setTimeout(done, 30))
  assert.equal(events.includes("__connected"), true)
  assert.equal(events.includes("__disconnected"), true)
  await client.request("session.snapshot")
  client.close()
  const count = events.length
  await new Promise((done) => setTimeout(done, 40))
  assert.equal(events.length, count)
  await assert.rejects(client.request("session.snapshot"), /closed/)
})

test("key encoding includes modifiers and rejects unknown keys", () => {
  assert.equal(encodeCoreKeys(["ctrl+alt+x", "ctrl+shift+up", "f12"]), "\x1b\x18\x1b[1;6A\x1b[24~")
  assert.equal(encodeCoreKeys(["up"], true), "\x1bOA")
  assert.throws(() => encodeCoreKeys(["bogus"]), { code: "invalid_keys" })
})

test("real isolated hc supports create, ANSI paint, exact input and agent startup", {
  skip: process.env.HC_TEST_REAL !== "1",
}, async () => {
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, "core-live-"))
  const bin = join(root, "bin")
  await mkdir(bin)
  for (const kind of ["claude", "codex", "pi"]) {
    const path = join(bin, kind)
    await writeFile(path, "#!/bin/sh\nprintf 'core_agent:%s\\n' \"$@\"\n")
    await chmod(path, 0o700)
  }
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    HC_SESSION: "web-core-isolated",
    HC_SOCKET: join(root, "s"),
    SHELL: "/bin/sh",
  }
  const client = new CoreClient({ env, timeoutMs: 5000 })
  try {
    await exec("hc", ["server", "start"], { env, timeout: 10000 })
    await client.request("tab.create", { cwd: "~" })
    const created = await client.request("tab.create", { cwd: root })
    const address = created.pane_id
    const marker = join(root, "input-marker")
    await client.request("pane.send_text", { pane_id: address, text: `printf core_exact_input > '${marker}'` })
    await assert.rejects(readFile(marker), { code: "ENOENT" })
    const before = await client.request("pane.read", { pane_id: address, format: "text" })
    assert.equal(before.read.text.includes("printf core_exact_input"), true)
    await client.request("pane.send_keys", { pane_id: address, keys: ["enter"] })
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        if ((await readFile(marker, "utf8")) === "core_exact_input") break
      } catch {}
      await new Promise((done) => setTimeout(done, 20))
    }
    assert.equal(await readFile(marker, "utf8"), "core_exact_input")
    const after = await client.request("pane.read", { pane_id: address, format: "ansi" })
    assert.equal(after.read.text.includes("core_exact_input"), true)
    for (const kind of ["claude", "codex", "pi"]) {
      const pane = await client.request("tab.create", { cwd: root })
      await client.request("agent.start", { pane_id: pane.pane_id, name: kind, kind, args: ["a'b", "$(echo unsafe)"] })
      let output = ""
      for (let attempt = 0; attempt < 20; attempt++) {
        output = (await client.request("pane.read", { pane_id: pane.pane_id, format: "text" })).read.text
        if (output.includes("core_agent:a'b")) break
        await new Promise((done) => setTimeout(done, 20))
      }
      assert.equal(output.includes("core_agent:a'b"), true)
      assert.equal(output.includes("core_agent:$(echo unsafe)"), true)
      const running = (await client.request("session.snapshot")).snapshot.panes.find(
        (entry) => entry.pane_id === pane.pane_id,
      )
      assert.notEqual(running.agent_status, "exited")
      const survived = join(root, `shell-survived-${kind}`)
      await client.request("pane.send_text", { pane_id: pane.pane_id, text: `printf shell_survived > '${survived}'` })
      await client.request("pane.send_keys", { pane_id: pane.pane_id, keys: ["enter"] })
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          if ((await readFile(survived, "utf8")) === "shell_survived") break
        } catch {}
        await new Promise((done) => setTimeout(done, 20))
      }
      assert.equal(await readFile(survived, "utf8"), "shell_survived")
    }
    const snapshot = (await client.request("session.snapshot")).snapshot
    assert.equal(
      snapshot.panes.some((pane) => pane.pane_id === address),
      true,
    )
  } finally {
    client.close()
    await exec("hc", ["server", "stop"], { env, timeout: 10000 })
  }
})

test("ANSI paint spans DATA frames, credit-sized chunks and UTF-8 boundaries", async (t) => {
  const parts = [
    Buffer.from(`\x1b[31m${"x".repeat(270000)}`),
    Buffer.from([0xe4]),
    Buffer.from([0xb8, 0xad]),
    Buffer.from("\x1b[0m\x1b[?9001l"),
  ]
  const { client } = await fixture(t, parts)
  const { read } = await client.request("pane.read", { pane_id: "t1", format: "ansi" })
  assert.equal(read.text, Buffer.concat(parts).toString("utf8"))
  assert.equal(read.text.includes("\ufffd"), false)
  assert.equal(read.truncated, false)
  assert.equal(read.vt, true)
})

test("fish start quotes apostrophes and backslashes while keeping its shell", async (t) => {
  const { client, input, setTerminals } = await fixture(t)
  setTerminals([terminal("t1", { argv: ["/usr/bin/fish"], foreground: { pid: 42, name: "fish" } })])
  await client.request("agent.start", { pane_id: "t1", kind: "pi", args: ["a'b", "a\\b", "$(echo unsafe)"] })
  await client.request("session.snapshot")
  assert.equal(input[0].payload.toString(), "'pi' 'a\\'b' 'a\\\\b' '$(echo unsafe)'\r")
})

for (const backend of ["core", "auto"]) {
  test(`real HTTP ${backend} agent routes remote creation and preserves VT dimensions`, {
    timeout: 10000,
  }, async (t) => {
    const prefix = backend === "auto" ? "hc:" : ""
    const { root, socketPath, requests } = await fixture(t)
    const tuiPath = join(root, "tui.sock")
    const tuiRequests = []
    if (backend === "auto") {
      const tuiSockets = new Set()
      const tui = createServer((socket) => {
        tuiSockets.add(socket)
        socket.on("close", () => tuiSockets.delete(socket))
        let buffer = ""
        socket.on("data", (chunk) => {
          buffer += chunk.toString()
          if (!buffer.includes("\n")) return
          const message = JSON.parse(buffer.slice(0, buffer.indexOf("\n")))
          tuiRequests.push(message)
          const result =
            message.method === "session.snapshot"
              ? { snapshot: { workspaces: [], tabs: [], panes: [], agents: [] } }
              : { workspace_id: "w1" }
          socket.write(`${JSON.stringify({ id: message.id, result })}\n`)
          if (message.method !== "events.subscribe") socket.end()
        })
      })
      await new Promise((done) => tui.listen(tuiPath, done))
      t.after(async () => {
        for (const socket of tuiSockets) socket.destroy()
        await new Promise((done) => tui.close(done))
      })
    }
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
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", bootstrap, root, pathToFileURL(resolve("agent/dist/index.js")).href],
      {
        cwd: resolve("."),
        env: {
          PATH: process.env.PATH,
          HOME: root,
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_STATE_HOME: join(root, "state"),
          XDG_DATA_HOME: join(root, "data"),
          XDG_CACHE_HOME: join(root, "cache"),
          HC_SESSION: "web-core-http-isolated",
          HC_SOCKET: socketPath,
          HERDR_WEB_BACKEND: backend === "auto" ? undefined : backend,
          SHELL: join(root, "absent-shell"),
          HERDR_WEB_HOST: "127.0.0.1",
          HERDR_WEB_PORT: "0",
          HERDR_WEB_PASSWORD: "",
          HERDR_WEB_RELAY_URL: "",
          HERDR_SOCKET_PATH: tuiPath,
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    )
    const stopped = once(child, "exit")
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await stopped
    })
    const [{ port }] = await once(child, "message", { signal: t.signal })
    const base = `http://127.0.0.1:${port}`
    let state
    for (let attempt = 0; attempt < 30; attempt++) {
      state = await (await fetch(`${base}/api/state`)).json()
      if (state.connected && state.state.panes.some((pane) => pane.pane_id === `${prefix}vps/t1`)) break
      await new Promise((done) => setTimeout(done, 20))
    }
    assert.equal(state.ok, true)
    assert.equal(state.connected, true)
    assert.equal(
      state.state.panes.some((pane) => pane.pane_id === `${prefix}t1`),
      true,
    )
    const remote = state.state.panes.find((pane) => pane.pane_id === `${prefix}vps/t1`)
    assert.ok(remote)
    const workspace = state.state.workspaces.find((entry) => entry.workspace_id === remote.workspace_id)
    assert.ok(workspace)
    await assert.rejects(stat("/remote/only"), (error) => error.code === "ENOENT")
    const createdResponse = await fetch(`${base}/api/tab/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspace.workspace_id, cwd: "/remote/only" }),
    })
    assert.equal(createdResponse.status, 200)
    const created = await createdResponse.json()
    assert.equal(created.ok, true)
    assert.equal(created.result.pane_id.startsWith(`${prefix}vps/`), true)
    const run = requests.find((request) => request.method === "terminal.run")
    assert.equal(run.params.on, "vps")
    assert.equal(run.params.cwd, "/remote/only")
    const readResponse = await fetch(
      `${base}/api/pane/read?pane=${encodeURIComponent(created.result.pane_id)}&format=ansi`,
    )
    assert.equal(readResponse.status, 200)
    const result = await readResponse.json()
    assert.equal(result.ok, true)
    assert.equal(result.result.read.vt, true)
    assert.equal(result.result.read.cols, 80)
    assert.equal(result.result.read.rows, 24)
    assert.equal(result.result.read.text, "\x1b[31mcolor\x1b[0m\x1b[?9001l")
    assert.equal(
      requests.filter((request) => request.method === "terminal.attach").at(-1).params.terminal,
      created.result.pane_id.slice(prefix.length),
    )
    if (backend === "auto") {
      const createWorkspace = async (params) =>
        (
          await fetch(`${base}/api/workspace/create`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cwd: "/project", ...params }),
          })
        ).json()
      const coreWorkspace = await createWorkspace({ backend: "hc" })
      assert.equal(coreWorkspace.ok, true)
      assert.equal(coreWorkspace.result.pane_id.startsWith("hc:"), true)
      assert.equal(requests.filter((entry) => entry.method === "terminal.run").length, 2)
      assert.equal(tuiRequests.filter((entry) => entry.method === "workspace.create").length, 0)
      const tuiWorkspace = await createWorkspace({})
      assert.equal(tuiWorkspace.ok, true)
      assert.equal(tuiWorkspace.result.workspace_id, "w1")
      assert.equal(tuiRequests.filter((entry) => entry.method === "workspace.create").length, 1)
      assert.equal(requests.filter((entry) => entry.method === "terminal.run").length, 2)
    }
  })
}
