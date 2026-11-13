import { homedir } from "node:os"
import { basename, join } from "node:path"
import { type CoreOptions, CoreTransport, encodeCoreKeys } from "./core-transport.js"
import { type HerdrEventHandler, HerdrRequestError, type HerdrSubscription } from "./herdr.js"

export { type CoreOptions, encodeCoreKeys } from "./core-transport.js"

type Json = Record<string, unknown>
const record = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {})
const text = (value: unknown): string => (typeof value === "string" ? value : "")
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(record) : [])
const machineOf = (address: string): string => (address.includes("/") ? address.slice(0, address.lastIndexOf("/")) : "")
const workspaceKey = "alma-web.workspace"
const nameKey = "alma-web.agent-name"

/** Maps core terminals to browser panes, retaining their complete routed address. */
export class CoreClient {
  private readonly transport: CoreTransport
  private readonly handlers: HerdrEventHandler[] = []
  private readonly terminals = new Map<string, Json>()
  private readonly groups = new Map<string, { machine: string; group: string; cwd: string }>()
  private readonly machines = new Map<string, Json>()
  private readonly revisions = new Map<string, number>()
  private focused: string | null = null
  private poll: NodeJS.Timeout | null = null
  private closed = false

  constructor(private readonly options: CoreOptions = {}) {
    this.transport = new CoreTransport(options, () => this.emit("__disconnected", {}))
  }

  onEvent(handler: HerdrEventHandler): void {
    this.handlers.push(handler)
  }

  subscribe(_subscriptions: HerdrSubscription[]): void {
    if (this.closed || this.poll) return
    // Core fact events omit output and machine line changes. Polling invalidates
    // the shared snapshot and pane output without retaining per-pane streams.
    const invalidate = (): void => {
      if (this.closed) return
      this.emit("__connected", {})
      for (const address of this.terminals.keys()) {
        const revision = this.bump(address)
        this.emit("pane_output_changed", { pane_id: address, revision })
      }
      this.poll = setTimeout(invalidate, this.options.pollIntervalMs ?? 1500)
      this.poll.unref()
    }
    this.poll = setTimeout(invalidate, 0)
  }

  close(): void {
    this.closed = true
    if (this.poll) clearTimeout(this.poll)
    this.poll = null
    this.transport.close()
  }

  private emit(type: string, data: Json): void {
    for (const handler of this.handlers) handler(type, data)
  }
  private bump(address: string): number {
    const revision = (this.revisions.get(address) ?? 0) + 1
    this.revisions.set(address, revision)
    return revision
  }

  private available(machine: string): boolean {
    return !machine || this.machines.get(machine)?.state === "connected"
  }

  private async refresh(): Promise<void> {
    const result = await this.transport.request("terminal.list", { all: true })
    this.machines.clear()
    for (const machine of list(result.machines)) this.machines.set(text(machine.name), machine)
    const seen = new Set<string>()
    for (const terminal of list(result.terminals)) {
      const address = text(terminal.address)
      if (!address) continue
      seen.add(address)
      this.terminals.set(address, terminal)
    }
    for (const address of this.terminals.keys()) {
      const machine = machineOf(address)
      if (!seen.has(address) && (!machine || !this.machines.has(machine) || this.available(machine)))
        this.terminals.delete(address)
    }
  }

  private group(terminal: Json): { id: string; machine: string; group: string; cwd: string } {
    const machine = machineOf(text(terminal.address))
    const cwd = text(terminal.cwd)
    const group = text(record(terminal.labels)[workspaceKey]) || cwd || "Terminals"
    const id = `core:${encodeURIComponent(machine)}:${encodeURIComponent(group)}`
    const result = { id, machine, group, cwd }
    this.groups.set(id, result)
    return result
  }

