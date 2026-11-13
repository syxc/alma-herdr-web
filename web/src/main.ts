import {
  type AgentEvent,
  closeRemote,
  connectEvents,
  connectRelay,
  createTerminalTab,
  disconnectEvents,
  disconnectRelay,
  fetchRelayStatus,
  fetchState,
  focusPane,
  hasLocalApi,
  needsStatePolling,
  openAlmaRemote,
  openRemote,
  type PaneRecord,
  promptAgent,
  readPane,
  rotateRelay,
  type SessionSnapshot,
  sendKeys,
  sendText,
  setUnauthorizedHandler,
  startAgent,
} from "./api.js"
import { appendAppearanceControl, initAppearance } from "./appearance.js"
import { authStatus, signIn, signOut } from "./auth.js"
import { DetailScreen } from "./detail.js"
import { createAgentTerminal, type NewTabAgent, NewTerminalMenu } from "./new-terminal.js"
import { forgetPairing, type Pairing, readPairing, readSavedPairing, savePairing } from "./pairing.js"
import { restartAgent as runRestart } from "./restart.js"
import { type ScannerHandle, startScanner } from "./scanner.js"
import { renderSessionList } from "./session-list.js"
import { type FitMode, TerminalView } from "./terminal.js"
import { type ScrollDirection, TerminalHistory } from "./terminal-scroll.js"
import { renderWorkspaceTree } from "./workspace-tree.js"

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) {
    throw new Error(`missing element: ${id}`)
  }
  return node as T
}

const app = el<HTMLDivElement>("app")
const startupScreen = el<HTMLElement>("screen-startup")
const startupNote = el<HTMLElement>("startup-note")
const startupRetry = el<HTMLButtonElement>("startup-retry")
const loginScreen = el<HTMLElement>("screen-login")
const listScreen = el<HTMLElement>("screen-list")
const detailScreen = el<HTMLElement>("screen-detail")
const loginForm = el<HTMLFormElement>("login-form")
const loginPassword = el<HTMLInputElement>("login-password")
const loginNote = el<HTMLParagraphElement>("login-note")
const sessionList = el<HTMLDivElement>("session-list")
const listMenu = el<HTMLDivElement>("list-menu")
const tree = el<HTMLDivElement>("tree")
const connectionPill = el<HTMLSpanElement>("connection")
const statusbar = el<HTMLDivElement>("statusbar")
const terminalCanvas = el<HTMLCanvasElement>("terminal")
const remoteBanner = el<HTMLElement>("remote-banner")
const relayUrlInput = el<HTMLInputElement>("relay-url")
const relayTokenInput = el<HTMLInputElement>("relay-token")
const relayConnect = el<HTMLButtonElement>("relay-connect")
const relayDisconnect = el<HTMLButtonElement>("relay-disconnect")
const relayRotate = el<HTMLButtonElement>("relay-rotate")
const relayState = el<HTMLDivElement>("relay-state")
const relayPair = el<HTMLDivElement>("relay-pair")
const relayQr = el<HTMLImageElement>("relay-qr")
const relayLink = el<HTMLElement>("relay-link")
const relayQrLan = el<HTMLImageElement>("relay-qr-lan")
const relayLinkLan = el<HTMLElement>("relay-link-lan")
const relayQrLanBox = el<HTMLDivElement>("relay-qr-lan-box")
const pairPanel = el<HTMLElement>("pair-panel")
const pairInput = el<HTMLInputElement>("pair-input")
const pairApply = el<HTMLButtonElement>("pair-apply")
const pairScan = el<HTMLButtonElement>("pair-scan")
const pairNote = el<HTMLParagraphElement>("pair-note")
const scanPanel = el<HTMLDivElement>("scan-panel")
const scanVideo = el<HTMLVideoElement>("scan-video")
const scanStatus = el<HTMLSpanElement>("scan-status")
const scanStop = el<HTMLButtonElement>("scan-stop")
const sidebar = el<HTMLElement>("sidebar")
const scrim = el<HTMLElement>("scrim")
const desktopSharing = el<HTMLDialogElement>("desktop-sharing")
const qrNote = el<HTMLElement>("qr-note")

let scanner: ScannerHandle | null = null

let desktopConnected = false
let desktopSidebarOpen = true
let phoneDrawerOpen = false
let phoneLayout = window.matchMedia("(max-width: 760px)").matches
let drawerReturnFocus: HTMLElement | null = null

let localApi = true
let authRequired = false
let currentScreen: "login" | "list" | "detail" = "login"
let stateRefreshNeeded = false

const terminal = new TerminalView(terminalCanvas, (direction) => void scrollHistory(direction))
const terminalHistories = new Map<string, TerminalHistory>()
initAppearance((theme) => void terminal.setTheme(theme))
appendAppearanceControl(loginNote.parentElement ?? loginScreen)

