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

test("wide glyphs keep their trailing columns when wrapping", () => {
  const cells = ["A", "你", "", "好", "", "B", "你", "", "Z"].map(cell)
  const laid = layoutGrid({ cols: cells.length, rows: 1, cells: [cells] }, 4)
  assert.ok(laid.cells.every((row) => row.length <= 4 && row[0].ch !== ""))
  assert.deepEqual(
    laid.cells.flat().map((entry) => entry.ch),
    cells.map((entry) => entry.ch),
  )
  for (const row of laid.cells) {
    row.forEach((entry, index) => {
      if (entry.ch === "你" || entry.ch === "好") assert.equal(row[index + 1]?.ch, "")
    })
  }
})

test("reflow preserves background, reverse and underlined spaces", () => {
  const cells = [cell("A"), cell(" "), cell(" "), cell(" "), cell("B")]
  cells[1].style.underline = true
  cells[2].style.reverse = true
  cells[3].style.bg = "#ff0000"
  const laid = layoutGrid({ cols: 5, rows: 1, cells: [cells] }, 3)
  assert.deepEqual(laid.cells.flat(), cells)
})

test("visible space styles preserve word boundaries and every styled cell", () => {
  for (const style of [{ underline: true }, { reverse: true }]) {
    const cells = [..."alpha beta gamma delta"].map(cell)
    for (const entry of cells) Object.assign(entry.style, style)
    const laid = layoutGrid({ cols: cells.length, rows: 1, cells: [cells] }, 12)
    assert.deepEqual(lines(laid), ["alpha beta", "gamma delta"])
    assert.deepEqual(laid.cells.flat(), cells)
  }
})

test("a styled separator at the width boundary does not split the following full-width word", () => {
  for (const style of [{ underline: true }, { reverse: true }]) {
    const cells = [..."hello world"].map(cell)
    for (const entry of cells) Object.assign(entry.style, style)
    const laid = layoutGrid({ cols: cells.length, rows: 1, cells: [cells] }, 5)
    assert.deepEqual(
      laid.cells.map((row) => row.map((entry) => entry.ch).join("")),
      ["hello", " ", "world"],
    )
    assert.deepEqual(laid.cells.flat(), cells)
  }
})

test("a background separator does not become its own empty row at a word boundary", () => {
  const cells = [..."hello world"].map(cell)
  for (const entry of cells) entry.style.bg = "#373737"
  const laid = layoutGrid({ cols: 11, rows: 1, cells: [cells] }, 5)
  assert.deepEqual(lines(laid), ["hello", "world"])
  assert.ok(laid.cells.flat().every((entry) => entry.style.bg === "#373737"))
})

test("Claude message background padding fills the view without creating extra rows", () => {
  for (const message of [
    "❯ /effort",
    "❯ /model",
    "❯ echo almaprobe",
    "❯ a longer message that needs several text rows",
  ]) {
    const cells = [...message.padEnd(72)].map(cell)
    for (const entry of cells) entry.style.bg = "#373737"
    for (const width of [18, 30, 51]) {
      const laid = layoutGrid({ cols: 72, rows: 1, cells: [cells] }, width)
      assert.ok(
        laid.cells.every((row) => row.some((entry) => entry.ch.trim())),
        JSON.stringify(lines(laid)),
      )
      assert.ok(laid.cells.every((row) => row.length === width && row.at(-1).style.bg === "#373737"))
      assert.equal(flat(laid), message)
    }
  }
})

test("a background-only source row stays one blank row", () => {
  const cells = Array.from({ length: 72 }, () => cell(" "))
  for (const entry of cells) entry.style.bg = "#373737"
  const laid = layoutGrid({ cols: 72, rows: 1, cells: [cells] }, 30)
  assert.equal(laid.rows, 1)
  assert.equal(laid.cells[0].length, 30)
  assert.ok(laid.cells[0].every((entry) => entry.style.bg === "#373737"))
})

test("paragraph and consecutive blank rows survive narrow reflow", () => {
  const laid = layoutGrid(
    screen(["First paragraph with long content", "", "", "Second paragraph with long content"]),
    18,
  )
  assert.deepEqual(lines(laid), [
    "First paragraph",
    "with long content",
    "",
    "",
    "Second paragraph",
    "with long content",
  ])
})

function wideScreen(rows) {
  const cells = rows.map((line) =>
    [...line].flatMap((ch) =>
      /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u.test(ch) ? [cell(ch), cell("")] : [cell(ch)],
    ),
  )
  return { cols: Math.max(...cells.map((line) => line.length)), rows: rows.length, cells }
}

test("Chinese Claude paragraphs retain their marker and hanging indent", () => {
  const laid = layoutGrid(
    wideScreen(["⏺ 这是需要自然换行的中文说明，后面继续展示内容。", "  这里是桌面端的续行。"]),
    22,
  )
  const text = lines(laid)
  assert.ok(text[0].startsWith("⏺ 这是"), JSON.stringify(text))
  assert.ok(
    text.slice(1).every((line) => line.startsWith("  ")),
    JSON.stringify(text),
  )
  assert.equal(text.join("").replaceAll(" ", ""), "⏺这是需要自然换行的中文说明，后面继续展示内容。这里是桌面端的续行。")
  assert.ok(
    text.every((line) => !/^\s*[，。！？、；：）】》]/u.test(line)),
    JSON.stringify(text),
  )
})

