import { agentKind, agentLabel, resumeArgs } from "./agents.js"
import type { PaneRecord, SessionSnapshot } from "./api.js"
import { appendAppearanceControl } from "./appearance.js"
import { ICONS } from "./icons.js"
import { TerminalInput } from "./input.js"
import { KeyToolbar } from "./key-toolbar.js"
import { paneNumbers, statusClass } from "./session-list.js"
import type { FitMode } from "./terminal.js"
import { terminalSelection } from "./terminal-selection.js"

export interface DetailCallbacks {
  pickPane(paneId: string): void
  sendText(pane: PaneRecord, text: string): Promise<void>
  sendKeys(pane: PaneRecord, keys: string[]): Promise<void>
  restartAgent(pane: PaneRecord, continueAfter: boolean): Promise<void>
  toggleTree(): void
  back(): void
  status(message: string, isError: boolean): void
  setFitMode(mode: FitMode): void
  paneSize(): { cols: number; rows: number }
  clearSelection?(): void
  connectionInfo?(): string
}

const MODE_KEY = "alma-herdr-web:fit-mode"

function isPhone(): boolean {
  return window.matchMedia("(max-width: 760px)").matches
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) {
    throw new Error(`missing element: ${id}`)
  }
  return node as T
}

function readMode(): FitMode {
  try {
    const raw = window.localStorage.getItem(MODE_KEY)
    if (raw === "original" || raw === "shrink" || raw === "wrap") {
      return raw
    }
  } catch {
    // The choice then lives only as long as the page.
  }
  return window.matchMedia("(max-width: 760px)").matches ? "wrap" : "original"
}

export class DetailScreen {
  private readonly actions: DetailCallbacks
  private snapshot: SessionSnapshot | null = null
  private pane: PaneRecord | null = null
  private mode: FitMode = "wrap"
  private actionSignature = ""

  private readonly tabSwitch = el<HTMLButtonElement>("tab-switch")
  private readonly tabNumber = el<HTMLSpanElement>("tab-number")
  private readonly tabMenu = el<HTMLDivElement>("tab-menu")
  private readonly actionMenu = el<HTMLDivElement>("action-menu")
  private readonly detailDot = el<HTMLSpanElement>("detail-dot")
  private readonly detailStatus = el<HTMLSpanElement>("detail-status")
  private readonly detailTitle = el<HTMLSpanElement>("detail-title")
  private readonly keyChips = el<HTMLDivElement>("key-chips")
  private readonly shortcutBar = el<HTMLDivElement>("shortcut-bar")
  private readonly commandInput = el<HTMLInputElement>("command-input")
  private readonly commandSend = el<HTMLButtonElement>("command-send")
  private readonly keysToggle = el<HTMLButtonElement>("keys-toggle")
  private readonly keyboardToggle = el<HTMLButtonElement>("keyboard-toggle")
  private readonly canvas = el<HTMLCanvasElement>("terminal")
  private readonly keyToolbar: KeyToolbar
  private readonly input: TerminalInput
  private inputPaneId: string | null = null

  constructor(actions: DetailCallbacks) {
    this.actions = actions
    this.mode = readMode()
    this.actions.setFitMode(this.mode)
    this.input = new TerminalInput(this.commandInput, this.canvas, {
      sendText: (text) => {
        const pane = this.pane
        if (pane !== null) {
          void this.actions.sendText(pane, text)
        }
      },
      sendKeys: (keys) => {
        const pane = this.pane
        if (pane !== null) {
          void this.actions.sendKeys(pane, keys)
        }
      },
    })
    this.keyToolbar = new KeyToolbar(
      this.keyChips,
      el("extra-keys"),
      el("input-mode"),
      this.input,
      this.commandInput,
      this.canvas,
      this.actions.status,
      () => {
        this.closeActionMenu()
        this.closeTabMenu()
      },
    )
    this.wire()
  }