let snapshot: SessionSnapshot | null = null
let selectedPaneId: string | null = null
let pendingTerminal: object | null = null
let activePairing: Pairing | null = null
let pairingBusy = false
let reconnectNeeded = false
let reconnectAt = 0
let pollBusy = false
let pollTimer: number | null = null
let connectionGeneration = 0
let lastSignature = ""
const collapsedWorkspaces = new Set<string>()

const SELECTION_KEY = "alma-herdr-web:selection"

interface Selection {
  paneId: string
  tabId: string
  screen?: "list" | "detail"
}

function readSelection(): Selection | null {
  try {
    const raw = window.localStorage.getItem(SELECTION_KEY)
    if (raw === null) {
      return null
    }
    const parsed = JSON.parse(raw) as Partial<Selection>
    if (typeof parsed.paneId !== "string" || parsed.paneId.length === 0) {
      return null
    }
    return {
      paneId: parsed.paneId,
      tabId: typeof parsed.tabId === "string" ? parsed.tabId : "",
      screen: parsed.screen === "list" ? "list" : "detail",
    }
  } catch {
    // A browser that refuses to store anything still works, the choice
    // then lives only as long as the page.
    return null
  }
}

function writeSelection(selection: Selection): void {
  try {
    window.localStorage.setItem(SELECTION_KEY, JSON.stringify(selection))
  } catch {
    // Nothing to do: the choice is kept in memory either way.
  }
}

function hasSelectedPane(state: SessionSnapshot): boolean {
  if (selectedPaneId === null) {
    return false
  }
  return state.panes.some((pane) => pane.pane_id === selectedPaneId)
}

function pickPane(state: SessionSnapshot): string | null {
  const stored = readSelection()
  if (stored !== null) {
    const pane = state.panes.find((candidate) => candidate.pane_id === stored.paneId)
    if (pane !== undefined) {
      return pane.pane_id
    }
    if (stored.tabId.length > 0) {
      const tabPane = state.panes.find((candidate) => candidate.tab_id === stored.tabId)
      if (tabPane !== undefined) {
        return tabPane.pane_id
      }
    }
  }
  if (state.focused_pane_id !== null) {
    const focused = state.panes.find((candidate) => candidate.pane_id === state.focused_pane_id)
    if (focused !== undefined) {
      return focused.pane_id
    }
  }
  if (state.focused_tab_id !== null) {
    const tabPane = state.panes.find((candidate) => candidate.tab_id === state.focused_tab_id)
    if (tabPane !== undefined) {
      return tabPane.pane_id
    }
  }
  return state.panes[0]?.pane_id ?? null
}

function setStatus(message: string, isError: boolean): void {
  statusbar.textContent = message
  statusbar.classList.toggle("error", isError)
}

function isPhone(): boolean {
  return window.matchMedia("(max-width: 760px)").matches
}

function showScreen(screen: "login" | "list" | "detail"): void {
  if (screen !== "detail") terminal.clearSelection()
  if (screen !== "list") stopScanner()
  if (screen === "login" && currentScreen !== "login") connectionGeneration += 1
  const leavingDrawer = isPhone() && phoneDrawerOpen
  newTerminalMenu.close()
  closeListMenu()
  detail.closeMenus()
  phoneDrawerOpen = false
  currentScreen = screen
  const pane = selectedPane()
  if (pane !== null && screen !== "login") {
    writeSelection({ paneId: pane.pane_id, tabId: pane.tab_id, screen })
  }
  startupScreen.classList.add("hidden")
  loginScreen.classList.toggle("hidden", screen !== "login")
  app.classList.toggle("hidden", screen === "login")
  listScreen.classList.toggle("hidden", screen !== "list")
  detailScreen.classList.toggle("hidden", screen !== "detail")
  syncDrawer()
  if (leavingDrawer) el(screen === "detail" ? "detail-more" : "list-more").focus()
  if (screen === "detail") {
    terminal.resize()
  }
}

function syncDrawer(): void {
  const available = currentScreen === "detail" && (snapshot?.panes.length ?? 0) > 1
  const open = available && (isPhone() ? phoneDrawerOpen : desktopSidebarOpen)
  sidebar.classList.toggle("open", isPhone() && open)
  scrim.classList.toggle("hidden", !isPhone() || !open)
  app.classList.toggle("no-sidebar", !available || !desktopSidebarOpen)
  sidebar.inert = !open
  sidebar.setAttribute("aria-hidden", String(!open))
  el("main").inert = isPhone() && open
  const toggle = el<HTMLButtonElement>("tree-toggle")
  toggle.setAttribute("aria-expanded", String(open))
  toggle.setAttribute("aria-label", open ? "Hide the sessions" : "Show the sessions")
}

function setDrawer(open: boolean, restoreFocus = false): void {
  detail.closeMenus()
  if (isPhone()) {
    if (open) drawerReturnFocus = document.activeElement as HTMLElement | null
    phoneDrawerOpen = open
  } else desktopSidebarOpen = open
  syncDrawer()
  if (isPhone() && open) tree.querySelector<HTMLButtonElement>("button")?.focus()
  else if (restoreFocus) drawerReturnFocus?.focus()
}

