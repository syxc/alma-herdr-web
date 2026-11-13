import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { homedir, networkInterfaces } from "node:os"
import { extname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import QRCode from "qrcode"
import { type WebSocket, WebSocketServer } from "ws"

import { createAuth, SESSION_COOKIE } from "./auth.js"
import { AutoClient } from "./auto.js"
import { coreSocketPaths, loginEndpoints, tuiSocketPaths } from "./backend-discovery.js"
import { loadConfig } from "./config.js"
import { CoreClient } from "./core.js"
import { tabDirectory } from "./directory.js"
import { HerdrClient, type HerdrSubscription } from "./herdr.js"
import { deriveToken, hexToBytes, newConnectCode } from "./identity.js"
import { RelayAgent } from "./relay.js"
import { SessionState } from "./state.js"

const here = fileURLToPath(new URL(".", import.meta.url))
const projectRoot = resolve(here, "..", "..")
const webRoot = join(projectRoot, "web")
const stateDir = join(homedir(), ".config", "alma-herdr-web")
const identityPath = join(stateDir, "relay.json")

/**
 * Identity used for remote access through an Alma relay.
 *
 * The connect code is the secret; the routing token is what the relay and
 * the pairing link carry.
 */
interface RelayIdentity {
  code: string
  token: string
  relayUrl: string
  relayKey: string
}

async function loadIdentity(): Promise<RelayIdentity> {
  try {
    const raw = await readFile(identityPath, "utf8")
    const parsed = JSON.parse(raw) as Partial<RelayIdentity>
    if (typeof parsed.code === "string" && parsed.code.length > 0) {
      return {
        code: parsed.code,
        token: typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : deriveToken(parsed.code),
        relayUrl: typeof parsed.relayUrl === "string" ? parsed.relayUrl : "",
        relayKey: typeof parsed.relayKey === "string" ? parsed.relayKey : "",
      }
    }
  } catch {
    // fall through and mint a fresh identity
  }
  const code = newConnectCode()
  const identity: RelayIdentity = { code, token: deriveToken(code), relayUrl: "", relayKey: "" }
  await saveIdentity(identity)
  return identity
}

async function saveIdentity(identity: RelayIdentity): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  await writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8")
}

/** URL a phone opens to reach this desktop through the relay. */
function pairingUrl(identity: RelayIdentity): string {
  if (identity.relayUrl.length === 0) {
    return ""
  }
  return `${identity.relayUrl.replace(/\/$/, "")}/c/${identity.token}/`
}

/**
 * The pairing payload a phone needs: where the relay is, the routing token
 * and the connect code that keys the encrypted channel.
 *
 * It travels in the URL fragment, which browsers never send to a server, so
 * the relay never sees the code.
 */
function pairingPayload(identity: RelayIdentity): string {
  const payload = JSON.stringify({
    relay: identity.relayUrl,
    token: identity.token,
    code: identity.code,
  })
  return Buffer.from(payload, "utf8").toString("base64url")
}

/** Pairing link that opens the client straight from the relay. */
function remoteLink(identity: RelayIdentity): string {
  const base = pairingUrl(identity)
  if (base.length === 0) {
    return ""
  }
  return `${base}#pair=${pairingPayload(identity)}`
}

/** Pairing link that opens the client on the local network first. */
function lanLink(identity: RelayIdentity, port: number): string {
  const address = lanAddress()
  if (address === "") {
    return ""
  }
  return `http://${address}:${port}/#pair=${pairingPayload(identity)}`
}

/** First non internal IPv4 address of this machine. */
function lanAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address
      }
    }
  }
  return ""
}

/**
 * What the user pasted into the relay field.
 *
 * Three shapes are accepted:
 *   https://relay.example.com                     a plain relay address
 *   https://relay.alma.now#k=<token>&e2e=1        an Alma pairing link
 *   https://relay.example.com/c/<token>/#pair=…  a pairing link of this app
 */
interface RelayInput {
  relayUrl: string
  token?: string
  code?: string
  e2e: boolean
  error?: string
}

