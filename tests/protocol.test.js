import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { HerdrClient } from "../agent/dist/herdr.js"
import { SessionState } from "../agent/dist/state.js"
import { HerdrMock } from "../mock/dist/herdr-mock.js"
import { gridToText, parseAnsi } from "../web/dist/ansi.js"
import { mapKey } from "../web/dist/keys.js"

test("parseAnsi turns SGR sequences into styled cells", () => {
  const grid = parseAnsi("\u001b[1;31mred\u001b[0m plain")
  assert.equal(grid.rows, 1)
  assert.equal(grid.cols, 9)
  assert.equal(grid.cells[0][0].ch, "r")
  assert.equal(grid.cells[0][0].style.bold, true)
  assert.notEqual(grid.cells[0][0].style.fg, "")
  assert.equal(grid.cells[0][3].style.bold, false)
  assert.equal(grid.cells[0][4].ch, "p")
})

test("parseAnsi handles carriage returns, newlines and tabs", () => {
  // A carriage return puts the cursor back at column 0, so the next characters
  // overwrite the ones already on the line, exactly like a real terminal.
  const grid = parseAnsi("ab\rcd\n\tef")
  assert.equal(
    grid.cells[0]
      .map((cell) => cell.ch)
      .join("")
      .trimEnd(),
    "cd",
  )
  assert.equal(grid.rows, 2)
  // Tabs advance to the next eight column tab stop.
  assert.equal(grid.cells[1][8].ch, "e")
  assert.equal(grid.cells[1][9].ch, "f")
  assert.ok(grid.cells[1].slice(0, 8).every((cell) => cell.ch === " "))
})

test("parseAnsi understands 256 colour and true colour", () => {
  const grid = parseAnsi("\u001b[38;5;196mA\u001b[0m\u001b[38;2;10;20;30mB")
  assert.equal(grid.cells[0][0].style.fg, "#ff0000")
  assert.equal(grid.cells[0][1].style.fg, "#0a141e")
})

test("fallback parser keeps wide glyphs, combining marks and emoji in terminal cells", () => {
  const text = "你e\u0301👩‍💻🇨🇳Z"
  const row = parseAnsi(text).cells[0]
  assert.deepEqual(
    row.map((cell) => cell.ch),
    ["你", "", "e\u0301", "👩‍💻", "", "🇨🇳", "", "Z"],
  )
  assert.equal(gridToText(parseAnsi(text)), text)
})

test("fallback overwrite clears both halves of a wide glyph", () => {
  assert.equal(gridToText(parseAnsi("你Z\rA")), "A Z")
  assert.equal(gridToText(parseAnsi("你Z\b\bA")), " AZ")
})

test("gridToText strips trailing padding", () => {
  const grid = parseAnsi("hello   \nnext")
  assert.equal(gridToText(grid), "hello\nnext")
})

test("mapKey translates browser keys into herdr key names", () => {
  assert.deepEqual(mapKey({ key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }), {
    kind: "keys",
    keys: ["enter"],
  })
  assert.deepEqual(mapKey({ key: "Tab", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false }), {
    kind: "keys",
    keys: ["shift+tab"],
  })
  assert.deepEqual(mapKey({ key: "c", shiftKey: false, ctrlKey: true, altKey: false, metaKey: false }), {
    kind: "keys",
    keys: ["ctrl+c"],
  })
  assert.deepEqual(mapKey({ key: "x", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }), {
    kind: "text",
    text: "x",
  })
  assert.equal(mapKey({ key: "Meta", shiftKey: false, ctrlKey: false, altKey: false, metaKey: true }), null)
})

test("the client answers a request over a short lived connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-mock-"))
  const socketPath = join(dir, "herdr.sock")
  const mock = new HerdrMock(socketPath)
  await mock.start()
  const client = new HerdrClient(socketPath)
  try {
    const result = await client.request("session.snapshot")
    assert.equal(result.type, "session_snapshot")
    const snapshot = result.snapshot
    assert.equal(snapshot.version, "0.9.5-mock")
    assert.equal(snapshot.protocol, 22)
    assert.equal(mock.requests.length, 1)
  } finally {
    client.close()
    await mock.stop()
  }
})

test("the client reports request errors as herdr error codes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-mock-"))
  const socketPath = join(dir, "herdr.sock")
  const mock = new HerdrMock(socketPath)
  await mock.start()
  const client = new HerdrClient(socketPath)
  try {
    await client.request("pane.read", { pane_id: "w1:p1", source: "visible", format: "ansi" })
    const read = await client.request("pane.read", { pane_id: "w1:p1", source: "visible", format: "ansi" })
    const payload = read.read
    assert.equal(payload.format, "ansi")
    assert.match(String(payload.text), /tmp\/demo/)
  } finally {
    client.close()
    await mock.stop()
  }
})

test("the subscription connection keeps receiving events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-mock-"))
  const socketPath = join(dir, "herdr.sock")
  const mock = new HerdrMock(socketPath)
  await mock.start()
  const client = new HerdrClient(socketPath)
  const events = []
  client.onEvent((type, data) => events.push({ type, data }))
  try {
    client.subscribe([{ type: "workspace.created" }, { type: "pane.updated" }])
    await new Promise((resolve) => setTimeout(resolve, 200))
    mock.emit("workspace_created", {
      workspace: {
        workspace_id: "w2",
        label: "second",
        number: 2,
        agent_status: "idle",
        focused: false,
        active_tab_id: "w2:t1",
        pane_count: 0,
        tab_count: 0,
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.ok(
      events.some((event) => event.type === "__connected"),
      "expected the connected signal",
    )
    assert.ok(
      events.some((event) => event.type === "workspace_created"),
      "expected the workspace event",
    )
  } finally {
    client.close()
    await mock.stop()
  }
})

test("the session state applies snapshot and events", () => {
  const state = new SessionState()
  state.applySnapshot({
    snapshot: {
      version: "0.9.5",
      protocol: 22,
      workspaces: [
        {
          workspace_id: "w1",
          label: "demo",
          number: 1,
          agent_status: "working",
          focused: true,
          active_tab_id: "w1:t1",
          pane_count: 1,
          tab_count: 1,
        },
      ],
      tabs: [
        {
          tab_id: "w1:t1",
          workspace_id: "w1",
          label: "1",
          number: 1,
          agent_status: "working",
          focused: true,
          pane_count: 1,
        },
      ],
      panes: [
        {
          pane_id: "w1:p1",
          workspace_id: "w1",
          tab_id: "w1:t1",
          agent: "claude",
          agent_status: "working",
          focused: true,
          revision: 1,
        },
      ],
      agents: [],
      layouts: [],
    },
  })
  const snapshot = state.snapshot()
  assert.equal(snapshot.workspaces.length, 1)
  assert.equal(snapshot.panes[0].pane_id, "w1:p1")

  state.applyEvent("pane_agent_status_changed", {
    pane_id: "w1:p1",
    workspace_id: "w1",
    agent_status: "blocked",
    agent: "claude",
  })
  assert.equal(state.snapshot().panes[0].agent_status, "blocked")

  state.applyEvent("workspace_created", {
    workspace: {
      workspace_id: "w2",
      label: "second",
      number: 2,
      agent_status: "idle",
      focused: false,
      active_tab_id: "w2:t1",
      pane_count: 0,
      tab_count: 0,
    },
  })
  assert.equal(state.snapshot().workspaces.length, 2)

  state.applyEvent("workspace_closed", { workspace_id: "w1" })
  assert.equal(state.snapshot().workspaces.length, 1)
  assert.equal(state.snapshot().panes.length, 0)
})
