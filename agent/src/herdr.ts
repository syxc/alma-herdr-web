import { connect, type Socket } from "node:net"

/** A request as herdr expects it on the socket. */
export interface HerdrRequest {
  id: string
  method: string
  params: Record<string, unknown>
}

/** The error object herdr returns for a failed request. */
export interface HerdrErrorBody {
  code: string
  message: string
}

/** One entry of the events.subscribe payload. */
export interface HerdrSubscription {
  type: string
  pane_id?: string
}

export class HerdrRequestError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "HerdrRequestError"
    this.code = code
  }
}

export type HerdrEventHandler = (type: string, data: Record<string, unknown>) => void

/**
 * Client for the herdr control socket.
 *
 * The socket speaks newline delimited JSON, but it is not a multiplexed
 * channel: herdr answers a request and then closes the connection. Two
 * consequences shape this class.
 *
 * - Every request opens its own short lived connection.
 * - Event subscriptions need a connection of their own, which stays open and
 *   carries the event stream.
 */
export class HerdrClient {
  private readonly socketPath: string
  private sequence = 0
  private eventSocket: Socket | null = null
  private subscriptionKey = ""
  private readonly handlers: HerdrEventHandler[] = []
  private reconnectTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(socketPath: string) {
    this.socketPath = socketPath
  }

  onEvent(handler: HerdrEventHandler): void {
    this.handlers.push(handler)
  }

  /**
   * Opens the event connection with the given subscriptions.
   *
   * The connection is replaced whenever the subscription set changes, because
   * herdr has no way to amend a live subscription.
   */
  subscribe(subscriptions: HerdrSubscription[]): void {
    const key = subscriptions.map((entry) => `${entry.type}:${entry.pane_id ?? ""}`).join(",")
    if (key === this.subscriptionKey && this.eventSocket !== null) {
      return
    }
    this.subscriptionKey = key
    this.openEventConnection(subscriptions)
  }

  /**
   * Sends a single request over a dedicated connection and resolves with the
   * result object of the response.
   */
  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath)
      let buffer = ""
      let settled = false
      const id = `r${++this.sequence}`

      const finish = (error: Error | null, result?: Record<string, unknown>): void => {
        if (settled) {
          return
        }
        settled = true
        socket.end()
        if (error !== null) {
          reject(error)
          return
        }
        resolve(result ?? {})
      }

      socket.setEncoding("utf8")
      socket.on("connect", () => {
        const payload: HerdrRequest = { id, method, params }
        socket.write(`${JSON.stringify(payload)}\n`, "utf8")
      })
      socket.on("data", (chunk: string) => {
        buffer += chunk
        let index = buffer.indexOf("\n")
        while (index >= 0) {
          const line = buffer.substring(0, index).trim()
          buffer = buffer.substring(index + 1)
          if (line.length > 0) {
            const message = this.parseLine(line)
            if (message !== null && message.id === id) {
              const error = message.error
              if (error !== undefined && error !== null) {
                const body = error as Partial<HerdrErrorBody>
                finish(new HerdrRequestError(body.code ?? "unknown", body.message ?? "herdr request failed"))
                return
              }
              finish(null, (message.result ?? {}) as Record<string, unknown>)
              return
            }
          }
          index = buffer.indexOf("\n")
        }
      })
      socket.on("error", (error: Error) => finish(error))
      socket.on("close", () => finish(new Error("herdr socket closed before answering")))
    })
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.eventSocket?.destroy()
    this.eventSocket = null
  }

  private openEventConnection(subscriptions: HerdrSubscription[]): void {
    this.eventSocket?.destroy()
    this.eventSocket = null
    if (this.closed) {
      return
    }
    const socket = connect(this.socketPath)
    this.eventSocket = socket
    let buffer = ""

    socket.setEncoding("utf8")
    socket.on("connect", () => {
      const payload: HerdrRequest = {
        id: "subscribe",
        method: "events.subscribe",
        params: { subscriptions },
      }
      socket.write(`${JSON.stringify(payload)}\n`, "utf8")
    })
    socket.on("data", (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf("\n")
      while (index >= 0) {
        const line = buffer.substring(0, index).trim()
        buffer = buffer.substring(index + 1)
        if (line.length > 0) {
          const message = this.parseLine(line)
          if (message !== null && message.id === "subscribe" && message.error === undefined) {
            for (const handler of this.handlers) {
              handler("__connected", {})
            }
          }
          this.dispatch(line)
        }
        index = buffer.indexOf("\n")
      }
    })
    socket.on("error", () => {
      this.scheduleReconnect(subscriptions)
    })
    socket.on("close", () => {
      if (this.eventSocket === socket) {
        this.eventSocket = null
      }
      this.scheduleReconnect(subscriptions)
    })
  }

  private scheduleReconnect(subscriptions: HerdrSubscription[]): void {
    if (this.closed || this.reconnectTimer !== null) {
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openEventConnection(subscriptions)
    }, 1000)
  }

  private dispatch(line: string): void {
    const message = this.parseLine(line)
    if (message === null) {
      return
    }
    const event = message.event
    if (typeof event !== "string") {
      return
    }
    const data = (message.data ?? {}) as Record<string, unknown>
    for (const handler of this.handlers) {
      handler(event, data)
    }
  }

  parseLine(line: string): Record<string, unknown> | null {
    try {
      return JSON.parse(line) as Record<string, unknown>
    } catch {
      return null
    }
  }
}
