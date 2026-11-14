import { CoreClient } from "./core.js"
import { HerdrClient, type HerdrEventHandler, HerdrRequestError, type HerdrSubscription } from "./herdr.js"

type Json = Record<string, unknown>
interface Client {
  request(method: string, params?: Json): Promise<Json>
  onEvent(handler: HerdrEventHandler): void
  subscribe(subscriptions: HerdrSubscription[]): void
  close(): void
}

export interface AutoOptions {
  tuiSockets: () => string[]
  coreSockets: () => string[]
  createTuiClient?: (socketPath: string) => Client
  createCoreClient?: (socketPath: string) => Client
}

type Backend = "tui" | "core"
type Source = { client: Client; socketPath: string; snapshot: Json }
const record = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {})
const rows = (value: unknown): Json[] => (Array.isArray(value) ? value.map(record) : [])
const idKeys = new Set([
  "pane_id",
  "tab_id",
  "workspace_id",
  "active_tab_id",
  "focused_pane_id",
  "focused_tab_id",
  "focused_workspace_id",
  "pane_ids",
  "tab_ids",
  "workspace_ids",
  "paneId",
  "tabId",
  "workspaceId",
  "paneID",
  "tabID",
  "workspaceID",
])
const routeKeys = ["pane_id", "tab_id", "workspace_id", "target"]

// Only identity fields cross namespaces; terminal text, names and machine addresses stay literal.
function namespace(value: unknown, identity = false): unknown {
  if (typeof value === "string") return identity && value ? `hc:${value}` : value
  if (Array.isArray(value)) return value.map((entry) => namespace(entry, identity))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, namespace(entry, idKeys.has(key))]))
}

/** Combines running TUI and core sessions using Alma's hc: identity namespace. */
export class AutoClient {
  private readonly sources: Partial<Record<Backend, Source>> = {}
  private readonly socketPaths: Partial<Record<Backend, string>> = {}
  private readonly handlers: HerdrEventHandler[] = []
  private subscriptions: HerdrSubscription[] | null = null
  private pendingSnapshot: Promise<Json> | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(private readonly options: AutoOptions) {}

  onEvent(handler: HerdrEventHandler): void {
    this.handlers.push(handler)
  }

  subscribe(subscriptions: HerdrSubscription[]): void {
    this.subscriptions = subscriptions.map((entry) => ({ ...entry }))
    for (const backend of ["tui", "core"] as const) this.applySubscriptions(backend)
  }

  private applySubscriptions(backend: Backend): void {
    if (!this.subscriptions) return
    const entries = this.subscriptions
      .filter((entry) => !entry.pane_id || entry.pane_id.startsWith("hc:") === (backend === "core"))
      .map((entry) => ({
        ...entry,
        ...(backend === "core" && entry.pane_id ? { pane_id: entry.pane_id.slice(3) } : {}),
      }))
    this.sources[backend]?.client.subscribe(entries)
  }

  private emit(type: string, data: Json): void {
    for (const handler of this.handlers) handler(type, data)
  }

  private listen(backend: Backend, client: Client): void {
    client.onEvent((type, data) => {
      if (this.closed || this.sources[backend]?.client !== client) return
      if (type === "__connected" || type === "__disconnected") {
        // The active snapshot already checks both sources. Do not recursively refresh it.
        if (!this.pendingSnapshot) this.emit("__connected", {})
        return
      }
      this.emit(type, backend === "core" ? (namespace(data) as Json) : data)
    })
  }

  private discard(backend: Backend): void {
    const source = this.sources[backend]
    delete this.sources[backend]
    source?.client.close()
  }

  private async discover(backend: Backend): Promise<Json | null> {
    const cached = this.sources[backend]
    let failedPath: string | undefined
    if (cached) {
      try {
        const result = await cached.client.request("session.snapshot")
        cached.snapshot = this.validSnapshot(result)
        return result
      } catch {
        failedPath = cached.socketPath
        this.discard(backend)
      }
    }
    let paths: string[]
    try {
      // Pane identities belong to their first established source, even during an outage.
      const pinned = this.socketPaths[backend]
      paths = pinned ? [pinned] : backend === "tui" ? this.options.tuiSockets() : this.options.coreSockets()
    } catch {
      return null
    }
    for (const socketPath of new Set(paths)) {
      if (!socketPath || socketPath === failedPath || this.closed) continue
      let client: Client | undefined
      try {
        client =
          backend === "tui"
            ? (this.options.createTuiClient?.(socketPath) ?? new HerdrClient(socketPath))
            : (this.options.createCoreClient?.(socketPath) ?? new CoreClient({ socketPath }))
        this.listen(backend, client)
        const result = await client.request("session.snapshot")
        const snapshot = this.validSnapshot(result)
        if (this.closed) {
          client.close()
          return null
        }
        this.sources[backend] = { client, socketPath, snapshot }
        this.socketPaths[backend] = socketPath
        this.applySubscriptions(backend)
        return result
      } catch {
        if (this.sources[backend]?.client === client) delete this.sources[backend]
        client?.close()
      }
    }
    return null
  }

