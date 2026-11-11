import type { webcrypto } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { Socket } from "node:net"
import { type WebSocket, WebSocketServer } from "ws"

/**
 * A stand in for an Alma desktop.
 *
 * It speaks the same end to end protocol as the Alma app: the client sends a
 * hello with its ephemeral key, the desktop answers with its own key and a
 * confirmation value, and both sides seal every frame afterwards. Inside the
 * tunnel the desktop answers herdr calls, which is what the client needs to
 * show a terminal and to type into it.
 *
 * The crypto is the one of the Alma desktop: WebCrypto with ECDH P-256,
 * HKDF-SHA256 and AES-256-GCM.
 */

type CryptoKey = webcrypto.CryptoKey
type SubtleCrypto = webcrypto.SubtleCrypto

const LABEL = "alma-relay-e2e/v1"
const ROUTING_SALT = "alma-relay-e2e/v1/routing"
const FRAME_MAGIC = 0

// The crypto is taken here, so a test can take crypto.subtle away from the
// client without taking it away from the desktop.
const SUBTLE = globalThis.crypto.subtle

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function base64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
  const remainder = padded.length % 4
  const full = remainder === 0 ? padded : padded + "=".repeat(4 - remainder)
  const binary = atob(full)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false
  }
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

/** The ephemeral key pair of one session. */
interface EphemeralKeys {
  privateKey: CryptoKey
  publicKey: CryptoKey
}

interface SessionKeys {
  c2s: CryptoKey
  s2c: CryptoKey
  confirmResponder: Uint8Array
  confirmInitiator: Uint8Array
}

/** A frame that came out of the tunnel. */
interface InnerFrame {
  t?: string
  id?: string
  method?: string
  path?: string
  headers?: Record<string, string>
  b?: Uint8Array
  status?: number
  message?: string
}

export class AlmaMock {
  readonly code: string
  private readonly server: Server
  private readonly wss: WebSocketServer
  private readonly connections = new Set<Socket>()
  private port = 0
  private readonly paneText = new Map<string, string>()
  private revision = 0