function parseRelayInput(raw: string): RelayInput {
  let text = raw.trim()
  if (text.length === 0) {
    return { relayUrl: "", e2e: true, error: "a relay address is required" }
  }
  if (text.includes("pair=")) {
    const payload = decodePairingPayload(text)
    if (payload === null) {
      return { relayUrl: "", e2e: true, error: "that pairing link carries no pairing data" }
    }
    return { relayUrl: payload.relay, token: payload.token, code: payload.code, e2e: true }
  }
  if (text.includes("%3A") || text.includes("%2F")) {
    try {
      text = decodeURIComponent(text)
    } catch {
      // keep the original text
    }
  }
  const hash = text.indexOf("#")
  const base = hash >= 0 ? text.slice(0, hash) : text
  const fragment = hash >= 0 ? text.slice(hash + 1) : ""
  let token: string | undefined
  let e2e = true
  for (const part of fragment.split("&")) {
    const [key, value] = part.split("=")
    if (key === "k" && value !== undefined) {
      token = value
    }
    if (key === "e2e") {
      e2e = value !== "0"
    }
  }
  try {
    const parsed = new URL(base)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { relayUrl: "", e2e, error: "the relay address must be http or https" }
    }
    return { relayUrl: parsed.origin + parsed.pathname.replace(/\/$/, ""), token, e2e }
  } catch {
    return { relayUrl: "", e2e, error: "that relay address cannot be parsed" }
  }
}

function decodePairingPayload(source: string): { relay: string; token: string; code: string } | null {
  const match = /[#&]pair=([^&\s]+)/.exec(source)
  if (match === null || match[1] === undefined) {
    return null
  }
  try {
    const parsed = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as {
      relay?: string
      token?: string
      code?: string
    }
    if (typeof parsed.relay !== "string" || typeof parsed.token !== "string" || typeof parsed.code !== "string") {
      return null
    }
    return { relay: parsed.relay, token: parsed.token, code: parsed.code }
  } catch {
    return null
  }
}

/** The pairing secret is only handed out to the machine that owns it. */
function isLoopback(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress ?? ""
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1"
}

/**
 * Event types that describe the whole session. Pane scoped events are
 * subscribed per pane because herdr requires a pane id for them.
 */
const GLOBAL_SUBSCRIPTIONS = [
  "layout.updated",
  "pane.agent_detected",
  "pane.closed",
  "pane.created",
  "pane.exited",
  "pane.focused",
  "pane.moved",
  "pane.updated",
  "tab.closed",
  "tab.created",
  "tab.focused",
  "tab.moved",
  "tab.renamed",
  "workspace.closed",
  "workspace.created",
  "workspace.focused",
  "workspace.metadata_updated",
  "workspace.moved",
  "workspace.renamed",
  "workspace.reordered",
  "workspace.updated",
]

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
}

interface Json {
  ok: boolean
  error?: string
  code?: string
  /** The session the client should keep, set when a sign in succeeds. */
  session?: string
  /** Whether the server asks for a passphrase. */
  required?: boolean
  [key: string]: unknown
}

/**
 * Keeps a browser facing view of the herdr session.
 */
class HerdrWebAgent {
  readonly client: HerdrClient | CoreClient | AutoClient
  readonly state = new SessionState()
  readonly sockets = new Set<WebSocket>()
  connected = false

  private paneSubscriptions: string[] = []

  constructor(client: HerdrClient | CoreClient | AutoClient) {
    this.client = client
    this.client.onEvent((type, data) => {
      void this.onHerdrEvent(type, data)
    })
  }

  start(): void {
    this.client.subscribe(this.subscriptions())
    void this.refreshSnapshot()
  }

  private subscriptions(): HerdrSubscription[] {
    const entries: HerdrSubscription[] = GLOBAL_SUBSCRIPTIONS.map((type) => ({ type }))
    for (const paneId of this.paneSubscriptions) {
      entries.push({ type: "pane.agent_status_changed", pane_id: paneId })
      entries.push({ type: "pane.scroll_changed", pane_id: paneId })
    }
    return entries
  }

  /**
   * Keeps the pane scoped subscriptions in step with the known panes.
   */
  private syncSubscriptions(): void {
    const ids = this.state
      .snapshot()
      .panes.map((pane) => pane.pane_id)
      .sort()
    if (ids.join(",") === this.paneSubscriptions.join(",")) {
      return
    }
    this.paneSubscriptions = ids
    this.client.subscribe(this.subscriptions())
  }

