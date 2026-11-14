import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const assets = join(root, "dist", "worker")

async function files(directory, prefix = "") {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name
    if (entry.isDirectory()) result.push(...(await files(join(directory, entry.name), `${path}/`)))
    else result.push(path)
  }
  return result
}

test("the Workers upload contains only runnable client assets and licenses", async () => {
  const paths = await files(assets)
  for (const required of [
    "index.html",
    "style.css",
    "dist/main.js",
    "dist/alma.js",
    "dist/tunnel.js",
    "vendor/jsQR.js",
    "vendor/jsQR/LICENSE",
    "vendor/ghostty/ghostty-vt.wasm",
    "vendor/ghostty/LICENSE",
    "vendor/noble/curves/LICENSE",
    "vendor/noble/hashes/LICENSE",
    "vendor/noble/ciphers/LICENSE",
    "vendor/nerd-fonts/symbols.css",
    "vendor/nerd-fonts/LICENSE",
    "vendor/nerd-fonts/terminal-symbols/playback.woff2",
    "vendor/nerd-fonts/terminal-symbols/symbols.css",
    "vendor/nerd-fonts/terminal-symbols/LICENSE",
  ])
    assert.ok(paths.includes(required), `${required} must ship`)
  for (const path of paths) {
    assert.match(path, /^(index\.html|style\.css|(?:dist|vendor)\/.+(?:\.js|\.wasm|\.woff2|\.css|\/LICENSE))$/)
    if (path.endsWith(".js")) assert.doesNotMatch(await readFile(join(assets, path), "utf8"), /sourceMappingURL=/)
  }
  assert.ok(!paths.includes("vendor/nerd-fonts/symbols-nerd-font-mono.woff2"))
  const { iconFontChunks } = await import("../web/dist/icon-font-ranges.js")
  assert.equal(iconFontChunks.length, 50)
  for (const { file } of iconFontChunks) {
    const path = `vendor/nerd-fonts/${file}`
    const font = await readFile(join(assets, path))
    assert.equal(font.subarray(0, 4).toString(), "wOF2")
    assert.deepEqual(font, await readFile(join(root, "web", path)))
  }
  const css = await readFile(join(assets, "vendor/nerd-fonts/symbols.css"), "utf8")
  assert.deepEqual(css, await readFile(join(root, "web/vendor/nerd-fonts/symbols.css"), "utf8"))
  assert.match(await readFile(join(assets, "index.html"), "utf8"), /href="vendor\/nerd-fonts\/symbols\.css"/)
  assert.match(
    await readFile(join(assets, "index.html"), "utf8"),
    /href="vendor\/nerd-fonts\/terminal-symbols\/symbols\.css"/,
  )
  const playback = "vendor/nerd-fonts/terminal-symbols/playback.woff2"
  const playbackFont = await readFile(join(assets, playback))
  assert.equal(playbackFont.subarray(0, 4).toString(), "wOF2")
  assert.deepEqual(playbackFont, await readFile(join(root, "web", playback)))
  const wasm = await readFile(join(assets, "vendor/ghostty/ghostty-vt.wasm"))
  assert.deepEqual([...wasm.subarray(0, 4)], [0, 97, 115, 109])
})

test("Workers preserves missing API routes instead of serving the page shell", async () => {
  const config = JSON.parse(await readFile(join(root, "wrangler.jsonc"), "utf8"))
  assert.equal(config.assets.directory, "./dist/worker")
  assert.equal(config.assets.not_found_handling, "none")
  assert.equal(config.main, undefined)
  assert.equal(config.build.command, "npm run build:worker")
  assert.ok(config.build.watch_dir.includes("./web/src"))
})

test("the worker shell marks itself as a static host, the local shell does not", async () => {
  const workerShell = await readFile(join(assets, "index.html"), "utf8")
  const localShell = await readFile(join(root, "web", "index.html"), "utf8")
  assert.match(workerShell, /__ALMA_STATIC__=true/)
  assert.doesNotMatch(localShell, /__ALMA_STATIC__/)
})

test("a stamped static host skips the local probes and needs no event WebSocket", async (t) => {
  const originalFetch = globalThis.fetch
  const originalWebSocket = globalThis.WebSocket
  const originalMarker = globalThis.__ALMA_STATIC__
  const paths = []
  t.after(() => {
    globalThis.fetch = originalFetch
    globalThis.WebSocket = originalWebSocket
    if (originalMarker === undefined) delete globalThis.__ALMA_STATIC__
    else globalThis.__ALMA_STATIC__ = originalMarker
  })
  globalThis.__ALMA_STATIC__ = true
  globalThis.fetch = async (path) => {
    paths.push(path)
    return new Response(null, { status: 404 })
  }
  globalThis.WebSocket = class {
    constructor() {
      throw new Error("A static host has no local event socket")
    }
  }
  // A unique query gives this test its own module instance, so the cached
  // localApi result of another test cannot mask the fetch behaviour here.
  const { authStatus } = await import("../web/dist/auth.js?stamped=1")
  const api = await import("../web/dist/api.js?stamped=1")
  assert.deepEqual(await authStatus(), { required: false })
  assert.equal(await api.hasLocalApi(), false)
  assert.equal(api.hasEventStream(), false)
  assert.equal(api.needsStatePolling(), false)
  const stop = api.connectEvents(() => assert.fail("A static host must not push local state"))
  stop()
  assert.deepEqual(paths, [], "the hosted client must not request local API routes")
})

test("an unmarked static host still falls back to the 404 contract", async (t) => {
  const originalFetch = globalThis.fetch
  const originalMarker = globalThis.__ALMA_STATIC__
  const paths = []
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalMarker === undefined) delete globalThis.__ALMA_STATIC__
    else globalThis.__ALMA_STATIC__ = originalMarker
  })
  delete globalThis.__ALMA_STATIC__
  globalThis.fetch = async (path) => {
    paths.push(path)
    return new Response(null, { status: 404 })
  }
  const { authStatus } = await import("../web/dist/auth.js?unmarked=1")
  const api = await import("../web/dist/api.js?unmarked=1")
  assert.deepEqual(await authStatus(), { required: false })
  assert.equal(await api.hasLocalApi(), false)
  assert.deepEqual(paths, ["/api/auth", "/api/state"])
})
