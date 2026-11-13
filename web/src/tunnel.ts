import { withTimeout } from "./deadline.js"
import { E2E_PATH, E2EClientSession } from "./e2e.js"
import { hexToBytes } from "./pairing.js"

export interface RemoteConfig {
  relay: string
  token: string
  code: string
}

export interface TunnelResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}

interface PendingRequest {
  resolve: (response: TunnelResponse) => void
  reject: (error: Error) => void
}

interface Stream {
  onMessage: (data: Uint8Array) => void
  onClose: () => void
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

/**
 * The remote half of the client: an encrypted tunnel to the desktop through
 * an Alma relay.
 *
 * The socket carries the handshake first and sealed frames afterwards, so the
 * relay only sees ciphertext. Requests and the event stream share this one
 * channel.
 */
export class RemoteTunnel {
  private socket: WebSocket | null = null
  private session: E2EClientSession | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly streams = new Map<string, Stream>()
  private counter = 0
  private readonly ready: Promise<void>
  private markReady: () => void = () => undefined
  private failReady: (error: Error) => void = () => undefined

  constructor(private readonly config: RemoteConfig) {
    this.ready = new Promise((resolve, reject) => {
      this.markReady = resolve
      this.failReady = reject
    })
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN
  }

  connect(): Promise<void> {
    const base = this.config.relay.replace(/\/$/, "")
    const origin = base.replace(/^https?:\/\//, "")
    const scheme = base.startsWith("https") ? "wss://" : "ws://"
    const url = `${scheme + origin}/c/${this.config.token}${E2E_PATH}`
    const socket = new WebSocket(url)
    this.socket = socket

    this.session = new E2EClientSession({
      psk: hexToBytes(this.config.code),
      send: (text) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(text)
        }
      },
      onAppFrame: (frame) => this.handleFrame(frame),
      onError: (message) => {
        this.failReady(new Error(message))
        this.close()
      },
      onReady: () => this.markReady(),
    })

    socket.addEventListener("open", () => {
      void this.session?.start()
    })
    socket.addEventListener("message", (event) => {
      void this.session?.receive(String(event.data))
    })
    socket.addEventListener("error", () => {
      this.failReady(new Error("the relay connection failed"))
    })
    socket.addEventListener("close", () => {
      this.failReady(new Error("the relay closed the connection"))
      for (const stream of this.streams.values()) {
        stream.onClose()
      }
      this.streams.clear()
      // A request that is still open would wait for an answer that never
      // comes, so it fails right away instead.
      for (const pending of this.pending.values()) {
        pending.reject(new Error("the relay closed the connection"))
      }
      this.pending.clear()
    })
    return withTimeout(this.ready, 10000, "the relay handshake timed out").catch((error) => {
      this.close()
      throw error
    })
  }

  /**
   * Sends one request through the tunnel.
   */
  async request(method: string, path: string, body?: Uint8Array): Promise<TunnelResponse> {
    await this.ready
    if (!this.connected) throw new Error("the relay is disconnected")
    const id = `r${++this.counter}`
    const answer = new Promise<TunnelResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    try {
      const [, response] = await withTimeout(
        Promise.all([
          this.session!.sendApp({
            t: "req",
            id,
            method,
            path,
            headers: {},
            body: body === undefined ? undefined : toBase64(body),
          }),
          answer,
        ]),
        15000,
        "the desktop request timed out",
      )
      return response
    } catch (error) {
      this.close()
      throw error
    } finally {
      this.pending.delete(id)
    }
  }

  /**
   * Opens a stream, used for the event channel.
   *
   * It hands back a function that closes this stream alone. The tunnel stays
   * open, because the requests travel through the same socket.
   */
  async openStream(path: string, onMessage: (data: Uint8Array) => void): Promise<() => void> {
    await this.ready
    const id = `s${++this.counter}`
    this.streams.set(id, { onMessage, onClose: () => this.streams.delete(id) })
    await this.session?.sendApp({ t: "wsopen", id, path })
    return () => {
      if (!this.streams.delete(id)) {
        return
      }
      void this.session?.sendApp({ t: "wsclose", id })
    }
  }

  close(): void {
    const error = new Error("the relay connection was closed")
    this.failReady(error)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const stream of this.streams.values()) stream.onClose()
    this.streams.clear()
    this.socket?.close()
    this.socket = null
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const kind = frame.t
    const id = String(frame.id ?? "")
    if (kind === "res") {
      const pending = this.pending.get(id)
      this.pending.delete(id)
      pending?.resolve({
        status: Number(frame.status ?? 200),
        headers: (frame.headers ?? {}) as Record<string, string>,
        body: fromBase64(String(frame.body ?? "")),
      })
      return
    }
    if (kind === "err") {
      const pending = this.pending.get(id)
      this.pending.delete(id)
      pending?.reject(new Error(String(frame.message ?? "request failed")))
      return
    }
    if (kind === "wsmsg") {
      this.streams.get(id)?.onMessage(fromBase64(String(frame.data ?? "")))
      return
    }
    if (kind === "wsclose" || kind === "wserr") {
      const stream = this.streams.get(id)
      this.streams.delete(id)
      stream?.onClose()
    }
  }
}
