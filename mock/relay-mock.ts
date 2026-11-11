import { createServer, type Server } from "node:http"
import type { Socket } from "node:net"
import { type WebSocket, WebSocketServer } from "ws"

/** A frame on the agent socket, as the relay sends and receives them. */
export interface RelayFrame {
  t: string
  id?: string
  method?: string
  path?: string
  headers?: Record<string, string>
  b?: string
  s?: string
  status?: number
  message?: string
}

/** Phone facing paths look like /c/<code>/rest. */
const CLIENT_PATH = /^\/c\/([A-Za-z0-9_-]{16,128})(\/.*)?$/

/** One bridged phone socket and the frames still waiting to reach it. */
interface Bridge {
  id: string
  socket: WebSocket
  opened: boolean
  queue: Array<{ data: Buffer; isBinary: boolean }>
}

/**
 * Minimal stand in for an Alma relay.
 *
 * It accepts one desktop agent on /agent and one phone on /c/<code>/...,
 * forwards the phone's WebSocket to the agent as wopen and pipes the wmsg
 * frames in both directions. That is enough to exercise the desktop side of
 * the tunnel protocol end to end.
 *
 * The queueing behaviour of the real relay is reproduced here: phone frames
 * are held back until the desktop answers wopen with wopened, so a desktop
 * that forgets to open the socket fails here too.
 */
export class RelayMock {
  readonly received: RelayFrame[] = []
  private readonly server: Server
  private readonly agentWss: WebSocketServer
  private readonly phoneWss: WebSocketServer
  private agent: WebSocket | null = null
  private port = 0
  private counter = 0
  private readonly bridges = new Map<string, Bridge>()
  private readonly connections = new Set<Socket>()

  constructor() {
    this.server = createServer()
    this.agentWss = new WebSocketServer({ noServer: true })
    this.phoneWss = new WebSocketServer({ noServer: true })

    this.server.on("connection", (socket) => {
      this.connections.add(socket)
      socket.on("close", () => this.connections.delete(socket))
    })

    this.server.on("upgrade", (request, socket, head) => {
      const url = request.url ?? ""
      if (url === "/agent" || url.startsWith("/agent?")) {
        this.agentWss.handleUpgrade(request, socket, head, (ws) => this.handleAgent(ws))
        return
      }
      const parsed = CLIENT_PATH.exec(url)
      if (parsed === null) {
        socket.destroy()
        return
      }
      const rest = parsed[2] ?? "/"
      this.phoneWss.handleUpgrade(request, socket, head, (ws) => this.handlePhone(ws, rest))
    })
  }

  private handleAgent(socket: WebSocket): void {
    this.agent = socket
    socket.on("message", (data: Buffer) => {
      let frame: RelayFrame
      try {
        frame = JSON.parse(data.toString("utf8")) as RelayFrame
      } catch {
        return
      }
      this.received.push(frame)
      if (frame.t === "register") {
        socket.send(JSON.stringify({ t: "registered", proto: 1 }))
        return
      }
      if (frame.t === "wopened") {
        const bridge = this.bridges.get(String(frame.id ?? ""))
        if (bridge === undefined) {
          return
        }
        bridge.opened = true
        for (const queued of bridge.queue) {
          this.sendWs(bridge, queued.data, queued.isBinary)
        }
        bridge.queue = []
        return
      }
      if (frame.t === "werr") {
        const bridge = this.bridges.get(String(frame.id ?? ""))
        bridge?.socket.close(1011, "Desktop could not open the socket")
        this.bridges.delete(String(frame.id ?? ""))
        return
      }
      if (frame.t === "wmsg" && frame.id !== undefined && frame.s !== undefined) {
        const bridge = this.bridges.get(frame.id)
        bridge?.socket.send(frame.s)
      }
    })
    socket.on("close", () => {
      this.agent = null
    })
  }

  private handlePhone(socket: WebSocket, path: string): void {
    if (this.agent === null) {
      socket.close(502, "no desktop")
      return
    }
    const id = `b${++this.counter}`
    this.bridges.set(id, { id, socket, opened: false, queue: [] })
    this.agent.send(JSON.stringify({ t: "wopen", id, path }))
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      const bridge = this.bridges.get(id)
      if (bridge === undefined) {
        return
      }
      if (!bridge.opened) {
        bridge.queue.push({ data, isBinary })
        return
      }
      this.sendWs(bridge, data, isBinary)
    })
    socket.on("close", () => {
      this.bridges.delete(id)
      this.agent?.send(JSON.stringify({ t: "wclose", id }))
    })
  }

  private sendWs(bridge: Bridge, data: Buffer, isBinary: boolean): void {
    this.agent?.send(JSON.stringify({ t: "wmsg", id: bridge.id, s: data.toString("utf8") }))
    void isBinary
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address()
        this.port = typeof address === "object" && address !== null ? address.port : 0
        resolve()
      })
    })
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /** Sends a frame to the connected desktop. */
  push(frame: RelayFrame): void {
    this.agent?.send(JSON.stringify(frame))
  }

  /** All frames of a kind the desktop sent. */
  framesOfKind(kind: string): RelayFrame[] {
    return this.received.filter((frame) => frame.t === kind)
  }

  async stop(): Promise<void> {
    this.agent?.terminate()
    for (const bridge of this.bridges.values()) {
      bridge.socket.terminate()
    }
    this.bridges.clear()
    for (const connection of this.connections) {
      connection.destroy()
    }
    this.connections.clear()
    this.agentWss.close()
    this.phoneWss.close()
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })
  }
}
