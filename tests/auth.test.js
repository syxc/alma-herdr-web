import assert from "node:assert/strict"
import { test } from "node:test"

import { createAuth } from "../agent/dist/auth.js"
import { authStatus, signOut } from "../web/dist/auth.js"

test("access status distinguishes static hosts, open agents and existing sessions", async (t) => {
  for (const [status, body, expected] of [
    [404, {}, { required: false }],
    [200, { required: false, authenticated: true }, { required: false, authenticated: true }],
    [200, { required: true, authenticated: false }, { required: true, authenticated: false }],
    [200, { required: true, authenticated: true }, { required: true, authenticated: true }],
    [200, { required: true }, { required: true, authenticated: false }],
  ]) {
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body), { status }))
    assert.deepEqual(await authStatus(), expected)
    t.mock.restoreAll()
  }
})

test("failed access checks do not invent a passphrase requirement or silently open the app", async (t) => {
  for (const reply of [
    () => new Response("unavailable", { status: 503 }),
    () => new Response("<html>fallback</html>"),
    () => new Response(JSON.stringify({ ok: true })),
    () => {
      throw new Error("network unavailable")
    },
  ]) {
    t.mock.method(globalThis, "fetch", async () => reply())
    const state = await authStatus()
    assert.equal(state.required, false)
    assert.match(state.error, /Could not check desktop access/)
    t.mock.restoreAll()
  }
})

test("sign out reports server failures and accepts an already expired session", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }))
  await assert.rejects(signOut, /Could not end desktop access/)
  t.mock.restoreAll()
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 401 }))
  await signOut()
})

test("a server without a passphrase lets every request through", () => {
  const auth = createAuth("")
  assert.equal(auth.required, false)
  assert.equal(auth.verify({}), true)
  assert.equal(auth.signIn("anything").ok, true)
})

test("a wrong passphrase is refused", () => {
  const auth = createAuth("correct-horse")
  const result = auth.signIn("wrong")
  assert.equal(result.ok, false)
  assert.equal(result.token, undefined)
})

test("the right passphrase hands out a session", () => {
  const auth = createAuth("correct-horse")
  const result = auth.signIn("correct-horse")
  assert.equal(result.ok, true)
  assert.equal(typeof result.token, "string")
  assert.equal(auth.verify({ cookie: `alma_session=${result.token}` }), true)
  assert.equal(auth.verify({ authorization: `Bearer ${result.token}` }), true)
})

test("a request without a session is refused", () => {
  const auth = createAuth("correct-horse")
  assert.equal(auth.verify({}), false)
  assert.equal(auth.verify({ cookie: "alma_session=made-up" }), false)
})

test("signing out ends the session", () => {
  const auth = createAuth("correct-horse")
  const token = auth.signIn("correct-horse").token
  assert.equal(auth.verify({ cookie: `alma_session=${token}` }), true)
  auth.signOut({ cookie: `alma_session=${token}` })
  assert.equal(auth.verify({ cookie: `alma_session=${token}` }), false)
})