  private validSnapshot(result: Json): Json {
    const snapshot = record(result.snapshot)
    if (!["workspaces", "tabs", "panes"].every((key) => Array.isArray(snapshot[key])))
      throw new Error("Backend returned an invalid session snapshot")
    return snapshot
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.closed && !this.pendingSnapshot) this.emit("__connected", {})
      if (!this.sources.tui && !this.sources.core) this.scheduleRetry()
    }, 1500)
    this.retryTimer.unref()
  }

  private async snapshot(): Promise<Json> {
    const [tui, core] = await Promise.all([this.discover("tui"), this.discover("core")])
    if (this.closed) throw new Error("Auto client is closed")
    if (!tui && !core) {
      this.scheduleRetry()
      throw new HerdrRequestError("backend_unavailable", "No running herdr TUI or core session is available")
    }
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const left = record(tui?.snapshot)
    const right = record(namespace(core?.snapshot))
    const snapshot: Json = { ...right, ...left }
    for (const key of ["workspaces", "tabs", "panes", "agents", "machines"])
      snapshot[key] = [...rows(left[key]), ...rows(right[key])]
    for (const key of ["focused_pane_id", "focused_tab_id", "focused_workspace_id"])
      snapshot[key] = left[key] || right[key] || null
    return { ...(tui ?? core), snapshot }
  }

  private promptTarget(target: string): { backend: Backend; target: string } {
    if (target.startsWith("hc:")) return { backend: "core", target: target.slice(3) }
    const tui = this.sources.tui?.snapshot
    if (rows(tui?.panes).some((pane) => pane.pane_id === target)) return { backend: "tui", target }
    const matches: { backend: Backend; target: string }[] = []
    for (const backend of ["tui", "core"] as const) {
      const ids = new Set(
        rows(this.sources[backend]?.snapshot.agents)
          .filter((agent) => agent.name === target)
          .map((agent) => agent.pane_id)
          .filter((id): id is string => typeof id === "string" && Boolean(id)),
      )
      for (const id of ids) matches.push({ backend, target: id })
    }
    if (matches.length !== 1)
      throw new HerdrRequestError("invalid_target", "Prompt target must identify exactly one namespaced pane or agent")
    return matches[0]!
  }

  async request(method: string, params: Json = {}): Promise<Json> {
    if (this.closed) throw new Error("Auto client is closed")
    if (method === "session.snapshot") {
      if (!this.pendingSnapshot)
        this.pendingSnapshot = Promise.resolve()
          .then(() => this.snapshot())
          .finally(() => {
            this.pendingSnapshot = null
          })
      return this.pendingSnapshot
    }
    const routed = { ...params }
    const backends = new Set<Backend>()
    for (const key of routeKeys) {
      const value = params[key]
      if (typeof value !== "string" || !value) continue
      if (key === "target" && method === "agent.prompt") {
        const match = this.promptTarget(value)
        backends.add(match.backend)
        routed[key] = match.target
      } else {
        const backend = value.startsWith("hc:") ? "core" : "tui"
        backends.add(backend)
        if (backend === "core") routed[key] = value.slice(3)
      }
    }
    if (backends.size > 1) throw new HerdrRequestError("invalid_target", "Request targets span multiple backends")
    if (!backends.size && (method.startsWith("pane.") || method === "agent.start" || method === "agent.prompt"))
      throw new HerdrRequestError("invalid_target", "An explicit pane or agent target is required")
    const defaultCore =
      (method === "workspace.create" || method === "ping") && (params.backend === "hc" || !this.sources.tui)
    const backend = [...backends][0] ?? (defaultCore ? "core" : "tui")
    const source = this.sources[backend]
    if (!source)
      throw new HerdrRequestError(
        "backend_unavailable",
        `The ${backend} backend is unavailable; refresh the session snapshot`,
      )
    // Never replay a failed operation, even if another source is online.
    const result = await source.client.request(method, routed)
    return backend === "core" ? (namespace(result) as Json) : result
  }

  close(): void {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.discard("tui")
    this.discard("core")
  }
}
