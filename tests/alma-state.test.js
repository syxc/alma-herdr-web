import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { AlmaMock } from "../mock/dist/alma-mock.js"
import { AlmaTunnel } from "../web/dist/alma.js"
import { closeRemote, fetchState, openAlmaRemote, readPane, sendKeys, sendText } from "../web/dist/api.js"

function snapshot() {
  return {
    version: "core-0.1.21",
    protocol: 1,
    focused_pane_id: "hc:vps/t1",
    workspaces: [
      { workspace_id: "hc:local-project", label: "This computer / project", number: 1 },
      { workspace_id: "hc:vps-project", label: "vps / project", number: 2 },
    ],
    tabs: [
      { workspace_id: "hc:local-project", tab_id: "hc:local-tab", number: 1 },
      { workspace_id: "hc:vps-project", tab_id: "hc:vps-tab", number: 1 },
    ],
    panes: [
      {
        pane_id: "hc:t1",
        workspace_id: "hc:local-project",
        tab_id: "hc:local-tab",
        agent_status: "idle",
        scroll: { viewport_rows: 24 },
      },
      {
        pane_id: "hc:vps/t1",
        workspace_id: "hc:vps-project",
        tab_id: "hc:vps-tab",
        agent_status: "working",
        revision: 4,
        scroll: { viewport_rows: 39 },
      },
    ],
  }
}

async function waitForState(predicate) {
  const deadline = Date.now() + 3000
  do {
    const state = await fetchState()
    if (predicate(state)) return state
    await delay(5)
  } while (Date.now() < deadline)
  assert.fail("Expected streamed state did not arrive before the deadline")
}

async function desktop(t, deliveryDelay = 0) {
  if (deliveryDelay) {
    const openStream = AlmaTunnel.prototype.openStream
    // Frame delivery must remain asynchronous even when localhost I/O is fast.
    t.mock.method(AlmaTunnel.prototype, "openStream", function (path, message, close) {
      return openStream.call(this, path, (bytes) => setTimeout(() => message(bytes), deliveryDelay), close)
    })
  }
  const mock = new AlmaMock(undefined, snapshot())
  await mock.start()
  t.after(async () => {
    closeRemote()
    await mock.stop()
  })
  await openAlmaRemote({ relay: mock.url, code: mock.code })
  return mock
}

test("Alma core uses the unified snapshot without unsupported TUI list RPCs", async (t) => {
  const mock = await desktop(t)
  const result = await fetchState()
  assert.equal(result.connected, true)
  assert.equal(result.state.version, "core-0.1.21")
  assert.equal(result.state.focused_pane_id, "hc:vps/t1")
  assert.deepEqual(
    result.state.panes.map((p) => p.pane_id),
    ["hc:t1", "hc:vps/t1"],
  )
  assert.equal(result.state.panes[1].revision, 4)
  assert.equal(result.state.panes[1].viewport_rows, 39)
  assert.equal(mock.requests.length, 1)
  assert.equal(mock.requests[0].path, "/api/herdr/info")
  assert.equal((await fetchState()).connected, true)
  assert.equal(mock.requests.length, 1, "polling reuses the live snapshot stream")
})

test("Alma core routes same-number terminals on different machines independently", async (t) => {
  const mock = await desktop(t)
  await fetchState()
  assert.equal(await sendText("hc:vps/t1", "remote only"), null)
  assert.equal(await sendKeys("hc:vps/t1", ["enter"]), null)
  assert.equal(await sendText("hc:t1", "local only"), null)
  assert.equal((await readPane("hc:vps/t1", "visible", "ansi", 0)).text, "remote only\r\n")
  assert.equal(mock.outputOf("hc:t1"), "local only")
  assert.equal(mock.requests.find((r) => r.method === "pane.read").params.pane_id, "hc:vps/t1")
})

test("a core state stream updates and closes without closing the shared request tunnel", async (t) => {
  const mock = await desktop(t, 40)
  await fetchState()
  const changed = snapshot()
  changed.panes[1].agent_status = "blocked"
  await mock.emitState({ type: "snapshot", snapshot: changed })
  await waitForState((result) => result.state?.panes[1].agent_status === "blocked")
  assert.equal((await fetchState()).state.panes[1].agent_status, "blocked")
  await mock.closeStateStreams()
  await waitForState((result) => !result.connected)
  assert.equal((await fetchState()).connected, false)
  assert.equal(await sendText("hc:vps/t1", "still on the request tunnel"), null)
  await openAlmaRemote({ relay: mock.url, code: mock.code })
  assert.equal((await fetchState()).connected, true)
})

test("malformed and offline core snapshots do not turn into an empty connected session", async (t) => {
  const mock = await desktop(t, 40)
  await fetchState()
  await mock.emitState({ type: "herdr", online: false })
  await waitForState((result) => !result.connected)
  assert.equal((await fetchState()).connected, false)
  await mock.emitState({ type: "snapshot", snapshot: snapshot() })
  await waitForState((result) => result.connected)
  await mock.emitState({ type: "snapshot", snapshot: {} })
  await waitForState((result) => !result.connected)
  assert.equal((await fetchState()).connected, false)
})

test("failed frame authentication disconnects cached Alma state without an HTTP poll", async (t) => {
  const mock = await desktop(t)
  await fetchState()
  const count = mock.requests.length
  for (const socket of mock.wss.clients) socket.send(new Uint8Array(32))
  await waitForState((result) => !result.connected)
  assert.equal((await fetchState()).connected, false)
  assert.equal(mock.requests.length, count, "state becomes offline without waiting for an RPC timeout")
})

test("closing only an Alma WebSocket child stream leaves ordinary RPCs working", async (t) => {
  const mock = new AlmaMock(undefined, snapshot())
  await mock.start()
  const tunnel = new AlmaTunnel({ relay: mock.url, code: mock.code })
  t.after(async () => {
    tunnel.close()
    await mock.stop()
  })
  await tunnel.connect()
  const received = Promise.withResolvers()
  const stop = await tunnel.openStream("/ws/herdr", (bytes) => {
    if (JSON.parse(new TextDecoder().decode(bytes)).type === "snapshot") received.resolve()
  })
  await received.promise
  stop()
  stop()
  assert.equal((await tunnel.request("GET", "/api/herdr/info")).status, 200)
  await assert.rejects(
    tunnel.openStream("/unknown", () => {}),
    /unknown stream/,
  )
  assert.equal((await tunnel.request("GET", "/api/herdr/info")).status, 200)
})
