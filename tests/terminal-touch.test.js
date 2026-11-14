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

test("wheel input at a clamped boundary holds colored snapshots until the whole burst settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const viewport = host()
  const { view } = environment(t, undefined, viewport)
  await ready(view)
  await view.setContent(sample, 24)
  viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight
  const replay = t.mock.method(view.kernel, "setContent")
  const wheel = () => {
    const event = new Event("wheel")
    Object.assign(event, { deltaX: 0, deltaY: 80, deltaMode: 0 })
    viewport.dispatchEvent(event)
  }
  const before = viewport.scrollTop
  for (let index = 0; index < 8; index++) {
    wheel()
    await view.setContent(`\x1b[32m${sample}\nlatest ${index}\x1b[0m`, 24)
    t.mock.timers.tick(80)
    await settle()
    assert.equal(replay.mock.callCount(), 0, "wheel activity still exists when the boundary emits no scroll events")
    assert.equal(viewport.scrollTop, before, "snapshot auto-follow cannot move the reader during the gesture")
  }
  t.mock.timers.tick(121)
  await settle()
  assert.equal(replay.mock.callCount(), 1, "only the latest colored snapshot is replayed after release")
  assert.ok(view.text.includes("latest 7"))
})

test("a small upward native scroll leaves follow mode and keeps its fractional position", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const viewport = host()
  const { view } = environment(t, undefined, viewport)
  await ready(view)
  await view.setContent(sample, 24)
  viewport.scrollHeight = view.laidOut.length * view.rowHeight
  viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight - 10.5
  viewport.dispatchEvent(new Event("scroll"))
  assert.equal(view.follow, false, "being within one row of the bottom is still reading above it")
  const before = viewport.scrollTop
  await view.setContent(`\x1b[32m${sample}\x1b[0m`, 24)
  t.mock.timers.tick(121)
  await settle()
  assert.equal(viewport.scrollTop, before, "a styled snapshot cannot pull a small upward scroll to the bottom")
})

test("unchanged bottom position is not assigned again on native render or follow reset", async (t) => {
  const viewport = host()
  let top = 0
  let writes = 0
  Object.defineProperty(viewport, "scrollTop", {
    get: () => top,
    set: (value) => {
      writes++
      top = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, value))
    },
  })
  const { view } = environment(t, undefined, viewport)
  await ready(view)
  await view.setContent(sample, 24)
  assert.equal(viewport.scrollTop, viewport.scrollHeight - viewport.clientHeight)
  writes = 0
  view.render(false)
  view.followBottom()
  assert.equal(writes, 0, "even a same-value write interrupts native scrolling")
})

test("history prepending after a touch keeps the same occurrence of a repeated row", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const viewport = host()
  const { view } = environment(t, undefined, viewport)
  await ready(view)
  view.setMode("original")
  const repeated = Array.from({ length: 100 }, () => "repeated source row").join("\n")
  await view.setContent(repeated, 24)
  touch(viewport, "touchstart", 1)
  viewport.scrollTop = 20 * view.rowHeight + 5.5
  viewport.dispatchEvent(new Event("scroll"))
  const expanded = `${Array.from({ length: 5 }, () => "older source row").join("\n")}\n${repeated}`
  await view.setHistoryContent(expanded, 24, 0, 5)
  viewport.scrollTop = 30 * view.rowHeight + 5.5
  viewport.dispatchEvent(new Event("scroll"))
  await view.setContent(expanded, 24)
  touch(viewport, "touchend")
  t.mock.timers.tick(121)
  await settle()
  assert.equal(viewport.scrollTop, 35 * view.rowHeight + 5.5)
})