  private wire(): void {
    el<HTMLButtonElement>("detail-back").addEventListener("click", () => {
      this.closeMenus()
      this.actions.back()
    })
    el<HTMLButtonElement>("tree-toggle").addEventListener("click", () => {
      this.closeMenus()
      this.actions.toggleTree()
    })
    el<HTMLButtonElement>("detail-more").addEventListener("click", () => {
      if (this.actionMenu.classList.contains("hidden")) {
        this.keyToolbar.closeMenu()
        this.renderActionMenu()
        this.actionMenu.classList.remove("hidden")
        this.closeTabMenu()
      } else {
        this.closeActionMenu()
      }
    })

    this.tabSwitch.addEventListener("click", () => {
      if (this.tabMenu.classList.contains("hidden")) {
        this.keyToolbar.closeMenu()
        this.renderTabMenu()
        this.tabMenu.classList.remove("hidden")
        this.closeActionMenu()
      } else {
        this.closeTabMenu()
      }
    })

    this.keysToggle.addEventListener("click", () => {
      const visible = !this.shortcutBar.classList.toggle("hidden")
      this.keysToggle.setAttribute("aria-expanded", String(visible))
      this.keysToggle.setAttribute("aria-label", visible ? "Hide terminal shortcuts" : "Show terminal shortcuts")
      this.keyToolbar.closeMenu()
    })
    this.keyboardToggle.addEventListener("click", () => {
      // The field is the input surface of the phone: every key it takes
      // goes to the pane right away.
      this.input.focusField()
    })

    for (const button of [this.keysToggle, this.commandSend]) {
      button.addEventListener("mousedown", (event) => event.preventDefault())
    }
    this.commandSend.addEventListener("click", () => {
      this.keyToolbar.submit()
    })

    el("terminal-view").addEventListener("click", () => {
      // A drag or long press must retain native selection instead of opening the keyboard.
      if (terminalSelection(this.canvas) !== null) return
      if (isPhone()) this.input.focusField()
      else this.input.focusScreen()
    })
    const detailMore = el<HTMLButtonElement>("detail-more")
    document.addEventListener("click", (event) => {
      const target = event.target as Node | null
      if (target === null) {
        return
      }
      if (this.actionMenu.contains(target) || this.tabMenu.contains(target) || this.keyToolbar.contains(target)) {
        return
      }
      // The button that opens a menu must not close it again right away.
      if (detailMore.contains(target) || this.tabSwitch.contains(target)) {
        return
      }
      this.closeMenus()
    })
  }

  private renderTabMenu(): void {
    this.tabMenu.replaceChildren()
    const snapshot = this.snapshot
    if (snapshot === null) {
      return
    }
    for (const workspace of snapshot.workspaces) {
      for (const tab of snapshot.tabs.filter((t) => t.workspace_id === workspace.workspace_id)) {
        for (const pane of snapshot.panes.filter((p) => p.tab_id === tab.tab_id)) {
          const item = document.createElement("button")
          item.type = "button"
          item.className = `popover-item${pane.pane_id === this.pane?.pane_id ? " selected" : ""}`
          const glyph = document.createElement("span")
          glyph.className = "popover-glyph quiet"
          glyph.innerHTML = pane.agent !== null ? ICONS.agent : ICONS.folder
          const text = document.createElement("span")
          text.className = "popover-text"
          const label = document.createElement("span")
          label.className = "popover-label"
          const title = pane.terminal_title_stripped || pane.title || pane.pane_id
          label.textContent = `${tab.label || tab.tab_id} · ${title}`
          const hint = document.createElement("span")
          hint.className = "popover-hint"
          hint.textContent = pane.agent_status
          text.append(label, hint)
          item.append(glyph, text)
          item.addEventListener("click", () => {
            this.closeMenus()
            void this.actions.pickPane(pane.pane_id)
          })
          this.tabMenu.appendChild(item)
        }
      }
    }
  }

  private renderActionMenu(): void {
    const connection = this.actions.connectionInfo?.() ?? ""
    const signature = JSON.stringify([
      this.mode,
      this.pane?.pane_id,
      this.pane?.agent,
      this.pane?.agent_session,
      connection,
    ])
    const size = this.actions.paneSize()
    const dimensions = `Pane is ${size.cols} × ${size.rows}`
    if (signature === this.actionSignature) {
      const foot = this.actionMenu.querySelector(".popover-foot:not(.connection-info)")
      if (foot !== null) foot.textContent = dimensions
      return
    }
    this.actionSignature = signature
    this.actionMenu.replaceChildren()

    const modes: { key: FitMode; label: string; hint: string; glyph: string }[] = [
      { key: "wrap", label: "Wrap to Phone", hint: "Wrap wide output at the current window width", glyph: ICONS.wrap },
      {
        key: "original",
        label: "Original Width",
        hint: "Keep the original width; scroll sideways if needed",
        glyph: ICONS.width,
      },
      {
        key: "shrink",
        label: "Shrink to Fit",
        hint: "Shrink wide output only; keep smaller output at normal size",
        glyph: ICONS.shrink,
      },
    ]
    for (const mode of modes) {
      const active = mode.key === this.mode
      this.actionMenu.appendChild(
        this.item(
          active ? ICONS.check : mode.glyph,
          mode.label,
          mode.hint,
          () => {
            this.setMode(mode.key)
            this.closeActionMenu()
          },
          active,
        ),
      )
    }
    this.actionMenu.appendChild(this.separator())

    appendAppearanceControl(this.actionMenu)
    this.actionMenu.appendChild(this.separator())
    this.renderAgentActions()

    if (connection.length > 0) {
      const info = document.createElement("div")
      info.className = "popover-foot connection-info"
      info.textContent = connection
      this.actionMenu.appendChild(info)
    }
    const foot = document.createElement("div")
    foot.className = "popover-foot"
    foot.textContent = dimensions
    this.actionMenu.appendChild(foot)
  }

