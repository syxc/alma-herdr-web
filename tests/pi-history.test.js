import assert from "node:assert/strict"
import { test } from "node:test"
import { PiHistoryBuffer, piHistoryKey } from "../web/dist/pi-history.js"

const RESET = "\x1b[0m"
const RED = "\x1b[31m"
const BLUE = "\x1b[34m"
const rule = "─".repeat(70)
const hint = "[ ↓ Back to bottom · Ctrl+End ]"
const plain = (text) => text.replace(/\x1b\[[0-9;:]*m/g, "")

function screen(body, { prompt = "❯", status = "/synthetic/project", scrolled = false } = {}) {
  return [...body, ...(scrolled ? ["", hint, ""] : []), rule, prompt, rule, status, "model · synthetic"].join("\n")
}

function body(buffer) {
  return JSON.parse(piHistoryKey(buffer.text))
}

test("unknown screens remain byte-for-byte intact and reject historical pages", () => {
  for (const raw of ["", `${RED}ordinary\n  text  `, "──\n❯\n──\nstatus", `${rule}\nnot a prompt\n${rule}\nstatus`]) {
    const buffer = new PiHistoryBuffer(raw, 1)
    assert.equal(buffer.supported, false)
    assert.equal(buffer.text, raw)
    assert.equal(buffer.prepend(screen(["older"])), false)
    assert.equal(piHistoryKey(raw), null)
  }
  assert.equal(piHistoryKey(`${rule}\n❯\n${rule}`), null, "a footer needs a trailing status row")
})

test("non-overlapping PageUp bodies concatenate with one latest footer", () => {
  const buffer = new PiHistoryBuffer(screen(["new one", "new two"], { prompt: "❯ typing", status: "latest cwd" }))
  assert.equal(
    buffer.prepend(screen(["old one", "old two"], { prompt: "› old input", status: "older cwd", scrolled: true })),
    true,
  )
  assert.deepEqual(body(buffer), ["old one", "old two", "new one", "new two"])
  assert.equal(buffer.lines, 9)
  assert.equal(
    plain(buffer.text)
      .split("\n")
      .filter((line) => line === rule).length,
    2,
  )
  assert.ok(buffer.text.includes("❯ typing"))
  assert.ok(!buffer.text.includes("older cwd"))
  assert.ok(!buffer.text.includes(hint))
})

test("two adjacent meaningful matches remove overlap while preserving source whitespace", () => {
  const buffer = new PiHistoryBuffer(screen([`${BLUE}  shared one  ${RESET}`, "  shared two\t", "new"]))
  assert.equal(buffer.prepend(screen(["old", `${RED}  shared one${RESET}`, "  shared two"])), true)
  assert.deepEqual(body(buffer), ["old", "  shared one", "  shared two", "new"])
  assert.ok(buffer.text.includes(`${BLUE}  shared one  ${RESET}`))
  assert.ok(buffer.text.includes("  shared two\t"))
})

test("a single repeated meaningful line is preserved at the seam", () => {
  const buffer = new PiHistoryBuffer(screen(["repeat", "new"]))
  buffer.prepend(screen(["old", "repeat"]))
  assert.deepEqual(body(buffer), ["old", "repeat", "repeat", "new"])
})

test("blank rows and repeated separators do not prove partial overlap", () => {
  const edge = ["", "─────", "─────", ""]
  const buffer = new PiHistoryBuffer(screen([...edge, "new"]))
  buffer.prepend(screen(["old", ...edge]))
  assert.deepEqual(body(buffer), ["old", ...edge, ...edge, "new"])
})

test("whole-page matches can include blank rows between meaningful text", () => {
  const buffer = new PiHistoryBuffer(screen(["shared", "", "end", "new"]))
  assert.equal(buffer.prepend(screen(["shared", "", "end"])), false)
  assert.deepEqual(body(buffer), ["shared", "", "end", "new"])
})

test("the oldest loaded page is not added twice after overlap trimming", () => {
  const buffer = new PiHistoryBuffer(screen(["shared one", "shared two", "new"]))
  const older = screen(["old", "shared one", "shared two"], { scrolled: true })
  assert.equal(buffer.prepend(older), true)
  assert.equal(buffer.prepend(older), false)
  assert.equal(buffer.prepend(screen([`${RED}old ${RESET}`, "shared one", "shared two"], { status: "changed" })), false)
  assert.deepEqual(body(buffer), ["old", "shared one", "shared two", "new"])
})

test("SGR resets at page seams retain colors, indentation, blank rows, and trailing newline", () => {
  const buffer = new PiHistoryBuffer(`${screen(["  latest", "", "tail"])}\n`)
  buffer.prepend(screen([`${RED}  colored`, "  still colored"]))
  assert.ok(buffer.text.includes(`${RED}  colored\n  still colored\n${RESET}  latest`))
  assert.ok(buffer.text.includes("  latest\n\ntail"))
  assert.ok(plain(buffer.text).endsWith("model · synthetic\n"))
  assert.ok(buffer.text.endsWith(RESET))
  assert.equal(buffer.lines, plain(buffer.text).split("\n").length)
})

test("the final prompt-rule pair wins and a distant hint remains body text", () => {
  const content = ["intro", rule, "> code sample", rule, "sample status", hint, "keep after hint"]
  const buffer = new PiHistoryBuffer(screen(content, { scrolled: true }))
  assert.equal(buffer.supported, true)
  assert.deepEqual(body(buffer), content)
  assert.equal(buffer.prepend("unknown"), false)
})

test("viewport keys ignore SGR, trailing whitespace, footer, and adjacent scroll hints", () => {
  const initial = screen([`${RED}  code  ${RESET}`, "last\t"], { scrolled: true })
  const refreshed = screen(["  code", "last"], { prompt: "> new text", status: "different cwd" })
  assert.equal(piHistoryKey(initial), piHistoryKey(refreshed))
  assert.notEqual(piHistoryKey(refreshed), piHistoryKey(screen(["code", "last"])), "leading code spaces matter")
  assert.equal(piHistoryKey(screen([])), "[]")
  assert.equal(piHistoryKey("ordinary screen"), null)
  assert.equal(piHistoryKey("━━━\n› draft\n═══\nsynthetic status"), "[]")
})

test("normal latest repaint preserves loaded history and replaces the footer", () => {
  const buffer = new PiHistoryBuffer(screen(["old viewport", "old content"], { status: "stale footer" }))
  buffer.prepend(screen(["history one", "history two"]))
  buffer.updateLatest(screen(["replacement", "new content"], { prompt: "> typed", status: "new footer" }))
  assert.deepEqual(body(buffer), ["history one", "history two", "replacement", "new content"])
  assert.ok(!buffer.text.includes("stale footer"))
  assert.ok(!buffer.text.includes("old viewport"))
  assert.ok(buffer.text.includes("> typed"))
})

test("sliding latest viewports retain departed body rows once", () => {
  const buffer = new PiHistoryBuffer(screen(["one", "two", "three", "four"]))
  buffer.prepend(screen(["prehistory"]))
  buffer.updateLatest(screen(["three", "four", "five", "six"]))
  buffer.updateLatest(screen(["five", "six", "seven", "eight"]))
  buffer.updateLatest(screen(["five", "six", "seven", "eight"], { prompt: "❯ draft" }))
  assert.deepEqual(body(buffer), ["prehistory", "one", "two", "three", "four", "five", "six", "seven", "eight"])
})

test("a growing last line preserves departed rows only behind trusted stable overlap", () => {
  const buffer = new PiHistoryBuffer(screen(["departed", "stable one", "stable two", `${RED}partial`]))
  buffer.updateLatest(screen(["stable one", "stable two", `${BLUE}partial extended`, "newest"]))
  assert.deepEqual(body(buffer), ["departed", "stable one", "stable two", "partial extended", "newest"])
  assert.ok(buffer.text.includes(`${BLUE}partial extended`), "the growing row keeps its current color")
  const uncertain = new PiHistoryBuffer(screen(["departed", "only match", "partial"]))
  uncertain.updateLatest(screen(["only match", "partial extended", "newest"]))
  assert.deepEqual(body(uncertain), ["only match", "partial extended", "newest"])
  const repainted = new PiHistoryBuffer(screen(["departed", "stable one", "stable two", "previous"]))
  repainted.updateLatest(screen(["stable one", "stable two", "replacement", "newest"]))
  assert.deepEqual(body(repainted), ["stable one", "stable two", "replacement", "newest"])
})

test("a duplicate initial page after a latest slide is still rejected", () => {
  const first = screen(["one", "two", "three"])
  const buffer = new PiHistoryBuffer(first)
  buffer.updateLatest(screen(["two", "three", "four"]))
  assert.equal(buffer.prepend(first), false)
  assert.deepEqual(body(buffer), ["one", "two", "three", "four"])
})

test("unknown repaint falls back exactly and later trusted input starts fresh", () => {
  const buffer = new PiHistoryBuffer(screen(["latest"]))
  buffer.prepend(screen(["history"]))
  const unknown = `${RED}unrecognized\n  screen  `
  buffer.updateLatest(unknown)
  assert.equal(buffer.text, unknown)
  assert.equal(buffer.supported, false)
  buffer.updateLatest(screen(["fresh"]))
  assert.equal(buffer.supported, true)
  assert.deepEqual(body(buffer), ["fresh"])
})

test("the total line cap retains the newest rows and full stops older loading", () => {
  const buffer = new PiHistoryBuffer(screen(["three", "four"]), 9)
  assert.equal(buffer.full, false)
  assert.equal(buffer.prepend(screen(["zero", "one", "two"])), true)
  assert.equal(buffer.full, true)
  assert.equal(buffer.lines, 9)
  assert.deepEqual(body(buffer), ["one", "two", "three", "four"])
  assert.equal(buffer.prepend(screen(["older"])), false)
  buffer.updateLatest(screen(["four", "five", "six"]))
  assert.deepEqual(body(buffer), ["two", "four", "five", "six"], "one matching row cannot promote a repainted viewport")
  assert.equal(buffer.lines, 9)
})

test("cap trimming and latest sliding preserve inherited source SGR", () => {
  const buffer = new PiHistoryBuffer(screen([`${RED}one`, "two", "three", "four"]), 9)
  assert.equal(buffer.full, true)
  buffer.updateLatest(screen([`${BLUE}three`, "four", "five", "six"]))
  assert.deepEqual(body(buffer), ["three", "four", "five", "six"])
  assert.ok(buffer.text.includes(`${BLUE}three`))
  const trimmed = new PiHistoryBuffer(screen([`${RED}one`, "two", "three"]), 7)
  assert.deepEqual(body(trimmed), ["two", "three"])
  assert.ok(trimmed.text.startsWith(`${RESET}${RED}two`))
})

test("a tiny limit is bounded even when the latest footer alone is longer", () => {
  const buffer = new PiHistoryBuffer(screen(["body"]), 2)
  assert.equal(buffer.lines, 2)
  assert.equal(buffer.full, true)
  assert.equal(plain(buffer.text), "/synthetic/project\nmodel · synthetic")
})