function selectedPane(): PaneRecord | null {
  if (snapshot === null || selectedPaneId === null) {
    return null
  }
  return snapshot.panes.find((pane) => pane.pane_id === selectedPaneId) ?? null
}

function renderTree(): void {
  renderWorkspaceTree(tree, {
    snapshot,
    selectedPaneId,
    connected: desktopConnected && !pairingBusy,
    collapsedWorkspaces,
    onWorkspace: (id) => void selectWorkspace(id),
    onTab: (id) => void selectTab(id),
    onPane: (id) => void selectPane(id),
  })
}

function renderList(): void {
  if (snapshot === null) {
    sessionList.replaceChildren()
    return
  }
  renderSessionList(sessionList, {
    snapshot,
    selectedPaneId,
    connected: desktopConnected && !pairingBusy,
    onPick: (paneId) => {
      void selectPane(paneId)
    },
  })
}

const detail = new DetailScreen({
  pickPane: (paneId) => {
    void selectPane(paneId)
  },
  sendText: async (pane, text) => {
    if (!desktopConnected || pairingBusy || !snapshot?.panes.some((entry) => entry.pane_id === pane.pane_id)) return
    const error = await sendText(pane.pane_id, text)
    if (error !== null) {
      setStatus(`send failed: ${error}`, true)
    }
  },
  sendKeys: async (pane, keys) => {
    if (!desktopConnected || pairingBusy || !snapshot?.panes.some((entry) => entry.pane_id === pane.pane_id)) return
    const error = await sendKeys(pane.pane_id, keys)
    if (error !== null) {
      setStatus(`send failed: ${error}`, true)
    }
  },
  restartAgent: async (pane, continueAfter) => {
    if (!desktopConnected || pairingBusy || !snapshot?.panes.some((entry) => entry.pane_id === pane.pane_id)) return
    await runRestart(pane, continueAfter, {
      sendKeys,
      startAgent,
      promptAgent,
      status: (message, isError) => setStatus(message, isError),
    })
    await refreshTerminal()
  },
  toggleTree: () => setDrawer(isPhone() ? !phoneDrawerOpen : !desktopSidebarOpen),
  showList: () => {
    showScreen("list")
    listMore.focus()
  },
  status: (message, isError) => setStatus(message, isError),
  setFitMode: (mode: FitMode) => terminal.setMode(mode),
  paneSize: () => terminal.size(),
  clearSelection: () => terminal.clearSelection(),
  connectionInfo,
})

async function selectPane(paneId: string, focusDesktop = true): Promise<void> {
  if (!desktopConnected || pairingBusy || !snapshot?.panes.some((pane) => pane.pane_id === paneId)) return
  if (selectedPaneId !== paneId) {
    terminal.clearSelection()
    pendingTerminal = null
    void terminal.setContent("", 1)
  }
  selectedPaneId = paneId
  const pane = selectedPane()
  if (pane !== null) {
    // The choice survives a reload.
    writeSelection({ paneId: pane.pane_id, tabId: pane.tab_id })
    collapsedWorkspaces.delete(pane.workspace_id)
  }
  renderTree()
  renderList()
  detail.update(snapshot, pane, desktopConnected && !pairingBusy)
  showScreen("detail")
  // A desktop has a keyboard of its own, so the screen takes it right away.
  detail.focusTerminal()
  try {
    if (focusDesktop) await focusPane(paneId)
  } catch (error) {
    connectionFailed(error)
    return
  }
  // A new pane starts at its newest line.
  terminal.followBottom()
  await refreshTerminal()
  if (isPhone()) {
    // The drawer closes, so the terminal fills the screen again.
    setDrawer(false)
  }
}

async function selectTab(tabId: string): Promise<void> {
  if (snapshot === null) {
    return
  }
  const pane = snapshot.panes.find((p) => p.tab_id === tabId)
  if (pane === undefined) {
    return
  }
  await selectPane(pane.pane_id)
}

async function selectWorkspace(workspaceId: string): Promise<void> {
  if (snapshot === null) {
    return
  }
  const workspace = snapshot.workspaces.find((w) => w.workspace_id === workspaceId)
  if (workspace === undefined) {
    return
  }
  const tab = snapshot.tabs.find((t) => t.tab_id === workspace.active_tab_id)
  const pane =
    (tab !== undefined ? snapshot.panes.find((p) => p.tab_id === tab.tab_id) : undefined) ??
    snapshot.panes.find((p) => p.workspace_id === workspaceId)
  if (pane !== undefined) {
    await selectPane(pane.pane_id)
  }
}

function terminalVisible(): boolean {
  return currentScreen === "detail" && document.visibilityState !== "hidden"
}

