import assert from "node:assert/strict"
import { test } from "node:test"

import { layoutGrid } from "../web/dist/layout.js"

function cell(ch) {
  return {
    ch,
    style: { fg: "", bg: "", bold: false, dim: false, underline: false, reverse: false },
  }
}

function screen(rows) {
  const cells = rows.map((line) => [...line].map(cell))
  const cols = Math.max(...cells.map((line) => line.length))
  for (const line of cells) {
    while (line.length < cols) {
      line.push(cell(" "))
    }
  }
  return { cols, rows: rows.length, cells }
}

function lines(grid) {
  return grid.cells.map((line) =>
    line
      .map((c) => c.ch)
      .join("")
      .replace(/\s+$/, ""),
  )
}

function flat(grid) {
  return lines(grid).join(" ").replace(/\s+/g, " ").trim()
}

test("a screen that fits stays as it is", () => {
  const grid = screen(["short", "lines"])
  assert.equal(layoutGrid(grid, 40), grid)
})

test("a line the terminal wrapped is joined and wrapped again", () => {
  const grid = screen([
    "⏺ Session was started with bypass permissions, so",
    "  without bypass permissions for prompts in plan mode.",
  ])
  const laid = layoutGrid(grid, 30)
  assert.equal(
    flat(laid),
    "⏺ Session was started with bypass permissions, so without bypass permissions for prompts in plan mode.",
  )
  // The lines after the first one are indented like the terminal indents them.
  assert.ok(lines(laid)[1].startsWith("  "))
})

test("a line of a tree entry keeps the deeper indent", () => {
  const grid = screen([
    "  ⎿  Set effort level to low (saved as your default for new",
    "     sessions): Quick, straightforward implementation",
  ])
  const laid = layoutGrid(grid, 30)
  assert.ok(lines(laid)[1].startsWith("     "))
})

test("lines of the same indent stay apart", () => {
  const grid = screen([
    "  [GPT-6.1 Terra · Codex] │ Workspace/pi-mono",
    "  Context 0% (0/500k)",
    "  1 CLAUDE.md | 5 MCPs | 17 hooks",
  ])
  const laid = layoutGrid(grid, 50)
  assert.equal(lines(laid).length, 3)
  assert.ok(lines(laid)[1].startsWith("  Context"))
})

test("the parts of a status bar are pulled together", () => {
  const grid = screen([`● full  $0.00  0s${" ".repeat(40)}Review  Board [-]`])
  const laid = layoutGrid(grid, 40)
  assert.equal(lines(laid)[0], "● full  $0.00  0s  Review  Board [-]")
})

test("a word is not cut in half", () => {
  const grid = screen(["alpha beta gamma delta"])
  const laid = layoutGrid(grid, 12)
  assert.deepEqual(lines(laid), ["alpha beta", "gamma delta"])
})

test("a line that divides the screen is cut to the width, not folded", () => {
  const grid = screen(["\u2500".repeat(129), "\u276f"])
  const laid = layoutGrid(grid, 51)
  assert.equal(lines(laid).length, 2)
  assert.equal(lines(laid)[0].length, 51)
  assert.equal(lines(laid)[1], "\u276f")
})

test("a long word is still folded over several lines", () => {
  const grid = screen(["x".repeat(129)])
  const laid = layoutGrid(grid, 51)
  assert.equal(lines(laid).length, 3)
})