  constructor(code = "mock-connect-code-0123456789abcdef") {
    this.code = code
    // The second pane starts with its own text, so a test can tell the panes
    // apart when it switches between them.
    this.paneText.set("w1:p2", "mock pane two")
    this.server = createServer()
    this.wss = new WebSocketServer({ noServer: true })
    this.server.on("connection", (socket) => {
      this.connections.add(socket)
      socket.on("close", () => this.connections.delete(socket))
    })
    this.server.on("upgrade", (request, socket, head) => {
      this.wss.handleUpgrade(request, socket, head, (ws) => void this.serve(ws))
    })
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

  /** The text the mock pane shows, so a test can check what was typed. */
  get output(): string {
    return this.paneText.get("w1:p1") ?? ""
  }

  /** The text of one pane, so a test can check what was typed into it. */
  outputOf(paneId: string): string {
    return this.paneText.get(paneId) ?? ""
  }

  async stop(): Promise<void> {
    for (const socket of this.connections) {
      socket.destroy()
    }
    this.connections.clear()
    this.wss.close()
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })
  }

  /** The routing token the relay would address this desktop with. */
  async routingToken(): Promise<string> {
    const subtle = SUBTLE
    const key = await subtle.importKey("raw", encoder.encode(this.code), "HKDF", false, ["deriveBits"])
    const bits = await subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode(ROUTING_SALT),
        info: new Uint8Array(0),
      },
      key,
      128,
    )
    return base64Url(new Uint8Array(bits))
  }

  private async serve(socket: WebSocket): Promise<void> {
    const subtle = SUBTLE
    const myNonce = crypto.getRandomValues(new Uint8Array(16))
    // The keys are made when the hello arrives, so no frame of the client
    // can be lost while this is set up.
    let ephemeral: EphemeralKeys | null = null
    let myPublic: Uint8Array | null = null
    let keys: SessionKeys | null = null
    let sendKey: CryptoKey | null = null
    let recvKey: CryptoKey | null = null

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      void (async () => {
        try {
          if (!isBinary) {
            const frame = JSON.parse(data.toString("utf8")) as {
              t?: string
              epk?: string
              n?: string
              ci?: string
            }
            if (frame.t === "hi") {
              const peerPublic = fromBase64Url(String(frame.epk ?? ""))
              const peerNonce = fromBase64Url(String(frame.n ?? ""))
              ephemeral = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])
              myPublic = new Uint8Array(await subtle.exportKey("raw", ephemeral.publicKey))
              keys = await deriveKeys(
                subtle,
                ephemeral.privateKey,
                peerPublic,
                this.code,
                peerPublic,
                myPublic,
                peerNonce,
                myNonce,
              )
              socket.send(
                JSON.stringify({
                  t: "hi",
                  epk: base64Url(myPublic),
                  n: base64Url(myNonce),
                  cr: base64Url(keys.confirmResponder),
                  bin: 1,
                }),
              )
              return
            }
            if (frame.t === "ok" && keys !== null) {
              if (!equalBytes(fromBase64Url(String(frame.ci ?? "")), keys.confirmInitiator)) {
                socket.close(4401, "handshake failed")
                return
              }
              sendKey = keys.s2c
              recvKey = keys.c2s
              return
            }
            return
          }

          if (recvKey === null) {
            return
          }
          const bytes = new Uint8Array(data)
          const plain = new Uint8Array(
            await subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, recvKey, bytes.subarray(12)),
          )
          const frame = decodeFrame(new Uint8Array(plain))
          if (frame.t === "hreq") {
            await this.answer(socket, frame, sendKey)
          }
        } catch (error) {
          socket.close(4401, `e2e error: ${(error as Error).message}`)
        }
      })()
    })
  }

  /** Answers one herdr call and sends the result back through the tunnel. */
  private async answer(socket: WebSocket, frame: InnerFrame, sendKey: CryptoKey | null): Promise<void> {
    if (sendKey === null) {
      return
    }
    const id = String(frame.id ?? "")
    // The herdr call travels in the body of the http request.
    const body =
      frame.b === undefined
        ? {}
        : (JSON.parse(decoder.decode(frame.b)) as { method?: string; params?: Record<string, unknown> })
    const method = String(body.method ?? "")
    const params = body.params ?? {}
    const result = this.herdr(method, params)
    const payload = new TextEncoder().encode(JSON.stringify(result.body))
    await this.send(
      socket,
      sendKey,
      encodeFrame({
        t: "hres",
        id,
        status: result.status,
        headers: { "content-type": "application/json" },
      }),
    )
    await this.send(socket, sendKey, encodeFrame({ t: "hchunk", id, b: payload }))
    await this.send(socket, sendKey, encodeFrame({ t: "hend", id }))
  }

  /** Seals one frame and puts it on the wire. */
  private async send(socket: WebSocket, key: CryptoKey, frame: Uint8Array): Promise<void> {
    const nonce = new Uint8Array(12)
    const sealed = await SUBTLE.encrypt({ name: "AES-GCM", iv: nonce }, key, frame)
    const out = new Uint8Array(nonce.length + sealed.byteLength)
    out.set(nonce, 0)
    out.set(new Uint8Array(sealed), nonce.length)
    socket.send(out)
  }

  /** The little herdr the mock answers with. */
  private herdr(
    method: string,
    params: Record<string, unknown>,
  ): {
    status: number
    body: Record<string, unknown>
  } {
    if (method === "workspace.list") {
      return {
        status: 200,
        body: {
          result: {
            type: "workspace_list",
            workspaces: [
              {
                workspace_id: "w1",
                number: 1,
                label: "mock",
                focused: true,
                pane_count: 2,
                tab_count: 2,
                active_tab_id: "w1:t1",
                agent_status: "idle",
              },
            ],
          },
        },
      }
    }
    if (method === "tab.list") {
      return {
        status: 200,
        body: {
          result: {
            type: "tab_list",
            tabs: [
              {
                tab_id: "w1:t1",
                workspace_id: "w1",
                number: 1,
                label: "1",
                focused: true,
                pane_count: 1,
                agent_status: "idle",
              },
              {
                tab_id: "w1:t2",
                workspace_id: "w1",
                number: 2,
                label: "2",
                focused: false,
                pane_count: 1,
                agent_status: "working",
              },
            ],
          },
        },
      }
    }
    if (method === "pane.list") {
      return {
        status: 200,
        body: {
          result: {
            type: "pane_list",
            panes: [
              {
                pane_id: "w1:p1",
                workspace_id: "w1",
                tab_id: "w1:t1",
                focused: true,
                cwd: "/tmp",
                foreground_cwd: "/tmp",
                agent_status: "idle",
                scroll: { viewport_rows: 24 },
              },
              {
                pane_id: "w1:p2",
                workspace_id: "w1",
                tab_id: "w1:t2",
                focused: false,
                cwd: "/var/tmp",
                foreground_cwd: "/var/tmp",
                agent_status: "working",
                scroll: { viewport_rows: 24 },
              },
            ],
          },
        },
      }
    }
    if (method === "pane.read") {
      return {
        status: 200,
        body: {
          result: {
            type: "pane_read",
            read: {
              pane_id: String(params.pane_id ?? ""),
              source: String(params.source ?? "visible"),
              format: String(params.format ?? "ansi"),
              text: this.paneText.get(String(params.pane_id ?? "")) ?? "",
              revision: this.revision,
              truncated: false,
            },
          },
        },
      }
    }
    if (method === "pane.send_text") {
      const paneId = String(params.pane_id ?? "")
      this.paneText.set(paneId, (this.paneText.get(paneId) ?? "") + String(params.text ?? ""))
      this.revision += 1
      return { status: 200, body: { result: { type: "ok" } } }
    }
    if (method === "pane.send_keys") {
      const keys = Array.isArray(params.keys) ? (params.keys as string[]) : []
      const paneId = String(params.pane_id ?? "")
      this.paneText.set(paneId, (this.paneText.get(paneId) ?? "") + (keys.includes("enter") ? "\r\n" : ""))
      this.revision += 1
      return { status: 200, body: { result: { type: "ok" } } }
    }
    return {
      status: 403,
      body: {
        error: {
          code: "forbidden",
          message: `${method} is not available from the phone`,
        },
      },
    }
  }
}

