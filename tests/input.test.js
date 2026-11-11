import assert from "node:assert/strict"
import { test } from "node:test"
import { DetailScreen } from "../web/dist/detail.js"
import { lineEdit, TerminalInput } from "../web/dist/input.js"
import { mapKey } from "../web/dist/keys.js"
import { groupActions } from "../web/dist/send-queue.js"

/**
 * A key event, as the browser would hand it over.
 */
function key(name, options = {}) {
  return {
    key: name,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...options,
  }
}

test("a character at the end of the line is only text", () => {
  assert.deepEqual(lineEdit("ls", 2, "lsi", 3), {
    backspaces: 0,
    killToEnd: false,
    text: "i",
  })
})

test("a character in the middle of the line erases nothing", () => {
  assert.deepEqual(lineEdit("abc", 1, "aXbc", 2), {
    backspaces: 0,
    killToEnd: false,
    text: "X",
  })
})

test("a backspace at the end erases one character", () => {
  assert.deepEqual(lineEdit("abc", 3, "ab", 2), {
    backspaces: 1,
    killToEnd: false,
    text: "",
  })
})

test("a backspace in the middle erases the character before the cursor", () => {
  assert.deepEqual(lineEdit("abc", 2, "ac", 1), {
    backspaces: 1,
    killToEnd: false,
    text: "",
  })
})

test("a line that was written over is typed again", () => {
  assert.deepEqual(lineEdit("abc", 3, "x", 1), {
    backspaces: 3,
    killToEnd: true,
    text: "x",
  })
})

test("a paste is text", () => {
  assert.deepEqual(lineEdit("", 0, "hello", 5), {
    backspaces: 0,
    killToEnd: false,
    text: "hello",
  })
})

test("a line that did not change asks for nothing", () => {
  assert.deepEqual(lineEdit("a", 1, "a", 1), {
    backspaces: 0,
    killToEnd: false,
    text: "",
  })
})

test("the named keys go to the pane by name", () => {
  assert.deepEqual(mapKey(key("Enter")), { kind: "keys", keys: ["enter"] })
  assert.deepEqual(mapKey(key("Escape")), { kind: "keys", keys: ["esc"] })
  assert.deepEqual(mapKey(key("Backspace")), { kind: "keys", keys: ["backspace"] })
  assert.deepEqual(mapKey(key("Tab")), { kind: "keys", keys: ["tab"] })
  assert.deepEqual(mapKey(key("Tab", { shiftKey: true })), {
    kind: "keys",
    keys: ["shift+tab"],
  })
  assert.deepEqual(mapKey(key("ArrowUp")), { kind: "keys", keys: ["up"] })
  assert.deepEqual(mapKey(key("F5")), { kind: "keys", keys: ["f5"] })
})

test("the keys herdr does not know become the ones it does", () => {
  assert.deepEqual(mapKey(key("Home")), { kind: "keys", keys: ["ctrl+a"] })
  assert.deepEqual(mapKey(key("End")), { kind: "keys", keys: ["ctrl+e"] })
  assert.deepEqual(mapKey(key("Delete")), null)
})

test("a combo keeps the modifiers", () => {
  assert.deepEqual(mapKey(key("ArrowLeft", { ctrlKey: true })), {
    kind: "keys",
    keys: ["ctrl+left"],
  })
  assert.deepEqual(mapKey(key("a", { ctrlKey: true })), {
    kind: "keys",
    keys: ["ctrl+a"],
  })
  assert.deepEqual(mapKey(key("b", { altKey: true })), {
    kind: "keys",
    keys: ["alt+b"],
  })
})

test("a printable character travels as text", () => {
  assert.deepEqual(mapKey(key("a")), { kind: "text", text: "a" })
  assert.deepEqual(mapKey(key("A")), { kind: "text", text: "A" })
  assert.deepEqual(mapKey(key(" ")), { kind: "text", text: " " })
})

test("the shortcuts of the browser stay with the browser", () => {
  assert.equal(mapKey(key("a", { metaKey: true })), null)
})

