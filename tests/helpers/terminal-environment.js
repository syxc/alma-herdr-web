import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { TerminalView } from "../../web/dist/terminal.js"

const bytes = await readFile(new URL("../../web/vendor/ghostty/ghostty-vt.wasm", import.meta.url))
const settle = () => new Promise((resolve) => setImmediate(resolve))

export function environment(t, response = Promise.resolve(new Response(bytes)), host = null) {
  for (const name of ["window", "document", "fetch"]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    })
  }
  const frames = new Map()
  let nextFrame = 0
  globalThis.window = {
    devicePixelRatio: 1,
    setTimeout,
    clearTimeout,
    requestAnimationFrame(callback) {
      const id = ++nextFrame
      frames.set(id, callback)
      return id
    },
    cancelAnimationFrame(id) {
      frames.delete(id)
    },
  }
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
  const view = new TerminalView(canvas)
  t.after(() => clearTimeout(view.scrollTimer))
  return {
    view,
    operations,
    canvas,
    flushFrame() {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(0)
    },
  }
}

export async function ready(view) {
  assert.equal(await view.kernel.load(), true)
  await settle()
}
