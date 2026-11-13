import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { TerminalView } from "../web/dist/terminal.js"
import { cellColors } from "../web/dist/terminal-theme.js"
import { TerminalKernel } from "../web/dist/vt.js"

const bytes = await readFile(new URL("../web/vendor/ghostty/ghostty-vt.wasm", import.meta.url))
const settle = () => new Promise((resolve) => setImmediate(resolve))

function environment(t, response = Promise.resolve(new Response(bytes)), host = null) {
  for (const name of ["window", "document", "fetch"]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    })
  }
  globalThis.window = { devicePixelRatio: 1, setTimeout, clearTimeout }
  globalThis.document = {
    fonts: new Set(),
    createElement: () => ({
      style: {},
      append() {
        if (host !== null) host.surface = this
      },
    }),
  }
  globalThis.fetch = () => response
  const operations = []
  const context = {
    globalAlpha: 1,
    setTransform() {},
    translate() {},
    measureText: () => ({ width: 8 }),
    fillRect(x, y, width, height) {
      operations.push({ kind: "rect", x, y, width, height, color: this.fillStyle, alpha: this.globalAlpha })
    },
    fillText(text, x, y) {
      operations.push({ kind: "text", text, x, y, color: this.fillStyle, alpha: this.globalAlpha })
    },
  }
  const canvas = {
    parentElement: host,
    style: {},
    width: 300,
    height: 100,
    before() {},
    getContext: () => context,
    getBoundingClientRect: () => ({
      width: host === null ? 300 : Number.parseFloat(canvas.style.width ?? "300"),
      height: host === null ? 100 : Number.parseFloat(canvas.style.height ?? "100"),
    }),
  }
  return { view: new TerminalView(canvas), operations, canvas }
}

async function ready(view) {
  assert.equal(await view.kernel.load(), true)
  await settle()
}

test("native core screen metadata reaches the renderer and participates in caching", async (t) => {
  const { view } = environment(t)
  await view.setContent("1234567890Z", 4, 10)
  assert.deepEqual(view.size(), { cols: 10, rows: 4 })
  assert.equal(view.rows[1][0].ch, "Z")
  await view.setContent("1234567890Z", 4, 20)
  assert.deepEqual(view.size(), { cols: 20, rows: 4 })
  assert.equal(view.rows[0][10].ch, "Z")
  await view.setContent("legacy", 4)
  assert.equal(view.rows[0].map((cell) => cell.ch).join(""), "legacy")
})

test("selection during native kernel loading applies the pending screen after release", async (t) => {
  const pending = Promise.withResolvers()
  const { view } = environment(t, pending.promise)
  await view.setContent("old screen", 4)
  const next = view.setContent("new screen", 4, 80)
  let selected = true
  view.selection = { active: () => selected, update() {}, clear() {} }
  pending.resolve(new Response(bytes))
  await next
  await settle()
  assert.equal(view.rows[0].map((cell) => cell.ch).join(""), "old screen")
  selected = false
  const queued = view.pendingContent
  assert.equal(queued.text, "new screen")
  assert.equal(queued.cols, 80)
  await view.setContent(queued.text, queued.rows, queued.cols)
  assert.equal(view.rows[0].map((cell) => cell.ch).join(""), "new screen")
})

test("a late kernel repaints the latest snapshot without waiting for another poll", async (t) => {
  const pending = Promise.withResolvers()
  const { view, operations } = environment(t, pending.promise)
  view.setMode("original")
  await view.setContent("obsolete", 5)
  await view.setContent("你Z", 5)
  operations.length = 0
  pending.resolve(new Response(bytes))
  await ready(view)
  const text = operations.filter((op) => op.kind === "text")
  assert.deepEqual(
    text.map((op) => op.text),
    ["你", "Z"],
  )
  assert.equal(text[1].x, 16, "the wide character reserves its trailing column")
})

test("unchanged snapshots draw nothing, while resize still repaints existing content", async (t) => {
  const { view, operations } = environment(t)
  await view.setContent("static screen", 5)
  await ready(view)
  operations.length = 0
  for (let index = 0; index < 100; index += 1) await view.setContent("static screen", 5)
  assert.equal(operations.length, 0)
  view.resize()
  assert.ok(operations.some((op) => op.kind === "text"))
  operations.length = 0
  await view.setContent("changed screen", 5)
  assert.ok(operations.some((op) => op.kind === "text"))
})

test("themes recolour indexed cells and defaults but preserve explicit RGB", async (t) => {
  const { view, operations } = environment(t)
  await ready(view)
  await view.setContent("D\x1b[31mR\x1b[38;2;12;34;56mT", 5)
  operations.length = 0
  await view.setTheme("light")
  const text = operations.filter((op) => op.kind === "text")
  assert.deepEqual(
    text.map((op) => op.color),
    ["#1a1a1a", "#e45649", "#0c2238"],
  )
  assert.equal(operations[0].color, "#ffffff")
  operations.length = 0
  await view.setTheme("dark")
  assert.deepEqual(
    operations.filter((op) => op.kind === "text").map((op) => op.color),
    ["#dcdfe4", "#e06c75", "#0c2238"],
  )
})

