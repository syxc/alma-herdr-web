import assert from "node:assert/strict"
import { test } from "node:test"
import { loadConfig } from "../agent/dist/config.js"

test("backend defaults to automatic compatibility and preserves explicit socket resolution", () => {
  const config = loadConfig({ XDG_CONFIG_HOME: "/config", HERDR_SESSION: "fixture" })
  assert.equal(config.backend, "auto")
  assert.equal(config.socketPath, "/config/herdr/sessions/fixture/herdr.sock")
  assert.equal(loadConfig({ HERDR_SOCKET_PATH: "/explicit" }).socketPath, "/explicit")
})

test("explicit overrides remain available without reinterpreting HC endpoint variables as TUI paths", () => {
  const config = loadConfig({
    HERDR_WEB_BACKEND: "core",
    HC_SOCKET: "/core",
    HC_SESSION: "scratch",
    XDG_CONFIG_HOME: "/config",
  })
  assert.equal(config.backend, "core")
  assert.equal(config.socketPath, "/config/herdr/herdr.sock")
  assert.throws(() => loadConfig({ HERDR_WEB_BACKEND: "other" }), /must be auto, tui or core/)
})