/** Derives the session keys the way the Alma desktop does. */
async function deriveKeys(
  subtle: SubtleCrypto,
  privateKey: CryptoKey,
  peerPublic: Uint8Array,
  code: string,
  initiatorPublic: Uint8Array,
  responderPublic: Uint8Array,
  initiatorNonce: Uint8Array,
  responderNonce: Uint8Array,
): Promise<SessionKeys> {
  const peer = await subtle.importKey("raw", peerPublic, { name: "ECDH", namedCurve: "P-256" }, false, [])
  const shared = await subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256)
  const prk = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"])
  const digest = new Uint8Array(
    await subtle.digest(
      "SHA-256",
      concat(encoder.encode(LABEL), initiatorPublic, responderPublic, initiatorNonce, responderNonce),
    ),
  )
  const salt = encoder.encode(code)
  const info = (tag: string): Uint8Array => concat(encoder.encode(`${tag}|`), digest)
  const derive = async (tag: string): Promise<Uint8Array> =>
    new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: info(tag) }, prk, 256))
  const c2s = await subtle.importKey("raw", await derive("c2s"), "AES-GCM", false, ["encrypt", "decrypt"])
  const s2c = await subtle.importKey("raw", await derive("s2c"), "AES-GCM", false, ["encrypt", "decrypt"])
  return {
    c2s,
    s2c,
    confirmResponder: await derive("confirm-r"),
    confirmInitiator: await derive("confirm-i"),
  }
}

/** Encodes one frame the way the Alma desktop does. */
function encodeFrame(frame: Record<string, unknown>): Uint8Array {
  const payload = frame.b
  if (!(payload instanceof Uint8Array)) {
    return encoder.encode(JSON.stringify(frame))
  }
  const header: Record<string, unknown> = { ...frame, $: "b" }
  delete header.b
  const headerBytes = encoder.encode(JSON.stringify(header))
  const out = new Uint8Array(5 + headerBytes.length + payload.length)
  out[0] = FRAME_MAGIC
  new DataView(out.buffer).setUint32(1, headerBytes.length, false)
  out.set(headerBytes, 5)
  out.set(payload, 5 + headerBytes.length)
  return out
}

function decodeFrame(bytes: Uint8Array): InnerFrame {
  if (bytes.length > 0 && bytes[0] === FRAME_MAGIC) {
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1)
    const header = JSON.parse(decoder.decode(bytes.subarray(5, 5 + length))) as Record<string, unknown>
    const kind = header.$
    delete header.$
    const payload = bytes.subarray(5 + length)
    if (kind === "b") {
      header.b = new Uint8Array(payload)
    }
    return header as InnerFrame
  }
  const frame = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>
  if (typeof frame.b === "string") {
    frame.b = fromBase64Url(frame.b)
  }
  return frame as InnerFrame
}
