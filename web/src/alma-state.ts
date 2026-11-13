import type { AlmaTunnel } from "./alma.js"
import { almaSnapshot, records } from "./alma-snapshot.js"
import type { StateResponse } from "./api.js"
import { withTimeout } from "./deadline.js"

/** Alma adapts both runtimes into this stream; core has no workspace.list RPC. */
export class AlmaState {
  private latest: StateResponse = { state: null, connected: false }
  private loading: Promise<void> | null = null
  private legacy = false
  private stopped = false
  private stopStream: (() => void) | null = null

  constructor(private readonly tunnel: AlmaTunnel) {}

  async read(): Promise<StateResponse | null> {
    this.loading ??= this.start()
    await this.loading
    return this.legacy ? null : this.latest
  }

  close(): void {
    this.stopped = true
    this.stopStream?.()
    this.stopStream = null
    this.latest = { state: null, connected: false }
  }

  private async start(): Promise<void> {
    const info = await this.tunnel.request("GET", "/api/herdr/info")
    if (this.stopped) return
    if (info.status === 404 || info.status === 405) {
      this.legacy = true
      return
    }
    if (info.status >= 400) throw new Error("the desktop refused herdr discovery")
    let settle: () => void = () => undefined
    let fail: (error: Error) => void = () => undefined
    const first = new Promise<void>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    // Attach a handler before stream setup: the first snapshot may arrive with its ack.
    const waiting = withTimeout(first, 15000, "the desktop did not send a herdr snapshot")
    void waiting.catch(() => undefined)
    try {
      const stop = await this.tunnel.openStream(
        "/ws/herdr",
        (data) => {
          if (this.stopped) return
          try {
            const message = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>
            if (message.type === "herdr" && message.online === false) {
              this.latest = { state: null, connected: false }
              settle()
            } else if (message.type === "snapshot") {
              const raw = message.snapshot as Record<string, unknown> | null
              if (!raw || !Array.isArray(raw.workspaces) || !Array.isArray(raw.tabs) || !Array.isArray(raw.panes)) {
                throw new Error("the desktop sent an invalid herdr snapshot")
              }
              const state = almaSnapshot(records(raw.workspaces), records(raw.tabs), records(raw.panes))
              if (typeof raw.version === "string") state.version = raw.version
              if (typeof raw.protocol === "number") state.protocol = raw.protocol
              for (const key of ["focused_workspace_id", "focused_tab_id", "focused_pane_id"] as const) {
                if (typeof raw[key] === "string" || raw[key] === null) state[key] = raw[key]
              }
              this.latest = { state, connected: true }
              settle()
            }
          } catch (error) {
            this.latest = { state: null, connected: false }
            fail(error as Error)
            this.stopStream?.()
          }
        },
        () => {
          this.latest = { state: null, connected: false }
          fail(new Error("the desktop herdr stream closed"))
        },
      )
      if (this.stopped) {
        stop()
        settle()
        return
      }
      this.stopStream = stop
      await waiting
    } catch (error) {
      fail(error as Error)
      this.stopStream?.()
      this.stopStream = null
      throw error
    }
  }
}