  private async snapshot(): Promise<Json> {
    await this.refresh()
    this.groups.clear()
    const panes: Json[] = []
    const tabs: Json[] = []
    const workspaces = new Map<string, Json>()
    const agents: Json[] = []
    if (!this.focused || !this.terminals.has(this.focused)) this.focused = this.terminals.keys().next().value ?? null
    for (const [address, terminal] of this.terminals) {
      const group = this.group(terminal)
      const connected = this.available(group.machine)
      const status = record(terminal.status)
      const agent = text(status.app) || null
      const state = connected ? (terminal.state === "finished" ? "exited" : text(status.state) || "unknown") : "unknown"
      const focused = this.focused === address
      const title = text(terminal.title) || text(status.title) || text(terminal.name) || address
      const pane = {
        pane_id: address,
        tab_id: address,
        workspace_id: group.id,
        agent,
        display_agent: agent,
        agent_status: state,
        agent_session: null,
        cwd: terminal.cwd ?? null,
        foreground_cwd: record(terminal.foreground).cwd ?? null,
        terminal_title: title,
        terminal_title_stripped: title,
        title,
        label: terminal.name ?? null,
        focused,
        revision: this.revisions.get(address) ?? 0,
        scroll: { viewport_rows: terminal.rows ?? 24 },
        machine: group.machine || null,
        connected,
        connection_state: group.machine ? this.machines.get(group.machine)?.state : "connected",
      }
      panes.push(pane)
      tabs.push({
        tab_id: address,
        workspace_id: group.id,
        label: title,
        number: tabs.length + 1,
        agent_status: state,
        focused,
        pane_count: 1,
        machine: pane.machine,
        connected,
      })
      let workspace = workspaces.get(group.id)
      if (!workspace) {
        workspace = {
          workspace_id: group.id,
          label: `${group.machine ? `${group.machine}: ` : ""}${basename(group.group) || group.group}${connected ? "" : " (offline)"}`,
          number: workspaces.size + 1,
          agent_status: "unknown",
          focused: false,
          active_tab_id: address,
          pane_count: 0,
          tab_count: 0,
          machine: pane.machine,
          connected,
          connection_state: pane.connection_state,
          cwd: group.cwd,
        }
        workspaces.set(group.id, workspace)
      }
      workspace.pane_count = Number(workspace.pane_count) + 1
      workspace.tab_count = Number(workspace.tab_count) + 1
      if (focused) {
        workspace.focused = true
        workspace.active_tab_id = address
      }
      if (agent)
        agents.push({
          ...pane,
          name: record(terminal.labels)[nameKey] ?? terminal.name ?? agent,
          state_change_seq: terminal.status_ms ?? 0,
          completion_seq: terminal.turn ?? null,
        })
    }
    // Disconnected machines remain visible even before their first terminal snapshot.
    for (const [machine, info] of this.machines) {
      if ([...workspaces.values()].some((workspace) => workspace.machine === machine)) continue
      const id = `core:${encodeURIComponent(machine)}:`
      this.groups.set(id, { machine, group: "", cwd: "" })
      workspaces.set(id, {
        workspace_id: id,
        label: `${machine}${this.available(machine) ? "" : " (offline)"}`,
        number: workspaces.size + 1,
        agent_status: "unknown",
        focused: false,
        active_tab_id: "",
        pane_count: 0,
        tab_count: 0,
        machine,
        connected: this.available(machine),
        connection_state: info.state,
        cwd: "",
      })
    }
    const focused = panes.find((pane) => pane.pane_id === this.focused)
    return {
      snapshot: {
        version: "herdr-core",
        protocol: 1,
        workspaces: [...workspaces.values()],
        tabs,
        panes,
        agents,
        machines: [...this.machines.values()],
        focused_pane_id: focused?.pane_id ?? null,
        focused_tab_id: focused?.tab_id ?? null,
        focused_workspace_id: focused?.workspace_id ?? null,
      },
    }
  }

