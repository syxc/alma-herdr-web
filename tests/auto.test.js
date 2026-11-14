import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { AutoClient } from "../agent/dist/auto.js"

function snapshot(id = "t1", workspace = "core:t1") {
  const pane = { pane_id: id, tab_id: id, workspace_id: workspace, focused: true, agent: "claude" }
  return {
    snapshot: {
      version: "test",
      protocol: 1,
      panes: [pane],
      tabs: [{ tab_id: id, workspace_id: workspace }],
      workspaces: [{ workspace_id: workspace, active_tab_id: id }],
      agents: [{ ...pane, name: "worker" }],
      focused_pane_id: id,
      focused_tab_id: id,
      focused_workspace_id: workspace,
    },
  }
}

class FakeClient {
  calls = []
  subscriptions = []
  handlers = []
  closed = false
  online = true
  result = snapshot()
  failure = null
  async request(method, params = {}) {
    this.calls.push({ method, params })
    if (!this.online || (this.failure && method !== "session.snapshot")) throw new Error("source failed")
    if (method === "session.snapshot") return structuredClone(this.result)
    return { pane_id: params.pane_id ?? "vps/t2", tab_id: "vps/t2", workspace_id: "core:t1" }
  }
  onEvent(handler) {
    this.handlers.push(handler)
  }
  subscribe(entries) {
    this.subscriptions.push(entries)
  }
  emit(type, data = {}) {
    for (const handler of this.handlers) handler(type, data)
  }
  close() {
    this.closed = true
  }
}

function fakeAuto(t, options = {}) {
  const tui = new FakeClient()
  const core = new FakeClient()
  const created = []
  const client = new AutoClient({
    tuiSockets: () => ["tui"],
    coreSockets: () => ["core"],
    createTuiClient: (path) => {
      created.push(path)
      return tui
    },
    createCoreClient: (path) => {
      created.push(path)
      return core
    },
    ...options,
  })
  t.after(() => client.close())
  return { client, tui, core, created }
}

test("discovery is lazy, validates candidates, caches clients and namespaces every core identity", async (t) => {
  const invalid = new FakeClient()
  invalid.result = { snapshot: {} }
  const bad = new FakeClient()
  bad.online = false
  const tui = new FakeClient()
  const { client, core, created } = fakeAuto(t, {
    tuiSockets: () => ["bad", "invalid", "good", "unused"],
    createTuiClient: (path) => ({ bad, invalid, good: tui })[path],
  })
  client.subscribe([
    { type: "pane.created" },
    { type: "pane_output_changed", pane_id: "hc:t1" },
    { type: "pane_output_changed", pane_id: "t1" },
  ])
  assert.deepEqual(created, [])
  assert.deepEqual(core.subscriptions, [])
  await assert.rejects(client.request("pane.send_text", { pane_id: "hc:t1", text: "early" }), /unavailable/)
  assert.deepEqual(created, [])
  const { snapshot: merged } = await client.request("session.snapshot")
  assert.equal(bad.closed, true)
  assert.equal(invalid.closed, true)
  assert.deepEqual(
    merged.panes.map((pane) => pane.pane_id),
    ["t1", "hc:t1"],
  )
  assert.equal(merged.panes[1].tab_id, "hc:t1")
  assert.equal(merged.panes[1].workspace_id, "hc:core:t1")
  assert.equal(merged.agents[1].pane_id, "hc:t1")
  assert.equal(merged.agents[1].name, "worker")
  assert.equal(merged.workspaces[1].active_tab_id, "hc:t1")
  assert.equal(merged.focused_pane_id, "t1")
  assert.deepEqual(core.subscriptions[0], [{ type: "pane.created" }, { type: "pane_output_changed", pane_id: "t1" }])
  assert.deepEqual(tui.subscriptions[0], core.subscriptions[0])
  await client.request("session.snapshot")
  assert.deepEqual(created, ["core"])
  assert.equal(core.subscriptions.length, 1)
})

test("a failing endpoint discovery callback cannot hide the healthy backend", async (t) => {
  const { client } = fakeAuto(t, {
    tuiSockets: () => {
      throw new Error("directory unavailable")
    },
  })
  assert.deepEqual(
    (await client.request("session.snapshot")).snapshot.panes.map((pane) => pane.pane_id),
    ["hc:t1"],
  )
})

