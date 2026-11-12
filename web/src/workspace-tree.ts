import type { SessionSnapshot } from "./api.js"
import { ICONS } from "./icons.js"
import { statusClass } from "./session-list.js"

interface TreeOptions {
  snapshot: SessionSnapshot | null
  selectedPaneId: string | null
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

  function row(kind: string, label: string, status: string, pick: () => void): HTMLButtonElement {
    const button = doc.createElement("button")
    button.type = "button"
    button.className = `row ${kind.toLowerCase()}`
    button.title = `${kind}: ${label} · ${status}`
    button.setAttribute("aria-label", button.title)
    const copy = doc.createElement("span")
    copy.className = "tree-copy"
    const type = doc.createElement("span")
    type.className = "tree-kind"
    type.textContent = kind
    const name = doc.createElement("span")
    name.className = "label"
    name.textContent = label
    copy.append(type, name)
    const dot = doc.createElement("span")
    dot.className = `dot ${statusClass(status)}`
    dot.setAttribute("aria-hidden", "true")
    button.append(copy, dot)
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
    const workspaceRow = row("Workspace", name, workspace.agent_status, () => {
      collapsedWorkspaces.delete(workspace.workspace_id)
      updateExpanded()
      onWorkspace(workspace.workspace_id)
    })
    workspaceRow.dataset.workspace = workspace.workspace_id
    const count = doc.createElement("span")
    count.className = "count"
    count.textContent = `${workspace.tab_count} ${workspace.tab_count === 1 ? "tab" : "tabs"}`
    workspaceRow.title = `${workspaceRow.title} · ${count.textContent}`
    workspaceRow.setAttribute("aria-label", workspaceRow.title)
    workspaceRow.insertBefore(count, workspaceRow.lastChild)
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
      const item = doc.createElement("li")
      item.className = "tree-tab"
      const tabRow = row("Tab", tab.label || tab.tab_id, tab.agent_status, () => onTab(tab.tab_id))
      tabRow.dataset.tab = tab.tab_id
      item.append(tabRow)
      const panes = doc.createElement("ul")
      panes.className = "tree-panes"
      for (const pane of snapshot.panes.filter((candidate) => candidate.tab_id === tab.tab_id)) {
        const paneItem = doc.createElement("li")
        const title = pane.terminal_title_stripped || pane.title || pane.agent || pane.pane_id
        const paneRow = row("Pane", title, pane.agent_status, () => onPane(pane.pane_id))
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
