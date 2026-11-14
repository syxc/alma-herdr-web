import assert from "node:assert/strict"
import { test } from "node:test"
import { parseAnsi } from "../web/dist/ansi.js"
import { layoutGrid } from "../web/dist/layout.js"
import { PiHistoryBuffer, piHistoryKey } from "../web/dist/pi-history.js"
import { cellColors } from "../web/dist/terminal-theme.js"

const rule = "─".repeat(70)
const sgr = /\x1b\[[0-9;:]*m/g
const footer = [rule, "❯", rule, "synthetic status"]
const plain = (text) => text.replace(sgr, "")
const sourceBody = (text) => JSON.parse(piHistoryKey(text)).map((line) => line.trimEnd())
const framed = (line) => `${line + " ".repeat(69 - parseAnsi(line).cols)}\x1b[0m|\x1b[0m`
const displayed = (grid) =>
  grid.cells.map((row) =>
    row
      .map((cell) => cell.ch)
      .join("")
      .trimEnd(),
  )

test("pi's repeated right frame does not enter the continuous document or phone reflow", () => {
  const content = ["synthetic startup", "中文正文应保持原来的字序，不插入窗格边框", "", "last synthetic row"]
  const input = [...content.map(framed), ...footer].join("\r\n")
  const buffer = new PiHistoryBuffer(input)
  assert.deepEqual(sourceBody(buffer.text), content)
  assert.ok(plain(input).includes("|"), "the fixture must contain the visible frame")
  const phone = displayed(layoutGrid(parseAnsi(buffer.text), 34))
  assert.ok(!phone.some((line) => line.includes("|")))
})

test("a complete framed pi page is recognized without a blank row", () => {
  const content = ["synthetic warning one", "synthetic warning two", "synthetic warning three"]
  const input = [...content.map(framed), ...footer].join("\r\n")
  assert.deepEqual(sourceBody(new PiHistoryBuffer(input).text), content)
})

test("pi keeps code pipelines and table borders without isolated right-frame evidence", () => {
  for (const content of [
    ["command | filter", "ending pipe |", ""],
    ["| first | second |", "|       |        |", "| value | other  |"],
    [`|${" ".repeat(68)}|`, `|${"x".repeat(68)}|`, `|${"y".repeat(68)}|`],
  ]) {
    const text = [...content, ...footer].join("\n")
    assert.deepEqual(sourceBody(new PiHistoryBuffer(text).text), content)
  }
})

test("slightly blue neutral message fills follow the page theme but saturated highlights stay intact", () => {
  const style = { fg: "#484e52", bg: "#e0e7ed", reverse: false }
  assert.equal(cellColors(style, "dark").background, "#2d313a")
  assert.equal(cellColors(style, "light").background, "#e0e7ed")
  const colored = { fg: "#dee0e1", bg: "#213b49", reverse: false }
  assert.equal(cellColors(colored, "dark").background, colored.bg)
  assert.equal(cellColors({ fg: "#ffffff", bg: "#ab2b3f", reverse: false }, "dark").background, "#ab2b3f")
})

test("inserted word separators inherit a continuous message background", () => {
  const first = "这是一段合成的中英混排说明用于检查连续背景 responsive layout"
  const second = "以及下一行继续补充的中文说明"
  const padded = (line) => `\x1b[48;2;33;59;73m${line}${" ".repeat(Math.max(0, 80 - parseAnsi(line).cols))}\x1b[0m`
  const grid = layoutGrid(parseAnsi([padded(first), padded(second)].join("\n")), 34)
  assert.ok(displayed(grid).join("").includes("layout 以及"))
  assert.ok(grid.cells.every((row) => row.every((cell) => cell.style.bg === "#213b49")))
})

test("joining background-filled Chinese rows does not turn their padding into word gaps", () => {
  const first = "这是一段合成的中文说明用于检查窄屏连续正文的背景填充与换行"
  const second = "下一行继续同一段正文并保留实际的文字顺序"
  const padded = (line) => `\x1b[48;2;33;59;73m${line}${" ".repeat(Math.max(0, 70 - parseAnsi(line).cols))}\x1b[0m`
  const expected = layoutGrid(parseAnsi(padded(first + second)), 34)
  const actual = layoutGrid(parseAnsi([padded(first), padded(second)].join("\n")), 34)
  assert.deepEqual(displayed(actual), displayed(expected))
  assert.ok(actual.cells.every((row) => row.length === 34 && row.every((cell) => cell.style.bg === "#213b49")))
})
