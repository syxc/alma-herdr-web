import type { SessionSnapshot } from "./api.js"
import { ICONS } from "./icons.js"
import { type AgentStatus, agentStatus, agentStatusLabel } from "./navigation-state.js"
import { paneNumbers } from "./session-list.js"

interface TreeOptions {
  snapshot: SessionSnapshot | null
  selectedPaneId: string | null
  connected?: boolean
  collapsedWorkspaces?: Set<string>
  onWorkspace(id: string): void
  onTab(id: string): void
  onPane(id: string): void
}

export function renderWorkspaceTree(container: HTMLElement, options: TreeOptions): void {
  const { snapshot, selectedPaneId, collapsedWorkspaces = new Set<string>(), onWorkspace, onTab, onPane } = options
  const doc = container.ownerDocument
  container.replaceChildren()
  if (snapshot === null) return
  const numbers = paneNumbers(snapshot.panes)

  function row(
    kind: string,
    label: string,
    status: AgentStatus | "",
    pick: () => void,
    available = true,
  ): HTMLButtonElement {
    const button = doc.createElement("button")
    button.type = "button"
    button.className = `row ${kind.toLowerCase()}`
    button.title = `${kind}: ${label}${status ? ` · ${agentStatusLabel(status)}` : ""}`
    button.disabled = options.connected === false || !available
    if (options.connected === false) button.title += " · Reconnect to open"
    else if (!available) button.title += " · No terminal is open"
    button.setAttribute("aria-label", button.title)
    const copy = doc.createElement("span")
    copy.className = "tree-copy"
    if (kind !== "Pane") {
      const type = doc.createElement("span")
      type.className = "tree-kind"
      type.textContent = kind
      copy.append(type)
    }
    const name = doc.createElement("span")
    name.className = "label"
    name.textContent = label
    copy.append(name)
    button.append(copy)
    if (status) {
      const dot = doc.createElement("span")
      dot.className = `dot ${status}`
      dot.setAttribute("aria-hidden", "true")
      button.append(dot)
    }
    button.addEventListener("click", pick)
    return button
  }

  for (const workspace of snapshot.workspaces) {
    const section = doc.createElement("section")
    section.className = "tree-workspace"
    section.setAttribute("aria-label", workspace.label || workspace.workspace_id)
    const name = workspace.label || workspace.workspace_id
    const heading = doc.createElement("div")
    heading.className = "workspace-heading"
    const workspaceRow = row(
      "Workspace",
      name,
      "",
      () => {
        collapsedWorkspaces.delete(workspace.workspace_id)
        updateExpanded()
        onWorkspace(workspace.workspace_id)
      },
      snapshot.panes.some((pane) => pane.workspace_id === workspace.workspace_id),
    )
    workspaceRow.dataset.workspace = workspace.workspace_id
    const count = doc.createElement("span")
    count.className = "count"
    count.textContent = `${workspace.tab_count} ${workspace.tab_count === 1 ? "tab" : "tabs"}`
    workspaceRow.title = `${workspaceRow.title} · ${count.textContent}`
    workspaceRow.setAttribute("aria-label", workspaceRow.title)
    workspaceRow.append(count)
    const tabs = doc.createElement("ul")
    tabs.className = "tree-tabs"
    tabs.id = `workspace-tabs-${encodeURIComponent(workspace.workspace_id)}`
    const toggle = doc.createElement("button")
    toggle.type = "button"
    toggle.className = "workspace-toggle"
    toggle.setAttribute("aria-controls", tabs.id)
    function updateExpanded(): void {
      const expanded = !collapsedWorkspaces.has(workspace.workspace_id)
      tabs.classList.toggle("hidden", !expanded)
      toggle.setAttribute("aria-expanded", String(expanded))
      toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${name}`)
      toggle.innerHTML = expanded ? ICONS.fold : ICONS.chevron
    }
    toggle.addEventListener("click", () => {
      if (collapsedWorkspaces.has(workspace.workspace_id)) collapsedWorkspaces.delete(workspace.workspace_id)
      else collapsedWorkspaces.add(workspace.workspace_id)
      updateExpanded()
    })
    updateExpanded()
    heading.append(workspaceRow, toggle)
    section.append(heading)
    for (const tab of snapshot.tabs.filter((candidate) => candidate.workspace_id === workspace.workspace_id)) {
      const tabPanes = snapshot.panes.filter((candidate) => candidate.tab_id === tab.tab_id)
      const item = doc.createElement("li")
      item.className = "tree-tab"
      // A merged core tab has no friendly label. Show the same consecutive
      // number as the list and switcher instead of its long opaque id.
      const firstNumber = tabPanes.length > 0 ? numbers.get(tabPanes[0]!.pane_id) : undefined
      const tabLabel = tab.label || (firstNumber === undefined ? "" : String(firstNumber))
      const tabRow = row("Tab", tabLabel, "", () => onTab(tab.tab_id), tabPanes.length > 0)
      tabRow.dataset.tab = tab.tab_id
      item.append(tabRow)
      const panes = doc.createElement("ul")
      panes.className = "tree-panes"
      for (const pane of tabPanes) {
        const paneItem = doc.createElement("li")
        const title = pane.terminal_title_stripped || pane.title || pane.label || pane.agent || "Pane"
        const paneRow = row("Pane", title, agentStatus(pane, options.connected), () => onPane(pane.pane_id))
        paneRow.dataset.pane = pane.pane_id
        if (pane.pane_id === selectedPaneId) {
          paneRow.classList.add("selected")
          paneRow.setAttribute("aria-current", "true")
        }
        paneItem.append(paneRow)
        panes.append(paneItem)
      }
      item.append(panes)
      tabs.append(item)
    }
    section.append(tabs)
    container.append(section)
  }
}