test("fixed neutral snapshot colours follow the page while accent colours stay intact", async (t) => {
  const { view, operations } = environment(t)
  await ready(view)
  view.setMode("original")
  const light = "\x1b[48;2;240;240;240m\x1b[38;2;0;0;0mM\x1b[49;38;2;102;102;102mH\x1b[38;2;215;119;87mA\x1b[0m"
  operations.length = 0
  await view.setContent(light, 5)
  assert.equal(operations.find((op) => op.kind === "rect" && op.height === 21).color, "#2d313a")
  assert.deepEqual(
    operations.filter((op) => op.kind === "text").map((op) => op.color),
    ["#dcdfe4", "#9da2ae", "#d77757"],
  )
  operations.length = 0
  await view.setTheme("light")
  assert.equal(operations.find((op) => op.kind === "rect" && op.height === 21).color, "#f0f0f0")
  assert.deepEqual(
    operations.filter((op) => op.kind === "text").map((op) => op.color),
    ["#000000", "#666666", "#d77757"],
  )
  operations.length = 0
  await view.setContent("\x1b[48;2;32;32;32m\x1b[38;2;240;240;240mD\x1b[0m", 5)
  assert.equal(operations.find((op) => op.kind === "rect" && op.height === 21).color, "#f0f2f5")
  assert.equal(operations.find((op) => op.kind === "text").color, "#1a1a1a")
})

test("neutral adaptation preserves inverse polarity and coloured terminal pairs", () => {
  assert.equal(
    cellColors({ fg: "#d77757", bg: "#f0f0f0", reverse: false }, "dark").background,
    "#2d313a",
    "a coloured span does not break the surrounding neutral surface",
  )
  assert.deepEqual(cellColors({ fg: "#000000", bg: "#f0f0f0", reverse: true }, "dark"), {
    foreground: "#2d313a",
    background: "#dcdfe4",
  })
  for (const theme of ["dark", "light"]) {
    assert.deepEqual(cellColors({ fg: "#d77757", bg: "#000000", reverse: false }, theme), {
      foreground: "#d77757",
      background: "#000000",
    })
    assert.equal(cellColors({ fg: "#ffffff", bg: "#ab2b3f", reverse: false }, theme).background, "#ab2b3f")
  }
})

test("fallback snapshots and the loaded kernel use the same adaptive colours", async (t) => {
  const pending = Promise.withResolvers()
  const { view, operations } = environment(t, pending.promise)
  const content = "\x1b[48;2;240;240;240;38;2;0;0;0mM"
  await view.setContent(content, 5)
  assert.equal(operations.findLast((op) => op.kind === "rect" && op.height === 21).color, "#2d313a")
  assert.equal(operations.findLast((op) => op.kind === "text").color, "#dcdfe4")
  pending.resolve(new Response(bytes))
  await ready(view)
  assert.equal(operations.findLast((op) => op.kind === "rect" && op.height === 21).color, "#2d313a")
  assert.equal(operations.findLast((op) => op.kind === "text").color, "#dcdfe4")
})

test("a wide underlined glyph at the end of a row has a full-width underline", async (t) => {
  const { view, operations } = environment(t)
  await ready(view)
  view.setMode("original")
  operations.length = 0
  await view.setContent("\x1b[4m你", 5)
  assert.equal(operations.find((op) => op.kind === "rect" && op.height === 1)?.width, 16)
})

test("wide glyph backgrounds precede text and dim cannot leak into the next background", async (t) => {
  const { view, operations } = environment(t)
  await ready(view)
  await view.setContent("\x1b[2mA\x1b[22;41m你\x1b[4m B", 5)
  const firstText = operations.findIndex((op) => op.kind === "text")
  const backgrounds = operations.filter((op) => op.kind === "rect" && op.height === 21)
  assert.ok(backgrounds.length > 0)
  assert.ok(backgrounds.every((op) => op.alpha === 1))
  assert.ok(operations.slice(firstText).every((op) => op.kind !== "rect" || op.height === 1))
  assert.ok(
    operations.some((op) => op.kind === "rect" && op.height === 1),
    "underline reaches the canvas",
  )
})

