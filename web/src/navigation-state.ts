import type { PaneRecord, SessionSnapshot } from "./api.js"

export type AgentStatus = "working" | "blocked" | "done"

// Only explicit agent states from a connected desktop are useful to the UI.
export function agentStatus(pane: PaneRecord, connected = true): AgentStatus | "" {
  if (!connected || !pane.agent?.trim()) return ""
  const status = pane.agent_status
  return status === "working" || status === "blocked" || status === "done" ? status : ""
}

export function agentStatusLabel(status: AgentStatus | ""): string {
  return status === "blocked" ? "Needs input" : status === "working" ? "Working" : status === "done" ? "Done" : ""
}

export function detailNavigation(snapshot: SessionSnapshot | null, pane: PaneRecord | null, connected: boolean) {
  const available = pane !== null && snapshot?.panes.some((entry) => entry.pane_id === pane.pane_id) === true
  return {
    input: available && connected,
    switcher: available && (snapshot?.panes.length ?? 0) > 1,
    tree: (snapshot?.panes.length ?? 0) > 1,
  }
}