  async refreshSnapshot(): Promise<void> {
    try {
      const result = await this.client.request("session.snapshot")
      this.state.applySnapshot(result)
      this.connected = true
      this.syncSubscriptions()
    } catch {
      this.connected = false
      console.error("[alma-herdr-web] snapshot failed")
    }
    this.broadcastState()
  }

  private async onHerdrEvent(type: string, data: Record<string, unknown>): Promise<void> {
    if (type === "__connected") {
      await this.refreshSnapshot()
      return
    }
    if (type === "__disconnected") {
      this.connected = false
      this.broadcastState()
      return
    }
    if (type === "pane_output_changed") {
      this.broadcast({
        type: "pane_output",
        pane_id: String(data.pane_id ?? ""),
        revision: Number(data.revision ?? 0),
      })
      return
    }
    this.state.applyEvent(type, data)
    this.syncSubscriptions()
    this.broadcastState()
  }

  private broadcastState(): void {
    this.broadcast({ type: "state", state: this.state.snapshot(), connected: this.connected })
  }

  private broadcast(message: Record<string, unknown>): void {
    const payload = JSON.stringify(message)
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload)
      }
    }
  }

  status(): Json {
    return {
      ok: true,
      connected: this.connected,
      state: this.state.snapshot(),
    }
  }

  async call(method: string, params: Record<string, unknown>): Promise<Json> {
    try {
      const result = await this.client.request(method, params)
      return { ok: true, result }
    } catch (error) {
      const err = error as Error & { code?: string }
      return { ok: false, error: err.message, code: err.code ?? "request_failed" }
    }
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = ""
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8")
      if (body.length > 8 * 1024 * 1024) {
        rejectPromise(new Error("request body too large"))
        request.destroy()
      }
    })
    request.on("end", () => resolvePromise(body))
    request.on("error", rejectPromise)
  })
}

function parseJsonBody(text: string): Record<string, unknown> {
  if (text.trim().length === 0) {
    return {}
  }
  const parsed = JSON.parse(text) as unknown
  if (parsed !== null && typeof parsed === "object") {
    return parsed as Record<string, unknown>
  }
  return {}
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<boolean> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
  const target = resolve(webRoot, normalize(relative))
  if (!target.startsWith(webRoot)) {
    return false
  }
  try {
    const data = await readFile(target)
    response.writeHead(200, {
      "content-type": MIME[extname(target)] ?? "application/octet-stream",
      // The client is rebuilt often during development, and a stale script
      // would keep running the old code on a phone.
      "cache-control": "no-cache",
    })
    response.end(data)
    return true
  } catch {
    return false
  }
}

