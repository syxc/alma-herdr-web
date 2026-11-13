import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { WebSocketServer } from "ws"

import { E2EAgentSession } from "../agent/dist/e2e.js"

const root = fileURLToPath(new URL("../", import.meta.url))
const checker = readFileSync(join(root, "scripts/privacy-check.mjs"), "utf8")

function directory(t) {
  mkdirSync(join(root, "dist"), { recursive: true })
  const path = mkdtempSync(join(root, "dist/privacy-test-"))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function repository(t) {
  const path = directory(t)
  const git = (...args) => execFileSync("git", args, { cwd: path, stdio: ["pipe", "pipe", "pipe"] })
  git("init", "--quiet")
  git("config", "user.name", "Privacy Test")
  git("config", "user.email", "privacy@example.invalid")
  git("config", "commit.gpgSign", "false")
  const write = (file, text) => {
    mkdirSync(dirname(join(path, file)), { recursive: true })
    writeFileSync(join(path, file), text)
  }
  write("scripts/privacy-check.mjs", checker)
  git("add", "scripts/privacy-check.mjs")
  const scan = (...args) => {
    const result = spawnSync(process.execPath, ["scripts/privacy-check.mjs", ...args], {
      cwd: path,
      encoding: "utf8",
    })
    return { ...result, output: result.stdout + result.stderr }
  }
  return { path, git, write, scan }
}

function code() {
  return randomBytes(32).toString("base64url")
}

function noValues(output, values) {
  for (const value of values) assert.ok(!output.includes(value), "logs must not repeat private values")
}

test("index checks read staged blobs after working files are changed or removed", (t) => {
  const repo = repository(t)
  const value = code()
  repo.write("notes.txt", value)
  repo.git("add", "notes.txt")
  repo.write("notes.txt", "safe text")
  assert.equal(repo.scan().status, 0)
  const result = repo.scan("--staged")
  assert.equal(result.status, 1)
  noValues(result.output, [value])
  unlinkSync(join(repo.path, "notes.txt"))
  assert.equal(repo.scan("--staged").status, 1)
  repo.write("notes.txt", "safe text")
  repo.git("add", "notes.txt")
  repo.write("notes.txt", value)
  assert.equal(repo.scan("--staged").status, 0)
  assert.equal(repo.scan().status, 1)
  repo.write("notes.txt", "safe text")
  repo.git("commit", "-m", "test: record safe fixture")
  repo.write("untracked.txt", value)
  assert.equal(repo.scan("--staged").status, 0)
  assert.equal(repo.scan().status, 1)
  repo.git("rm", "notes.txt")
  assert.equal(repo.scan("--staged").status, 0)
})

test("index checks preserve whitespace and newlines in filenames", (t) => {
  const repo = repository(t)
  const file = "odd folder/new\nname.txt"
  repo.write(file, code())
  repo.git("add", file)
  repo.write(file, "safe text")
  const result = repo.scan("--staged")
  assert.equal(result.status, 1)
  assert.ok(result.output.includes(`${JSON.stringify(file)}:1`))
})

test("the installed hook rejects an unsafe index and accepts a safe partially staged file", (t) => {
  const repo = repository(t)
  assert.equal(repo.scan("--install").status, 0)
  assert.match(readFileSync(join(repo.path, ".git/hooks/pre-commit"), "utf8"), /--staged/)
  const value = code()
  repo.write("notes.txt", value)
  repo.git("add", "notes.txt")
  repo.write("notes.txt", "safe text")
  const commit = () =>
    spawnSync("git", ["commit", "-m", "test: check privacy hook"], {
      cwd: repo.path,
      encoding: "utf8",
    })
  const rejected = commit()
  assert.notEqual(rejected.status, 0)
  noValues(rejected.stdout + rejected.stderr, [value])
  repo.git("add", "notes.txt")
  repo.write("notes.txt", value)
  assert.equal(commit().status, 0)
  assert.equal(repo.git("show", "HEAD:notes.txt").toString(), "safe text")
})

test("connection-code detection covers all padding bits and does not require mixed letter case", (t) => {
  const repo = repository(t)
  const values = []
  const endings = new Set()
  for (let last = 0; last < 256; last += 1) {
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 31 + 73) % 256))
    bytes[31] = last
    const value = bytes.toString("base64url")
    values.push(value)
    endings.add(value.at(-1))
  }
  assert.equal(endings.size, 16)
  values.push(Buffer.alloc(32).toString("base64url"), Buffer.alloc(32, 255).toString("base64url"))
  repo.write("notes.txt", values.join("\n"))
  repo.git("add", "notes.txt")
  const result = repo.scan("--staged")
  assert.equal(result.status, 1)
  for (let i = 0; i < values.length; i += 1) {
    assert.ok(result.output.includes(`"notes.txt":${i + 1}  `), "every valid code must be detected")
  }
  noValues(result.output, values)
  repo.write("notes.txt", `${values[0].slice(0, -1)}B`)
  repo.git("add", "notes.txt")
  assert.equal(repo.scan("--staged").status, 0)
})