function selectedHistory(paneId: string): TerminalHistory {
  const key = `${connectionGeneration}:${paneId}`
  let history = terminalHistories.get(key)
  if (history === undefined) {
    history = new TerminalHistory()
    terminalHistories.set(key, history)
  }
  return history
}

async function scrollHistory(direction: ScrollDirection): Promise<void> {
  const pane = selectedPane()
  if (!desktopConnected || pairingBusy || !terminalVisible() || pane === null) return
  const generation = connectionGeneration
  try {
    const changed = await selectedHistory(pane.pane_id).move(direction, pane.agent, (text) =>
      sendText(pane.pane_id, text),
    )
    if (changed && generation === connectionGeneration && selectedPaneId === pane.pane_id) await refreshTerminal()
  } catch (error) {
    setStatus((error as Error).message, true)
  }
}

async function refreshTerminal(): Promise<void> {
  if (!desktopConnected || pairingBusy || !terminalVisible()) return
  const pane = selectedPane()
  if (pane === null || pendingTerminal !== null) {
    return
  }
  const pending = {}
  pendingTerminal = pending
  const generation = connectionGeneration
  try {
    // Read logical lines so source-side wrapping does not add blank rows or
    // split separators before the view applies its own width.
    const history = selectedHistory(pane.pane_id)
    const read = await readPane(pane.pane_id, "recent_unwrapped", "ansi", history.lines)
    if (read === null) throw new Error("the desktop did not return its screen")
    history.truncated = read.truncated
    if (
      desktopConnected &&
      pendingTerminal === pending &&
      generation === connectionGeneration &&
      pane.pane_id === selectedPaneId &&
      terminalVisible()
    ) {
      await terminal.setContent(read.text, read.vt ? (read.rows ?? pane.viewport_rows) : pane.viewport_rows, read.cols)
    }
  } catch (error) {
    if (pendingTerminal === pending && generation === connectionGeneration) connectionFailed(error)
  } finally {
    if (pendingTerminal === pending) pendingTerminal = null
  }
}

function connectionInfo(): string {
  const status = connectionPill.textContent ?? "offline"
  if (activePairing === null) return localApi ? `Local herdr · ${status}` : "No paired herdr"
  const relay = activePairing.kind === "alma" ? activePairing.relay : activePairing.payload.relay
  return `${status} · Encrypted session via ${relay}`
}

function renderListMenu(): void {
  listMenu.replaceChildren()
  const entries: { label: string; hint: string; run: () => void }[] = [
    {
      label: "Share this desktop",
      hint: "Relay and pairing settings for this local agent",
      run: () => {
        desktopSharing.showModal()
        void refreshRelay()
      },
    },
    {
      label: "Join a remote session",
      hint: "Connects this browser to herdr on another machine",
      run: () => {
        pairPanel.classList.remove("hidden")
        updatePairingView()
        pairInput.focus()
      },
    },
    {
      label: "Forget paired herdr",
      hint: "Disconnects this tab and removes its saved pairing",
      run: () => {
        forgetPairing()
        activePairing = null
        collapsedWorkspaces.clear()
        reconnectNeeded = false
        closeRemote()
        connectionGeneration += 1
        pendingTerminal = null
        selectedPaneId = null
        void applyState(null, false)
        remoteBanner.classList.add("hidden")
        remoteBanner.textContent = ""
        setPairingNote("")
        setStatus("", false)
        pairPanel.classList.remove("hidden")
        showScreen("list")
      },
    },
    {
      label: "Sign out",
      hint: "Ends access to this local desktop",
      run: () => {
        void signOutFlow()
      },
    },
  ].filter(
    (entry) =>
      (entry.label !== "Sign out" || (localApi && authRequired)) &&
      (entry.label !== "Join a remote session" || localApi || activePairing !== null) &&
      (entry.label !== "Forget paired herdr" || activePairing !== null) &&
      (entry.label !== "Share this desktop" ||
        (localApi && activePairing === null && !window.location.pathname.startsWith("/c/"))),
  )
  for (const entry of entries) {
    const item = document.createElement("button")
    item.type = "button"
    item.className = "popover-item"
    const glyph = document.createElement("span")
    glyph.className = "popover-glyph muted"
    glyph.textContent = "•"
    const text = document.createElement("span")
    text.className = "popover-text"
    const label = document.createElement("span")
    label.className = "popover-label"
    label.textContent = entry.label
    const hint = document.createElement("span")
    hint.className = "popover-hint"
    hint.textContent = entry.hint
    text.append(label, hint)
    item.append(glyph, text)
    item.addEventListener("click", () => {
      closeListMenu()
      entry.run()
    })
    listMenu.appendChild(item)
  }
  appendAppearanceControl(listMenu)
  const info = document.createElement("div")
  info.className = "popover-foot connection-info"
  info.textContent = connectionInfo()
  listMenu.appendChild(info)
}

