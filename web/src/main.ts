import {
  type AgentEvent,
  closeRemote,
  connectEvents,
  connectRelay,
  createTab,
  createWorkspace,
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
import { authStatus, signIn, signOut } from "./auth.js"
import { DetailScreen } from "./detail.js"
import { forgetPairing, type Pairing, readPairing, readSavedPairing, savePairing } from "./pairing.js"
import { restartAgent as runRestart } from "./restart.js"
import { type ScannerHandle, startScanner } from "./scanner.js"
import { renderSessionList, statusClass } from "./session-list.js"
import { type FitMode, TerminalView } from "./terminal.js"

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) {
    throw new Error(`missing element: ${id}`)
  }
  return node as T
}

const app = el<HTMLDivElement>("app")
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
const remotePanel = el<HTMLElement>("remote-panel")
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
const pairPanel = el<HTMLDivElement>("pair-panel")
const pairInput = el<HTMLInputElement>("pair-input")
const pairApply = el<HTMLButtonElement>("pair-apply")
const pairScan = el<HTMLButtonElement>("pair-scan")
const scanPanel = el<HTMLDivElement>("scan-panel")
const scanVideo = el<HTMLVideoElement>("scan-video")
const scanStatus = el<HTMLSpanElement>("scan-status")
const scanStop = el<HTMLButtonElement>("scan-stop")
const sidebar = el<HTMLElement>("sidebar")
const scrim = el<HTMLElement>("scrim")
const remoteDetails = el<HTMLDetailsElement>("remote-details")
const qrNote = el<HTMLElement>("qr-note")

let scanner: ScannerHandle | null = null

let localApi = true

const terminal = new TerminalView(terminalCanvas)

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

const SELECTION_KEY = "alma-herdr-web:selection"

interface Selection {
  paneId: string
  tabId: string
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
  loginScreen.classList.toggle("hidden", screen !== "login")
  app.classList.toggle("hidden", screen === "login")
  listScreen.classList.toggle("hidden", screen !== "list")
  detailScreen.classList.toggle("hidden", screen !== "detail")
  if (screen === "detail") {
    terminal.resize()
  }
}

function setDrawer(open: boolean): void {
  if (isPhone()) {
    sidebar.classList.toggle("open", open)
    scrim.classList.toggle("hidden", !open)
  } else {
    app.classList.toggle("no-sidebar", open)
  }
}

function selectedPane(): PaneRecord | null {
  if (snapshot === null || selectedPaneId === null) {
    return null
  }
  return snapshot.panes.find((pane) => pane.pane_id === selectedPaneId) ?? null
}

function renderTree(): void {
  tree.replaceChildren()
  if (snapshot === null) {
    return
  }
  for (const workspace of snapshot.workspaces) {
    const workspaceRow = document.createElement("div")
    workspaceRow.className = "row workspace"
    const workspaceDot = document.createElement("span")
    workspaceDot.className = `dot ${statusClass(workspace.agent_status)}`
    const workspaceLabel = document.createElement("span")
    workspaceLabel.className = "label"
    workspaceLabel.textContent = workspace.label || workspace.workspace_id
    const workspaceCount = document.createElement("span")
    workspaceCount.className = "count"
    workspaceCount.textContent = String(workspace.tab_count)
    workspaceRow.append(workspaceDot, workspaceLabel, workspaceCount)
    workspaceRow.addEventListener("click", () => {
      void selectWorkspace(workspace.workspace_id)
    })
    tree.appendChild(workspaceRow)

    for (const tab of snapshot.tabs.filter((t) => t.workspace_id === workspace.workspace_id)) {
      const tabRow = document.createElement("div")
      tabRow.className = "row tab"
      const tabDot = document.createElement("span")
      tabDot.className = `dot ${statusClass(tab.agent_status)}`
      const tabLabel = document.createElement("span")
      tabLabel.className = "label"
      tabLabel.textContent = tab.label || tab.tab_id
      tabRow.append(tabDot, tabLabel)
      tabRow.addEventListener("click", () => {
        void selectTab(tab.tab_id)
      })
      tree.appendChild(tabRow)

      for (const pane of snapshot.panes.filter((p) => p.tab_id === tab.tab_id)) {
        const paneRow = document.createElement("div")
        paneRow.className = `row pane${pane.pane_id === selectedPaneId ? " selected" : ""}`
        const paneDot = document.createElement("span")
        paneDot.className = `dot ${statusClass(pane.agent_status)}`
        const paneLabel = document.createElement("span")
        paneLabel.className = "label"
        const title = pane.terminal_title_stripped || pane.title || pane.agent || pane.pane_id
        paneLabel.textContent = title
        paneRow.append(paneDot, paneLabel)
        paneRow.addEventListener("click", () => {
          void selectPane(pane.pane_id)
        })
        tree.appendChild(paneRow)
      }
    }
  }
}