test("fixture words embedded in a credential do not exempt it, including inside lockfiles", (t) => {
  const repo = repository(t)
  const values = ["mock", "test", "token", "secret"].map((word) => `Q7_${word}_Z9mP2vR5bK8nL3hX`)
  repo.write("package-lock.json", JSON.stringify({ password: values[0] }))
  repo.write(
    "notes.txt",
    values
      .slice(1)
      .map((value) => JSON.stringify({ token: value }))
      .join("\n"),
  )
  repo.git("add", "notes.txt", "package-lock.json")
  const result = repo.scan("--staged")
  assert.equal(result.status, 1)
  assert.ok(result.output.includes('"package-lock.json":1'))
  for (let line = 1; line <= 3; line += 1) assert.ok(result.output.includes(`"notes.txt":${line}`))
  noValues(result.output, values)
  repo.write("package-lock.json", "{}")
  repo.write("notes.txt", JSON.stringify({ token: "mock-reload-code-with-more-words" }))
  repo.git("add", "notes.txt", "package-lock.json")
  assert.equal(repo.scan("--staged").status, 0)
})

test("paths, network addresses, links, hex codes and encoded pairing data are reported without their values", (t) => {
  const repo = repository(t)
  const value = code()
  const hex = randomBytes(32).toString("hex")
  const payload = Buffer.from(JSON.stringify({ relay: "https://relay.example.com", code: value })).toString("base64url")
  const privatePath = ["", "Users", "fixture-person", "private.sock"].join("/")
  const windowsPath = ["C:", "People", "fixture-person", "private.sock"].join("\\")
  const address = [192, 168, 23, 17].join(".")
  const lines = [
    privatePath,
    windowsPath,
    address,
    `alma://connect?u=https://relay.example.com&k=${value}`,
    `const code = ${JSON.stringify(hex)}`,
    `#pair=${payload}`,
    payload,
  ]
  repo.write("notes.txt", lines.join("\n"))
  repo.git("add", "notes.txt")
  const result = repo.scan("--staged")
  assert.equal(result.status, 1)
  for (let line = 1; line <= lines.length; line += 1) assert.ok(result.output.includes(`"notes.txt":${line}`))
  noValues(result.output, [value, hex, payload, privatePath, windowsPath, address])
})

test("Git errors fail closed without printing paths or raw index data", (t) => {
  const repo = repository(t)
  const privateData = code()
  const index = join(repo.path, "invalid-index")
  writeFileSync(index, privateData)
  const result = spawnSync(process.execPath, ["scripts/privacy-check.mjs", "--staged"], {
    cwd: repo.path,
    encoding: "utf8",
    env: { ...process.env, GIT_INDEX_FILE: index },
  })
  assert.equal(result.status, 1)
  noValues(result.stdout + result.stderr, [privateData, index, repo.path])
  assert.match(result.stderr, /could not read repository data/)
})

// Override only the child's home lookup; tests never read or write the real pairing identity.
const bootstrap = [
  "import os from 'node:os';",
  "import { syncBuiltinESMExports } from 'node:module';",
  "const home = process.argv[1];",
  "const entry = process.argv[2];",
  "os.homedir = () => home;",
  "syncBuiltinESMExports();",
  "process.argv = [process.argv[0], entry];",
  "await import(entry);",
].join("\n")

function runScript(home, entry, env = {}) {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", bootstrap, home, pathToFileURL(join(root, entry)).href],
    {
      cwd: root,
      env: { ...process.env, HERDR_WEB_BACKEND: "tui", ...env },
      timeout: 10000,
    },
  )
  const output = { stdout: "", stderr: "" }
  child.stdout.on("data", (data) => {
    output.stdout += data
  })
  child.stderr.on("data", (data) => {
    output.stderr += data
  })
  const done = once(child, "close").then(([status]) => ({ ...output, status }))
  return { child, output, done }
}

