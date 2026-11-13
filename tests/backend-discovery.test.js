import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { coreSocketPaths, parseLoginEndpoints, tuiSocketPaths } from "../agent/dist/backend-discovery.js"

async function fixture(t) {
  const cache = resolve(".cache")
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, "backend-discovery-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test("TUI discovery follows Alma named-session, explicit socket, and default candidates", () => {
  assert.deepEqual(
    tuiSocketPaths(
      [
        { XDG_CONFIG_HOME: "/config", HERDR_SESSION: "work", HERDR_SOCKET_PATH: "/explicit" },
        { XDG_CONFIG_HOME: "/login", HERDR_SOCKET: "/login/socket" },
      ],
      "/fixture-home",
      "darwin",
    ),
    ["/config/herdr/sessions/work/herdr.sock", "/explicit", "/login/socket", "/fixture-home/.config/herdr/herdr.sock"],
  )
  assert.deepEqual(
    tuiSocketPaths([{ XDG_CONFIG_HOME: "/config", HERDR_SESSION: "default" }], "/fixture-home", "darwin"),
    ["/config/herdr/herdr.sock", "/fixture-home/.config/herdr/herdr.sock"],
  )
})

test("core discovery includes configured, named, runtime and state sockets while excluding holders", async (t) => {
  const home = await fixture(t)
  const config = join(home, "config")
  const runtime = join(home, "runtime")
  const state = join(home, "state")
  await mkdir(join(config, "herdr-core"), { recursive: true })
  await writeFile(join(config, "herdr-core", "config.toml"), 'socket = "~/configured.sock"\n')
  await mkdir(join(runtime, "herdr-core", "extra"), { recursive: true })
  await writeFile(join(runtime, "herdr-core", "extra", "extra.sock"), "")
  await writeFile(join(runtime, "herdr-core", "legacy.sock"), "")
  await writeFile(join(runtime, "herdr-core", "default.holder.42.sock"), "")
  const paths = coreSocketPaths(
    [
      {
        XDG_CONFIG_HOME: config,
        XDG_RUNTIME_DIR: runtime,
        XDG_STATE_HOME: state,
        HC_SESSION: "work",
        HC_SOCKET: "/explicit-core",
      },
    ],
    home,
    "darwin",
  )
  assert.deepEqual(paths.slice(0, 6), [
    "/explicit-core",
    join(home, "configured.sock"),
    join(runtime, "herdr-core", "work", "work.sock"),
    join(runtime, "herdr-core", "work.sock"),
    join(state, "herdr-core", "work", "work.sock"),
    join(state, "herdr-core", "work.sock"),
  ])
  assert.ok(paths.includes(join(runtime, "herdr-core", "extra", "extra.sock")))
  assert.ok(paths.includes(join(runtime, "herdr-core", "legacy.sock")))
  assert.equal(
    paths.some((path) => path.includes(".holder.")),
    false,
  )
  assert.equal(new Set(paths).size, paths.length)
})

test("login environment parsing retains only validated endpoint values", () => {
  const result = parseLoginEndpoints(
    [
      "shell banner",
      "__HERDR_WEB_ENDPOINTS__",
      "HC_SESSION=work",
      "HERDR_SOCKET=/socket/alias",
      "HC_SOCKET=/socket/core",
      "XDG_STATE_HOME=/state",
      "OTHER_FIELD=outside",
      "XDG_CONFIG_HOME=relative",
      "HERDR_SESSION=../invalid",
    ].join("\n"),
  )
  assert.deepEqual(result, {
    HC_SESSION: "work",
    HERDR_SOCKET: "/socket/alias",
    HC_SOCKET: "/socket/core",
    XDG_STATE_HOME: "/state",
  })
  assert.deepEqual(parseLoginEndpoints("unmarked output\nHC_SOCKET=/wrong"), {})
})