function relayStatus(identity: RelayIdentity, relay: RelayAgent, port: number): Json {
  const status = relay.current()
  return {
    ok: true,
    connected: status.connected,
    relayUrl: identity.relayUrl,
    token: identity.token,
    proto: status.proto,
    error: status.error ?? undefined,
    pairingUrl: pairingUrl(identity),
    remoteLink: remoteLink(identity),
    lanLink: lanLink(identity, port),
    lanAddress: lanAddress(),
    hasRelayKey: identity.relayKey.length > 0,
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  const auth = createAuth(config.password)
  const environments = [process.env]
  const client =
    config.backend === "auto"
      ? new AutoClient({
          tuiSockets: () => tuiSocketPaths(environments),
          coreSockets: () => coreSocketPaths(environments),
        })
      : config.backend === "core"
        ? new CoreClient()
        : new HerdrClient(config.socketPath)
  const agent = new HerdrWebAgent(client)
  if (config.backend === "auto") {
    void loginEndpoints().then((env) => {
      if (Object.keys(env).length === 0) return
      environments.push(env)
      void agent.refreshSnapshot()
    })
  }
  const identity = await loadIdentity()
  const relay = new RelayAgent({ host: config.host, port: config.port }, hexToBytes(identity.code))

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: Error) => {
      response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ ok: false, error: error.message }))
    })
  })

  server.on("error", () => {
    console.error("[alma-herdr-web] server failed")
    process.exit(1)
  })
  const wss = new WebSocketServer({ server, path: "/api/events" })

  wss.on("connection", (socket, request) => {
    if (!auth.verify(request.headers)) {
      socket.close(4401, "sign in first")
      return
    }
    agent.sockets.add(socket)
    socket.send(
      JSON.stringify({
        type: "state",
        state: agent.state.snapshot(),
        connected: agent.connected,
      }),
    )
    socket.on("close", () => {
      agent.sockets.delete(socket)
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost")
    const path = url.pathname

    if (path === "/api/events") {
      return
    }

    if (path === "/api/relay/pairing.svg") {
      if (!isLoopback(request)) {
        response.writeHead(403, { "content-type": "text/plain" })
        response.end("pairing details are only available on the host machine")
        return
      }
      const wantLan = url.searchParams.get("target") === "lan"
      const url2 = wantLan ? lanLink(identity, config.port) : remoteLink(identity)
      if (url2.length === 0) {
        response.writeHead(400, { "content-type": "text/plain" })
        response.end("no relay configured")
        return
      }
      const svg = await QRCode.toString(url2, { type: "svg", margin: 1, width: 260 })
      response.writeHead(200, { "content-type": "image/svg+xml" })
      response.end(svg)
      return
    }

    if (path.startsWith("/api/")) {
      response.setHeader("content-type", "application/json; charset=utf-8")
      if (path !== "/api/auth" && path !== "/api/login" && !auth.verify(request.headers)) {
        response.writeHead(401)
        response.end(JSON.stringify({ ok: false, error: "sign in first" }))
        return
      }
      if (path === "/api/auth") {
        response.setHeader("cache-control", "no-store")
        response.writeHead(200)
        response.end(JSON.stringify({ ok: true, required: auth.required, authenticated: auth.verify(request.headers) }))
        return
      }
      const body = request.method === "POST" ? parseJsonBody(await readBody(request)) : {}
      if (path === "/api/logout") {
        auth.signOut(request.headers)
        response.setHeader("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
      }
      const result = await route(path, url, body, isLoopback(request), auth)
      const session = result.session
      delete result.session
      if (session !== undefined) {
        // The session travels in a cookie that the page cannot read.
        response.setHeader(
          "set-cookie",
          `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
        )
      }
      response.writeHead(result.ok ? 200 : 400)
      response.end(JSON.stringify(result))
      return
    }

    if (await serveStatic(path, response)) {
      return
    }
    response.writeHead(404, { "content-type": "text/plain" })
    response.end("not found")
  }

  async function route(
    path: string,
    url: URL,
    body: Record<string, unknown>,
    loopback: boolean,
    auth: { required: boolean; signIn(password: string): { ok: boolean; token?: string; error?: string } },
  ): Promise<Json> {
    switch (path) {
      case "/api/login": {
        const result = auth.signIn(String(body.password ?? ""))
        if (!result.ok) {
          return { ok: false, error: result.error ?? "sign in failed" }
        }
        if (result.token === undefined) {
          return { ok: true, required: false }
        }
        return { ok: true, required: true, session: result.token }
      }
      case "/api/logout":
        return { ok: true }
      case "/api/state":
        return agent.status()
      case "/api/pane/read": {
        const params: Record<string, unknown> = {
          pane_id: url.searchParams.get("pane") ?? "",
          source: url.searchParams.get("source") ?? "visible",
          format: url.searchParams.get("format") ?? "ansi",
        }
        const lines = Number(url.searchParams.get("lines") ?? "0")
        if (lines > 0) {
          params.lines = lines
        }
        return agent.call("pane.read", params)
      }
      case "/api/pane/text":
        return agent.call("pane.send_text", {
          pane_id: String(body.pane_id ?? ""),
          text: String(body.text ?? ""),
        })
      case "/api/pane/keys":
        return agent.call("pane.send_keys", {
          pane_id: String(body.pane_id ?? ""),
          keys: Array.isArray(body.keys) ? (body.keys as string[]) : [],
        })
      case "/api/agent/start":
        return agent.call("agent.start", {
          name: String(body.name ?? ""),
          kind: String(body.kind ?? ""),
          pane_id: String(body.pane_id ?? ""),
          args: Array.isArray(body.args) ? (body.args as string[]) : [],
        })
      case "/api/agent/prompt":
        return agent.call("agent.prompt", {
          target: String(body.target ?? ""),
          text: String(body.text ?? ""),
        })
      case "/api/workspace/create":
        return agent.call("workspace.create", {
          ...(body.backend === "hc" ? { backend: "hc" } : {}),
          cwd: body.cwd === undefined ? null : String(body.cwd),
          label: body.label === undefined ? null : String(body.label),
          focus: body.focus !== false,
        })
      case "/api/tab/create": {
        let cwd: string
        try {
          // Core resolves directories on the selected machine, including remote homes.
          const core =
            config.backend === "core" ||
            (config.backend === "auto" && String(body.workspace_id ?? "").startsWith("hc:"))
          cwd = core ? String(body.cwd ?? "~") : await tabDirectory(body.cwd)
        } catch (error) {
          return { ok: false, error: (error as Error).message, code: "invalid_cwd" }
        }
        return agent.call("tab.create", {
          workspace_id: body.workspace_id === undefined ? null : String(body.workspace_id),
          cwd,
          label: body.label === undefined ? null : String(body.label),
          focus: body.focus !== false,
        })
      }
      case "/api/workspace/move":
        return agent.call("workspace.move", {
          workspace_id: String(body.workspace_id ?? ""),
          insert_index: Number(body.insert_index ?? 0),
        })
      case "/api/tab/move":
        return agent.call("tab.move", {
          tab_id: String(body.tab_id ?? ""),
          insert_index: Number(body.insert_index ?? 0),
        })
      case "/api/workspace/focus":
        return agent.call("workspace.focus", { workspace_id: String(body.workspace_id ?? "") })
      case "/api/tab/focus":
        return agent.call("tab.focus", { tab_id: String(body.tab_id ?? "") })
      case "/api/pane/focus":
        return agent.call("pane.focus", { pane_id: String(body.pane_id ?? "") })
      case "/api/relay/status":
        return relayStatus(identity, relay, config.port)
      case "/api/relay/connect": {
        const input = parseRelayInput(String(body.relayUrl ?? ""))
        if (input.error !== undefined) {
          return { ok: false, error: input.error }
        }
        if (input.token !== undefined && input.token !== identity.token) {
          return {
            ok: false,
            error: "that pairing link belongs to another desktop; this one keeps its own connect code",
          }
        }
        if (input.code !== undefined && input.code !== identity.code) {
          identity.code = input.code
          identity.token = deriveToken(input.code)
        }
        identity.relayUrl = input.relayUrl
        if (typeof body.relayKey === "string") {
          identity.relayKey = body.relayKey.trim()
        }
        await saveIdentity(identity)
        relay.connect(identity.relayUrl, identity.token, identity.relayKey)
        return relayStatus(identity, relay, config.port)
      }
      case "/api/relay/disconnect":
        relay.disconnect()
        return relayStatus(identity, relay, config.port)
      case "/api/relay/rotate": {
        const code = newConnectCode()
        identity.code = code
        identity.token = deriveToken(code)
        await saveIdentity(identity)
        relay.disconnect()
        if (identity.relayUrl.length > 0) {
          relay.connect(identity.relayUrl, identity.token)
        }
        return relayStatus(identity, relay, config.port)
      }
      case "/api/relay/pairing": {
        if (!loopback) {
          return { ok: false, error: "pairing details are only available on the host machine" }
        }
        return {
          ok: true,
          relay: identity.relayUrl,
          token: identity.token,
          code: identity.code,
          remoteLink: remoteLink(identity),
          lanLink: lanLink(identity, config.port),
        }
      }
      default:
        return { ok: false, error: `unknown endpoint: ${path}` }
    }
  }

  agent.start()
  setInterval(() => {
    void agent.refreshSnapshot()
  }, 20000)

  const relayUrl = process.env.HERDR_WEB_RELAY_URL ?? identity.relayUrl
  if (relayUrl.length > 0) {
    identity.relayUrl = relayUrl.replace(/\/$/, "")
    await saveIdentity(identity)
    relay.connect(identity.relayUrl, identity.token, identity.relayKey)
  }

  server.listen(config.port, config.host, () => {
    console.log(`[alma-herdr-web] listening on port ${config.port}`)
  })
}

void main().catch(() => {
  console.error("[alma-herdr-web] startup failed")
  process.exit(1)
})