test("agent startup and snapshot errors do not log the socket or home path", async (t) => {
  const home = directory(t)
  const socket = join(home, "private-socket")
  const { child, output, done } = runScript(home, "agent/dist/index.js", {
    HERDR_SOCKET_PATH: socket,
    HERDR_WEB_HOST: "127.0.0.1",
    HERDR_WEB_PORT: "0",
    HERDR_WEB_RELAY_URL: "",
  })
  t.after(() => child.kill())
  const deadline = Date.now() + 5000
  while (
    (!output.stdout.includes("listening on port") || !output.stderr.includes("snapshot failed")) &&
    Date.now() < deadline &&
    child.exitCode === null
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  child.kill()
  const result = await done
  assert.ok(result.stdout.includes("listening on port"))
  assert.ok(result.stderr.includes("snapshot failed"))
  noValues(result.stdout + result.stderr, [home, socket])
})

test("agent startup failures do not print private filesystem errors", async (t) => {
  const path = join(directory(t), "not-a-directory")
  writeFileSync(path, "fixture")
  const { done } = runScript(path, "agent/dist/index.js")
  const result = await done
  assert.equal(result.status, 1)
  assert.match(result.stderr, /startup failed/)
  noValues(result.stdout + result.stderr, [path, root])
})

test("listener failures do not print a raw stack or machine paths", async (t) => {
  const home = directory(t)
  const server = createServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const result = await runScript(home, "agent/dist/index.js", {
    HERDR_SOCKET_PATH: join(home, "private-socket"),
    HERDR_WEB_HOST: "127.0.0.1",
    HERDR_WEB_PORT: String(server.address().port),
    HERDR_WEB_RELAY_URL: "",
  }).done
  assert.equal(result.status, 1)
  assert.match(result.stderr, /server failed/)
  noValues(result.stdout + result.stderr, [home, root, "node:events"])
})

test("E2E check failures do not dump terminal output or pairing credentials", async (t) => {
  const home = directory(t)
  const psk = randomBytes(32)
  const privateText = `private-output-${randomBytes(16).toString("hex")}`
  const token = code()
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  t.after(() => {
    for (const socket of wss.clients) socket.terminate()
    return new Promise((resolve) => wss.close(resolve))
  })
  wss.on("connection", (socket) => {
    const session = new E2EAgentSession({
      psk,
      send: (frame) => socket.send(frame),
      onError: () => assert.fail("mock E2E handshake must succeed"),
      onAppFrame: (frame) => {
        const body =
          frame.path === "/api/state"
            ? { state: { panes: [{ pane_id: "mock-pane" }] } }
            : String(frame.path).startsWith("/api/pane/read")
              ? { result: { read: { text: privateText } } }
              : { ok: true }
        session.sendApp({
          t: "res",
          id: frame.id,
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify(body)).toString("base64"),
        })
      },
    })
    socket.on("message", (data) => session.receive(String(data)))
  })
  await once(wss, "listening")
  const identity = join(home, ".config/alma-herdr-web")
  mkdirSync(identity, { recursive: true })
  writeFileSync(
    join(identity, "relay.json"),
    JSON.stringify({
      code: psk.toString("hex"),
      token,
      relayUrl: `http://127.0.0.1:${wss.address().port}`,
    }),
  )
  const { done } = runScript(home, "scripts/e2e-check.mjs")
  const result = await done
  assert.equal(result.status, 1)
  assert.match(result.stderr, /did not echo the check marker/)
  noValues(result.stdout + result.stderr, [privateText, token, psk.toString("hex"), home])
})

test("unexpected E2E failures do not print raw exceptions or identity paths", async (t) => {
  const home = directory(t)
  const identity = join(home, ".config/alma-herdr-web")
  mkdirSync(identity, { recursive: true })
  const privateData = `private-identity-${randomBytes(16).toString("hex")}`
  writeFileSync(join(identity, "relay.json"), privateData)
  const result = await runScript(home, "scripts/e2e-check.mjs").done
  assert.equal(result.status, 1)
  assert.match(result.stderr, /E2E check failed/)
  noValues(result.stdout + result.stderr, [privateData, home, root])
})