function renderList(): void {
  if (snapshot === null) {
    return
  }
  renderSessionList(sessionList, {
    snapshot,
    selectedPaneId,
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
    const error = await sendText(pane.pane_id, text)
    if (error !== null) {
      setStatus(`send failed: ${error}`, true)
    }
  },
  sendKeys: async (pane, keys) => {
    const error = await sendKeys(pane.pane_id, keys)
    if (error !== null) {
      setStatus(`send failed: ${error}`, true)
    }
  },
  restartAgent: async (pane, continueAfter) => {
    await runRestart(pane, continueAfter, {
      sendKeys,
      startAgent,
      promptAgent,
      status: (message, isError) => setStatus(message, isError),
    })
    await refreshTerminal()
  },
  toggleTree: () => setDrawer(!isPhone() ? !app.classList.contains("no-sidebar") : !sidebar.classList.contains("open")),
  back: () => {
    showScreen("list")
  },
  status: (message, isError) => setStatus(message, isError),
  setFitMode: (mode: FitMode) => terminal.setMode(mode),
  paneSize: () => terminal.size(),
})

async function selectPane(paneId: string): Promise<void> {
  selectedPaneId = paneId
  const pane = selectedPane()
  if (pane !== null) {
    // The choice survives a reload.
    writeSelection({ paneId: pane.pane_id, tabId: pane.tab_id })
  }
  renderTree()
  renderList()
  detail.update(snapshot, pane)
  showScreen("detail")
  // A desktop has a keyboard of its own, so the screen takes it right away.
  detail.focusTerminal()
  try {
    await focusPane(paneId)
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
  const pane = tab !== undefined ? snapshot.panes.find((p) => p.tab_id === tab.tab_id) : undefined
  if (pane !== undefined) {
    await selectPane(pane.pane_id)
  }
}

async function refreshTerminal(): Promise<void> {
  const pane = selectedPane()
  if (pane === null || pendingTerminal !== null) {
    return
  }
  const pending = {}
  pendingTerminal = pending
  const generation = connectionGeneration
  try {
    // The read carries the screen of the pane and the lines above it, so
    // a reader can scroll back into the history.
    const read = await readPane(pane.pane_id, "recent", "ansi", 120)
    if (read === null) throw new Error("the desktop did not return its screen")
    if (generation === connectionGeneration && pane.pane_id === selectedPaneId) {
      await terminal.setContent(read.text, pane.viewport_rows)
    }
  } catch (error) {
    connectionFailed(error)
  } finally {
    if (pendingTerminal === pending) pendingTerminal = null
  }
}

function renderListMenu(): void {
  listMenu.replaceChildren()
  const entries: { label: string; hint: string; run: () => void }[] = [
    {
      label: "Join a remote session",
      hint: "Pairs this browser with another desktop",
      run: () => {
        pairPanel.classList.toggle("hidden")
        pairInput.focus()
      },
    },
    {
      label: "New tab",
      hint: "Opens another terminal in this workspace",
      run: () => void createNewTab(),
    },
    {
      label: "New workspace",
      hint: "Opens a workspace of its own",
      run: () => void createNewWorkspace(),
    },
    {
      label: "Forget paired desktop",
      hint: "Disconnects this tab and removes its saved pairing",
      run: () => {
        forgetPairing()
        activePairing = null
        reconnectNeeded = false
        closeRemote()
        connectionGeneration += 1
        pendingTerminal = null
        selectedPaneId = null
        void applyState(null, false)
        remoteBanner.textContent = "Pair with a desktop to open its terminals."
        pairPanel.classList.remove("hidden")
        showScreen("list")
      },
    },
    {
      label: "Sign out",
      hint: "Ends the session of this browser",
      run: () => {
        void signOut().then(() => showScreen("login"))
      },
    },
  ].filter(
    (entry) =>
      (entry.label !== "Sign out" || localApi) &&
      (entry.label !== "Forget paired desktop" || activePairing !== null) &&
      (!entry.label.startsWith("New ") || snapshot !== null),
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
      listMenu.classList.add("hidden")
      entry.run()
    })
    listMenu.appendChild(item)
  }
}

