import { spawn } from "node:child_process"
import { connect } from "node:net"
import type { Readable, Writable } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import { HerdrRequestError } from "./herdr.js"

type Json = Record<string, unknown>
type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
type Channel = {
  data: Buffer[]
  credit: number
  receive?: (data: Buffer) => void
  fail?: (error: Error) => void
  ended: boolean
}

export interface CoreOptions {
  /** Omit to let hc resolve its native endpoint and session defaults. */
  env?: NodeJS.ProcessEnv
  hcPath?: string
  socketPath?: string
  timeoutMs?: number
  pollIntervalMs?: number
}

/** One framed connection; closing a terminal stream never closes its siblings. */
export class CoreTransport {
  private input: Writable | null = null
  private disconnect: (() => void) | null = null
  private ready: Promise<void> | null = null
  private buffer: Buffer = Buffer.alloc(0)
  private framed = false
  private sequence = 0
  private closed = false
  private epoch = 0
  private readonly pending = new Map<number, Pending>()
  private readonly channels = new Map<number, Channel>()

  constructor(
    private readonly options: CoreOptions = {},
    private readonly onDisconnect: () => void = () => {},
  ) {}

  private open(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Core client is closed"))
    if (this.ready) return this.ready
    const epoch = ++this.epoch
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error("Core connection timed out")), this.options.timeoutMs ?? 10000)
      const fail = (error: Error): void => {
        clearTimeout(timer)
        reject(error)
        if (this.epoch === epoch) this.drop(error)
      }
      const env = this.options.env ?? process.env
      const endpoint = this.options.socketPath || env.HC_SOCKET
      let output: Readable
      let begin: () => void
      if (endpoint) {
        const socket = connect(endpoint)
        this.input = socket
        output = socket
        this.disconnect = () => socket.destroy()
        begin = () => {
          socket.once("connect", handshake)
        }
      } else {
        const child = spawn(this.options.hcPath ?? "hc", ["connect"], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        })
        this.input = child.stdin
        output = child.stdout
        this.disconnect = () => {
          child.stdin.destroy()
          child.stdout.destroy()
          child.kill()
        }
        // Drain diagnostics without logging potentially private terminal information.
        child.stderr.resume()
        child.once("error", fail)
        child.once("exit", () => fail(new Error("hc connect exited")))
        begin = () => {
          child.once("spawn", handshake)
        }
      }
      const handshake = (): void => {
        this.sendRequest("hello", { framed: true, generation: 1 }, false).then((result) => {
          if (result.framed !== true || result.generation !== 1) {
            fail(new Error("Core does not support framed protocol generation 1"))
          } else {
            clearTimeout(timer)
            resolve()
          }
        }, fail)
      }
      this.input.on("error", fail)
      output.on("error", fail)
      output.on("close", () => fail(new Error("Core connection closed")))
      output.on("data", (chunk: Buffer) => {
        if (this.epoch !== epoch) return
        try {
          this.receive(chunk)
        } catch (error) {
          fail(error as Error)
        }
      })
      begin()
    })
    // Clear failed connections after this promise has been installed.
    const ready = this.ready
    ready.catch(() => {
      if (this.ready === ready) this.ready = null
    })
    return this.ready
  }

  async request(method: string, params: Json = {}): Promise<Json> {
    await this.open()
    return this.sendRequest(method, params, true)
  }

  private sendRequest(method: string, params: Json, framed: boolean): Promise<Json> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(
        () => {
          this.drop(new Error(`Core request timed out: ${method}`))
        },
        this.options.timeoutMs ?? (method === "terminal.send" ? 90000 : 10000),
      )
      this.pending.set(id, { resolve, reject, timer })
      const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      if (framed) this.frame(0, 0, payload)
      else this.input?.write(Buffer.concat([payload, Buffer.from("\n")]))
    })
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (!this.framed) {
      const end = this.buffer.indexOf(10)
      if (end < 0) {
        if (this.buffer.length > 16 * 1024 * 1024) throw new Error("Core handshake exceeds frame limit")
        return
      }
      const message = JSON.parse(this.buffer.subarray(0, end).toString()) as Json
      this.buffer = this.buffer.subarray(end + 1)
      this.framed = (message.result as Json | undefined)?.framed === true
      this.reply(message)
    }
    while (this.framed && this.buffer.length >= 9) {
      const channel = this.buffer.readUInt32LE(0)
      const kind = this.buffer[4]
      const size = this.buffer.readUInt32LE(5)
      if (size > 16 * 1024 * 1024) throw new Error("Core frame exceeds 16 MiB")
      if (this.buffer.length < size + 9) return
      const payload = this.buffer.subarray(9, size + 9)
      this.buffer = this.buffer.subarray(size + 9)
      if (channel === 0 && kind === 0) this.reply(JSON.parse(payload.toString()) as Json)
      else {
        if (!this.channels.has(channel)) continue
        const stream = this.channel(channel)
        if (kind === 0) {
          if (stream.receive) stream.receive(payload)
          else stream.data.push(payload)
          const credit = Buffer.alloc(4)
          credit.writeUInt32LE(size)
          this.frame(channel, 1, credit)
        } else if (kind === 1 && payload.length === 4) stream.credit += payload.readUInt32LE(0)
        else if (kind === 2 && !stream.ended) {
          stream.ended = true
          stream.fail?.(new Error("Core terminal stream closed"))
          this.frame(channel, 2)
        }
      }
    }
  }

  private reply(message: Json): void {
    const pending = this.pending.get(Number(message.id))
    if (!pending) return
    this.pending.delete(Number(message.id))
    clearTimeout(pending.timer)
    if (message.error) {
      const body = message.error as Json
      const data = body.data as Json | undefined
      pending.reject(
        new HerdrRequestError(String(data?.kind ?? body.code), String(body.message ?? "Core request failed")),
      )
    } else {
      const result = (message.result ?? {}) as Json
      if (typeof result.channel === "number" && result.channel > 0) this.channel(result.channel)
      pending.resolve(result)
    }
  }

  private channel(id: number): Channel {
    let channel = this.channels.get(id)
    if (!channel) {
      channel = { data: [], credit: 256 * 1024, ended: false }
      this.channels.set(id, channel)
    }
    return channel
  }

  private frame(channel: number, kind: number, payload: Buffer = Buffer.alloc(0)): void {
    if (!this.input || this.input.destroyed) return
    const header = Buffer.alloc(9)
    header.writeUInt32LE(channel, 0)
    header[4] = kind
    header.writeUInt32LE(payload.length, 5)
    this.input.write(Buffer.concat([header, payload]))
  }

  async paint(id: number, settleMs = 25): Promise<{ text: string; truncated: boolean }> {
    const stream = this.channel(id)
    if (!this.input) throw new Error("Core terminal stream closed")
    return new Promise((resolve, reject) => {
      const chunks = stream.data.splice(0)
      let quiet: NodeJS.Timeout | undefined
      let bounded: NodeJS.Timeout | undefined
      const cleanup = (): void => {
        clearTimeout(timer)
        clearTimeout(quiet)
        clearTimeout(bounded)
        stream.receive = undefined
        stream.fail = undefined
      }
      const finish = (): void => {
        const bytes = Buffer.concat(chunks)
        // A paint can end with a partial character carried into live output.
        // Keep that tail buffered in the decoder rather than emitting U+FFFD.
        const decoder = new StringDecoder("utf8")
        const text = decoder.write(bytes)
        cleanup()
        resolve({ text, truncated: Buffer.byteLength(text) !== bytes.length })
      }
      const completeScreen = (): boolean => {
        const bytes = Buffer.concat(chunks)
        // Core appends this mode after screen.paint(), before status/continuation.
        // Credit can split that paint across DATA frames and UTF-8 boundaries.
        return bytes.includes(Buffer.from("\x1b[?9001h")) || bytes.includes(Buffer.from("\x1b[?9001l"))
      }
      const changed = (): void => {
        if (!completeScreen()) return
        if (settleMs === 0) {
          finish()
          return
        }
        clearTimeout(quiet)
        quiet = setTimeout(finish, settleMs)
        bounded ??= setTimeout(finish, 200)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error("Core paint timed out before its complete screen"))
      }, this.options.timeoutMs ?? 10000)
      stream.fail = (error) => {
        if (completeScreen()) finish()
        else {
          cleanup()
          reject(error)
        }
      }
      stream.receive = (data) => {
        chunks.push(data)
        changed()
      }
      changed()
      if (stream.ended && stream.fail) stream.fail(new Error("Core terminal stream closed"))
    })
  }

  async write(id: number, data: Buffer): Promise<void> {
    const stream = this.channel(id)
    const deadline = Date.now() + (this.options.timeoutMs ?? 10000)
    let offset = 0
    while (offset < data.length) {
      if (stream.ended || !this.input || this.input.destroyed) throw new Error("Core terminal stream closed")
      if (Date.now() > deadline) throw new Error("Core input credit timed out")
      if (stream.credit === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        continue
      }
      const size = Math.min(stream.credit, 64 * 1024, data.length - offset)
      stream.credit -= size
      this.frame(id, 0, data.subarray(offset, offset + size))
      offset += size
    }
    // Queue CLOSE after all DATA writes on the same ordered stream.
    if (!this.input || this.input.destroyed) throw new Error("Core terminal stream closed")
    await new Promise<void>((resolve, reject) =>
      this.input?.write(Buffer.alloc(0), (error) => (error ? reject(error) : resolve())),
    )
  }

  closeChannel(id: number): void {
    this.channels.get(id)?.fail?.(new Error("Core terminal stream closed"))
    this.frame(id, 2)
    this.channels.delete(id)
  }

  private drop(error: Error): void {
    this.epoch += 1
    const disconnect = this.disconnect
    this.disconnect = null
    this.input = null
    this.ready = null
    this.framed = false
    this.buffer = Buffer.alloc(0)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    for (const stream of this.channels.values()) {
      stream.ended = true
      stream.fail?.(error)
    }
    this.channels.clear()
    disconnect?.()
    if (!this.closed) this.onDisconnect()
  }

  close(): void {
    this.closed = true
    this.drop(new Error("Core client is closed"))
  }
}

