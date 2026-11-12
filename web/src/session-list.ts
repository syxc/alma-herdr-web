import type { PaneRecord, SessionSnapshot } from "./api.js"
import { ICONS } from "./icons.js"

export interface SessionListOptions {
  snapshot: SessionSnapshot
  selectedPaneId: string | null
  onPick(paneId: string): void
}

const GROUPS: { key: string; label: string; match(status: string): boolean }[] = [
  { key: "working", label: "Working", match: (status) => status === "working" },
  { key: "blocked", label: "Blocked", match: (status) => status === "blocked" },
  {
    key: "settled",
    label: "Settled",
    match: (status) => status !== "working" && status !== "blocked",
  },
]

const COLLAPSED_KEY = "alma-herdr-web:collapsed-groups"

function readCollapsed(): string[] {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY)
    if (raw === null) {
      return []
    }
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return []
  }
}

function writeCollapsed(keys: string[]): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(keys))
  } catch {
    // The choice only lives as long as the page.
  }
}

export function paneNumbers(panes: readonly PaneRecord[]): Map<string, number> {
  return new Map(panes.map((pane, index) => [pane.pane_id, index + 1]))
}

export function statusClass(status: string): string {
  return ["working", "blocked", "done", "idle"].includes(status) ? status : ""
}

function shortPath(path: string): string {
  const parts = path.split("/")
  if (parts.length > 3 && parts[0] === "" && parts[1] === "Users") {
    return `~/${parts.slice(3).join("/")}`
  }
  return path
}

function subtitle(pane: PaneRecord): { glyph: string; text: string } {
  const title = pane.terminal_title_stripped || pane.title || ""
  if (pane.agent !== null && pane.agent.length > 0) {
    const parts = [title.length > 0 ? title : pane.agent]
    if (pane.cwd !== null && pane.cwd.length > 0) {
      parts.push(shortPath(pane.cwd))
    }
    return { glyph: ICONS.agent, text: parts.join(" · ") }
  }
  return { glyph: ICONS.folder, text: shortPath(pane.cwd ?? pane.pane_id) }
}

export function renderSessionList(container: HTMLElement, options: SessionListOptions): void {
  const { snapshot, selectedPaneId, onPick } = options
  container.replaceChildren()

  const panes = snapshot.panes
  if (panes.length === 0) {
    const empty = document.createElement("div")
    empty.className = "session-empty"
    empty.textContent = "No terminal is open on this desktop yet."
    container.appendChild(empty)
    return
  }

  const collapsed = readCollapsed()
  const number = paneNumbers(panes)

  for (const group of GROUPS) {
    const members = panes.filter((pane) => group.match(pane.agent_status))
    if (members.length === 0) {
      continue
    }
    const isCollapsed = collapsed.includes(group.key)

    const head = document.createElement("button")
    head.type = "button"
    head.className = "section-head"
    const label = document.createElement("span")
    label.textContent = group.label
    const chevron = document.createElement("span")
    chevron.className = "chevron"
    chevron.innerHTML = isCollapsed ? ICONS.unfold : ICONS.fold
    head.append(label, chevron)
    head.addEventListener("click", () => {
      const current = readCollapsed()
      const next = current.includes(group.key) ? current.filter((key) => key !== group.key) : current.concat(group.key)
      writeCollapsed(next)
      renderSessionList(container, options)
    })
    container.appendChild(head)

    if (isCollapsed) {
      continue
    }

    for (const pane of members) {
      const row = document.createElement("button")
      row.type = "button"
      row.className = `session-row${pane.pane_id === selectedPaneId ? " selected" : ""}`
      row.dataset.pane = pane.pane_id

      const body = document.createElement("span")
      body.className = "session-body"

      const index = document.createElement("span")
      index.className = "session-number"
      index.textContent = String(number.get(pane.pane_id) ?? 1)

      const sub = document.createElement("span")
      sub.className = "session-sub"
      const glyph = document.createElement("span")
      glyph.className = "glyph"
      const text = subtitle(pane)
      glyph.innerHTML = text.glyph
      const path = document.createElement("span")
      path.className = "path"
      path.textContent = text.text
      sub.append(glyph, path)

      body.append(index, sub)

      const tail = document.createElement("span")
      tail.className = "session-tail"
      // The Alma app marks a pane that is not idle with a dot.
      const tone = statusClass(pane.agent_status)
      if (tone !== "" && tone !== "idle") {
        const dot = document.createElement("span")
        dot.className = `dot ${tone}`
        tail.appendChild(dot)
      }
      const chevron = document.createElement("span")
      chevron.className = "chevron"
      chevron.innerHTML = ICONS.chevron
      tail.appendChild(chevron)

      row.append(body, tail)
      row.addEventListener("click", () => {
        onPick(pane.pane_id)
      })
      container.appendChild(row)
    }
  }
}
