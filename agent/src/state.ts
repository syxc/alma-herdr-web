/**
 * The session state the agent keeps in sync with herdr.
 *
 * herdr pushes invalidating events, so the cache is rebuilt from the snapshot
 * and then patched by every event. A fresh snapshot is taken whenever the
 * socket reconnects.
 */

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

export interface AgentRecord {
  pane_id: string
  workspace_id: string
  tab_id: string
  name: string | null
  agent: string | null
  display_agent: string | null
  agent_status: string
  agent_session: AgentSessionRef | null
  cwd: string | null
  title: string | null
  terminal_title_stripped: string | null
  focused: boolean
  state_change_seq: number
  completion_seq: number | null
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0
}

function bool(value: unknown): boolean {
  return value === true
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function sessionRef(value: unknown): AgentSessionRef | null {
  if (value === null || value === undefined) {
    return null
  }
  const raw = asRecord(value)
  return {
    agent: str(raw.agent),
    kind: str(raw.kind),
    source: str(raw.source),
    value: str(raw.value),
  }
}

export function workspaceFrom(raw: Record<string, unknown>): WorkspaceRecord {
  return {
    workspace_id: str(raw.workspace_id),
    label: str(raw.label),
    number: num(raw.number),
    agent_status: str(raw.agent_status),
    focused: bool(raw.focused),
    active_tab_id: str(raw.active_tab_id),
    pane_count: num(raw.pane_count),
    tab_count: num(raw.tab_count),
  }
}

export function tabFrom(raw: Record<string, unknown>): TabRecord {
  return {
    tab_id: str(raw.tab_id),
    workspace_id: str(raw.workspace_id),
    label: str(raw.label),
    number: num(raw.number),
    agent_status: str(raw.agent_status),
    focused: bool(raw.focused),
    pane_count: num(raw.pane_count),
  }
}

export function paneFrom(raw: Record<string, unknown>): PaneRecord {
  const scroll = asRecord(raw.scroll)
  return {
    pane_id: str(raw.pane_id),
    workspace_id: str(raw.workspace_id),
    tab_id: str(raw.tab_id),
    agent: nullableStr(raw.agent),
    display_agent: nullableStr(raw.display_agent),
    agent_status: str(raw.agent_status),
    agent_session: sessionRef(raw.agent_session),
    cwd: nullableStr(raw.cwd),
    foreground_cwd: nullableStr(raw.foreground_cwd),
    terminal_title: nullableStr(raw.terminal_title),
    terminal_title_stripped: nullableStr(raw.terminal_title_stripped),
    title: nullableStr(raw.title),
    label: nullableStr(raw.label),
    focused: bool(raw.focused),
    revision: num(raw.revision),
    viewport_rows: num(scroll.viewport_rows),
  }
}

export function agentFrom(raw: Record<string, unknown>): AgentRecord {
  return {
    pane_id: str(raw.pane_id),
    workspace_id: str(raw.workspace_id),
    tab_id: str(raw.tab_id),
    name: nullableStr(raw.name),
    agent: nullableStr(raw.agent),
    display_agent: nullableStr(raw.display_agent),
    agent_status: str(raw.agent_status),
    agent_session: sessionRef(raw.agent_session),
    cwd: nullableStr(raw.cwd),
    title: nullableStr(raw.title),
    terminal_title_stripped: nullableStr(raw.terminal_title_stripped),
    focused: bool(raw.focused),
    state_change_seq: num(raw.state_change_seq),
    completion_seq: raw.completion_seq === null || raw.completion_seq === undefined ? null : num(raw.completion_seq),
  }
}

export interface SessionSnapshot {
  workspaces: WorkspaceRecord[]
  tabs: TabRecord[]
  panes: PaneRecord[]
  agents: AgentRecord[]
  focused_workspace_id: string | null
  focused_tab_id: string | null
  focused_pane_id: string | null
  version: string
  protocol: number
}

export class SessionState {
  private workspaces: WorkspaceRecord[] = []
  private tabs: TabRecord[] = []
  private panes: PaneRecord[] = []
  private agents: AgentRecord[] = []
  private focusedWorkspaceId: string | null = null
  private focusedTabId: string | null = null
  private focusedPaneId: string | null = null
  private version = ""
  private protocol = 0

  applySnapshot(result: Record<string, unknown>): void {
    const snapshot = asRecord(result.snapshot)
    this.version = str(snapshot.version)
    this.protocol = num(snapshot.protocol)
    this.focusedWorkspaceId = nullableStr(snapshot.focused_workspace_id)
    this.focusedTabId = nullableStr(snapshot.focused_tab_id)
    this.focusedPaneId = nullableStr(snapshot.focused_pane_id)

    this.workspaces = this.list(snapshot.workspaces).map(workspaceFrom)
    this.tabs = this.list(snapshot.tabs).map(tabFrom)
    this.panes = this.list(snapshot.panes).map(paneFrom)
    this.agents = this.list(snapshot.agents).map(agentFrom)
  }

  applyEvent(type: string, data: Record<string, unknown>): void {
    switch (type) {
      case "workspace_created":
      case "workspace_updated":
      case "workspace_metadata_updated": {
        const workspace = workspaceFrom(asRecord(data.workspace))
        if (workspace.workspace_id.length === 0) {
          return
        }
        const index = this.workspaces.findIndex((w) => w.workspace_id === workspace.workspace_id)
        if (index >= 0) {
          this.workspaces[index] = workspace
        } else {
          this.workspaces.push(workspace)
        }
        return
      }
      case "workspace_closed": {
        const id = str(data.workspace_id)
        this.workspaces = this.workspaces.filter((w) => w.workspace_id !== id)
        this.tabs = this.tabs.filter((t) => t.workspace_id !== id)
        this.panes = this.panes.filter((p) => p.workspace_id !== id)
        this.agents = this.agents.filter((a) => a.workspace_id !== id)
        return
      }
      case "workspace_renamed": {
        const id = str(data.workspace_id)
        const label = str(data.label)
        const workspace = this.workspaces.find((w) => w.workspace_id === id)
        if (workspace !== undefined) {
          workspace.label = label
        }
        return
      }
      case "workspace_moved": {
        const id = str(data.workspace_id)
        const insertIndex = num(data.insert_index)
        this.workspaces = this.move(this.workspaces, id, insertIndex, (w) => w.workspace_id)
        return
      }
      case "workspace_reordered": {
        const ids = this.strings(data.workspace_ids)
        this.workspaces = this.reorder(this.workspaces, ids, (w) => w.workspace_id)
        return
      }
      case "workspace_focused": {
        this.focusedWorkspaceId = str(data.workspace_id)
        return
      }
      case "tab_created": {
        const tab = tabFrom(asRecord(data.tab))
        if (tab.tab_id.length === 0) {
          return
        }
        const index = this.tabs.findIndex((t) => t.tab_id === tab.tab_id)
        if (index >= 0) {
          this.tabs[index] = tab
        } else {
          this.tabs.push(tab)
        }
        return
      }
      case "tab_closed": {
        const id = str(data.tab_id)
        this.tabs = this.tabs.filter((t) => t.tab_id !== id)
        this.panes = this.panes.filter((p) => p.tab_id !== id)
        this.agents = this.agents.filter((a) => a.tab_id !== id)
        return
      }
      case "tab_renamed": {
        const id = str(data.tab_id)
        const label = str(data.label)
        const tab = this.tabs.find((t) => t.tab_id === id)
        if (tab !== undefined) {
          tab.label = label
        }
        return
      }
      case "tab_moved": {
        const id = str(data.tab_id)
        const insertIndex = num(data.insert_index)
        this.tabs = this.move(this.tabs, id, insertIndex, (t) => t.tab_id)
        return
      }
      case "tab_focused": {
        this.focusedTabId = str(data.tab_id)
        return
      }
      case "pane_created":
      case "pane_updated": {
        const pane = paneFrom(asRecord(data.pane))
        if (pane.pane_id.length === 0) {
          return
        }
        const index = this.panes.findIndex((p) => p.pane_id === pane.pane_id)
        if (index >= 0) {
          this.panes[index] = pane
        } else {
          this.panes.push(pane)
        }
        return
      }
      case "pane_closed": {
        const id = str(data.pane_id)
        this.panes = this.panes.filter((p) => p.pane_id !== id)
        this.agents = this.agents.filter((a) => a.pane_id !== id)
        return
      }
      case "pane_focused": {
        this.focusedPaneId = str(data.pane_id)
        return
      }
      case "pane_agent_status_changed":
      case "pane_agent_detected": {
        const id = str(data.pane_id)
        const pane = this.panes.find((p) => p.pane_id === id)
        if (pane !== undefined) {
          const status = str(data.agent_status) || str(data.final_status)
          if (status.length > 0) {
            pane.agent_status = status
          }
          const agent = nullableStr(data.agent)
          if (agent !== null) {
            pane.agent = agent
          }
        }
        const agent = this.agents.find((a) => a.pane_id === id)
        if (agent !== undefined) {
          const status = str(data.agent_status) || str(data.final_status)
          if (status.length > 0) {
            agent.agent_status = status
          }
        }
        return
      }
      default:
        return
    }
  }

  snapshot(): SessionSnapshot {
    return {
      workspaces: this.workspaces,
      tabs: this.tabs,
      panes: this.panes,
      agents: this.agents,
      focused_workspace_id: this.focusedWorkspaceId,
      focused_tab_id: this.focusedTabId,
      focused_pane_id: this.focusedPaneId,
      version: this.version,
      protocol: this.protocol,
    }
  }

  private list(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) {
      return []
    }
    return value.filter((entry) => entry !== null && entry !== undefined).map(asRecord)
  }

  private strings(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return []
    }
    return value.filter((entry) => typeof entry === "string") as string[]
  }

  private move<T>(items: T[], id: string, insertIndex: number, key: (item: T) => string): T[] {
    const index = items.findIndex((item) => key(item) === id)
    if (index < 0) {
      return items
    }
    const copy = items.slice()
    const [moved] = copy.splice(index, 1)
    if (moved === undefined) {
      return items
    }
    const target = Math.max(0, Math.min(insertIndex, copy.length))
    copy.splice(target, 0, moved)
    return copy
  }

  private reorder<T>(items: T[], ids: string[], key: (item: T) => string): T[] {
    const byId = new Map<string, T>()
    for (const item of items) {
      byId.set(key(item), item)
    }
    const ordered: T[] = []
    for (const id of ids) {
      const item = byId.get(id)
      if (item !== undefined) {
        ordered.push(item)
        byId.delete(id)
      }
    }
    for (const item of items) {
      const id = key(item)
      if (byId.has(id)) {
        ordered.push(item)
        byId.delete(id)
      }
    }
    return ordered
  }
}
