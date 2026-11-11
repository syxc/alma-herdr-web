import assert from "node:assert/strict"
import { test } from "node:test"

import { AlmaMock } from "../mock/dist/alma-mock.js"
import { AlmaTunnel, deriveRoutingToken, parseAlmaLink } from "../web/dist/alma.js"
import { fetchState, openAlmaRemote, readPane, sendKeys, sendText } from "../web/dist/api.js"

test("the Alma deep link carries the relay and the connect code", () => {
  const link = parseAlmaLink("alma://connect?u=https%3A%2F%2Frelay.alma.now&k=abc123&e2e=1")
  assert.deepEqual(link, { relay: "https://relay.alma.now", code: "abc123" })
  assert.equal(parseAlmaLink("https://example.com"), null)
  assert.equal(parseAlmaLink("alma://connect?u=https%3A%2F%2Frelay.alma.now"), null)
})

test("the routing token is derived from the connect code", async () => {
  const mock = new AlmaMock()
  try {
    assert.equal(await deriveRoutingToken(mock.code), await mock.routingToken())
  } finally {
    await mock.stop()
  }
})

test("the client talks to an Alma desktop through the tunnel", async () => {
  const mock = new AlmaMock()
  await mock.start()
  const tunnel = new AlmaTunnel({ relay: mock.url, code: mock.code })
  try {
    await tunnel.connect()
    const response = await tunnel.request(
      "POST",
      "/api/herdr/rpc",
      new TextEncoder().encode(JSON.stringify({ method: "workspace.list", params: {} })),
    )
    assert.equal(response.status, 200)
    const body = JSON.parse(new TextDecoder().decode(response.body))
    assert.equal(body.result.workspaces[0].workspace_id, "w1")
  } finally {
    tunnel.close()
    await mock.stop()
  }
})

test("a wrong pairing code is refused by the Alma desktop", async () => {
  const mock = new AlmaMock()
  await mock.start()
  const tunnel = new AlmaTunnel({ relay: mock.url, code: "wrong-connect-code-000000" })
  try {
    await assert.rejects(() => tunnel.connect(), /pairing code/)
  } finally {
    tunnel.close()
    await mock.stop()
  }
})

test("the client reads and types in an Alma desktop", async () => {
  const mock = new AlmaMock()
  await mock.start()
  try {
    await openAlmaRemote({ relay: mock.url, code: mock.code })

    const state = await fetchState()
    assert.equal(state.connected, true)
    assert.equal(state.state?.workspaces[0]?.workspace_id, "w1")
    assert.equal(state.state?.tabs[0]?.tab_id, "w1:t1")
    assert.equal(state.state?.panes[0]?.pane_id, "w1:p1")
    assert.equal(state.state?.focused_pane_id, "w1:p1")

    assert.equal(await sendText("w1:p1", "echo marker"), null)
    assert.equal(await sendKeys("w1:p1", ["enter"]), null)

    const read = await readPane("w1:p1", "visible", "ansi", 0)
    assert.equal(read?.text, "echo marker\r\n")
    assert.equal(mock.output, "echo marker\r\n")
  } finally {
    await mock.stop()
  }
})