test("TUI-only and core-only snapshots keep their own focus and default creation backend", async (t) => {
  for (const backend of ["tui", "core"]) {
    const { client, tui, core } = fakeAuto(t, {
      tuiSockets: () => (backend === "tui" ? ["tui"] : []),
      coreSockets: () => (backend === "core" ? ["core"] : []),
    })
    const { snapshot: merged } = await client.request("session.snapshot")
    const prefix = backend === "core" ? "hc:" : ""
    assert.equal(merged.focused_pane_id, `${prefix}t1`)
    assert.equal(merged.focused_tab_id, `${prefix}t1`)
    assert.equal(merged.focused_workspace_id, `${prefix}core:t1`)
    await client.request("workspace.create", { cwd: "/project" })
    const active = backend === "tui" ? tui : core
    assert.equal(active.calls.at(-1).method, "workspace.create")
    assert.equal((backend === "tui" ? core : tui).calls.length, 0)
  }
})

test("only ping and workspace creation default to core; explicit hc creation works with both online", async (t) => {
  const { client, tui, core } = fakeAuto(t)
  await client.request("session.snapshot")
  await client.request("ping")
  assert.equal(tui.calls.at(-1).method, "ping")
  await client.request("workspace.create", { backend: "hc", cwd: "/project" })
  assert.equal(core.calls.at(-1).method, "workspace.create")
  const coreOnly = fakeAuto(t, { tuiSockets: () => [] })
  await coreOnly.client.request("session.snapshot")
  await coreOnly.client.request("ping")
  assert.equal(coreOnly.core.calls.at(-1).method, "ping")
  const before = coreOnly.core.calls.length
  await assert.rejects(coreOnly.client.request("tab.focus"), /tui backend is unavailable/)
  await assert.rejects(coreOnly.client.request("tab.create"), /tui backend is unavailable/)
  assert.equal(coreOnly.core.calls.length, before)
})

test("routes by namespaced IDs, preserves full remote addresses and does not mutate params", async (t) => {
  const { client, tui, core } = fakeAuto(t)
  await client.request("session.snapshot")
  for (const method of ["pane.read", "pane.send_text", "pane.send_keys", "pane.focus", "agent.start"]) {
    const params = { pane_id: "hc:vps/t1", text: "hc:literal", keys: ["enter"], kind: "claude", args: [] }
    const result = await client.request(method, params)
    assert.equal(core.calls.at(-1).params.pane_id, "vps/t1")
    assert.equal(core.calls.at(-1).params.text, "hc:literal")
    assert.equal(params.pane_id, "hc:vps/t1")
    assert.equal(result.pane_id, "hc:vps/t1")
  }
  await client.request("pane.send_text", { pane_id: "t1", text: "local" })
  assert.equal(tui.calls.at(-1).params.pane_id, "t1")
  const created = await client.request("tab.create", { workspace_id: "hc:core:t1", cwd: "/remote/project" })
  assert.equal(core.calls.at(-1).params.workspace_id, "core:t1")
  assert.equal(created.pane_id, "hc:vps/t2")
  await client.request("agent.prompt", { target: "hc:vps/t1", text: "next" })
  assert.equal(core.calls.at(-1).params.target, "vps/t1")
  await assert.rejects(client.request("tab.create", { pane_id: "t1", workspace_id: "hc:core:t1" }), /multiple backends/)
  await assert.rejects(client.request("pane.send_text", { text: "missing target" }), /explicit/)
})

test("ambiguous or unknown agent names fail; unique names resolve to the exact backend pane", async (t) => {
  const { client, tui, core } = fakeAuto(t)
  await client.request("session.snapshot")
  await assert.rejects(client.request("agent.prompt", { target: "worker", text: "x" }), /exactly one/)
  await assert.rejects(client.request("agent.prompt", { target: "missing", text: "x" }), /exactly one/)
  assert.equal(tui.calls.length, 1)
  assert.equal(core.calls.length, 1)
  core.result.snapshot.agents[0].name = "remote-worker"
  await client.request("session.snapshot")
  await client.request("agent.prompt", { target: "remote-worker", text: "x" })
  assert.equal(core.calls.at(-1).params.target, "t1")
})

