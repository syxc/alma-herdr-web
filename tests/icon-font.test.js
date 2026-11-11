import assert from "node:assert/strict"
import { test } from "node:test"
import { IconFontLoader } from "../web/dist/icon-font.js"
import { TerminalView } from "../web/dist/terminal.js"
import { TerminalKernel } from "../web/dist/vt.js"

function fontEnvironment(t) {
  const requests = []
  const added = []
  for (const name of ["FontFace", "document", "window"]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    })
  }
  globalThis.FontFace = class {
    constructor(family, source, descriptors) {
      Object.assign(this, {
        family,
        source,
        descriptors,
        unicodeRange: descriptors.unicodeRange,
        status: "unloaded",
        deferred: Promise.withResolvers(),
      })
      requests.push(this)
    }
    load() {
      return this.deferred.promise
    }
  }
  const fonts = new Set()
  fonts.add = (face) => {
    added.push(face)
    return Set.prototype.add.call(fonts, face)
  }
  globalThis.document = { fonts }
  globalThis.window = { devicePixelRatio: 1 }
  return { requests, added }
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}

test("icons load only their exact Unicode pages, including supplementary characters", async (t) => {
  const { requests, added } = fontEnvironment(t)
  let repaints = 0
  const loader = new IconFontLoader(() => {
    repaints += 1
  })
  loader.load("ASCII 中文 \u2631 \ue0a4")
  assert.equal(requests.length, 0, "unmapped characters must not load any page")
  loader.load("\ue0a0\ue0b0\ue0a0")
  loader.load("\ue0a0")
  assert.equal(requests.length, 1, "pending pages are shared")
  assert.match(requests[0].source, /symbols-0e0\.woff2/)
  requests[0].deferred.resolve(requests[0])
  await settle()
  assert.equal(repaints, 1)
  assert.deepEqual(added, [requests[0]])
  loader.load("\ue0a0")
  assert.equal(requests.length, 1, "loaded pages are reused")
  loader.load("\ue0a0\u{f0766}")
  assert.equal(requests.length, 2, "a later icon loads its new page")
  assert.match(requests[1].source, /symbols-f07\.woff2/)
  requests[1].deferred.resolve(requests[1])
  await settle()
  assert.equal(repaints, 2)
})

test("playback symbols used by the real terminal load independently of Nerd Font symbols on the same page", async (t) => {
  const { requests } = fontEnvironment(t)
  const loader = new IconFontLoader(() => {})
  loader.load("⏵⏵ bypass permissions on")
  assert.equal(requests.length, 1, "U+23F5 needs a bundled font even when the OS lacks it")
  assert.match(requests[0].source, /terminal-symbols\/playback\.woff2/)
  assert.equal(requests[0].unicodeRange, "U+23f4-23fa")
  loader.load("⏵⏵ \u23fb")
  assert.equal(requests.length, 2, "two font faces can cover different ranges in one Unicode page")
  assert.match(requests[1].source, /symbols-023\.woff2/)
  for (const request of requests) request.deferred.resolve(request)
  await settle()
})

test("Canvas shares an existing CSS face instead of downloading a second copy", async (t) => {
  const { requests } = fontEnvironment(t)
  const face = new FontFace('"Symbols Nerd Font Mono"', "url(symbols-f00.woff2)", {
    unicodeRange: "U+F0001-F00FF",
  })
  document.fonts.add(face)
  const loader = new IconFontLoader(() => {})
  loader.load("\u{f0001}")
  assert.equal(requests.length, 1)
  face.deferred.resolve(face)
  await settle()
})

test("failed pages retry automatically with a fresh FontFace and stop retrying removed icons", async (t) => {
  const { requests } = fontEnvironment(t)
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 })
  let repaints = 0
  const loader = new IconFontLoader(() => {
    repaints += 1
  })
  loader.load("\ue0a0\u{f0001}")
  requests[0].deferred.reject(new Error("temporary network failure"))
  await settle()
  t.mock.timers.tick(1000)
  requests[1].deferred.reject(new Error("another temporary failure"))
  await settle()
  loader.load("\ue0a0\u{f0001}")
  assert.equal(requests.length, 2, "polling cannot bypass the retry delay")
  t.mock.timers.tick(4000)
  assert.equal(requests.length, 3)
  assert.notEqual(requests[2], requests[0])
  requests[2].deferred.resolve(requests[2])
  await settle()
  t.mock.timers.tick(1000)
  assert.equal(requests.length, 4, "a later failure keeps its own retry")
  requests[3].deferred.resolve(requests[3])
  await settle()
  assert.equal(repaints, 2)
  loader.load("\uf013")
  requests[4].deferred.reject(new Error("offline"))
  await settle()
  loader.load("plain text")
  t.mock.timers.tick(5000)
  assert.equal(requests.length, 5, "an icon no longer on screen is not retried")
})

test("TerminalView repaints after an icon page loads without new terminal content or width changes", async (t) => {
  const { requests } = fontEnvironment(t)
  t.mock.method(TerminalKernel.prototype, "load", async () => false)
  let draws = 0
  const context = {
    setTransform() {},
    translate() {},
    fillRect() {},
    measureText: () => ({ width: 8 }),
    fillText() {
      draws += 1
    },
  }
  const canvas = {
    parentElement: null,
    style: {},
    width: 300,
    height: 100,
    getContext: () => context,
    getBoundingClientRect: () => ({ width: 300, height: 100 }),
  }
  const terminal = new TerminalView(canvas)
  await terminal.setContent("\ue0a0 regular 中文", 10)
  const before = draws
  const size = terminal.size()
  const width = canvas.style.width
  requests[0].deferred.resolve(requests[0])
  await settle()
  assert.equal(draws, before * 2, "font completion redraws the existing screen")
  assert.deepEqual(terminal.size(), size)
  assert.equal(canvas.style.width, width)
  await terminal.setContent("\u{f0001} next", 10)
  assert.match(requests[1].source, /symbols-f00\.woff2/)
  const next = draws
  requests[1].deferred.resolve(requests[1])
  await settle()
  assert.ok(draws > next)
})

test("a font request that never settles retries and repaints without a reload", async (t) => {
  const { requests } = fontEnvironment(t)
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 })
  let repaints = 0
  const loader = new IconFontLoader(() => {
    repaints += 1
  })
  loader.load("\ue0a0")
  t.mock.timers.tick(15000)
  await settle()
  t.mock.timers.tick(5000)
  assert.equal(requests.length, 2, "a stalled FontFace must not block later attempts")
  requests[1].deferred.resolve(requests[1])
  await settle()
  assert.equal(repaints, 1)
})
