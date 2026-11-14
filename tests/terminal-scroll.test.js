import assert from "node:assert/strict"
import { test } from "node:test"
import { TerminalInput } from "../web/dist/input.js"
import { TerminalHistory, terminalScroll } from "../web/dist/terminal-scroll.js"

function gestures(move) {
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
    (direction) => {
      if (move?.(direction) === false) return false
      sent.push(direction)
      return true
    },
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

test("pi paging stays busy after input acknowledgement until a changed screen is read", async () => {
  const history = new TerminalHistory()
  const screen = Promise.withResolvers()
  let reads = 0
  const first = history.move(
    -1,
    "pi",
    async () => null,
    async () => {
      reads++
      await screen.promise
      return true
    },
  )
  await Promise.resolve()
  assert.equal(reads, 1, "input acknowledgement must start a screen read")
  assert.equal(history.busy, true, "another page cannot overtake the pending screen")
  assert.equal(await history.move(1, "pi", async () => assert.fail("duplicate page")), false)
  screen.resolve()
  assert.equal(await first, true)
  assert.equal(history.busy, false)
})

test("pi paging retries stale screens without resending input", async () => {
  const history = new TerminalHistory()
  let sends = 0
  let reads = 0
  assert.equal(
    await history.move(
      1,
      "pi",
      async () => {
        sends++
        return null
      },
      async () => ++reads === 3,
    ),
    true,
  )
  assert.equal(sends, 1)
  assert.equal(reads, 3)
  await assert.rejects(
    history.move(
      1,
      "pi",
      async () => null,
      async () => {
        throw new Error("read failed")
      },
    ),
    /read failed/,
  )
  assert.equal(history.busy, false)
})

test("an unchanged pi boundary has a finite refresh window and releases the page lock", async () => {
  const history = new TerminalHistory()
  let reads = 0
  let sends = 0
  await history.move(
    -1,
    "pi",
    async () => {
      sends++
      return null
    },
    async () => {
      reads++
      return false
    },
  )
  assert.equal(sends, 1)
  assert.ok(reads >= 2 && reads <= 10, "unchanged screens are retried within one bounded window")
  assert.equal(history.busy, false)
})

test("a sustained boundary wheel gesture pages once even after the repeat throttle expires", (t) => {
  let now = 1000
  t.mock.method(Date, "now", () => now)
  const g = gestures()
  for (let index = 0; index < 10; index++) {
    g.fire("wheel", { deltaX: 0, deltaY: -80, deltaMode: 0 })
    now += 60
  }
  assert.deepEqual(g.sent, [-1], "one continuous gesture must not turn into several remote pages")
  now += 200
  g.fire("wheel", { deltaX: 0, deltaY: -80, deltaMode: 0 })
  assert.deepEqual(g.sent, [-1, -1], "a new gesture can read the next page")
})

test("a busy page rejection does not consume a new wheel gesture", async (t) => {
  let now = 1000
  t.mock.method(Date, "now", () => now)
  const history = new TerminalHistory()
  const pending = Promise.withResolvers()
  const requests = []
  let sends = 0
  const g = gestures((direction) => {
    if (history.busy) return false
    requests.push(
      history.move(direction, "pi", async () => {
        if (++sends === 1) await pending.promise
        return null
      }),
    )
    return true
  })
  g.fire("wheel", { deltaX: 0, deltaY: -80, deltaMode: 0 })
  now = 1450
  g.fire("wheel", { deltaX: 0, deltaY: -80, deltaMode: 0 })
  pending.resolve()
  await requests[0]
  for (let index = 0; index < 8; index++) {
    now += 60
    g.fire("wheel", { deltaX: 0, deltaY: -80, deltaMode: 0 })
  }
  await Promise.all(requests)
  assert.equal(sends, 2, "the same gesture can retry once the previous page finishes")
  assert.deepEqual(g.sent, [-1, -1])
})