const newTerminalMenu = new NewTerminalMenu(
  el<HTMLButtonElement>("list-new"),
  el<HTMLDivElement>("new-terminal-menu"),
  {
    snapshot: () => (pairingBusy || !desktopConnected ? null : snapshot),
    create: createNewAgentTab,
    beforeOpen: closeListMenu,
  },
)

async function createNewAgentTab(agent: NewTabAgent, workspaceId: string): Promise<void> {
  if (snapshot === null || pairingBusy || !desktopConnected) return
  const generation = connectionGeneration
  const current = () => generation === connectionGeneration && currentScreen !== "login"
  const note = el<HTMLDivElement>("new-tab-status")
  const report = (message: string, error: boolean) => {
    setStatus(message, error)
    note.textContent = message
    note.classList.toggle("error", error)
    note.classList.toggle("hidden", message.length === 0)
  }
  report(`Starting ${agent.label}…`, false)
  try {
    const result = await createAgentTerminal(snapshot, workspaceId, agent, {
      create: createTerminalTab,
      start: startAgent,
      state: fetchState,
      current,
      pause: (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
    })
    if (!current()) return
    if (result.state !== null && result.paneId !== null) {
      await applyState(snapshot?.panes.some((pane) => pane.pane_id === result.paneId) ? snapshot : result.state, true)
      if (!current()) return
      await selectPane(result.paneId, false)
    }
    if (current()) {
      report(result.error ?? "", result.error !== null)
      if (result.error === null) setStatus(`Started ${agent.label}`, false)
    }
  } catch (error) {
    if (current()) report(`New tab failed: ${String(error)}`, true)
  } finally {
    if (!current()) {
      note.textContent = ""
      note.classList.add("hidden")
    }
  }
}

function closeListMenu(restoreFocus = false): void {
  listMenu.classList.add("hidden")
  el("list-more").setAttribute("aria-expanded", "false")
  if (restoreFocus) el("list-more").focus()
}

const listMore = el<HTMLButtonElement>("list-more")
listMore.addEventListener("click", () => {
  newTerminalMenu.close()
  if (listMenu.classList.contains("hidden")) {
    renderListMenu()
    listMenu.classList.remove("hidden")
    listMore.setAttribute("aria-expanded", "true")
    listMenu.querySelector<HTMLButtonElement>("button")?.focus()
  } else {
    closeListMenu()
  }
})

document.addEventListener("click", (event) => {
  const target = event.target as Node | null
  if (target === null) {
    return
  }
  if (listMenu.contains(target) || listMore.contains(target)) {
    return
  }
  closeListMenu()
})

el<HTMLButtonElement>("list-back").addEventListener("click", () => {
  if (snapshot === null) return
  pairPanel.classList.add("hidden")
  stopScanner()
  updatePairingView()
  listMore.focus()
})

loginForm.addEventListener("submit", (event) => {
  event.preventDefault()
  void signInFlow()
})

async function signOutFlow(): Promise<void> {
  try {
    await signOut()
    closeRemote()
    activePairing = null
    reconnectNeeded = false
    await applyState(null, false)
    loginNote.textContent = ""
    showScreen("login")
  } catch (error) {
    setStatus((error as Error).message, true)
    remoteBanner.textContent = (error as Error).message
    remoteBanner.classList.remove("hidden")
  }
}

async function signInFlow(): Promise<void> {
  loginNote.classList.remove("error")
  const state = await signIn(loginPassword.value)
  if (state.error !== undefined) {
    loginNote.textContent = state.error
    loginNote.classList.add("error")
    return
  }
  authRequired = state.required
  loginPassword.value = ""
  loginNote.textContent = ""
  try {
    await start()
  } catch (error) {
    startupFailed((error as Error).message)
  }
}

async function applyState(next: SessionSnapshot | null, connected: boolean): Promise<void> {
  const previousPaneId = selectedPaneId
  const connectionChanged = desktopConnected !== connected
  desktopConnected = connected
  const signature = contentSignature(next)
  const shapeChanged = signature !== lastSignature || connectionChanged
  lastSignature = signature
  snapshot = next
  updatePairingView()
  const unpaired = !localApi && activePairing === null
  connectionPill.textContent = connected ? "connected" : unpaired ? "not paired" : "offline"
  connectionPill.className = connected ? "pill online" : unpaired ? "pill" : "pill offline"
  newTerminalMenu.update()
  if (snapshot === null) selectedPaneId = null
  else if (!hasSelectedPane(snapshot)) selectedPaneId = pickPane(snapshot)
  if (previousPaneId !== selectedPaneId) {
    terminal.clearSelection()
    pendingTerminal = null
    terminal.followBottom()
    void terminal.setContent("", 1)
  }
  if (selectedPaneId === null && currentScreen === "detail") showScreen("list")
  // The tree and the list are only drawn again when the session really
  // changed, so a poll does not make the rows flicker under the finger.
  if (shapeChanged) {
    renderTree()
    renderList()
  }
  updateNavigation()
  await refreshTerminal()
}

function contentSignature(state: SessionSnapshot | null): string {
  if (state === null) {
    return ""
  }
  return JSON.stringify([
    state.workspaces.map((workspace) => [
      workspace.workspace_id,
      workspace.label,
      workspace.tab_count,
      workspace.agent_status,
    ]),
    state.tabs.map((tab) => [tab.tab_id, tab.workspace_id, tab.label, tab.agent_status]),
    state.panes.map((pane) => [
      pane.pane_id,
      pane.tab_id,
      pane.workspace_id,
      pane.agent_status,
      pane.terminal_title_stripped,
      pane.title,
      pane.agent,
      pane.cwd,
    ]),
  ])
}

function connectionFailed(error: unknown): void {
  setStatus(`connection failed: ${(error as Error).message}`, true)
  desktopConnected = false
  connectionGeneration += 1
  pendingTerminal = null
  connectionPill.textContent = "offline"
  connectionPill.className = "pill offline"
  updateNavigation()
  renderTree()
  renderList()
  if (activePairing === null) return
  reconnectNeeded = true
  reconnectAt = Date.now() + 5000
  closeRemote()
  connectionPill.textContent = "reconnecting"
  connectionPill.className = "pill connecting"
  updateNavigation()
  remoteBanner.classList.remove("hidden")
  remoteBanner.textContent = "Connection interrupted. Reconnecting automatically…"
  if (snapshot === null) {
    pairPanel.classList.remove("hidden")
    remoteBanner.classList.add("hidden")
    setPairingNote(
      "Could not reach herdr on the target machine. Check that it is running. Retrying automatically…",
      true,
    )
  }
}

async function poll(refreshStateFirst = false): Promise<void> {
  if (refreshStateFirst) stateRefreshNeeded = true
  if (pollBusy || pairingBusy || currentScreen === "login" || document.visibilityState === "hidden") return
  if (!localApi && activePairing === null) return
  pollBusy = true
  try {
    if (reconnectNeeded && activePairing !== null) {
      if (Date.now() >= reconnectAt) await applyPairing(activePairing)
    } else if (stateRefreshNeeded || needsStatePolling() || !desktopConnected) {
      stateRefreshNeeded = false
      await refreshState()
    } else {
      await refreshTerminal()
    }
  } catch (error) {
    connectionFailed(error)
  } finally {
    pollBusy = false
  }
}

async function refreshState(): Promise<void> {
  const next = await fetchState()
  if (activePairing !== null && (!next.connected || next.state === null)) {
    throw new Error("herdr is unavailable")
  }
  await applyState(next.state, next.connected)
}

async function refreshRelay(): Promise<void> {
  const status = await fetchRelayStatus()
  if (status === null) {
    relayState.textContent = "relay status unavailable"
    return
  }
  if (relayUrlInput.value.length === 0 && status.relayUrl.length > 0) {
    relayUrlInput.value = status.relayUrl
  }
  if (status.hasRelayKey && relayTokenInput.value.length === 0) {
    relayTokenInput.placeholder = "Relay token (saved on this machine)"
  }
  const parts: string[] = []
  parts.push(status.connected ? `connected to ${status.relayUrl}` : "not connected")
  if (status.proto !== null) {
    parts.push(`protocol ${status.proto}`)
  }
  if (status.error !== undefined) {
    parts.push(status.error)
  }
  relayState.textContent = parts.join(" · ")
  relayState.classList.toggle("error", status.error !== undefined)
  relayDisconnect.disabled = !status.connected
  const hasPairing = status.connected && status.remoteLink.length > 0
  relayPair.classList.toggle("hidden", !hasPairing)
  if (hasPairing) {
    relayLink.textContent = status.remoteLink
    // The pairing code is only drawn for the loopback address, so the image
    // fails to load on a phone. The note explains that instead of a broken
    // picture.
    relayQr.classList.remove("broken")
    relayQr.onerror = () => {
      relayQr.classList.add("broken")
      qrNote.classList.remove("hidden")
    }
    relayQr.src = `/api/relay/pairing.svg?t=${Date.now()}`
    const lan = status.lanLink
    relayQrLanBox.classList.toggle("hidden", lan.length === 0)
    relayLinkLan.textContent = lan
    relayQrLan.classList.remove("broken")
    relayQrLan.onerror = () => {
      relayQrLan.classList.add("broken")
      qrNote.classList.remove("hidden")
    }
    relayQrLan.src = `/api/relay/pairing.svg?target=lan&t=${Date.now()}`
  } else {
    qrNote.classList.add("hidden")
  }
}

function handleEvent(event: AgentEvent): void {
  if (event.type === "state" && event.state !== undefined) {
    void applyState(event.state, event.connected === true)
    return
  }
  if (event.type === "pane_output") {
    if (event.pane_id === selectedPaneId) {
      void refreshTerminal()
    }
  }
}

async function applyPairing(source: string | Pairing): Promise<boolean> {
  if (pairingBusy) return false
  const pairing = typeof source === "string" ? readPairing(source) : source
  if (pairing === null) {
    setPairingNote(
      "This link has no pairing code. Copy the full pairing link from Alma’s Remote Access settings.",
      true,
    )
    pairInput.setAttribute("aria-invalid", "true")
    return false
  }
  const replacing = activePairing !== pairing
  if (replacing) collapsedWorkspaces.clear()
  desktopSharing.close()
  activePairing = pairing
  pairInput.removeAttribute("aria-invalid")
  pairingBusy = true
  updatePairingControls()
  desktopConnected = false
  if (replacing) await applyState(null, false)
  else {
    updateNavigation()
    renderTree()
    renderList()
  }
  updatePairingControls()
  const generation = ++connectionGeneration
  pendingTerminal = null
  // The desktop the client leaves stops pushing its state.
  disconnectEvents()
  connectionPill.textContent = reconnectNeeded ? "reconnecting" : "connecting"
  connectionPill.className = "pill connecting"
  setPairingNote("Connecting to herdr…")
  remoteBanner.classList.toggle("hidden", snapshot === null)
  remoteBanner.textContent = "Connecting to herdr…"
  setStatus("connecting to herdr", false)
  try {
    if (pairing.kind === "alma") {
      await openAlmaRemote({ relay: pairing.relay, code: pairing.code })
    } else {
      await openRemote(pairing.payload)
    }
    if (generation !== connectionGeneration || activePairing !== pairing) {
      closeRemote()
      return false
    }
    savePairing(pairing)
    pairInput.value = ""
    setPairingNote("")
    reconnectNeeded = false
    stopScanner()
    pairPanel.classList.add("hidden")
    remoteBanner.classList.remove("hidden")
    // The session of the paired desktop replaces the local one.
    selectedPaneId = null
    await refreshState()
    if (reconnectNeeded) return false
    remoteBanner.classList.add("hidden")
    remoteBanner.textContent = ""
    setStatus("", false)
    connectEvents(handleEvent)
    return true
  } catch (error) {
    connectionFailed(error)
    return false
  } finally {
    pairingBusy = false
    updatePairingControls()
    updateNavigation()
    renderTree()
    renderList()
    await refreshTerminal()
  }
}

function updatePairingView(): void {
  const home = !localApi && snapshot === null
  listScreen.classList.toggle("pairing-home", home)
  el("list-heading").textContent = home ? "Alma herdr" : "Terminals"
  const back = el<HTMLButtonElement>("list-back")
  back.classList.toggle("hidden", snapshot === null || pairPanel.classList.contains("hidden"))
  back.setAttribute("aria-label", "Back to the terminals")
}

function updateNavigation(): void {
  const button = el<HTMLButtonElement>("list-new")
  button.classList.toggle("hidden", (snapshot?.workspaces.length ?? 0) === 0)
  button.title = !desktopConnected
    ? "Reconnect to create a terminal"
    : pairingBusy
      ? "Wait for the desktop connection"
      : "New Tab"
  newTerminalMenu.update()
  listScreen.querySelector(".signal")?.classList.toggle("hidden", !desktopConnected)
  detail.update(snapshot, selectedPane(), desktopConnected && !pairingBusy)
  updatePairingView()
  syncDrawer()
}

function setPairingNote(message: string, error = false): void {
  pairNote.textContent = message
  pairNote.classList.toggle("hidden", message.length === 0)
  pairNote.classList.toggle("error", error)
}

function updatePairingControls(): void {
  pairApply.disabled = pairingBusy || pairInput.value.trim().length === 0
  pairScan.disabled = pairingBusy
  pairInput.readOnly = pairingBusy
  pairPanel.setAttribute("aria-busy", String(pairingBusy))
  pairApply.textContent = pairingBusy ? "Connecting…" : "Connect"
}

pairInput.addEventListener("input", () => {
  pairInput.removeAttribute("aria-invalid")
  setPairingNote("")
  updatePairingControls()
})

el<HTMLFormElement>("pair-form").addEventListener("submit", (event) => {
  event.preventDefault()
  if (pairInput.value.trim().length > 0) void applyPairing(pairInput.value.trim())
})

async function scanPairingCode(): Promise<void> {
  if (scanner !== null) {
    return
  }
  scanPanel.classList.remove("hidden")
  scanVideo.classList.remove("hidden")
  scanStatus.textContent = "Point the camera at the pairing code"
  scanStatus.classList.remove("error")
  try {
    scanner = await startScanner(scanVideo, (code) => {
      stopScanner()
      void applyPairing(code)
    })
  } catch (error) {
    scanVideo.classList.add("hidden")
    scanStatus.textContent =
      (error as Error).name === "NotAllowedError"
        ? "Camera access was not allowed. Allow it in your browser, or paste a pairing link below."
        : (error as Error).message
    scanStatus.classList.add("error")
  }
}

function stopScanner(): void {
  scanner?.stop()
  scanner = null
  scanPanel.classList.add("hidden")
}

pairScan.addEventListener("click", () => {
  void scanPairingCode()
})

scanStop.addEventListener("click", () => {
  stopScanner()
})

el("desktop-sharing-close").addEventListener("click", () => desktopSharing.close())
desktopSharing.addEventListener("close", () => {
  relayTokenInput.value = ""
  el("list-more").focus()
})

relayConnect.addEventListener("click", () => {
  const key = relayTokenInput.value.trim()
  void connectRelay(relayUrlInput.value.trim(), key.length > 0 ? key : undefined).then((error) => {
    if (error !== null) {
      relayState.textContent = `Could not share this desktop: ${error}`
      relayState.classList.add("error")
      return
    }
    void refreshRelay()
  })
})

relayDisconnect.addEventListener("click", () => {
  void disconnectRelay().then(() => refreshRelay())
})

relayRotate.addEventListener("click", () => {
  void rotateRelay().then(() => refreshRelay())
})

scrim.addEventListener("click", () => {
  setDrawer(false, true)
})

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (desktopSharing.open) return
    if (newTerminalMenu.isOpen()) {
      newTerminalMenu.close(true)
      return
    }
    // The first escape closes the menu that is open, the drawer comes next.
    if (!listMenu.classList.contains("hidden")) {
      closeListMenu(true)
      return
    }
    if (isPhone() && phoneDrawerOpen) setDrawer(false, true)
  } else if (event.key === "Tab" && isPhone() && phoneDrawerOpen) {
    const buttons = [...sidebar.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].filter(
      (button) => button.getClientRects().length > 0,
    )
    const first = buttons[0]
    const last = buttons.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }
})