test("hard-wrapped CJK prose expands to the page width and retains paragraph boundaries", () => {
  const first = "  这是命令行按原来窄窗口排出的连续中文正文，需要在更宽的页面中重新排版"
  const second = "  、保留标点和颜色，并且让正文使用页面的实际可用宽度。"
  const grid = wideScreen([first, second, "", "  这是另一个独立段落。", "  下一句完整陈述不会合并。"])
  const laid = layoutGrid(grid, 90)
  const output = lines(laid)
  assert.ok(laid.cells[0].length >= 82, "the first line uses the wider page")
  assert.ok(output.every((line) => !/^\s*[，。！？、；：）】》]/u.test(line)))
  assert.equal(output.slice(0, 2).join("").replaceAll(" ", ""), (first + second).replaceAll(" ", ""))
  assert.deepEqual(output.slice(2), ["", "  这是另一个独立段落。", "  下一句完整陈述不会合并。"])
})

test("CJK prose reflow keeps source cells and does not join code or separate paragraphs", () => {
  const grid = wideScreen([
    "  这是一行足够长的中文正文，用于验证真实终端的续行与样式会保留",
    "  这里继续同一个段落。",
    "",
    "  const value = { enabled: true };",
    "  独立的中文说明。",
    "  // 这是足够长的中文代码注释，需要保留代码的原始行边界而不能当正文续行",
    "  // 这是下一行独立的代码注释",
  ])
  grid.cells[1][2].style.fg = "#c678dd"
  const styled = grid.cells[1][2]
  const laid = layoutGrid(grid, 90)
  assert.ok(laid.cells.some((row) => row.includes(styled)))
  assert.ok(lines(laid).includes("  const value = { enabled: true };"))
  assert.ok(lines(laid).includes("  独立的中文说明。"))
  assert.ok(lines(laid).includes("  // 这是足够长的中文代码注释，需要保留代码的原始行边界而不能当正文续行"))
  assert.ok(lines(laid).includes("  // 这是下一行独立的代码注释"))
})

test("hard-wrapped mixed CJK prose joins Latin and punctuation starts", () => {
  for (const [first, second, separator] of [
    [
      "  这段中文介绍跨设备正文排版以及可用空间的组织方式，其中英文术语 responsive",
      "  layout 会跟随页面宽度重新组织内容。",
      " ",
    ],
    ["  layout 会跟随页面宽度重新组织中文正文，保持自然的阅读顺序与连续内容", "  并让读者继续阅读当前段落。", ""],
    ["  ，中文续行可能从原终端折行后的标点开始，这仍然属于同一段连续正文", "  后面的内容应接着填满可用宽度。", ""],
  ]) {
    const joined = first + separator + second.trimStart()
    for (const width of [39, 53, 100]) {
      assert.deepEqual(
        lines(layoutGrid(wideScreen([first, second]), width)),
        lines(layoutGrid(wideScreen([joined]), width)),
      )
    }
  }
})

test("mixed CJK prose fills the line instead of breaking after a short English prefix", () => {
  const laid = layoutGrid(wideScreen(["Use 中文说明应该尽量填满可用宽度，不应该在短英文后提前换行。"]), 24)
  assert.ok(lines(laid)[0].startsWith("Use 中文说明"))
  assert.ok(laid.cells[0].length >= 20)
})

test("code alignment and table columns are not compacted like a status bar", () => {
  const row = "  first          second          third"
  const laid = layoutGrid(screen([row, "x".repeat(90)]), 50)
  assert.equal(lines(laid)[0], row)
})

test("a nested code line does not join the preceding list item", () => {
  const laid = layoutGrid(
    screen(["- Example of a command with arguments", "  const value = { enabled: true };", "- Next item"]),
    25,
  )
  assert.ok(
    lines(laid).some((line) => line.startsWith("  const value")),
    JSON.stringify(lines(laid)),
  )
})

test("fenced code rows keep their own leading indentation", () => {
  const laid = layoutGrid(
    screen([
      "- Example with a code block",
      "  ```js",
      "  const value = {",
      "    enabled: true,",
      "  };",
      "  ```",
      "- Next item",
    ]),
    24,
  )
  assert.ok(lines(laid).includes("    enabled: true,"), JSON.stringify(lines(laid)))
})

test("a long word is still folded over several lines", () => {
  const grid = screen(["x".repeat(129)])
  const laid = layoutGrid(grid, 51)
  assert.equal(lines(laid).length, 3)
  assert.ok(laid.cells.every((row) => row.length <= 51))
})

test("deep indentation stays intact when it already fits, and cannot consume a narrow view", () => {
  const indented = `${" ".repeat(20)}content`
  assert.equal(lines(layoutGrid(screen([indented, "x".repeat(90)]), 40))[0], indented)
  const narrow = layoutGrid(screen([`${" ".repeat(60)}alpha beta gamma`]), 18)
  assert.ok(narrow.cells.every((row) => row.length <= 18 && row.some((cell) => cell.ch.trim())))
  assert.equal(flat(narrow), "alpha beta gamma")
})

test("a bullet containing aligned code is not mistaken for a compact status row", () => {
  const row = "● first          second          third"
  assert.equal(lines(layoutGrid(screen([row, "x".repeat(90)]), 50))[0], row)
})

test("reflow preserves every wide glyph across phone widths and punctuation boundaries", () => {
  const source = "⏺ 中文说明（包含括号）与 English words，保留标点。下一句话继续说明。"
  for (const width of [12, 18, 22, 30, 40]) {
    const laid = layoutGrid(wideScreen([source]), width)
    const output = lines(laid)
    assert.equal(output.join("").replaceAll(" ", ""), source.replaceAll(" ", ""))
    assert.ok(laid.cells.every((row) => row.length <= width && row[0]?.ch !== ""))
    assert.ok(
      output.every((line) => !/^\s*[，。！？、；：）】》]/u.test(line)),
      JSON.stringify(output),
    )
    assert.ok(
      output.every((line) => !/[（【《]$/u.test(line)),
      JSON.stringify(output),
    )
  }
})