  private async terminal(address: string): Promise<Json> {
    if (!address) throw new HerdrRequestError("invalid_params", "A terminal address is required")
    await this.refresh()
    if (!this.available(machineOf(address)))
      throw new HerdrRequestError("machine_unavailable", "The terminal machine is disconnected")
    const terminal = await this.transport.request("terminal.get", { terminal: address })
    this.terminals.set(address, terminal)
    return terminal
  }

  private async attach(address: string, terminal: Json, observe: boolean, history = 0): Promise<number> {
    const result = await this.transport.request("terminal.attach", {
      terminal: address,
      cols: Number(terminal.cols) || 80,
      rows: Number(terminal.rows) || 24,
      history,
      observe,
    })
    if (typeof result.channel !== "number" || result.channel <= 0) throw new Error("Core attach returned no stream")
    return result.channel
  }

  private async input(address: string, bytes: string, keys?: string[]): Promise<Json> {
    const terminal = await this.terminal(address)
    const channel = await this.attach(address, terminal, false)
    try {
      if (keys) {
        const paint = (await this.transport.paint(channel, 0)).text
        if (paint.includes("\x1b[?9001h"))
          throw new HerdrRequestError("unsupported_keyboard", "This terminal requires win32 keyboard encoding")
        bytes = encodeCoreKeys(keys, paint.lastIndexOf("\x1b[?1h") > paint.lastIndexOf("\x1b[?1l"))
      }
      await this.transport.write(channel, Buffer.from(bytes))
    } finally {
      this.transport.closeChannel(channel)
    }
    return { pane_id: address, revision: this.bump(address) }
  }

  private async create(params: Json): Promise<Json> {
    await this.snapshot()
    const workspaceId = text(params.workspace_id)
    const group = this.groups.get(workspaceId)
    if (workspaceId && !group) throw new HerdrRequestError("not_found", "Unknown core workspace")
    const machine = group?.machine ?? ""
    if (!this.available(machine))
      throw new HerdrRequestError("machine_unavailable", "The workspace machine is disconnected")
    let cwd = text(params.cwd) || group?.cwd || undefined
    const home = (this.options.env ?? process.env).HOME || homedir()
    // The API takes literal paths; only the CLI shell normally expands tilde.
    // Omitting cwd with `on` selects that remote machine's home natively.
    if (cwd === "~") cwd = machine ? undefined : home
    else if (!machine && cwd?.startsWith("~/")) cwd = join(home, cwd.slice(2))
    const label = text(params.label)
    const terminal = await this.transport.request("terminal.run", {
      ...(machine ? { on: machine } : {}),
      ...(cwd ? { cwd } : {}),
      labels: { [workspaceKey]: group?.group || cwd || "Terminals", ...(label ? { "alma-web.label": label } : {}) },
      no_parent: true,
      no_notify: true,
    })
    const address = text(terminal.address)
    if (!address || machineOf(address) !== machine) throw new Error("Core returned an unexpected terminal machine")
    this.terminals.set(address, terminal)
    if (params.focus !== false) this.focused = address
    const mapped = this.group(terminal)
    this.emit("__connected", {})
    return { pane_id: address, tab_id: address, workspace_id: mapped.id }
  }