window.addEventListener("resize", () => {
  if (phoneLayout !== isPhone()) {
    phoneLayout = isPhone()
    const sidebarFocused = sidebar.contains(document.activeElement)
    phoneDrawerOpen = false
    syncDrawer()
    if (sidebarFocused && sidebar.inert) el("tree-toggle").focus()
  }
  terminal.resize()
})

async function start(): Promise<void> {
  const restoreDetail = readSelection()?.screen === "detail"
  currentScreen = "list"
  localApi = await hasLocalApi()
  updatePairingView()
  const pairing = readPairing(window.location.hash + window.location.search) ?? readSavedPairing()
  let paired = false
  if (pairing !== null) {
    paired = await applyPairing(pairing)
  } else if (window.location.pathname.startsWith("/c/")) {
    remoteBanner.classList.remove("hidden")
    remoteBanner.textContent = "This page came through the relay but carries no pairing code."
    pairPanel.classList.remove("hidden")
  } else if (!localApi) {
    // There is no agent next to the page, so there is no relay of its own
    // either. The desktops are reached through a pairing.
    remoteBanner.textContent = ""
    remoteBanner.classList.add("hidden")
    pairPanel.classList.remove("hidden")
  }

  if (!paired && activePairing === null) {
    if (localApi) {
      const generation = connectionGeneration
      const initial = await fetchState()
      if (generation !== connectionGeneration) return
      await applyState(initial.state, initial.connected)
      connectEvents(handleEvent)
    } else {
      await applyState(null, false)
    }
  }

  showScreen(restoreDetail && selectedPane() !== null ? "detail" : "list")
  await refreshTerminal()

  if (pollTimer === null) pollTimer = window.setInterval(() => void poll(), 1500)
}