  private renderAgentActions(): void {
    const pane = this.pane
    if (pane === null) {
      return
    }
    const kind = agentKind(pane)
    if (kind.length === 0) {
      return
    }
    const label = agentLabel(kind)
    const canContinue = resumeArgs(pane) !== null

    this.actionMenu.appendChild(
      this.item(ICONS.restart, `Restart ${label}`, "Quit the agent and start it again", () => {
        this.closeActionMenu()
        if (this.pane !== null) void this.actions.restartAgent(this.pane, false)
      }),
    )
    this.actionMenu.appendChild(
      this.item(
        ICONS.restartContinue,
        "Restart & Continue",
        canContinue ? "Open the same session and carry on" : "This pane has no session to open",
        () => {
          this.closeActionMenu()
          if (this.pane !== null) void this.actions.restartAgent(this.pane, true)
        },
        false,
        !canContinue,
      ),
    )
    this.actionMenu.appendChild(this.separator())
  }

  private item(
    glyph: string,
    label: string,
    hint: string,
    onClick: () => void,
    strongGlyph = false,
    disabled = false,
  ): HTMLButtonElement {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "popover-item"
    button.disabled = disabled
    const mark = document.createElement("span")
    mark.className = `popover-glyph${strongGlyph ? " on" : ""}`
    mark.innerHTML = glyph
    const text = document.createElement("span")
    text.className = "popover-text"
    const title = document.createElement("span")
    title.className = "popover-label"
    title.textContent = label
    text.appendChild(title)
    if (hint.length > 0) {
      const sub = document.createElement("span")
      sub.className = "popover-hint"
      sub.textContent = hint
      text.appendChild(sub)
    }
    button.append(mark, text)
    button.addEventListener("click", onClick)
    return button
  }

  private separator(): HTMLDivElement {
    const line = document.createElement("div")
    line.className = "popover-sep"
    return line
  }

  setMode(mode: FitMode): void {
    this.mode = mode
    try {
      window.localStorage.setItem(MODE_KEY, mode)
    } catch {
      // The choice then lives only as long as the page.
    }
    this.actions.setFitMode(mode)
  }

  update(snapshot: SessionSnapshot | null, pane: PaneRecord | null): void {
    this.snapshot = snapshot
    const paneId = pane?.pane_id ?? null
    if (paneId !== this.inputPaneId) {
      this.actions.clearSelection?.()
      // Flush while the sink still points to the old pane.
      this.input.reset()
      this.keyToolbar.reset()
      this.inputPaneId = paneId
    }
    this.pane = pane
    this.input.setEnabled(pane !== null)
    this.keyToolbar.setEnabled(pane !== null)
    this.commandInput.disabled = pane === null
    this.commandSend.disabled = pane === null
    this.keyboardToggle.disabled = pane === null

    if (pane === null) {
      this.tabNumber.textContent = "—"
      this.detailStatus.textContent = "no pane"
      this.detailTitle.textContent = ""
      this.detailDot.className = "dot"
      if (!this.actionMenu.classList.contains("hidden")) {
        this.renderActionMenu()
      }
      return
    }

    const number = paneNumbers(snapshot?.panes ?? []).get(pane.pane_id)
    this.tabNumber.textContent = number === undefined ? "—" : String(number)
    this.detailStatus.textContent = pane.agent_status
    // The name under the number is the workspace, the Alma app names it
    // that way too.
    const workspace = snapshot?.workspaces.find((w) => w.workspace_id === pane.workspace_id)
    this.detailTitle.textContent = workspace?.label || pane.terminal_title_stripped || pane.title || pane.pane_id
    this.detailDot.className = `dot ${statusClass(pane.agent_status)}`
    if (!this.actionMenu.classList.contains("hidden")) {
      this.renderActionMenu()
    }
  }

  focusTerminal(): void {
    if (!isPhone()) {
      this.input.focusScreen()
    }
  }

  closeTabMenu(): void {
    this.tabMenu.classList.add("hidden")
    this.tabSwitch.setAttribute("aria-expanded", "false")
  }

  closeActionMenu(): void {
    this.actionMenu.classList.add("hidden")
  }

  closeMenus(): void {
    this.closeTabMenu()
    this.closeActionMenu()
    this.keyToolbar.closeMenu()
  }
}
