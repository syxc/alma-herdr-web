import { AlmaTunnel, type AlmaTunnelOptions } from "./alma.js"
import { almaSnapshot, records } from "./alma-snapshot.js"
import { AlmaState } from "./alma-state.js"
import { type RemoteConfig, RemoteTunnel } from "./tunnel.js"

export interface AgentSessionRef {
  agent: string
  kind: string
  source: string
  value: string
}

export interface WorkspaceRecord {
  workspace_id: string
  label: string
  number: number
  agent_status: string
  focused: boolean
  active_tab_id: string
  pane_count: number
  tab_count: number
}

export interface TabRecord {
  tab_id: string
  workspace_id: string
  label: string
  number: number
  agent_status: string
  focused: boolean
  pane_count: number
}

export interface PaneRecord {
  pane_id: string
  workspace_id: string
  tab_id: string
  agent: string | null
  display_agent: string | null
  agent_status: string
  agent_session: AgentSessionRef | null
  cwd: string | null
  foreground_cwd: string | null
  terminal_title: string | null
  terminal_title_stripped: string | null
  title: string | null
  label: string | null
  focused: boolean
  revision: number
  viewport_rows: number
}

export interface SessionSnapshot {
  workspaces: WorkspaceRecord[]
  tabs: TabRecord[]
  panes: PaneRecord[]
  focused_workspace_id: string | null
  focused_tab_id: string | null
  focused_pane_id: string | null
  version: string
  protocol: number
}

export interface AgentEvent {
  type: "state" | "pane_output"
  state?: SessionSnapshot
  connected?: boolean
  pane_id?: string
  revision?: number
}

export interface RelayStatus {
  connected: boolean
  relayUrl: string
  token: string
  proto: number | null
  error?: string
  pairingUrl: string
  remoteLink: string
  lanLink: string
  lanAddress: string
  hasRelayKey: boolean
}

export interface StateResponse {
  state: SessionSnapshot | null
  connected: boolean
}

interface ApiResult {
  ok: boolean
  error?: string
  code?: string
  result?: Record<string, unknown>
  state?: SessionSnapshot
  connected?: boolean
}

let unauthorized: (() => void) | null = null

export function setUnauthorizedHandler(handler: () => void): void {
  unauthorized = handler
}

type Backend =
  | { kind: "local" }
  | { kind: "herdr"; tunnel: RemoteTunnel }
  | { kind: "alma"; tunnel: AlmaTunnel; state: AlmaState }

let backend: Backend = { kind: "local" }

let localApi: boolean | null = null

export async function hasLocalApi(): Promise<boolean> {
  if (localApi !== null) {
    return localApi
  }
  try {
    const response = await fetch("/api/state", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    })
    localApi = response.status !== 404
  } catch {
    localApi = false
  }
  return localApi
}

export function needsStatePolling(): boolean {
  return backend.kind !== "local"
}

export async function openRemote(config: RemoteConfig): Promise<void> {
  const remote = new RemoteTunnel(config)
  await remote.connect()
  closeRemote()
  backend = { kind: "herdr", tunnel: remote }
}

export async function openAlmaRemote(config: AlmaTunnelOptions): Promise<void> {
  const remote = new AlmaTunnel(config)
  await remote.connect()
  closeRemote()
  backend = { kind: "alma", tunnel: remote, state: new AlmaState(remote) }
}

export function closeRemote(): void {
  disconnectEvents()
  if (backend.kind === "alma") backend.state.close()
  if (backend.kind !== "local") backend.tunnel.close()
  backend = { kind: "local" }
}

async function call(path: string, init?: RequestInit): Promise<ApiResult> {
  if (backend.kind === "herdr") {
    return tunnelCall(backend.tunnel, path, init)
  }
  if (backend.kind === "alma") {
    return { ok: false, error: "this session talks to an Alma desktop" }
  }
  const response = await fetch(path, { ...init, signal: init?.signal ?? AbortSignal.timeout(15000) })
  const text = await response.text()
  if (response.status === 401) {
    // The session is gone, so the reader has to sign in again.
    unauthorized?.()
  }
  try {
    return JSON.parse(text) as ApiResult
  } catch {
    return { ok: false, error: text.slice(0, 200) }
  }
}

