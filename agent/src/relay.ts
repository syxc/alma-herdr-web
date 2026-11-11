import { WebSocket } from "ws"
import { forwardedHeaders, type LocalTarget, localRequest } from "./bridge.js"
import { E2E_PATH, E2EAgentSession } from "./e2e.js"
import { sha256Hex } from "./identity.js"
import { TunnelSession } from "./tunnel.js"

/** A frame as the relay speaks it on the agent socket. */
interface RelayFrame {
  t: string
  id?: string
  method?: string
  path?: string
  headers?: Record<string, string | string[] | undefined>
  b?: string
  s?: string
  status?: number
  message?: string
  code?: number
  reason?: string
  proto?: number
}

export interface RelayStatus {
  connected: boolean
  relayUrl: string
  token: string
  proto: number | null
  error: string | null
}

function toWebSocketUrl(url: string): string {
  if (url.startsWith("https://")) {
    return `wss://${url.slice("https://".length)}`
  }
  if (url.startsWith("http://")) {
    return `ws://${url.slice("http://".length)}`
  }
  return url.replace(/\/$/, "")
}

/**
 * Desktop side of the Alma relay protocol.
 *
 * The agent dials out to the relay and registers with sha256(token). The relay
 * then tunnels a phone's traffic back to this process.
 *
 * Traffic runs inside an end to end encrypted channel: the phone opens a
 * WebSocket for /__alma_e2e__, both sides run the handshake keyed by the
 * connect code, and everything after that is sealed. Plain HTTP requests are
 * only served for the static page, so the relay can deliver the client but
 * cannot read a single API response.
 */
export class RelayAgent {
  private socket: WebSocket | null = null
  private readonly sessions = new Map<string, { session: E2EAgentSession; tunnel: TunnelSession }>()
  private reconnectTimer: NodeJS.Timeout | null = null
  private stopped = false
  private status: RelayStatus = {
    connected: false,
    relayUrl: "",
    token: "",
    proto: null,
    error: null,
  }

  constructor(
    private readonly target: LocalTarget,
    private readonly psk: Buffer,
  ) {}

  connect(relayUrl: string, token: string, key?: string): void {
    this.disconnect()
    this.stopped = false
    this.status = { connected: false, relayUrl, token, proto: null, error: null }
    let target: string
    try {
      target = toWebSocketUrl(relayUrl)
      new URL(target)
    } catch {
      this.status = { ...this.status, error: "that relay address cannot be parsed" }
      return
    }
    if (!target.startsWith("ws://") && !target.startsWith("wss://")) {
      this.status = { ...this.status, error: "the relay address must be http or https" }
      return
    }
    this.open(relayUrl, token, key)
  }

  disconnect(): void {
    this.stopped = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.socket?.close()
    this.socket = null
    for (const entry of this.sessions.values()) {
      entry.tunnel.close()
    }
    this.sessions.clear()
    this.status = { ...this.status, connected: false, error: null }
  }

  current(): RelayStatus {
    return { ...this.status }
  }