test("failed input is never retried on another backend or socket", async (t) => {
  const unused = new FakeClient()
  const first = new FakeClient()
  const factoryCalls = []
  const { client, tui } = fakeAuto(t, {
    coreSockets: () => ["first", "unused"],
    createCoreClient: (path) => {
      factoryCalls.push(path)
      return path === "first" ? first : unused
    },
  })
  await client.request("session.snapshot")
  first.failure = new Error("lost reply")
  const before = first.calls.length
  await assert.rejects(client.request("pane.send_text", { pane_id: "hc:t1", text: "once" }), /source failed/)
  assert.equal(first.calls.length, before + 1)
  assert.equal(tui.calls.length, 1)
  assert.equal(unused.calls.length, 0)
  assert.deepEqual(factoryCalls, ["first"])
})

for (const backend of ["tui", "core"]) {
  test(`${backend} identity stays pinned through an outage even when another socket has the same pane ID`, async (t) => {
    let first = new FakeClient()
    const other = new FakeClient()
    const candidates = []
    const { client } = fakeAuto(t, {
      [backend === "core" ? "coreSockets" : "tuiSockets"]: () => ["first", "other"],
      [backend === "core" ? "createCoreClient" : "createTuiClient"]: (path) => {
        candidates.push(path)
        return path === "first" ? first : other
      },
    })
    const paneId = backend === "core" ? "hc:t1" : "t1"
    await client.request("session.snapshot")
    await client.request("pane.send_text", { pane_id: paneId, text: "before" })
    assert.equal(first.calls.at(-1).params.text, "before")
    first.online = false
    await client.request("session.snapshot")
    await assert.rejects(client.request("pane.send_text", { pane_id: paneId, text: "during" }), /unavailable/)
    await client.request("session.snapshot")
    await assert.rejects(client.request("pane.send_keys", { pane_id: paneId, keys: ["enter"] }), /unavailable/)
    assert.equal(other.calls.length, 0)
    first = new FakeClient()
    assert.ok((await client.request("session.snapshot")).snapshot.panes.some((pane) => pane.pane_id === paneId))
    await client.request("pane.send_text", { pane_id: paneId, text: "after" })
    assert.equal(first.calls.at(-1).params.text, "after")
    assert.equal(candidates.includes("other"), false)
  })
}

test("one side can disconnect and recover while the other snapshot stays online; events request a unified refresh", async (t) => {
  let current = new FakeClient()
  const { client, tui } = fakeAuto(t, { createCoreClient: () => current })
  const events = []
  client.onEvent((type, data) => events.push({ type, data }))
  await client.request("session.snapshot")
  current.emit("pane_output_changed", { pane_id: "vps/t1", revision: 2 })
  assert.deepEqual(events.pop(), { type: "pane_output_changed", data: { pane_id: "hc:vps/t1", revision: 2 } })
  current.emit("__disconnected")
  assert.equal(events.pop().type, "__connected")
  current.online = false
  assert.deepEqual(
    (await client.request("session.snapshot")).snapshot.panes.map((pane) => pane.pane_id),
    ["t1"],
  )
  assert.equal(current.closed, true)
  const retired = current
  current = new FakeClient()
  assert.equal((await client.request("session.snapshot")).snapshot.panes.length, 2)
  retired.emit("__disconnected")
  assert.equal(events.length, 0)
  tui.online = false
  assert.deepEqual(
    (await client.request("session.snapshot")).snapshot.panes.map((pane) => pane.pane_id),
    ["hc:t1"],
  )
})

