import assert from "node:assert/strict"
import { test } from "node:test"

import { AlmaTunnel } from "../web/dist/alma.js"
import { closeRemote, createTerminalTab, openAlmaRemote, sendKeys, sendText, startAgent } from "../web/dist/api.js"

test("New Tab reports an Alma refusal without claiming that a pane was created", async (t) => {
  t.mock.method(AlmaTunnel.prototype, "connect", async () => {})
  t.mock.method(AlmaTunnel.prototype, "request", async () => ({
    status: 403,
    headers: {},
    body: new TextEncoder().encode(JSON.stringify({ error: { message: "creation refused" } })),
  }))
  await openAlmaRemote({ relay: "https://relay.example", code: "test-only" })
  assert.deepEqual(await createTerminalTab("w1", "/project"), { paneId: null, error: "creation refused" })
})

test("New Tab on Alma retains focus:false, extracts nested pane IDs, and reports missing IDs", async (t) => {
  const payloads = []
  let result = { tab: { panes: [{ pane_id: "new-pane" }] } }
  t.mock.method(AlmaTunnel.prototype, "connect", async () => {})
  t.mock.method(AlmaTunnel.prototype, "request", async (_verb, _path, body) => {
    payloads.push(JSON.parse(new TextDecoder().decode(body)))
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ result })) }
  })
  await openAlmaRemote({ relay: "https://relay.example", code: "test-only" })
  assert.deepEqual(await createTerminalTab("w2", "/project"), { paneId: "new-pane", error: null })
  assert.deepEqual(payloads[0], { method: "tab.create", params: { workspace_id: "w2", cwd: "/project", focus: false } })
  result = {}
  assert.match((await createTerminalTab("w2", null)).error, /did not return the new pane/)
  assert.deepEqual(payloads[1].params, { workspace_id: "w2", cwd: "~", focus: false })
})

test("Alma retains shell readiness error codes for safe startup retries", async (t) => {
  t.mock.method(AlmaTunnel.prototype, "connect", async () => {})
  t.mock.method(AlmaTunnel.prototype, "request", async () => ({
    status: 400,
    headers: {},
    body: new TextEncoder().encode(
      JSON.stringify({ error: { code: "agent_pane_busy", message: "not an available shell" } }),
    ),
  }))
  await openAlmaRemote({ relay: "https://relay.example", code: "test-only" })
  assert.deepEqual(await startAgent("new-pane", "codex-new-pane", "codex", []), {
    code: "agent_pane_busy",
    error: "not an available shell",
  })
})

test("pane writes stay ordered and continue after a failed send", async (t) => {
  closeRemote()
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  const calls = []
  t.mock.method(globalThis, "fetch", async (path, options) => {
    calls.push([path, JSON.parse(options.body)])
    if (calls.length === 1) {
      started.resolve()
      await release.promise
      throw new Error("mock disconnect")
    }
    return new Response(JSON.stringify({ ok: true }))
  })
  const first = sendText("pane-a", "hello")
  await started.promise
  const second = sendKeys("pane-a", ["enter"])
  await Promise.resolve()
  assert.equal(calls.length, 1, "the later write must wait for the first response")
  const failed = assert.rejects(first, /mock disconnect/)
  release.resolve()
  await failed
  assert.equal(await second, null)
  assert.deepEqual(calls, [
    ["/api/pane/text", { pane_id: "pane-a", text: "hello" }],
    ["/api/pane/keys", { pane_id: "pane-a", keys: ["enter"] }],
  ])
})

test("queued input cannot cross to another paired desktop", async (t) => {
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  const calls = []
  t.mock.method(AlmaTunnel.prototype, "connect", async () => {})
  t.mock.method(AlmaTunnel.prototype, "request", async function (_verb, _path, body) {
    calls.push({ tunnel: this, request: JSON.parse(new TextDecoder().decode(body)) })
    if (calls.length === 1) {
      started.resolve()
      await release.promise
    }
    return { status: 200, body: new TextEncoder().encode(JSON.stringify({ result: {} })) }
  })
  await openAlmaRemote({ relay: "https://first.example", code: "test-only" })
  const first = sendText("vps/t1", "first")
  await started.promise
  const queued = sendKeys("vps/t1", ["enter"])
  const rejected = assert.rejects(queued, /target desktop changed/)
  await openAlmaRemote({ relay: "https://second.example", code: "test-only" })
  const next = sendText("t1", "second")
  release.resolve()
  assert.equal(await first, null)
  await rejected
  assert.equal(await next, null)
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0].tunnel, calls[1].tunnel)
  assert.equal(calls[1].request.params.text, "second")
  closeRemote()
})

test("Alma reports HTTP 200 RPC errors and preserves remote creation IDs", async (t) => {
  const calls = []
  let response = { result: { tab: { panes: [{ pane_id: "hc:vps/t2" }] } } }
  t.mock.method(AlmaTunnel.prototype, "connect", async () => {})
  t.mock.method(AlmaTunnel.prototype, "request", async (_verb, _path, body) => {
    calls.push(JSON.parse(new TextDecoder().decode(body)))
    return { status: 200, body: new TextEncoder().encode(JSON.stringify(response)) }
  })
  await openAlmaRemote({ relay: "https://relay.example", code: "test-only" })
  assert.deepEqual(await createTerminalTab("hc:vps/project", "/srv/project"), { paneId: "hc:vps/t2", error: null })
  assert.deepEqual(calls[0].params, { workspace_id: "hc:vps/project", cwd: "/srv/project", focus: false })
  response = { error: { code: "machine_offline", message: "vps is offline" } }
  assert.deepEqual(await startAgent("hc:vps/t2", "codex-vps-t2", "codex", []), {
    code: "machine_offline",
    error: "vps is offline",
  })
  closeRemote()
})

test("New Tab on the local API retains the new pane ID and does not move focus", async (t) => {
  closeRemote()
  const calls = []
  t.mock.method(globalThis, "fetch", async (path, options) => {
    calls.push([path, JSON.parse(options.body)])
    return new Response(JSON.stringify({ ok: true, result: { pane_id: "local-pane" } }))
  })
  assert.deepEqual(await createTerminalTab("w2", "/project"), { paneId: "local-pane", error: null })
  assert.deepEqual(calls, [["/api/tab/create", { workspace_id: "w2", cwd: "/project", focus: false }]])
})
