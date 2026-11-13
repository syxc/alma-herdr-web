import type { AgentSessionRef, PaneRecord, SessionSnapshot, TabRecord, WorkspaceRecord } from "./api.js"

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function count(value: unknown): number {
  return typeof value === "number" ? value : 0
}

function sessionRef(value: unknown): AgentSessionRef | null {
  if (value === null || typeof value !== "object") {
    return null
  }
  const raw = value as Record<string, unknown>
  const source = typeof raw.source === "string" ? raw.source : ""
  if (source.length === 0) {
    return null
  }
  return {
    agent: typeof raw.agent === "string" ? raw.agent : "",
    kind: typeof raw.kind === "string" ? raw.kind : "",
    source,
    value: typeof raw.value === "string" ? raw.value : "",
  }
}

export function almaSnapshot(
  workspaces: Record<string, unknown>[],
  tabs: Record<string, unknown>[],
  panes: Record<string, unknown>[],
): SessionSnapshot {
  const workspaceRecords: WorkspaceRecord[] = workspaces.map((workspace) => ({
    workspace_id: text(workspace.workspace_id),
    label: text(workspace.label),
    number: count(workspace.number),
    agent_status: text(workspace.agent_status) || "unknown",
    focused: workspace.focused === true,
    active_tab_id: text(workspace.active_tab_id),
    pane_count: count(workspace.pane_count),
    tab_count: count(workspace.tab_count),
  }))
  const tabRecords: TabRecord[] = tabs.map((tab) => ({
    tab_id: text(tab.tab_id),
    workspace_id: text(tab.workspace_id),
    label: text(tab.label),
    number: count(tab.number),
    agent_status: text(tab.agent_status) || "unknown",
    focused: tab.focused === true,
    pane_count: count(tab.pane_count),
  }))
  const paneRecords: PaneRecord[] = panes.map((pane) => {
    const scroll = (pane.scroll ?? {}) as Record<string, unknown>
    return {
      pane_id: text(pane.pane_id),
      workspace_id: text(pane.workspace_id),
      tab_id: text(pane.tab_id),
      agent: optionalText(pane.agent),
      display_agent: optionalText(pane.display_agent),
      agent_status: text(pane.agent_status) || "unknown",
      agent_session: sessionRef(pane.agent_session),
      cwd: optionalText(pane.cwd),
      foreground_cwd: optionalText(pane.foreground_cwd),
      terminal_title: optionalText(pane.terminal_title),
      terminal_title_stripped: optionalText(pane.terminal_title_stripped),
      title: optionalText(pane.title),
      label: optionalText(pane.label),
      focused: pane.focused === true,
      revision: count(pane.revision),
      viewport_rows: count(scroll.viewport_rows ?? pane.viewport_rows),
    }
  })
  const focusedWorkspace = workspaceRecords.find((workspace) => workspace.focused)
  const focusedTab = tabRecords.find((tab) => tab.focused)
  const focusedPane = paneRecords.find((pane) => pane.focused)
  return {
    workspaces: workspaceRecords,
    tabs: tabRecords,
    panes: paneRecords,
    focused_workspace_id: focusedWorkspace?.workspace_id ?? null,
    focused_tab_id: focusedTab?.tab_id ?? null,
    focused_pane_id: focusedPane?.pane_id ?? null,
    version: "alma",
    protocol: 1,
  }
}