  private open(relayUrl: string, token: string, key?: string): void {
    const target = `${toWebSocketUrl(relayUrl)}/agent?th=${sha256Hex(token)}`
    const socket = new WebSocket(target)
    this.socket = socket

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          t: "register",
          tokenHash: sha256Hex(token),
          name: "alma-herdr-web",
          ver: "1.0.0",
          key,
          proto: 1,
        }),
      )
    })

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        return
      }
      let frame: RelayFrame
      try {
        frame = JSON.parse(data.toString("utf8")) as RelayFrame
      } catch {
        return
      }
      this.onFrame(frame)
    })

    socket.on("close", (code: number) => {
      if (this.socket === socket) {
        this.socket = null
      }
      this.status = { ...this.status, connected: false }
      if (code === 4002 || code === 4003 || code === 4401) {
        const reason =
          code === 4401
            ? "this relay needs an account token: paste your Alma relay token into the relay token field"
            : code === 4003
              ? "the relay refused the token"
              : "the relay refused the registration"
        this.status = { ...this.status, error: reason }
        return
      }
      if (!this.stopped) {
        this.scheduleReconnect(relayUrl, token, key)
      }
    })

    socket.on("error", (error: Error) => {
      this.status = { ...this.status, error: error.message }
    })
  }

  private scheduleReconnect(relayUrl: string, token: string, key?: string): void {
    if (this.stopped || this.reconnectTimer !== null) {
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open(relayUrl, token, key)
    }, 2000)
  }

  private send(frame: RelayFrame): void {
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame))
    }
  }

  private onFrame(frame: RelayFrame): void {
    switch (frame.t) {
      case "registered":
        this.status = { ...this.status, connected: true, proto: frame.proto ?? 1, error: null }
        return
      case "error":
        this.status = {
          ...this.status,
          connected: false,
          error: frame.message ?? "relay error",
        }
        return
      case "hreq":
        void this.serveStaticRequest(frame)
        return
      case "wopen":
        this.openEncryptedBridge(frame)
        return
      case "wmsg": {
        const id = String(frame.id ?? "")
        const entry = this.sessions.get(id)
        if (entry === undefined || frame.s === undefined) {
          return
        }
        entry.session.receive(frame.s)
        return
      }
      case "wclose": {
        const id = String(frame.id ?? "")
        const entry = this.sessions.get(id)
        entry?.tunnel.close()
        this.sessions.delete(id)
        return
      }
      default:
        return
    }
  }

  /**
   * Serves the static client over the plain tunnel.
   *
   * Only the page itself is allowed through: API paths answer 403 so the relay
   * cannot read or drive the desktop without the pairing code.
   */
  private async serveStaticRequest(frame: RelayFrame): Promise<void> {
    const id = String(frame.id ?? "")
    const path = frame.path ?? "/"
    if (path.startsWith("/api/")) {
      this.send({
        t: "hres",
        id,
        status: 403,
        headers: { "content-type": "application/json" },
      })
      this.send({
        t: "hchunk",
        id,
        b: Buffer.from(JSON.stringify({ error: "end to end encryption required" }), "utf8").toString("base64"),
      })
      this.send({ t: "hend", id })
      return
    }
    const method = frame.method ?? "GET"
    const headers = { "accept-encoding": "identity", ...forwardedHeaders(frame.headers ?? {}) }
    const body = frame.b !== undefined ? Buffer.from(frame.b, "base64") : undefined
    try {
      const response = await localRequest(this.target, method, path, headers, body)
      this.send({ t: "hres", id, status: response.status, headers: response.headers })
      this.send({ t: "hchunk", id, b: response.body.toString("base64") })
      this.send({ t: "hend", id })
    } catch (error) {
      this.send({ t: "herr", id, message: (error as Error).message })
    }
  }

  /**
   * Opens the encrypted channel for a phone that asked for /__alma_e2e__.
   */
  private openEncryptedBridge(frame: RelayFrame): void {
    const id = String(frame.id ?? "")
    const path = frame.path ?? ""
    if (path !== E2E_PATH) {
      this.send({ t: "werr", id, message: "end to end encryption is required" })
      return
    }
    // The tunnel answers through the encrypted session, never in the clear.
    let session: E2EAgentSession | null = null
    const tunnel = new TunnelSession(this.target, (frame) => session?.sendApp(frame))
    session = new E2EAgentSession({
      psk: this.psk,
      send: (text) => this.send({ t: "wmsg", id, s: text }),
      onAppFrame: (appFrame) => tunnel.handle(appFrame),
      onError: (message) => {
        this.send({ t: "wclose", id, code: 1011, reason: message })
        this.sessions.delete(id)
      },
    })
    this.sessions.set(id, { session, tunnel })
    // The relay holds the phone's first frames back until the desktop has
    // opened the socket, so the handshake only starts once this is sent.
    this.send({ t: "wopened", id })
  }
}