window.addEventListener("offline", () => {
  if (activePairing !== null) connectionFailed(new Error("network offline"))
})
window.addEventListener("online", () => {
  reconnectAt = 0
  void poll(true)
})
window.addEventListener("pageshow", () => {
  reconnectAt = 0
  void poll(true)
})
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    reconnectAt = 0
    void poll(true)
  }
})

setUnauthorizedHandler(() => {
  disconnectEvents()
  if (authRequired) showScreen("login")
  else void main()
})

startupRetry.addEventListener("click", () => void main())

function startupFailed(message: string): void {
  desktopConnected = false
  showScreen("login")
  startupNote.textContent = message
  startupRetry.classList.remove("hidden")
  startupScreen.classList.remove("hidden")
  loginScreen.classList.add("hidden")
}

async function main(): Promise<void> {
  startupRetry.disabled = true
  try {
    const state = await authStatus()
    if (state.error !== undefined) {
      startupFailed(state.error)
      return
    }
    startupRetry.classList.add("hidden")
    authRequired = state.required
    if (state.required && !state.authenticated) {
      loginNote.textContent = ""
      showScreen("login")
      return
    }
    await start()
  } catch (error) {
    startupFailed((error as Error).message)
  } finally {
    startupRetry.disabled = false
  }
}

void main()