test("all-offline uses one 1.5 second invalidation timer, coalesces snapshots and stops after close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let paths = []
  const core = new FakeClient()
  const { client, created } = fakeAuto(t, {
    tuiSockets: () => [],
    coreSockets: () => paths,
    createCoreClient: () => {
      created.push("core")
      return core
    },
  })
  let invalidations = 0
  client.onEvent((type) => {
    if (type === "__connected") invalidations++
  })
  await Promise.all([
    assert.rejects(client.request("session.snapshot"), /No running/),
    assert.rejects(client.request("session.snapshot"), /No running/),
  ])
  await assert.rejects(client.request("session.snapshot"), /No running/)
  t.mock.timers.tick(1499)
  assert.equal(invalidations, 0)
  t.mock.timers.tick(1)
  assert.equal(invalidations, 1)
  paths = ["new-core"]
  await Promise.all([client.request("session.snapshot"), client.request("session.snapshot")])
  assert.deepEqual(created, ["core"])
  assert.equal(core.calls.length, 1)
  t.mock.timers.tick(3000)
  assert.equal(invalidations, 1)
  client.close()
  t.mock.timers.tick(3000)
  assert.equal(invalidations, 1)
  await assert.rejects(client.request("session.snapshot"), /closed/)
})

function frame(channel, kind, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(9)
  header.writeUInt32LE(channel)
  header[4] = kind
  header.writeUInt32LE(payload.length, 5)
  return Buffer.concat([header, payload])
}

async function socketFixture(t, options = {}) {
  await mkdir(resolve(".cache"), { recursive: true })
  const root = await mkdtemp(join(resolve(".cache"), "auto-"))
  const paths = { tui: join(root, "tui"), core: join(root, "core") }
  const requests = { tui: [], core: [] }
  const input = []
  const servers = {}
  const sockets = { tui: new Set(), core: new Set() }
  const subscribers = new Set()
  const terminal = (address) => ({
    address,
    cwd: "/project",
    state: "live",
    rows: 24,
    cols: 80,
    argv: ["/bin/sh"],
    pid: 42,
    foreground: { name: "sh", pid: 42 },
    status: { app: "claude" },
  })
  const terminals = [terminal("t1"), terminal("vps/t1")]
  async function start(backend) {
    const server = createServer((socket) => {
      sockets[backend].add(socket)
      socket.on("error", () => {})
      socket.on("close", () => {
        sockets[backend].delete(socket)
        subscribers.delete(socket)
      })
      let buffer = Buffer.alloc(0)
      let framed = false
      const channels = new Map()
      function request(message) {
        requests[backend].push(message)
        let result = {}
        if (backend === "tui") {
          options.onTuiRequest?.()
          if (options.silentTui) return
          if (message.method === "events.subscribe") subscribers.add(socket)
          else if (message.method === "session.snapshot") result = snapshot("t1", "w1")
          else result = { pane_id: message.params.pane_id }
          socket.write(`${JSON.stringify({ id: message.id, result })}\n`)
          if (message.method !== "events.subscribe") socket.end()
          return
        }
        const params = message.params
        if (message.method === "hello") result = { framed: true, generation: 1 }
        else if (message.method === "terminal.list")
          result = { terminals, machines: [{ name: "vps", state: "connected" }] }
        else if (message.method === "terminal.get")
          result = terminals.find((entry) => entry.address === params.terminal)
        else if (message.method === "terminal.read") result = { text: `${params.terminal} output`, complete: true }
        else if (message.method === "terminal.run") {
          result = terminal(`${params.on ? `${params.on}/` : ""}t${terminals.length + 1}`)
          result.labels = params.labels
          terminals.push(result)
        } else if (message.method === "terminal.attach") {
          result = { channel: channels.size + 1 }
          channels.set(result.channel, params.terminal)
        }
        const response = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
        if (message.method === "hello" && !framed) {
          socket.write(Buffer.concat([response, Buffer.from("\n")]))
          framed = true
        } else socket.write(frame(0, 0, response))
      }
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        if (!framed) {
          let index = buffer.indexOf(10)
          while (index >= 0 && !framed) {
            const message = JSON.parse(buffer.subarray(0, index))
            buffer = buffer.subarray(index + 1)
            request(message)
            index = buffer.indexOf(10)
          }
        }
        while (framed && buffer.length >= 9) {
          const channel = buffer.readUInt32LE(0)
          const kind = buffer[4]
          const size = buffer.readUInt32LE(5)
          if (buffer.length < size + 9) return
          const payload = buffer.subarray(9, size + 9)
          buffer = buffer.subarray(size + 9)
          if (!channel) request(JSON.parse(payload))
          else if (kind === 0) input.push({ terminal: channels.get(channel), text: payload.toString() })
          else if (kind === 2) socket.write(frame(channel, 2))
        }
      })
    })
    servers[backend] = server
    await new Promise((done) => server.listen(paths[backend], done))
  }
  async function stop(backend) {
    for (const socket of sockets[backend]) socket.destroy()
    if (servers[backend]?.listening) await new Promise((done) => servers[backend].close(done))
  }
  const client = new AutoClient({
    tuiSockets: () => [paths.tui],
    coreSockets: () => [paths.core],
    ...options.clientOptions,
  })
  t.after(async () => {
    client.close()
    await stop("tui")
    await stop("core")
    await rm(root, { recursive: true, force: true })
  })
  return { client, requests, input, start, stop, subscribers }
}