test("a burst of typing goes as one call", () => {
  assert.deepEqual(
    groupActions([
      { kind: "text", text: "l" },
      { kind: "text", text: "s" },
      { kind: "keys", keys: ["backspace"] },
      { kind: "text", text: "x" },
    ]),
    [
      { kind: "text", text: "ls" },
      { kind: "keys", keys: ["backspace"] },
      { kind: "text", text: "x" },
    ],
  )
})

test("the keys keep their order", () => {
  assert.deepEqual(
    groupActions([
      { kind: "keys", keys: ["ctrl+c"] },
      { kind: "keys", keys: ["enter"] },
    ]),
    [{ kind: "keys", keys: ["ctrl+c", "enter"] }],
  )
})

function inputFixture(t) {
  const timers = new Map()
  let timerId = 0
  const originalWindow = globalThis.window
  globalThis.window = {
    setTimeout: (callback) => {
      timers.set(++timerId, callback)
      return timerId
    },
    clearTimeout: (id) => timers.delete(id),
  }
  t.after(() => {
    globalThis.window = originalWindow
  })
  const field = new EventTarget()
  field.value = ""
  field.selectionStart = 0
  field.setSelectionRange = (start) => {
    field.selectionStart = start
  }
  const canvas = new EventTarget()
  const sent = []
  const screen = Object.create(DetailScreen.prototype)
  Object.assign(screen, {
    pane: { pane_id: "A", agent_status: "idle" },
    inputPaneId: "A",
    tabNumber: {},
    detailStatus: {},
    detailTitle: {},
    detailDot: {},
    actionMenu: { classList: { contains: () => true } },
  })
  const input = new TerminalInput(field, canvas, {
    sendText: (text) => sent.push([screen.pane.pane_id, "text", text]),
    sendKeys: (keys) => sent.push([screen.pane.pane_id, "keys", keys]),
  })
  screen.input = input
  input.setEnabled(true)
  return {
    input,
    field,
    canvas,
    screen,
    sent,
    tick: () => {
      const callbacks = [...timers.values()]
      timers.clear()
      callbacks.forEach((fn) => {
        fn()
      })
    },
    press: (name, options = {}) => {
      const event = new Event("keydown", { cancelable: true })
      Object.assign(event, key(name, options))
      field.dispatchEvent(event)
      return event
    },
  }
}

test("field history keys reach the pane and clear the local line", (t) => {
  const f = inputFixture(t)
  f.input.type("draft")
  assert.equal(f.press("ArrowUp").defaultPrevented, true)
  assert.equal(f.field.value, "")
  assert.equal(f.press("ArrowDown").defaultPrevented, true)
  f.tick()
  assert.deepEqual(f.sent, [
    ["A", "text", "draft"],
    ["A", "keys", ["up", "down"]],
  ])
})

test("history keys keep modifiers and leave browser shortcuts alone", (t) => {
  const f = inputFixture(t)
  assert.equal(f.press("ArrowUp", { ctrlKey: true }).defaultPrevented, true)
  assert.equal(f.press("ArrowDown", { metaKey: true }).defaultPrevented, false)
  f.tick()
  assert.deepEqual(f.sent, [["A", "keys", ["ctrl+up"]]])
})

test("switching panes sends pending text and keys to their original pane", (t) => {
  const f = inputFixture(t)
  f.input.type("pending")
  f.input.sendSpecial(["left"])
  f.screen.update({ tabs: [], workspaces: [] }, { pane_id: "B", agent_status: "idle" })
  assert.equal(f.field.value, "")
  f.input.type("next")
  f.tick()
  assert.deepEqual(f.sent, [
    ["A", "text", "pending"],
    ["A", "keys", ["left"]],
    ["B", "text", "next"],
  ])
})

test("losing a pane flushes its pending input without targeting a null pane", (t) => {
  const f = inputFixture(t)
  f.input.type("last")
  f.screen.update({ tabs: [], workspaces: [] }, null)
  f.input.type("disabled")
  f.tick()
  assert.deepEqual(f.sent, [["A", "text", "last"]])
})