  private async start(params: Json): Promise<Json> {
    const kind = text(params.kind)
    if (!["claude", "codex", "pi"].includes(kind))
      throw new HerdrRequestError("unsupported_agent", "Supported agents: claude, codex, pi")
    if (
      !Array.isArray(params.args) ||
      params.args.some((arg) => typeof arg !== "string" || /^[^\x00-\x1f\x7f]*$/.test(arg) === false)
    )
      throw new HerdrRequestError("invalid_params", "Agent args must be strings without control characters")
    const address = text(params.pane_id)
    let terminal = await this.terminal(address)
    const argv = Array.isArray(terminal.argv) ? terminal.argv : []
    const shell = basename(text(argv[0]))
    // Wait only for a shell's first sample, never retry a known running program.
    for (
      let attempt = 0;
      attempt < 20 &&
      !terminal.foreground &&
      terminal.state === "live" &&
      ["sh", "bash", "zsh", "dash", "ksh", "fish"].includes(shell);
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      terminal = await this.transport.request("terminal.get", { terminal: address })
    }
    const foreground = record(terminal.foreground)
    if (
      terminal.state !== "live" ||
      !["sh", "bash", "zsh", "dash", "ksh", "fish"].includes(shell) ||
      foreground.pid !== terminal.pid ||
      ![shell, "sh", "bash", "zsh", "dash", "ksh", "fish"].includes(basename(text(foreground.name))) ||
      argv.includes("-c")
    ) {
      throw new HerdrRequestError(
        "agent_pane_busy",
        "Agent start requires an idle shell; the existing program was left running",
      )
    }
    const quote = (arg: string): string => {
      const escaped =
        shell === "fish" ? arg.replaceAll("\\", "\\\\").replaceAll("'", "\\'") : arg.replaceAll("'", "'\\''")
      return `'${escaped}'`
    }
    const command = [kind, ...(params.args as string[])].map(quote).join(" ")
    await this.input(address, `${command}\r`)
    if (text(params.name))
      await this.transport.request("terminal.label", { terminal: address, labels: { [nameKey]: text(params.name) } })
    this.emit("__connected", {})
    return { pane_id: address }
  }

  async request(method: string, params: Json = {}): Promise<Json> {
    if (this.closed) throw new Error("Core client is closed")
    switch (method) {
      case "ping":
        return this.transport.request("hello")
      case "session.snapshot":
        return this.snapshot()
      case "pane.send_text":
        return this.input(text(params.pane_id), text(params.text))
      case "pane.send_keys": {
        if (!Array.isArray(params.keys) || params.keys.some((key) => typeof key !== "string"))
          throw new HerdrRequestError("invalid_keys", "Keys must be strings")
        return this.input(text(params.pane_id), "", params.keys as string[])
      }
      case "pane.read": {
        const address = text(params.pane_id)
        const terminal = await this.terminal(address)
        const lines = Math.max(0, Math.floor(Number(params.lines) || 0))
        if (params.format === "ansi" && terminal.state === "live") {
          const channel = await this.attach(address, terminal, true, lines)
          try {
            const paint = await this.transport.paint(channel)
            return {
              read: {
                text: paint.text,
                vt: true,
                cols: Number(terminal.cols) || 80,
                rows: Number(terminal.rows) || 24,
                revision: this.revisions.get(address) ?? 0,
                truncated: paint.truncated || terminal.screen === "inexact",
              },
            }
          } finally {
            this.transport.closeChannel(channel)
          }
        }
        const result = await this.transport.request("terminal.read", { terminal: address, lines })
        return {
          read: { text: result.text, revision: this.revisions.get(address) ?? 0, truncated: result.complete === false },
        }
      }
      case "pane.focus":
      case "tab.focus":
      case "workspace.focus": {
        await this.snapshot()
        const address =
          text(params.pane_id) ||
          text(params.tab_id) ||
          [...this.terminals.keys()].find((id) => this.group(this.terminals.get(id)!).id === params.workspace_id) ||
          ""
        await this.terminal(address)
        this.focused = address
        this.emit("__connected", {})
        return { pane_id: address }
      }
      case "tab.create":
      case "workspace.create":
        return this.create(params)
      case "agent.start":
        return this.start(params)
      case "agent.prompt": {
        await this.refresh()
        const target = text(params.target)
        const matches = [...this.terminals.entries()].filter(
          ([address, terminal]) =>
            address === target || terminal.name === target || record(terminal.labels)[nameKey] === target,
        )
        if (matches.length !== 1)
          throw new HerdrRequestError("invalid_target", "Prompt target must identify exactly one terminal")
        const address = matches[0]![0]
        await this.terminal(address)
        return this.transport.request("terminal.send", { terminal: address, text: text(params.text) })
      }
      default:
        throw new HerdrRequestError("unsupported_method", `Core backend does not support ${method}`)
    }
  }
}
