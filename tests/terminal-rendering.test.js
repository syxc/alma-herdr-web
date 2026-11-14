import assert from "node:assert/strict"
import { test } from "node:test"
import { environment, ready } from "./helpers/terminal-environment.js"

function host() {
  return {
    clientWidth: 390,
    clientHeight: 500,
    scrollTop: 0,
    get scrollHeight() {
      return 500
    },
    classList: { toggle() {} },
    addEventListener() {},
  }
}

test("snapshot conversion reuses unchanged source rows without mutating old screens", async (t) => {
  const { view } = environment(t)
  await ready(view)
  await view.setContent("stable 中文\nold tail", 24)
  const first = view.rows
  await view.setContent("stable 中文\nnew tail", 24)
  assert.ok(view.rows[0] === first[0], "unchanged source rows keep their cell objects")
  assert.equal(first[1].map((cell) => cell.ch).join(""), "old tail")
  const second = view.rows
  await view.setContent("\x1b[31mstable 中文\x1b[0m\nnew tail", 24)
  assert.ok(view.rows[0] !== second[0], "style-only changes invalidate the changed row")
  assert.ok(view.rows[1] === second[1], "other rows survive a style-only change")
})

test("native column changes invalidate layout even when screen cells are unchanged", async (t) => {
  const viewport = host()
  const { view, canvas } = environment(t, undefined, viewport)
  await ready(view)
  view.setMode("original")
  await view.setContent("same", 4, 10)
  const row = view.rows[0]
  await view.setContent("same", 4, 60)
  assert.ok(view.rows[0] === row)
  assert.equal(view.layoutCols, 60)
  assert.equal(Number.parseFloat(canvas.style.width), 60 * view.cellWidth + 38)
})

test("offscreen output updates do not redraw unchanged visible rows", async (t) => {
  const viewport = host()
  const { view, operations } = environment(t, undefined, viewport)
  await ready(view)
  view.follow = false
  viewport.scrollTop = 0
  const sample = Array.from({ length: 80 }, (_, i) => `Row ${i}: stable output`).join("\n")
  await view.setContent(sample, 24)
  assert.ok(
    operations.some((op) => op.kind === "text"),
    "the initial screen was painted",
  )
  operations.length = 0
  await view.setContent(`${sample}\nnew offscreen output`, 24)
  assert.equal(operations.filter((op) => op.kind === "text").length, 0)
  view.resize()
  assert.ok(
    operations.some((op) => op.kind === "text"),
    "explicit resize can repaint a static screen",
  )
})

test("style-only changes repaint the affected visible rows and erase removed text", async (t) => {
  const viewport = host()
  const { view, operations } = environment(t, undefined, viewport)
  await ready(view)
  view.follow = false
  viewport.scrollTop = 0
  view.setMode("original")
  const lines = Array.from({ length: 12 }, (_, i) => `row ${i} content`)
  await view.setContent(lines.join("\n"), 24)
  operations.length = 0
  lines[5] = "\x1b[31mrow 5 content\x1b[0m"
  await view.setContent(lines.join("\n"), 24)
  const draws = operations.filter((op) => op.kind === "text")
  assert.ok(draws.length > 0, "a changed foreground is painted")
  assert.ok(draws.length < 50, "other visible rows are retained")
  assert.ok(draws.some((op) => op.color === "#e17078"))
  operations.length = 0
  lines[5] = ""
  await view.setContent(lines.join("\n"), 24)
  assert.ok(
    operations.some((op) => op.kind === "rect" && op.y === 5 * 21),
    "erased text clears its old row",
  )
})

test("native scrolling inside the painted buffer does not redraw cached glyphs", async (t) => {
  const viewport = host()
  const { view, canvas, operations, flushFrame } = environment(t, undefined, viewport)
  await ready(view)
  view.follow = false
  viewport.scrollTop = 0
  await view.setContent(Array.from({ length: 200 }, (_, i) => `row ${i}: stable 中文`).join("\n"), 24)
  assert.ok(
    operations.some((op) => op.kind === "text"),
    "initial pixels exist",
  )
  const origin = canvas.style.top
  operations.length = 0
  for (let step = 1; step <= 20; step += 1) {
    viewport.scrollTop = step * 5.5
    view.handleScroll()
    flushFrame()
  }
  assert.equal(operations.length, 0, "small native offsets reuse existing pixels")
  assert.equal(canvas.style.top, origin, "the painted content stays anchored in document coordinates")
  assert.equal(canvas.style.position, "absolute", "pixels move with the native scroll surface")
})
