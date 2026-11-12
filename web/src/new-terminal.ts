import { agentName } from "./agents.js"
import type { ApiFailure, CreatedTerminal, SessionSnapshot, StateResponse } from "./api.js"

export const NEW_TAB_AGENTS = [
  { kind: "claude", label: "Claude Code" },
  { kind: "codex", label: "Codex" },
  { kind: "pi", label: "pi" },
] as const

export type NewTabAgent = (typeof NEW_TAB_AGENTS)[number]

interface CreateCalls {
  create(workspaceId: string, cwd: string | null): Promise<CreatedTerminal>
  start(paneId: string, name: string, kind: string, args: string[]): Promise<ApiFailure | null>
  state(): Promise<StateResponse>
  current(): boolean
  pause(milliseconds: number): Promise<void>
}

interface CreateResult {
  paneId: string | null
  state: SessionSnapshot | null
  error: string | null
}

export async function createAgentTerminal(
  snapshot: SessionSnapshot,
  workspaceId: string,
  agent: NewTabAgent,
  calls: CreateCalls,
): Promise<CreateResult> {
  const failed = (error: string): CreateResult => ({ paneId: null, state: null, error })
  if (!calls.current()) return failed("connection changed")
  if (!snapshot.workspaces.some((workspace) => workspace.workspace_id === workspaceId)) {
    return failed("the workspace is no longer available")
  }
  const tab = snapshot.tabs.find((candidate) => candidate.workspace_id === workspaceId)
  const source = tab === undefined ? undefined : snapshot.panes.find((pane) => pane.tab_id === tab.tab_id)
  const created = await calls.create(workspaceId, source?.cwd ?? null)
  if (created.error !== null || created.paneId === null) return failed(created.error ?? "no pane was returned")
  const paneId = created.paneId
  // The create reply can arrive before the pane is visible in session state.
  for (let round = 0; round < 40; round += 1) {
    if (!calls.current()) return failed("connection changed")
    let next: StateResponse
    try {
      next = await calls.state()
    } catch (error) {
      return failed(`the tab was created, but its state could not be read: ${String(error)}`)
    }
    if (!calls.current()) return failed("connection changed")
    if (!next.connected || next.state === null) return failed("the tab was created, but the desktop disconnected")
    const pane = next.state.panes.find((candidate) => candidate.pane_id === paneId)
    if (pane !== undefined) {
      const name = agentName({ ...pane, agent: agent.kind, agent_session: null })
      let error: string | null = null
      try {
        let failure = await calls.start(paneId, name, agent.kind, [])
        // A new PTY can be listed before its shell has finished initialization.
        for (let attempt = 1; failure?.code === "agent_pane_busy" && attempt < 20; attempt += 1) {
          await calls.pause(250)
          if (!calls.current()) return failed("connection changed")
          failure = await calls.start(paneId, name, agent.kind, [])
        }
        if (failure !== null) error = `Tab created; ${agent.label} could not start: ${failure.error}`
      } catch (failure) {
        error = `Tab created; ${agent.label} could not start: ${String(failure)}`
      }
      return { paneId, state: next.state, error }
    }
    if (round < 39) await calls.pause(100)
  }
  return failed("the tab was created, but its pane did not appear; refresh the list before trying again")
}

interface MenuCalls {
  snapshot(): SessionSnapshot | null
  create(agent: NewTabAgent, workspaceId: string): Promise<void>
  beforeOpen(): void
}

export class NewTerminalMenu {
  private agent: NewTabAgent | null = null
  private busy = false
  private workspaceSignature = ""

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly menu: HTMLDivElement,
    private readonly calls: MenuCalls,
  ) {
    const doc = menu.ownerDocument
    button.addEventListener("click", () => {
      if (this.isOpen()) this.close()
      else if (!this.busy && this.calls.snapshot()?.workspaces.length) {
        this.calls.beforeOpen()
        this.agent = null
        this.render()
        menu.classList.remove("hidden")
        button.setAttribute("aria-expanded", "true")
        menu.querySelector<HTMLButtonElement>("button")?.focus()
      }
    })
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape" || (event.key === "ArrowLeft" && this.agent !== null)) {
        event.preventDefault()
        event.stopPropagation()
        if (this.agent !== null) {
          this.agent = null
          this.render()
          menu.querySelector<HTMLButtonElement>("button")?.focus()
        } else this.close(true)
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const items = [...menu.querySelectorAll<HTMLButtonElement>("button")]
        const index = items.indexOf(doc.activeElement as HTMLButtonElement)
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus()
      }
    })
    doc.addEventListener("click", (event) => {
      const target = event.target as Node | null
      if (target !== null && !button.contains(target) && !menu.contains(target)) this.close()
    })
  }

  isOpen(): boolean {
    return !this.menu.classList.contains("hidden")
  }

  close(restoreFocus = false): void {
    this.menu.classList.add("hidden")
    this.button.setAttribute("aria-expanded", "false")
    if (restoreFocus) this.button.focus()
  }

  update(): void {
    const workspaces = this.calls.snapshot()?.workspaces ?? []
    const signature = JSON.stringify(
      workspaces.map((workspace) => [workspace.workspace_id, workspace.label, workspace.number]),
    )
    this.button.disabled = this.busy || workspaces.length === 0
    if (this.button.disabled) this.close()
    else if (this.isOpen() && signature !== this.workspaceSignature) this.render()
    this.workspaceSignature = signature
  }

  private render(): void {
    this.menu.replaceChildren()
    const heading = this.menu.ownerDocument.createElement("div")
    heading.className = "popover-foot"
    heading.textContent = this.agent === null ? "New Tab" : `Start ${this.agent.label} in`
    this.menu.append(heading)
    if (this.agent === null) {
      for (const agent of NEW_TAB_AGENTS) {
        this.item(agent.label, "›", () => {
          this.agent = agent
          this.render()
          this.menu.querySelector<HTMLButtonElement>("button")?.focus()
        })
      }
      return
    }
    this.item("Back", "‹", () => {
      this.agent = null
      this.render()
      this.menu.querySelector<HTMLButtonElement>("button")?.focus()
    })
    for (const workspace of this.calls.snapshot()?.workspaces ?? []) {
      this.item(workspace.label || `Workspace ${workspace.number}`, "▱", () => {
        const agent = this.agent
        if (agent === null || this.busy) return
        this.busy = true
        this.close()
        this.update()
        void this.calls.create(agent, workspace.workspace_id).finally(() => {
          this.busy = false
          this.update()
        })
      })
    }
  }

  private item(label: string, glyph: string, run: () => void): void {
    const doc = this.menu.ownerDocument
    const button = doc.createElement("button")
    button.type = "button"
    button.className = "popover-item"
    const icon = doc.createElement("span")
    icon.className = "popover-glyph quiet"
    icon.textContent = glyph
    icon.setAttribute("aria-hidden", "true")
    const text = doc.createElement("span")
    text.className = "popover-label"
    text.textContent = label
    button.append(icon, text)
    button.addEventListener("click", (event) => {
      // Rendering a submenu removes this target before the document click runs.
      event.stopPropagation()
      run()
    })
    this.menu.append(button)
  }
}
