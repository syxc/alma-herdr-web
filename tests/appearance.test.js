import assert from "node:assert/strict"
import { test } from "node:test"
import { appendAppearanceControl, initAppearance } from "../web/dist/appearance.js"
import { DetailScreen } from "../web/dist/detail.js"

function environment(t, stored = null, dark = false) {
  for (const name of ["window", "document"]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    })
  }
  const selects = []
  const events = {}
  const media = {
    matches: dark,
    addEventListener: (_, callback) => {
      media.change = callback
    },
  }
  const storage = {
    getItem: () => stored,
    setItem: (_, value) => {
      stored = value
    },
  }
  globalThis.window = {
    matchMedia: () => media,
    localStorage: storage,
    addEventListener: (type, callback) => {
      events[type] = callback
    },
  }
  const meta = {
    setAttribute: (_, value) => {
      meta.content = value
    },
  }
  globalThis.document = {
    documentElement: { dataset: {} },
    querySelector: () => meta,
    querySelectorAll: () => selects,
    createElement: (tag) => {
      const element = {
        dataset: {},
        children: [],
        append(...children) {
          this.children.push(...children)
          for (const child of children) if (typeof child === "object") child.parentElement = this
        },
        setAttribute(name, value) {
          this[name] = value
        },
        querySelector() {
          return this.children.find((child) => child.dataset?.appearanceValue !== undefined) ?? null
        },
        addEventListener(type, callback) {
          this[type] = callback
        },
      }
      if (tag === "select") selects.push(element)
      return element
    },
  }
  return { media, storage, events, meta, selects, container: { append() {} } }
}

test("system changes update the theme until an explicit appearance is chosen", (t) => {
  const env = environment(t)
  const themes = []
  initAppearance((theme) => themes.push(theme))
  appendAppearanceControl(env.container)
  appendAppearanceControl(env.container)
  assert.deepEqual(themes, ["light"])
  assert.equal(env.selects[0].value, "system")
  env.media.matches = true
  env.media.change()
  assert.equal(themes.at(-1), "dark")
  env.selects[0].value = "light"
  env.selects[0].change()
  assert.equal(env.selects[1].value, "light", "other menus reflect the same preference")
  assert.equal(
    env.selects[1].parentElement.querySelector().textContent,
    "Light",
    "compact value follows the native select",
  )
  assert.equal(env.storage.getItem(), "light")
  env.media.change()
  assert.equal(themes.at(-1), "light")
  assert.equal(env.meta.content, "#ffffff")
})

test("state polling preserves the open appearance control and refreshes pane dimensions", (t) => {
  const env = environment(t)
  initAppearance(() => {})
  let dimensions = { cols: 80, rows: 24 }
  const menu = {
    children: [],
    appendChild(node) {
      this.children.push(node)
    },
    append(node) {
      this.children.push(node)
    },
    replaceChildren() {
      this.children = []
    },
    querySelector() {
      return this.children.find((node) => node.className === "popover-foot") ?? null
    },
  }
  const screen = Object.create(DetailScreen.prototype)
  Object.assign(screen, {
    mode: "wrap",
    pane: null,
    actionSignature: "",
    actionMenu: menu,
    actions: { paneSize: () => dimensions },
    item: () => ({}),
    separator: () => ({}),
  })
  screen.renderActionMenu()
  const appearance = menu.children.find((node) => node.className === "appearance-setting")
  const select = env.selects[0]
  dimensions = { cols: 100, rows: 30 }
  for (let index = 0; index < 5; index += 1) screen.renderActionMenu()
  assert.equal(env.selects.length, 1, "polls do not recreate the select")
  assert.ok(menu.children.includes(appearance))
  assert.ok(appearance.children.includes(select.parentElement))
  assert.equal(select.parentElement.querySelector().textContent, "System")
  assert.equal(menu.querySelector().textContent, "Pane is 100 × 30")
})

test("saved appearance survives initialization and a cross-tab preference change", (t) => {
  const env = environment(t, "dark")
  initAppearance(() => {})
  assert.equal(document.documentElement.dataset.theme, "dark")
  assert.equal(env.meta.content, "#282c34")
  env.storage.setItem(null, "light")
  env.events.storage({ key: "alma-herdr-web:appearance" })
  assert.equal(document.documentElement.dataset.theme, "light")
})

test("denied browser storage still permits immediate in-memory appearance changes", (t) => {
  const env = environment(t)
  env.storage.getItem = env.storage.setItem = () => {
    throw new Error("Storage unavailable")
  }
  initAppearance(() => {})
  appendAppearanceControl(env.container)
  env.selects[0].value = "dark"
  env.selects[0].change()
  assert.equal(document.documentElement.dataset.theme, "dark")
})