test("background runs merge same colours while preserving RGB, reset and reverse", async (t) => {
  const { view, operations } = environment(t)
  await ready(view)
  view.setMode("original")
  operations.length = 0
  await view.setContent("\x1b[48;2;239;239;239m A你 \x1b[44m B\x1b[49mZ\x1b[7mR\x1b[0mN", 5)
  const backgrounds = operations.filter((op) => op.kind === "rect" && op.height === 21)
  assert.deepEqual(
    backgrounds.map(({ x, width, color }) => ({ x, width, color })),
    [
      { x: 0, width: 40, color: "#2d313a" },
      { x: 40, width: 16, color: "#61afef" },
      { x: 64, width: 8, color: "#dcdfe4" },
    ],
  )
  const text = operations.filter((op) => op.kind === "text")
  assert.equal(text.find((op) => op.text === "N").color, "#dcdfe4")
  assert.equal(text.find((op) => op.text === "R").color, "#282c34")
  operations.length = 0
  await view.setContent("first\nsecond", 5)
  const rows = operations.filter((op) => op.kind === "text")
  assert.equal(rows.at(-1).y - rows[0].y, 21)
})

test("a stalled WASM download times out and does not block a later attempt", async (t) => {
  environment(t)
  t.mock.method(console, "warn", () => {})
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 })
  globalThis.fetch = () => new Promise(() => {})
  const kernel = new TerminalKernel()
  const first = kernel.load()
  t.mock.timers.tick(15000)
  assert.equal(await first, false)
  t.mock.timers.tick(5000)
  globalThis.fetch = async () => new Response(bytes)
  assert.equal(await kernel.load(), true)
})

test("a failed WASM download can recover after the bounded retry delay", async (t) => {
  environment(t)
  t.mock.method(console, "warn", () => {})
  let attempts = 0
  let now = 10000
  t.mock.method(Date, "now", () => now)
  globalThis.fetch = async () => {
    attempts += 1
    return attempts === 1 ? new Response("unavailable", { status: 503 }) : new Response(bytes)
  }
  const kernel = new TerminalKernel()
  assert.equal(await kernel.load(), false)
  assert.equal(await kernel.load(), false)
  assert.equal(attempts, 1)
  now += 5000
  assert.equal(await kernel.load(), true)
  assert.equal(attempts, 2)
})

function scrollHost() {
  let scrollTop = 0
  return {
    clientWidth: 390,
    clientHeight: 190,
    get scrollTop() {
      return scrollTop
    },
    set scrollTop(value) {
      scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))
    },
    scrollLeft: 0,
    get scrollHeight() {
      return Number.parseFloat(this.surface?.style.height ?? "0")
    },
    classList: { toggle() {} },
    addEventListener() {},
  }
}

const readingContent = Array.from(
  { length: 50 },
  (_, i) => `Record ${i}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron.`,
).join("\n")

test("width and mode changes keep the source character being read in view", async (t) => {
  const host = scrollHost()
  const { view } = environment(t, Promise.resolve(new Response(bytes)), host)
  t.after(() => clearTimeout(view.snapTimer))
  await ready(view)
  await view.setContent(readingContent, 24)
  host.scrollTop = 20 * view.rowHeight
  view.handleScroll()
  const target = view.laidOut[20].find((c) => c.ch.trim())
  for (const width of [320, 600, 390]) {
    host.clientWidth = width
    view.resize()
    const top = Math.round(host.scrollTop / view.rowHeight)
    assert.ok(view.laidOut[top].includes(target), `${width}px: resizing keeps the same source character at the top`)
  }
  view.setMode("original")
  const top = Math.round(host.scrollTop / view.rowHeight)
  assert.ok(view.laidOut[top].includes(target), "Original Width keeps the same source character at the top")
})

test("hidden terminals defer layout and painting until their viewport returns", async (t) => {
  const host = scrollHost()
  host.clientWidth = 0
  host.clientHeight = 0
  const { view, operations } = environment(t, Promise.resolve(new Response(bytes)), host)
  await ready(view)
  await view.setContent(readingContent, 24)
  assert.equal(operations.length, 0)
  assert.equal(view.laidOut.length, 0)
  host.clientWidth = 390
  host.clientHeight = 190
  view.resize()
  assert.ok(view.laidOut.length > 0)
  assert.ok(operations.some((operation) => operation.kind === "text"))
})

test("long snapshots paint only visible rows and repaint on reader scrolling", async (t) => {
  const host = scrollHost()
  const { view, canvas, operations } = environment(t, Promise.resolve(new Response(bytes)), host)
  t.after(() => clearTimeout(view.snapTimer))
  await ready(view)
  await view.setContent(readingContent, 24)
  assert.equal(canvas.height, host.clientHeight)
  assert.ok(host.scrollHeight > host.clientHeight * 10)
  operations.length = 0
  host.scrollTop = 20 * view.rowHeight
  view.handleScroll()
  const draws = operations.filter((op) => op.kind === "text")
  assert.ok(draws.length > 0)
  assert.ok(draws.length < 10 * view.layoutCols, "the full history is not repainted on scroll")
  assert.ok(draws.every((op) => op.y >= 0 && op.y <= host.clientHeight + view.cellHeight))
  assert.equal(
    draws
      .filter((op) => op.y === view.fontSize)
      .map((op) => op.text)
      .join(""),
    view.laidOut[20]
      .map((cell) => cell.ch)
      .join("")
      .replaceAll(" ", ""),
  )
})
