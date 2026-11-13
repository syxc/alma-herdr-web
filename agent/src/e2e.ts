import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from "node:crypto"

/**
 * End to end encryption for the Alma relay tunnel.
 *
 * The relay only carries opaque bytes, so the desktop and the phone run their
 * own encrypted channel inside it. The connect code is the pre shared key:
 * it authenticates both peers and is never sent in the clear.
 *
 *   client -> desktop : e2e-hello  (PSK sealed ephemeral public key)
 *   desktop -> client : e2e-hello-ack (PSK sealed ephemeral public key)
 *   both              : e2e frames (AES-256-GCM under ECDH derived keys)
 *
 * The ephemeral keys give forward secrecy, the pre shared key makes the
 * handshake mutual: only a peer that knows the code can produce a valid
 * sealed hello, so the relay cannot impersonate the desktop.
 */

export const E2E_PATH = "/__alma_e2e__"

const SALT = Buffer.from("herdr-web/e2e/v1", "utf8")
const HELLO_CLIENT = "hello-client"
const HELLO_AGENT = "hello-agent"
const SESSION_C2A = "session-c2a"
const SESSION_A2C = "session-a2c"
const FRAME_AAD = Buffer.from("herdr-web/e2e/v1/frame", "utf8")
const SPKI_PREFIX = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex")

/** HKDF-SHA256 with a salt and an info label. */
function hkdf(ikm: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, 32))
}

function encrypt(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([body, cipher.getAuthTag()])
}

function decrypt(key: Buffer, nonce: Buffer, ciphertext: Buffer, aad: Buffer): Buffer {
  const tag = ciphertext.subarray(ciphertext.length - 16)
  const body = ciphertext.subarray(0, ciphertext.length - 16)
  const decipher = createDecipheriv("aes-256-gcm", key, nonce)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

function counterBytes(counter: number): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(counter))
  return buffer
}

function publicPointOf(key: KeyObject): Buffer {
  const der = key.export({ format: "der", type: "spki" })
  return der.subarray(der.length - 65)
}

function importPublicKey(point: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, point]),
    format: "der",
    type: "spki",
  })
}

interface SessionKeys {
  send: Buffer
  recv: Buffer
  sendPrefix: Buffer
  recvPrefix: Buffer
}

export interface E2EAgentOptions {
  psk: Buffer
  send: (text: string) => void
  onAppFrame: (frame: Record<string, unknown>) => void
  onError: (message: string) => void
}

/**
 * Desktop side of the encrypted channel.
 */
export class E2EAgentSession {
  private readonly psk: Buffer
  private readonly send: (text: string) => void
  private readonly onAppFrame: (frame: Record<string, unknown>) => void
  private readonly onError: (message: string) => void
  private keys: SessionKeys | null = null
  private sendCounter = 0
  private recvCounter = 0

  constructor(options: E2EAgentOptions) {
    this.psk = options.psk
    this.send = options.send
    this.onAppFrame = options.onAppFrame
    this.onError = options.onError
  }

  get ready(): boolean {
    return this.keys !== null
  }

  receive(text: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    const kind = frame.t
    if (kind === "e2e-hello") {
      this.acceptHello(frame)
      return
    }
    if (kind === "e2e") {
      this.acceptEncrypted(frame)
      return
    }
    if (kind === "e2e-error") {
      this.onError(String(frame.message ?? "e2e error"))
    }
  }

  sendApp(frame: Record<string, unknown>): void {
    const keys = this.keys
    if (keys === null) {
      return
    }
    const nonce = Buffer.concat([keys.sendPrefix, counterBytes(this.sendCounter)])
    this.sendCounter += 1
    const plaintext = Buffer.from(JSON.stringify(frame), "utf8")
    const ciphertext = encrypt(keys.send, nonce, plaintext, FRAME_AAD)
    this.send(JSON.stringify({ t: "e2e", c: ciphertext.toString("base64") }))
  }

  private acceptHello(frame: Record<string, unknown>): void {
    if (this.keys !== null) {
      return
    }
    const nonce = Buffer.from(String(frame.n ?? ""), "base64")
    const ciphertext = Buffer.from(String(frame.c ?? ""), "base64")
    const helloKey = hkdf(this.psk, SALT, HELLO_CLIENT)
    let plaintext: Buffer
    try {
      plaintext = decrypt(helloKey, nonce, ciphertext, Buffer.from(`herdr-web/e2e/v1/${HELLO_CLIENT}`, "utf8"))
    } catch {
      this.send(JSON.stringify({ t: "e2e-error", message: "pairing code mismatch" }))
      this.onError("pairing code mismatch")
      return
    }
    let payload: { pk?: string; pn?: string }
    try {
      payload = JSON.parse(plaintext.toString("utf8")) as { pk?: string; pn?: string }
    } catch {
      this.send(JSON.stringify({ t: "e2e-error", message: "bad handshake" }))
      this.onError("bad handshake")
      return
    }
    const peerPoint = Buffer.from(String(payload.pk ?? ""), "base64")
    const peerPrefix = Buffer.from(String(payload.pn ?? ""), "base64")
    if (peerPoint.length !== 65 || peerPrefix.length !== 4) {
      this.send(JSON.stringify({ t: "e2e-error", message: "bad handshake" }))
      this.onError("bad handshake")
      return
    }

    const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    const point = publicPointOf(keyPair.publicKey)
    const shared = diffieHellman({
      privateKey: keyPair.privateKey,
      publicKey: importPublicKey(peerPoint),
    })
    const sendPrefix = randomBytes(4)
    this.keys = {
      send: hkdf(shared, this.psk, SESSION_A2C),
      recv: hkdf(shared, this.psk, SESSION_C2A),
      sendPrefix,
      recvPrefix: peerPrefix,
    }

    const ackPayload = Buffer.from(
      JSON.stringify({ pk: point.toString("base64"), pn: sendPrefix.toString("base64") }),
      "utf8",
    )
    const ackKey = hkdf(this.psk, SALT, HELLO_AGENT)
    const ackNonce = randomBytes(12)
    const ackCipher = encrypt(ackKey, ackNonce, ackPayload, Buffer.from(`herdr-web/e2e/v1/${HELLO_AGENT}`, "utf8"))
    this.send(
      JSON.stringify({
        t: "e2e-hello-ack",
        n: ackNonce.toString("base64"),
        c: ackCipher.toString("base64"),
      }),
    )
  }

  private acceptEncrypted(frame: Record<string, unknown>): void {
    const keys = this.keys
    if (keys === null) {
      return
    }
    const nonce = Buffer.concat([keys.recvPrefix, counterBytes(this.recvCounter)])
    this.recvCounter += 1
    try {
      const plaintext = decrypt(keys.recv, nonce, Buffer.from(String(frame.c ?? ""), "base64"), FRAME_AAD)
      this.onAppFrame(JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>)
    } catch {
      this.onError("e2e frame failed to decrypt")
    }
  }
}
