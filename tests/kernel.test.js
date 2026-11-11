import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { GhosttyKernel } from "../web/dist/ghostty-vt.js"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const kernelPath = join(root, "web", "vendor", "ghostty", "ghostty-vt.wasm")

/** A kernel of its own, so the tests do not share a screen. */
async function openKernel() {
  const bytes = new Uint8Array(await readFile(kernelPath))
  return GhosttyKernel.load(bytes)
}

test("a character that is wider than one column owns the column after it", async () => {
  const kernel = await openKernel()
  const screen = kernel.setContent("你好 world", 5)
  const row = screen.rows[0] ?? []
  assert.deepEqual(
    row.map((cell) => cell.ch),
    ["你", "", "好", "", " ", "w", "o", "r", "l", "d"],
  )
})

test("the styles of the text come from the kernel", async () => {
  const kernel = await openKernel()
  const screen = kernel.setContent("\u001b[1mbold\u001b[0m \u001b[3mitalic\u001b[0m \u001b[4munderline\u001b[0m", 5)
  const row = screen.rows[0] ?? []
  assert.equal(row[0]?.bold, true)
  assert.equal(row[4]?.bold, false)
  assert.equal(row[5]?.italic, true)
  assert.equal(row[11]?.italic, false)
  assert.equal(row[12]?.underline, true)
  assert.equal(row[4]?.underline, false)
})

test("the colours of the text come from the kernel", async () => {
  const kernel = await openKernel()
  const screen = kernel.setContent("\u001b[38;5;196mred\u001b[0m", 5)
  const row = screen.rows[0] ?? []
  assert.equal(row.length, 3)
  assert.equal(row[0]?.fg, "#ff0000")
  assert.equal(row[2]?.fg, "#ff0000")
})

test("the lines that scrolled out of the screen come back with it", async () => {
  const kernel = await openKernel()
  const lines = []
  for (let index = 1; index <= 30; index += 1) {
    lines.push(`line ${index}`)
  }
  const screen = kernel.setContent(lines.join("\r\n"), 10)
  assert.equal(screen.rows.length, 30)
  assert.equal(screen.rows[0]?.map((cell) => cell.ch).join(""), "line 1")
  assert.equal(screen.rows[29]?.map((cell) => cell.ch).join(""), "line 30")
})

test("the screen is emptied before the new content is written", async () => {
  const kernel = await openKernel()
  kernel.setContent("first\r\nsecond\r\nthird", 5)
  const screen = kernel.setContent("only", 5)
  assert.equal(screen.rows.length, 1)
  assert.equal(screen.rows[0]?.map((cell) => cell.ch).join(""), "only")
})
