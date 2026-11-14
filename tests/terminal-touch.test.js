import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { environment, ready } from "./helpers/terminal-environment.js"

function host() {
  return Object.assign(new EventTarget(), {
    clientWidth: 390,
    clientHeight: 400,
    scrollTop: 0,
    scrollHeight: 5000,
    classList: { toggle() {} },
  })
}

function touch(host, type, count = 0) {
  const event = new Event(type)
  Object.defineProperties(event, {
    touches: { value: Array.from({ length: count }, () => ({ clientX: 100, clientY: 100 })) },
    changedTouches: { value: [{ clientX: 100, clientY: 100 }] },
  })
  host.dispatchEvent(event)
}

const sample = Array.from({ length: 100 }, (_, i) => `pi row ${i}: stable 中文 output`).join(String.fromCharCode(10))
const settle = () => new Promise((resolve) => setImmediate(resolve))

test("slow touch scrolling defers snapshot replay until release and inertia settle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const viewport = host()
  const { view } = environment(t, undefined, viewport)
  await ready(view)
  await view.setContent(sample, 24)
  const replay = t.mock.method(view.kernel, "setContent")
  touch(viewport, "touchstart", 1)
  viewport.scrollTop = 500
  viewport.dispatchEvent(new Event("scroll"))
  await view.setContent(`${sample}\nlatest`, 24)
  t.mock.timers.tick(200)
  await settle()
  assert.equal(replay.mock.callCount(), 0, "a slow finger must not be mistaken for an idle reader")
  touch(viewport, "touchend")
  t.mock.timers.tick(80)
  viewport.scrollTop += 5.5
  viewport.dispatchEvent(new Event("scroll"))
  t.mock.timers.tick(80)
  await settle()
  assert.equal(replay.mock.callCount(), 0, "inertia extends the pause after release")
  t.mock.timers.tick(80)
  await settle()
  assert.equal(replay.mock.callCount(), 1, "the latest snapshot is replayed once after settling")
  assert.equal(view.text, `${sample}\nlatest`)
  assert.equal(viewport.scrollTop, 505.5)
})

test("touch cancellation drains pending output and pane reset discards an old touch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const viewport = host()
  const { view } = environment(t, undefined, viewport)
  await ready(view)
  await view.setContent(sample, 24)
  touch(viewport, "touchstart", 2)
  await view.setContent(`${sample}\npending`, 24)
  touch(viewport, "touchend", 1)
  t.mock.timers.tick(200)
  await settle()
  assert.equal(view.text, sample, "one finger still down keeps the pause")
  touch(viewport, "touchcancel")
  t.mock.timers.tick(200)
  await settle()
  assert.equal(view.text, `${sample}\npending`)
  touch(viewport, "touchstart", 1)
  await view.setContent("obsolete pane", 24)
  view.clearSelection()
  await view.setContent("new pane", 24)
  t.mock.timers.tick(200)
  await settle()
  assert.equal(view.text, "new pane")
  assert.equal(view.pendingContent, null)
})

test("theme and width changes wait for touch release and still render without new output", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const viewport = host()
  const { view, operations } = environment(t, undefined, viewport)
  await ready(view)
  await view.setContent(sample, 24)
  view.follow = false
  viewport.scrollTop = 500
  viewport.dispatchEvent(new Event("scroll"))
  t.mock.timers.tick(200)
  const replay = t.mock.method(view.kernel, "setContent")
  touch(viewport, "touchstart", 1)
  operations.length = 0
  viewport.clientWidth = 320
  view.resize()
  await view.setTheme("light")
  t.mock.timers.tick(200)
  await settle()
  assert.equal(replay.mock.callCount(), 0)
  assert.equal(operations.length, 0)
  touch(viewport, "touchend")
  t.mock.timers.tick(200)
  await settle()
  assert.equal(replay.mock.callCount(), 1)
  assert.equal(view.layoutWidth, 282)
  assert.ok(operations.some((op) => op.kind === "rect" && op.color === "#ffffff"))
})

test("kernel loading completed during a touch does not start a snapshot replay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const pending = Promise.withResolvers()
  const viewport = host()
  const { view } = environment(t, pending.promise, viewport)
  await view.setContent(sample, 24)
  const replay = t.mock.method(view.kernel, "setContent")
  touch(viewport, "touchstart", 1)
  const bytes = await readFile(new URL("../web/vendor/ghostty/ghostty-vt.wasm", import.meta.url))
  pending.resolve(new Response(bytes))
  await ready(view)
  assert.equal(replay.mock.callCount(), 0, "late kernel loading must not block a finger still scrolling")
  touch(viewport, "touchend")
  t.mock.timers.tick(200)
  await settle()
  assert.equal(replay.mock.callCount(), 1)
  assert.equal(view.usingKernel, true)
})