export function encodeCoreKeys(keys: string[], applicationCursor = false): string {
  return keys
    .map((key) => {
      const parts = key.toLowerCase().split("+")
      const name = parts.pop() ?? ""
      const ctrl = parts.includes("ctrl")
      const alt = parts.includes("alt")
      const shift = parts.includes("shift")
      if (parts.some((part) => !["ctrl", "alt", "shift"].includes(part)))
        throw new HerdrRequestError("invalid_keys", `Unsupported key: ${key}`)
      const modifier = 1 + Number(shift) + 2 * Number(alt) + 4 * Number(ctrl)
      const arrows: Record<string, string> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" }
      if (arrows[name])
        return modifier > 1
          ? `\x1b[1;${modifier}${arrows[name]}`
          : `\x1b${applicationCursor ? "O" : "["}${arrows[name]}`
      const named: Record<string, string> = {
        enter: "\r",
        esc: "\x1b",
        escape: "\x1b",
        tab: "\t",
        backspace: "\x7f",
        space: " ",
      }
      if (name === "tab" && shift && !ctrl && !alt) return "\x1b[Z"
      const tilde: Record<string, number> = {
        insert: 2,
        delete: 3,
        pageup: 5,
        pagedown: 6,
        f5: 15,
        f6: 17,
        f7: 18,
        f8: 19,
        f9: 20,
        f10: 21,
        f11: 23,
        f12: 24,
      }
      if (tilde[name]) return `\x1b[${tilde[name]}${modifier > 1 ? `;${modifier}` : ""}~`
      if (/^f[1-4]$/.test(name)) {
        const end = "PQRS"[Number(name.slice(1)) - 1]
        return modifier > 1 ? `\x1b[1;${modifier}${end}` : `\x1bO${end}`
      }
      let result = named[name] ?? (name.length === 1 ? (shift ? name.toUpperCase() : name) : "")
      if (!result) throw new HerdrRequestError("invalid_keys", `Unsupported key: ${key}`)
      if (ctrl) {
        const code = (name === "space" ? "@" : name).toUpperCase().charCodeAt(0)
        if (code < 64 || code > 95) throw new HerdrRequestError("invalid_keys", `Unsupported control key: ${key}`)
        result = String.fromCharCode(code - 64)
      }
      return (alt ? "\x1b" : "") + result
    })
    .join("")
}
