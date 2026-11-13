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
