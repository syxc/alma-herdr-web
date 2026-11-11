import assert from "node:assert/strict"
import { test } from "node:test"

import { AlmaMock } from "../mock/dist/alma-mock.js"
import { AlmaTunnel } from "../web/dist/alma.js"

// A page that is opened over plain http has no crypto.subtle, so the client
// falls back to the pure JavaScript crypto. The property lives on the
// prototype, so it is shadowed on the instance and taken away again after.
const prototype = Object.getPrototypeOf(globalThis.crypto)
const descriptor = Object.getOwnPropertyDescriptor(prototype, "subtle")
Object.defineProperty(globalThis.crypto, "subtle", { value: undefined, configurable: true })

test("the client talks to an Alma desktop without crypto.subtle", async () => {
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
    delete globalThis.crypto.subtle
    if (descriptor !== undefined) {
      Object.defineProperty(prototype, "subtle", descriptor)
    }
  }
})
