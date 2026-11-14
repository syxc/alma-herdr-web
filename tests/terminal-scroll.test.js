import assert from "node:assert/strict"
import { test } from "node:test"
import { TerminalInput } from "../web/dist/input.js"
import { TerminalHistory, terminalScroll } from "../web/dist/terminal-scroll.js"

function gestures() {
  const events = new Map()
  const host = {
    scrollTop: 0,
    scrollHeight: 600,
    clientHeight: 200,
    addEventListener: (name, run) => events.set(name, run),
  }
  const sent = []
  let paused = false
  terminalScroll(
    host,
    () => paused,
    (direction) => sent.push(direction),
  )
  return {
    host,
    sent,
    pause: () => {
      paused = true
    },
    fire: (name, event) => events.get(name)(event),
  }
}

test("wheel extends history at the boundary without intercepting normal or horizontal scrolling", () => {
  const g = gestures()
  g.host.scrollTop = 50
  g.fire("wheel", { deltaX: 0, deltaY: -100, deltaMode: 0 })
  assert.deepEqual(g.sent, [])
  g.host.scrollTop = 0
  g.fire("wheel", { deltaX: 200, deltaY: -100, deltaMode: 0 })
  g.fire("wheel", { ctrlKey: true, deltaX: 0, deltaY: -100, deltaMode: 0 })
  assert.deepEqual(g.sent, [])
  g.fire("wheel", { deltaX: 0, deltaY: -100, deltaMode: 0 })
  g.fire("wheel", { deltaX: 0, deltaY: -100, deltaMode: 0 })
  assert.deepEqual(g.sent, [-1], "one burst cannot skip multiple remote pages")
})

test("touch boundary gestures support short screens and reject horizontal or multiple fingers", () => {
  const g = gestures()
  g.host.scrollHeight = g.host.clientHeight
  const point = (clientX, clientY) => ({ clientX, clientY })
  const swipe = (x, y) => {
    g.fire("touchstart", { touches: [point(100, 100)] })
    g.fire("touchend", { touches: [], changedTouches: [point(x, y)] })
  }
  swipe(250, 105)
  assert.deepEqual(g.sent, [])
  g.fire("touchstart", { touches: [point(100, 100)] })
  g.fire("touchmove", { touches: [point(100, 100), point(150, 100)] })
  g.fire("touchend", { touches: [], changedTouches: [point(100, 200)] })
  assert.deepEqual(g.sent, [])
  swipe(100, 200)
  assert.deepEqual(g.sent, [-1])
  const down = gestures()
  down.host.scrollHeight = down.host.clientHeight
  down.fire("touchstart", { touches: [point(100, 200)] })
  down.fire("touchend", { touches: [], changedTouches: [point(100, 100)] })
  assert.deepEqual(down.sent, [1])
})

test("copy selection and modified keys never page the application", () => {
  const g = gestures()
  g.fire("keydown", { key: "PageUp", shiftKey: true })
  assert.deepEqual(g.sent, [])
  g.pause()
  g.fire("keydown", { key: "PageUp" })
  g.fire("wheel", { deltaX: 0, deltaY: -100, deltaMode: 0 })
  assert.deepEqual(g.sent, [])
})

test("native page keys keep a copy selection before the boundary handler runs", () => {
  for (const key of ["PageUp", "PageDown"]) {
    let selected = true
    const layer = {}
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ intersectsNode: (node) => node === layer }),
      removeAllRanges: () => {
        selected = false
      },
    }
    const canvas = new EventTarget()
    canvas.parentElement = { querySelector: () => layer }
    canvas.ownerDocument = { getSelection: () => (selected ? selection : null) }
    const input = new TerminalInput(new EventTarget(), canvas, {
      sendText: () => assert.fail("page keys cannot type"),
      sendKeys: () => assert.fail("page keys cannot send named input"),
    })
    input.setEnabled(true)
    const events = new Map()
    const host = {
      scrollTop: 0,
      scrollHeight: 200,
      clientHeight: 200,
      addEventListener: (name, run) => events.set(name, run),
    }
    const paged = []
    terminalScroll(
      host,
      () => selected,
      (direction) => paged.push(direction),
    )
    const event = new Event("keydown", { cancelable: true })
    Object.assign(event, { key })
    canvas.dispatchEvent(event)
    events.get("keydown")(event)
    assert.equal(selected, true, `${key} retains the copy selection`)
    assert.deepEqual(paged, [])
    assert.equal(event.defaultPrevented, false, "native selection navigation remains available")
  }
})

test("composition and already-handled page keys cannot page the application", () => {
  const g = gestures()
  g.fire("keydown", { key: "PageUp", isComposing: true })
  g.fire("keydown", { key: "PageUp", keyCode: 229 })
  g.fire("keydown", { key: "PageUp", defaultPrevented: true })
  assert.deepEqual(g.sent, [])
})

test("ordinary history expands persistently and pi paging uses the supported raw input path", async () => {
  const history = new TerminalHistory()
  const sent = []
  const send = async (text) => {
    sent.push(text)
    return null
  }
  history.truncated = true
  assert.equal(await history.move(-1, "pi", send), true)
  assert.equal(history.lines, 240)
  assert.deepEqual(sent, [])
  history.truncated = false
  assert.equal(await history.move(-1, "pi", send), true)
  assert.equal(await history.move(1, "pi", send), true)
  assert.deepEqual(sent, ["\x1b[5~", "\x1b[6~"])
  assert.equal(await history.move(-1, "codex", send), false)
  await assert.rejects(
    history.move(-1, "pi", async () => "offline"),
    /offline/,
  )
  assert.equal(history.busy, false)
})

test("a pending application page blocks duplicate paging requests", async () => {
  const history = new TerminalHistory()
  const pending = Promise.withResolvers()
  const first = history.move(-1, "pi", () => pending.promise)
  assert.equal(
    await history.move(-1, "pi", () => {
      throw new Error("duplicate")
    }),
    false,
  )
  pending.resolve(null)
  assert.equal(await first, true)
})
