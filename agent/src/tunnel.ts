import type WebSocket from "ws"

import { forwardedHeaders, type LocalTarget, localRequest, openLocalSocket } from "./bridge.js"

/**
 * Multiplexes requests and event streams over one encrypted channel.
 *
 * The frames below travel inside the end to end encrypted session, so the
 * relay only ever sees ciphertext:
 *
 *   client -> desktop : { t: 'req', id, method, path, headers, body }
 *   client -> desktop : { t: 'wsopen', id, path }
 *   desktop -> client : { t: 'res', id, status, headers, body }
 *   desktop -> client : { t: 'err', id, message }
 *   desktop -> client : { t: 'wsopened', id } / { t: 'wserr', id, message }
 *   both              : { t: 'wsmsg', id, data } / { t: 'wsclose', id, code }
 */
export class TunnelSession {
  private readonly sockets = new Map<string, WebSocket>()

  constructor(
    private readonly target: LocalTarget,
    private readonly send: (frame: Record<string, unknown>) => void,
  ) {}

  handle(frame: Record<string, unknown>): void {
    const kind = frame.t
    if (kind === "req") {
      void this.serveRequest(frame)
      return
    }
    if (kind === "wsopen") {
      this.openSocket(frame)
      return
    }
    if (kind === "wsmsg") {
      const id = String(frame.id ?? "")
      const socket = this.sockets.get(id)
      if (socket === undefined || typeof frame.data !== "string") {
        return
      }
      socket.send(Buffer.from(frame.data, "base64"))
      return
    }
    if (kind === "wsclose" || kind === "wscancel") {
      const id = String(frame.id ?? "")
      this.sockets.get(id)?.close()
      this.sockets.delete(id)
    }
  }

  close(): void {
    for (const socket of this.sockets.values()) {
      socket.close()
    }
    this.sockets.clear()
  }

  private async serveRequest(frame: Record<string, unknown>): Promise<void> {
    const id = String(frame.id ?? "")
    const method = String(frame.method ?? "GET")
    const path = String(frame.path ?? "/")
    const headers = {
      "accept-encoding": "identity",
      ...forwardedHeaders((frame.headers ?? {}) as Record<string, unknown>),
    }
    const body = typeof frame.body === "string" ? Buffer.from(frame.body, "base64") : undefined
    try {
      const response = await localRequest(this.target, method, path, headers, body)
      this.send({
        t: "res",
        id,
        status: response.status,
        headers: response.headers,
        body: response.body.toString("base64"),
      })
    } catch (error) {
      this.send({ t: "err", id, message: (error as Error).message })
    }
  }

  private openSocket(frame: Record<string, unknown>): void {
    const id = String(frame.id ?? "")
    const path = String(frame.path ?? "/")
    const socket = openLocalSocket(this.target, path, {
      onOpen: () => this.send({ t: "wsopened", id }),
      onMessage: (data, isBinary) => {
        this.send({
          t: "wsmsg",
          id,
          data: data.toString("base64"),
          binary: isBinary,
        })
      },
      onClose: (code) => this.send({ t: "wsclose", id, code }),
      onError: (message) => this.send({ t: "wserr", id, message }),
    })
    this.sockets.set(id, socket)
  }
}