async function tunnelCall(tunnel: RemoteTunnel, path: string, init?: RequestInit): Promise<ApiResult> {
  try {
    const body = typeof init?.body === "string" ? new TextEncoder().encode(init.body) : undefined
    const response = await tunnel.request(init?.method ?? "GET", path, body)
    const text = new TextDecoder().decode(response.body)
    try {
      return JSON.parse(text) as ApiResult
    } catch {
      return { ok: false, error: text.slice(0, 200) }
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

interface AlmaCall {
  ok: boolean
  result: Record<string, unknown>
  error?: string
  code?: string
}

async function almaCall(tunnel: AlmaTunnel, method: string, params: Record<string, unknown>): Promise<AlmaCall> {
  const body = new TextEncoder().encode(JSON.stringify({ method, params }))
  const response = await tunnel.request("POST", "/api/herdr/rpc", body, {
    "content-type": "application/json",
  })
  const text = new TextDecoder().decode(response.body)
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    // the answer was not json, the status still tells us what happened
  }
  if (response.status >= 400 || parsed.error) {
    const error = parsed.error as Record<string, unknown> | undefined
    return {
      ok: false,
      result: {},
      error: String(error?.message ?? "the Alma desktop refused the request"),
      code: typeof error?.code === "string" ? error.code : "",
    }
  }
  return { ok: true, result: (parsed.result ?? {}) as Record<string, unknown> }
}

export async function fetchState(): Promise<StateResponse> {
  if (backend.kind === "alma") {
    const tunnel = backend.tunnel
    const streamed = await backend.state.read()
    if (streamed !== null) return streamed
    const [workspaces, tabs, panes] = await Promise.all([
      almaCall(tunnel, "workspace.list", {}),
      almaCall(tunnel, "tab.list", {}),
      almaCall(tunnel, "pane.list", {}),
    ])
    if (!workspaces.ok || !tabs.ok || !panes.ok) {
      return { state: null, connected: false }
    }
    const state = almaSnapshot(
      records(workspaces.result.workspaces),
      records(tabs.result.tabs),
      records(panes.result.panes),
    )
    return { state, connected: true }
  }
  const result = await call("/api/state")
  if (!result.ok) {
    return { state: null, connected: false }
  }
  const state = result.state as SessionSnapshot | undefined
  return { state: state ?? null, connected: result.connected === true }
}

export async function readPane(
  paneId: string,
  source: string,
  format: string,
  lines: number,
): Promise<{ text: string; revision: number; truncated: boolean; vt?: boolean; cols?: number; rows?: number } | null> {
  if (backend.kind === "alma") {
    const params: Record<string, unknown> = { pane_id: paneId, source, format }
    if (lines > 0) {
      params.lines = lines
    }
    const call = await almaCall(backend.tunnel, "pane.read", params)
    if (!call.ok) {
      return null
    }
    const read = call.result.read as Record<string, unknown> | undefined
    if (read === undefined) {
      return null
    }
    return {
      text: String(read.text ?? ""),
      revision: Number(read.revision ?? 0),
      truncated: read.truncated === true,
      ...nativeSize(read),
    }
  }
  const url =
    "/api/pane/read?pane=" +
    encodeURIComponent(paneId) +
    "&source=" +
    encodeURIComponent(source) +
    "&format=" +
    encodeURIComponent(format) +
    "&lines=" +
    lines
  const result = await call(url)
  if (!result.ok || result.result === undefined) {
    return null
  }
  const raw = (result.result.read ?? result.result) as Record<string, unknown>
  return {
    text: String(raw.text ?? ""),
    revision: Number(raw.revision ?? 0),
    truncated: raw.truncated === true,
    ...nativeSize(raw),
  }
}

function nativeSize(read: Record<string, unknown>): { vt?: true; cols?: number; rows?: number } {
  if (read.vt !== true) return {}
  const cols = Number(read.cols)
  const rows = Number(read.rows)
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0 || cols > 65535 || rows > 65535) {
    throw new Error("the desktop sent invalid native terminal dimensions")
  }
  return { vt: true, cols, rows }
}

// Serialize writes: concurrent relay requests can reach the pane out of order.
let sendQueue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const target = backend
  const run = () => {
    if (backend !== target) throw new Error("the target desktop changed before the input was sent")
    return task()
  }
  const result = sendQueue.then(run, run)
  sendQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

async function command(method: string, path: string, params: Record<string, unknown>): Promise<ApiResult> {
  if (backend.kind === "alma") {
    return almaCall(backend.tunnel, method, params)
  }
  return call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  })
}

export function sendText(paneId: string, text: string): Promise<string | null> {
  return enqueue(async () => {
    const result = await command("pane.send_text", "/api/pane/text", { pane_id: paneId, text })
    return result.ok ? null : (result.error ?? "send failed")
  })
}

export function sendKeys(paneId: string, keys: string[]): Promise<string | null> {
  return enqueue(async () => {
    const result = await command("pane.send_keys", "/api/pane/keys", { pane_id: paneId, keys })
    return result.ok ? null : (result.error ?? "send failed")
  })
}

export interface ApiFailure {
  error: string
  code: string
}

