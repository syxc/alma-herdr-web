import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as turn } from "node:timers/promises"
import { E2EClientSession, getCipher } from "../web/dist/e2e.js"

for (const direction of ["send", "receive"]) {
  test(`encrypted ${direction} preserves frame order when the first crypto operation is delayed`, async (t) => {
    const firstStarted = Promise.withResolvers()
    const releaseFirst = Promise.withResolvers()
    const observed = []
    const nonces = []
    const crypto = await getCipher()
    const operation = direction === "send" ? "seal" : "open"
    let calls = 0
    t.mock.method(crypto, operation, async (_key, nonce, bytes) => {
      nonces.push(Number(new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength).getBigUint64(4)))
      if (++calls === 1) {
        firstStarted.resolve()
        await releaseFirst.promise
      }
      // Isolate scheduling from crypto correctness, covered by relay integration tests.
      return bytes
    })
    const session = new E2EClientSession({
      psk: new Uint8Array(32),
      send: (text) => observed.push(JSON.parse(Buffer.from(JSON.parse(text).c, "base64").toString()).id),
      onAppFrame: (frame) => observed.push(frame.id),
      onError: (message) => assert.fail(message),
      onReady() {},
    })
    if (direction === "send") session.sendKey = new Uint8Array(32)
    else session.recvKey = new Uint8Array(32)
    const deliver = (id) =>
      direction === "send"
        ? session.sendApp({ id })
        : session.receive(JSON.stringify({ t: "e2e", c: Buffer.from(JSON.stringify({ id })).toString("base64") }))
    const first = deliver("first")
    await firstStarted.promise
    const second = deliver("second")
    await turn()
    const pending = observed.slice()
    releaseFirst.resolve()
    await Promise.all([first, second])
    assert.deepEqual(pending, [], "a later frame must not overtake the blocked first frame")
    assert.deepEqual(observed, ["first", "second"])
    assert.deepEqual(nonces, [0, 1])
  })
}