test("an unresponsive TUI releases the pending snapshot and reconnects after its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const accepted = Promise.withResolvers()
  const options = {
    silentTui: true,
    onTuiRequest: accepted.resolve,
    clientOptions: { createCoreClient: () => new FakeClient() },
  }
  const { client, start, requests } = await socketFixture(t, options)
  await start("tui")
  let result
  const pending = client.request("session.snapshot").then((value) => {
    result = value
  })
  const coalesced = client.request("session.snapshot")
  await accepted.promise
  t.mock.timers.tick(5000)
  await new Promise((done) => setImmediate(done))
  assert.ok(result, "the healthy core snapshot must finish after the TUI deadline")
  await pending
  assert.deepEqual(
    (await coalesced).snapshot.panes.map((pane) => pane.pane_id),
    ["hc:t1"],
  )
  options.silentTui = false
  assert.deepEqual(
    (await client.request("session.snapshot")).snapshot.panes.map((pane) => pane.pane_id),
    ["t1", "hc:t1"],
  )
  assert.equal(requests.tui.length, 2)
})

test("isolated native sockets merge colliding IDs, read/write/create remotely, survive outages and recover", async (t) => {
  const { client, requests, input, start, stop } = await socketFixture(t)
  const events = []
  client.onEvent((type) => events.push(type))
  client.subscribe([{ type: "pane.created" }])
  await assert.rejects(client.request("session.snapshot"), /No running/)
  await start("tui")
  assert.equal((await client.request("session.snapshot")).snapshot.panes.length, 1)
  await start("core")
  const merged = (await client.request("session.snapshot")).snapshot
  assert.deepEqual(
    merged.panes.map((pane) => pane.pane_id),
    ["t1", "hc:t1", "hc:vps/t1"],
  )
  const read = await client.request("pane.read", { pane_id: "hc:vps/t1", format: "plain", lines: 10 })
  assert.equal(read.read.text, "vps/t1 output")
  await client.request("pane.send_text", { pane_id: "hc:vps/t1", text: "once" })
  const remote = merged.panes.find((pane) => pane.pane_id === "hc:vps/t1")
  const created = await client.request("tab.create", { workspace_id: remote.workspace_id, cwd: "/remote" })
  assert.equal(created.pane_id, "hc:vps/t3")
  assert.equal(requests.core.find((entry) => entry.method === "terminal.run").params.on, "vps")
  assert.equal(requests.core.filter((entry) => entry.method === "hello").length, 1)
  await new Promise((done) => setImmediate(done))
  assert.deepEqual(input, [{ terminal: "vps/t1", text: "once" }])
  await stop("tui")
  assert.equal((await client.request("session.snapshot")).snapshot.panes.length, 3)
  await start("tui")
  assert.equal((await client.request("session.snapshot")).snapshot.panes.length, 4)
  await stop("core")
  const tuiRequests = requests.tui.length
  await assert.rejects(client.request("pane.send_text", { pane_id: "hc:vps/t1", text: "do not replay" }))
  assert.equal(requests.tui.length, tuiRequests)
  assert.equal((await client.request("session.snapshot")).snapshot.panes.length, 1)
  assert.equal(events.includes("__disconnected"), false)
  await start("core")
  assert.equal((await client.request("session.snapshot")).snapshot.panes.length, 4)
  await stop("core")
  await stop("tui")
  await assert.rejects(client.request("session.snapshot"), /No running/)
})