export async function startAgent(
  paneId: string,
  name: string,
  kind: string,
  args: string[],
): Promise<ApiFailure | null> {
  const result = await command("agent.start", "/api/agent/start", { pane_id: paneId, name, kind, args })
  return result.ok ? null : { error: result.error ?? "start failed", code: result.code ?? "" }
}

export async function promptAgent(target: string, text: string): Promise<ApiFailure | null> {
  const result = await command("agent.prompt", "/api/agent/prompt", { target, text })
  return result.ok ? null : { error: result.error ?? "prompt failed", code: result.code ?? "" }
}

export interface CreatedTerminal {
  paneId: string | null
  error: string | null
}

export async function createTerminalTab(workspaceId: string, cwd: string | null): Promise<CreatedTerminal> {
  const result = await command("tab.create", "/api/tab/create", {
    workspace_id: workspaceId,
    cwd: cwd || "~",
    focus: false,
  })
  if (!result.ok) return { paneId: null, error: result.error ?? "create failed" }
  const paneId = createdPaneId(result.result)
  return { paneId, error: paneId === null ? "the desktop did not return the new pane" : null }
}

function createdPaneId(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (typeof record.pane_id === "string" && record.pane_id.length > 0) return record.pane_id
  for (const child of Object.values(record)) {
    const id = createdPaneId(child)
    if (id !== null) return id
  }
  return null
}

export async function focusPane(paneId: string): Promise<void> {
  if (backend.kind === "alma") {
    // The Alma desktop does not let a phone move the focus.
    return
  }
  await call("/api/pane/focus", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pane_id: paneId }),
  })
}

export async function fetchRelayStatus(): Promise<RelayStatus | null> {
  const result = await call("/api/relay/status")
  if (!result.ok) {
    return null
  }
  const body = result as unknown as Record<string, unknown>
  return {
    connected: body.connected === true,
    relayUrl: String(body.relayUrl ?? ""),
    token: String(body.token ?? ""),
    proto: typeof body.proto === "number" ? body.proto : null,
    error: typeof body.error === "string" ? body.error : undefined,
    pairingUrl: String(body.pairingUrl ?? ""),
    remoteLink: String(body.remoteLink ?? ""),
    lanLink: String(body.lanLink ?? ""),
    lanAddress: String(body.lanAddress ?? ""),
    hasRelayKey: body.hasRelayKey === true,
  }
}

export async function connectRelay(relayUrl: string, relayKey?: string): Promise<string | null> {
  const result = await call("/api/relay/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relayUrl, relayKey }),
  })
  return result.ok ? null : (result.error ?? "connect failed")
}

export async function disconnectRelay(): Promise<void> {
  await call("/api/relay/disconnect", { method: "POST" })
}

export async function rotateRelay(): Promise<void> {
  await call("/api/relay/rotate", { method: "POST" })
}

let stopEvents: (() => void) | null = null

export function disconnectEvents(): void {
  const stop = stopEvents
  stopEvents = null
  if (stop !== null) {
    stop()
  }
}

export function hasEventStream(): boolean {
  if (backend.kind === "alma") {
    return false
  }
  if (backend.kind === "herdr") {
    return true
  }
  return localApi !== false
}

export function connectEvents(onEvent: (event: AgentEvent) => void): () => void {
  disconnectEvents()
  if (!hasEventStream()) return () => undefined
  if (backend.kind === "herdr") {
    const remote = backend.tunnel
    let closed = false
    let closeStream: (() => void) | null = null
    void remote
      .openStream("/api/events", (data) => {
        try {
          onEvent(JSON.parse(new TextDecoder().decode(data)) as AgentEvent)
        } catch {
          // ignore malformed frames
        }
      })
      .then((close) => {
        closeStream = close
        if (closed) {
          close()
        }
      })
      .catch(() => {
        // The polling path detects the failed transport and reconnects it.
      })
    // Closing the event stream must not close the tunnel: the requests of the
    // client travel through the same socket.
    const stop = () => {
      closed = true
      closeStream?.()
    }
    stopEvents = stop
    return stop
  }
  let stopped = false
  const socket = new WebSocket(`ws://${window.location.host}/api/events`)
  socket.addEventListener("message", (message) => {
    try {
      onEvent(JSON.parse(String(message.data)) as AgentEvent)
    } catch {
      // ignore malformed frames
    }
  })
  socket.addEventListener("close", () => {
    if (stopped) {
      return
    }
    window.setTimeout(() => {
      if (!stopped) {
        connectEvents(onEvent)
      }
    }, 1000)
  })
  const stop = () => {
    stopped = true
    socket.close()
  }
  stopEvents = stop
  return stop
}
