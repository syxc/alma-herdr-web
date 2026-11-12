import assert from "node:assert/strict"
import { test } from "node:test"

import { AlmaTunnel } from "../web/dist/alma.js"
import {
  closeRemote,
  createTab,
  createTerminalTab,
  createWorkspace,
  openAlmaRemote,
  startAgent,
} from "../web/dist/api.js"

for (const method of ["workspace.create", "tab.create"]) {
  test(`${method} uses the Alma RPC tunnel and reports refusal`, async (t) => {
    const calls = []
    let status = 200
    t.mock.method(AlmaTunnel.prototype, "connect", async () => {})
    t.mock.method(AlmaTunnel.prototype, "request", async (verb, path, body, headers) => {
      calls.push({ verb, path, payload: JSON.parse(new TextDecoder().decode(body)), headers })
      return {
        status,
        headers: {},
        body: new TextEncoder().encode(
          JSON.stringify(status === 200 ? { result: {} } : { error: { message: "creation refused" } }),
        ),
      }
    })
    await openAlmaRemote({ relay: "https://relay.example", code: "test-only" })
    const create = () =>
      method === "tab.create" ? createTab("w1", "/project", "acceptance") : createWorkspace("/project", "acceptance")
    assert.equal(await create(), null)
    assert.deepEqual(calls[0], {
      verb: "POST",
      path: "/api/herdr/rpc",
      payload: {
        method,
        params: {
          ...(method === "tab.create" ? { workspace_id: "w1" } : {}),
          cwd: "/project",
          label: "acceptance",
          focus: true,
        },
      },
      headers: { "content-type": "application/json" },
    })
    status = 403
    assert.equal(await create(), "creation refused")
  })
}

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
  assert.deepEqual(payloads[1].params, { workspace_id: "w2", focus: false })
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