async function createNewWorkspace(): Promise<void> {
  const cwd = window.prompt("Directory for the new workspace", "/tmp")
  if (cwd === null) {
    return
  }
  const label = window.prompt("Label", "workspace") ?? "workspace"
  const error = await createWorkspace(cwd, label)
  if (error !== null) {
    setStatus(`create workspace failed: ${error}`, true)
  }
}

async function createNewTab(): Promise<void> {
  if (snapshot === null) {
    return
  }
  const workspaceId = snapshot.focused_workspace_id ?? snapshot.workspaces[0]?.workspace_id ?? ""
  const cwd = window.prompt("Directory for the new tab", "/tmp")
  if (cwd === null) {
    return
  }
  const label = window.prompt("Label", "tab") ?? "tab"
  const error = await createTab(workspaceId, cwd, label)
  if (error !== null) {
    setStatus(`create tab failed: ${error}`, true)
  }
}

el<HTMLButtonElement>("new-workspace").addEventListener("click", () => {
  void createNewWorkspace()
})

el<HTMLButtonElement>("new-tab").addEventListener("click", () => {
  void createNewTab()
})

el<HTMLButtonElement>("list-new").addEventListener("click", () => {
  void createNewTab()
})

const listMore = el<HTMLButtonElement>("list-more")
listMore.addEventListener("click", () => {
  if (listMenu.classList.contains("hidden")) {
    renderListMenu()
    listMenu.classList.remove("hidden")
  } else {
    listMenu.classList.add("hidden")
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
  listMenu.classList.add("hidden")
})

el<HTMLButtonElement>("list-back").addEventListener("click", () => {
  if (!localApi) {
    pairPanel.classList.remove("hidden")
    pairInput.focus()
    return
  }
  void signOut().then(() => showScreen("login"))
})

loginForm.addEventListener("submit", (event) => {
  event.preventDefault()
  void signInFlow()
})

async function signInFlow(): Promise<void> {
  loginNote.classList.remove("error")
  const state = await signIn(loginPassword.value)
  if (state.error !== undefined) {
    loginNote.textContent = state.error
    loginNote.classList.add("error")
    return
  }
  loginPassword.value = ""
  loginNote.textContent = ""
  await start()
}

async function applyState(next: SessionSnapshot | null, connected: boolean): Promise<void> {
  const signature = contentSignature(next)
  const shapeChanged = signature !== lastSignature
  lastSignature = signature
  snapshot = next
  el<HTMLButtonElement>("list-new").classList.toggle("hidden", !localApi && snapshot === null)
  connectionPill.textContent = connected ? "connected" : "offline"
  connectionPill.className = `pill ${connected ? "online" : "offline"}`
  if (snapshot !== null && !hasSelectedPane(snapshot)) {
    selectedPaneId = pickPane(snapshot)
  }
  // The tree and the list are only drawn again when the session really
  // changed, so a poll does not make the rows flicker under the finger.
  if (shapeChanged) {
    renderTree()
    renderList()
  }
  detail.update(snapshot, selectedPane())
  await refreshTerminal()
}

function contentSignature(state: SessionSnapshot | null): string {
  if (state === null) {
    return ""
  }
  const workspaces = state.workspaces
    .map((workspace) => `${workspace.workspace_id}:${workspace.agent_status}`)
    .join(",")
  const tabs = state.tabs.map((tab) => `${tab.tab_id}:${tab.agent_status}`).join(",")
  const panes = state.panes
    .map((pane) => `${pane.pane_id}:${pane.agent_status}:${pane.terminal_title_stripped ?? ""}:${pane.cwd ?? ""}`)
    .join(",")
  return `${workspaces}|${tabs}|${panes}`
}

function connectionFailed(error: unknown): void {
  setStatus(`connection failed: ${(error as Error).message}`, true)
  if (activePairing === null) return
  reconnectNeeded = true
  reconnectAt = Date.now() + 5000
  connectionGeneration += 1
  pendingTerminal = null
  closeRemote()
  connectionPill.textContent = "reconnecting"
  connectionPill.className = "pill offline"
  remoteBanner.classList.remove("hidden")
  remoteBanner.textContent = "Connection interrupted. Reconnecting automatically…"
  if (snapshot === null) pairPanel.classList.remove("hidden")
}

async function poll(): Promise<void> {
  if (pollBusy || pairingBusy) return
  pollBusy = true
  try {
    if (reconnectNeeded && activePairing !== null) {
      if (Date.now() >= reconnectAt) await applyPairing(activePairing)
    } else if (needsStatePolling()) {
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
    throw new Error("the desktop is unavailable")
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
    setStatus("that link carries no pairing data", true)
    return false
  }
  activePairing = pairing
  pairingBusy = true
  const generation = ++connectionGeneration
  pendingTerminal = null
  // The desktop the client leaves stops pushing its state.
  disconnectEvents()
  remoteBanner.classList.remove("hidden")
  remoteBanner.textContent = "Connecting to the desktop…"
  setStatus("connecting to the desktop", false)
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
    reconnectNeeded = false
    stopScanner()
    pairPanel.classList.add("hidden")
    remotePanel.classList.add("hidden")
    remoteBanner.classList.remove("hidden")
    // The session of the paired desktop replaces the local one.
    selectedPaneId = null
    await refreshState()
    if (reconnectNeeded) return false
    remoteBanner.textContent =
      pairing.kind === "alma"
        ? `Encrypted session with the Alma desktop via ${pairing.relay}`
        : `Encrypted remote session via ${pairing.payload.relay}`
    setStatus("connected to the desktop", false)
    connectEvents(handleEvent)
    return true
  } catch (error) {
    connectionFailed(error)
    return false
  } finally {
    pairingBusy = false
  }
}

pairApply.addEventListener("click", () => {
  void applyPairing(pairInput.value.trim())
})

async function scanPairingCode(): Promise<void> {
  if (scanner !== null) {
    return
  }
  scanPanel.classList.remove("hidden")
  scanStatus.textContent = "Point the camera at the pairing code"
  scanStatus.classList.remove("error")
  try {
    scanner = await startScanner(scanVideo, (code) => {
      stopScanner()
      void applyPairing(code)
    })
  } catch (error) {
    scanStatus.textContent = (error as Error).message
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

relayConnect.addEventListener("click", () => {
  const key = relayTokenInput.value.trim()
  void connectRelay(relayUrlInput.value.trim(), key.length > 0 ? key : undefined).then((error) => {
    if (error !== null) {
      setStatus(`relay connect failed: ${error}`, true)
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
  setDrawer(false)
})

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    // The first escape closes the menu that is open, the drawer comes next.
    if (!listMenu.classList.contains("hidden")) {
      listMenu.classList.add("hidden")
      return
    }
    setDrawer(false)
  }
})

window.addEventListener("resize", () => {
  terminal.resize()
})

async function start(): Promise<void> {
  showScreen("list")
  localApi = await hasLocalApi()
  if (!localApi) {
    // A hosted client pairs with a desktop; it cannot register this host.
    remoteDetails.classList.add("hidden")
    app.classList.add("no-sidebar")
    el<HTMLButtonElement>("list-back").setAttribute("aria-label", "Pair with another desktop")
  }
  const pairing = readPairing(window.location.hash + window.location.search) ?? readSavedPairing()
  let paired = false
  if (pairing !== null) {
    paired = await applyPairing(pairing)
  } else if (window.location.pathname.startsWith("/c/")) {
    remotePanel.classList.add("hidden")
    remoteBanner.classList.remove("hidden")
    remoteBanner.textContent = "This page came through the relay but carries no pairing code."
  } else if (localApi) {
    void refreshRelay()
  } else {
    // There is no agent next to the page, so there is no relay of its own
    // either. The desktops are reached through a pairing.
    remoteBanner.textContent = "Pair with a desktop to open its terminals. Paste a pairing link or scan its QR code."
    remoteBanner.classList.remove("hidden")
    pairPanel.classList.remove("hidden")
  }

  if (!paired && activePairing === null) {
    if (localApi) {
      const initial = await fetchState()
      await applyState(initial.state, initial.connected)
      connectEvents(handleEvent)
    } else {
      await applyState(null, false)
      connectionPill.textContent = "not paired"
    }
  }

  showScreen(paired && readSelection() !== null && selectedPane() !== null ? "detail" : "list")

  if (pollTimer === null) pollTimer = window.setInterval(() => void poll(), 1500)

  if (isPhone()) {
    // The remote access panel is long, so it starts closed on a phone.
    remoteDetails.open = false
  }
}

window.addEventListener("offline", () => {
  if (activePairing !== null) connectionFailed(new Error("network offline"))
})
window.addEventListener("online", () => {
  reconnectAt = 0
  void poll()
})
window.addEventListener("pageshow", () => {
  reconnectAt = 0
  void poll()
})
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    reconnectAt = 0
    void poll()
  }
})

setUnauthorizedHandler(() => {
  // The session is gone, so the reader signs in again.
  showScreen("login")
})

async function main(): Promise<void> {
  const state = await authStatus()
  if (state.required) {
    loginNote.textContent = state.error ?? ""
    showScreen("login")
    return
  }
  await start()
}

void main()
