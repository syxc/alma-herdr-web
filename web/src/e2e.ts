/**
 * End to end encryption for the Alma relay tunnel, browser side.
 *
 * Mirrors the desktop implementation in agent/src/e2e.ts: the connect code is
 * the pre shared key, ephemeral P-256 keys are exchanged through it, and
 * every frame afterwards is sealed with AES-256-GCM.
 *
 * The code lives in the URL fragment, which browsers never send to a server,
 * so the relay never learns it.
 *
 * crypto.subtle only exists in a secure context, so a phone that opens the
 * client over plain HTTP on the local network has none. The pure JavaScript
 * path below takes over there and speaks the same wire format.
 */

export const E2E_PATH = '/__alma_e2e__';

// Protocol identifiers, not product names: they are mixed into the session
// keys, so they stay as they are even after the project was renamed.
const SALT = new TextEncoder().encode('herdr-web/e2e/v1');
const FRAME_AAD = new TextEncoder().encode('herdr-web/e2e/v1/frame');

/** WebCrypto only accepts buffers backed by a plain ArrayBuffer. */
export type Bytes = Uint8Array<ArrayBuffer>;

function concat(...parts: Bytes[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function counterBytes(counter: number): Bytes {
  const buffer = new Uint8Array(8);
  new DataView(buffer.buffer).setBigUint64(0, BigInt(counter), false);
  return buffer;
}

function base64(bytes: Bytes): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function unbase64(value: string): Bytes {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Copies a buffer into one WebCrypto accepts. */
function toBytes(source: Uint8Array): Bytes {
  return new Uint8Array(source);
}

/**
 * URL of a vendored library.
 *
 * The path is relative to this module so it survives the relay prefix,
 * where the page is served from /c/<token>/.
 */
function vendorUrl(file: string): string {
  return new URL('../vendor/noble/' + file, import.meta.url).href;
}

/**
 * The crypto the client uses for one session.
 *
 * Both implementations produce the same bytes on the wire, so the desktop
 * cannot tell which one a phone used.
 */
export interface Cipher {
  deriveKey(ikm: Bytes, salt: Bytes, info: Bytes, length?: number): Promise<Bytes>;
  digest(data: Bytes): Promise<Bytes>;
  seal(key: Bytes, nonce: Bytes, plaintext: Bytes, aad?: Bytes): Promise<Bytes>;
  open(key: Bytes, nonce: Bytes, ciphertext: Bytes, aad?: Bytes): Promise<Bytes>;
  generateKeyPair(): Promise<{ publicKey: Bytes; privateKey: unknown }>;
  sharedSecret(privateKey: unknown, publicKey: Bytes): Promise<Bytes>;
  randomBytes(length: number): Bytes;
}

/**
 * The WebCrypto implementation, used wherever a secure context exists.
 */
class WebCryptoCipher implements Cipher {
  private readonly subtle: SubtleCrypto;

  constructor(subtle: SubtleCrypto) {
    this.subtle = subtle;
  }

  async deriveKey(ikm: Bytes, salt: Bytes, info: Bytes, length = 32): Promise<Bytes> {
    const key = await this.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
    const bits = await this.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt,
        info
      },
      key,
      length * 8
    );
    return new Uint8Array(bits);
  }

  async digest(data: Bytes): Promise<Bytes> {
    return new Uint8Array(await this.subtle.digest('SHA-256', data));
  }

  async seal(key: Bytes, nonce: Bytes, plaintext: Bytes, aad?: Bytes): Promise<Bytes> {
    const cipher = await this.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, ...(aad === undefined ? {} : { additionalData: aad }) },
      await this.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']),
      plaintext
    );
    return new Uint8Array(cipher);
  }

  async open(key: Bytes, nonce: Bytes, ciphertext: Bytes, aad?: Bytes): Promise<Bytes> {
    const plain = await this.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, ...(aad === undefined ? {} : { additionalData: aad }) },
      await this.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']),
      ciphertext
    );
    return new Uint8Array(plain);
  }

  async generateKeyPair(): Promise<{ publicKey: Bytes; privateKey: CryptoKey }> {
    const keyPair = await this.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
    const point = new Uint8Array(await this.subtle.exportKey('raw', keyPair.publicKey));
    return { publicKey: point, privateKey: keyPair.privateKey };
  }

  async sharedSecret(privateKey: CryptoKey, publicKey: Bytes): Promise<Bytes> {
    const peer = await this.subtle.importKey(
      'raw',
      publicKey,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
    const bits = await this.subtle.deriveBits(
      { name: 'ECDH', public: peer },
      privateKey,
      256
    );
    return new Uint8Array(bits);
  }

  randomBytes(length: number): Bytes {
    return crypto.getRandomValues(new Uint8Array(length));
  }
}

/**
 * The pure JavaScript implementation, used where crypto.subtle is missing.
 *
 * It is the same construction as the WebCrypto path: HKDF-SHA256 for the
 * keys and AES-256-GCM for the frames.
 */
class PureCipher implements Cipher {
  private hashes: typeof import('vendor/hashes/hkdf.js') | null = null;
  private ciphers: typeof import('vendor/ciphers/aes.js') | null = null;
  private curve: typeof import('vendor/curves/p256.js') | null = null;
  private sha256: ((message: Uint8Array) => Uint8Array) | null = null;

  private async load(): Promise<void> {
    if (this.hashes !== null) {
      return;
    }
    const hashes = await import(vendorUrl('hashes/hkdf.js'));
    const ciphers = await import(vendorUrl('ciphers/aes.js'));
    const curve = await import(vendorUrl('curves/p256.js'));
    const sha256 = await import(vendorUrl('hashes/sha2.js'));
    this.hashes = hashes;
    this.ciphers = ciphers;
    this.curve = curve;
    this.sha256 = sha256.sha256;
  }

  async deriveKey(ikm: Bytes, salt: Bytes, info: Bytes, length = 32): Promise<Bytes> {
    await this.load();
    const hashes = this.hashes;
    const sha256 = this.sha256;
    if (hashes === null || sha256 === null) {
      throw new Error('the pure JavaScript crypto is missing from this build');
    }
    const derived = hashes.hkdf(sha256, ikm, salt, info, length);
    return new Uint8Array(derived);
  }

  async digest(data: Bytes): Promise<Bytes> {
    await this.load();
    const sha256 = this.sha256;
    if (sha256 === null) {
      throw new Error('the pure JavaScript crypto is missing from this build');
    }
    return new Uint8Array(sha256(data));
  }

  async seal(key: Bytes, nonce: Bytes, plaintext: Bytes, aad?: Bytes): Promise<Bytes> {
    await this.load();
    const ciphers = this.ciphers;
    if (ciphers === null) {
      throw new Error('the pure JavaScript crypto is missing from this build');
    }
    return new Uint8Array(ciphers.gcm(key, nonce, aad).encrypt(plaintext));
  }

  async open(key: Bytes, nonce: Bytes, ciphertext: Bytes, aad?: Bytes): Promise<Bytes> {
    await this.load();
    const ciphers = this.ciphers;
    if (ciphers === null) {
      throw new Error('the pure JavaScript crypto is missing from this build');
    }
    return new Uint8Array(ciphers.gcm(key, nonce, aad).decrypt(ciphertext));
  }

  async generateKeyPair(): Promise<{ publicKey: Bytes; privateKey: unknown }> {
    await this.load();
    const curve = this.curve;
    if (curve === null) {
      throw new Error('the pure JavaScript crypto is missing from this build');
    }
    const privateKey = curve.p256.utils.randomPrivateKey();
    const publicKey = curve.p256.getPublicKey(privateKey, false);
    return { publicKey: new Uint8Array(publicKey), privateKey };
  }

  async sharedSecret(privateKey: unknown, publicKey: Bytes): Promise<Bytes> {
    await this.load();
    const curve = this.curve;
    if (curve === null || !(privateKey instanceof Uint8Array)) {
      throw new Error('the pure JavaScript crypto is missing from this build');
    }
    // The compressed point is the X coordinate with a prefix byte, while the
    // desktop hands out the bare X coordinate. Strip the prefix so both
    // sides derive the same key.
    const shared = curve.p256.getSharedSecret(privateKey, publicKey, true);
    return new Uint8Array(shared.slice(1));
  }

  randomBytes(length: number): Bytes {
    return crypto.getRandomValues(new Uint8Array(length));
  }
}

let cipher: Cipher | null = null;

/**
 * Picks the crypto implementation once.
 *
 * WebCrypto is preferred, the pure JavaScript path takes over on a plain
 * HTTP page, where the phone cannot use crypto.subtle.
 */
export async function getCipher(): Promise<Cipher> {
  if (cipher !== null) {
    return cipher;
  }
  const subtle = globalThis.crypto?.subtle;
  cipher = subtle === undefined ? new PureCipher() : new WebCryptoCipher(subtle);
  return cipher;
}

export interface E2EClientOptions {
  psk: Bytes;
  send: (text: string) => void;
  onAppFrame: (frame: Record<string, unknown>) => void;
  onError: (message: string) => void;
  onReady: () => void;
}

/**
 * Phone or browser side of the encrypted channel.
 */
export class E2EClientSession {
  private readonly psk: Bytes;
  private readonly send: (text: string) => void;
  private readonly onAppFrame: (frame: Record<string, unknown>) => void;
  private readonly onError: (message: string) => void;
  private readonly onReady: () => void;
  private sendKey: Bytes | null = null;
  private recvKey: Bytes | null = null;
  private sendPrefix: Bytes = new Uint8Array(4);
  private recvPrefix: Bytes = new Uint8Array(4);
  private sendCounter = 0;
  private recvCounter = 0;
  private started = false;
  private privateKey: unknown = null;

  constructor(options: E2EClientOptions) {
    this.psk = options.psk;
    this.send = options.send;
    this.onAppFrame = options.onAppFrame;
    this.onError = options.onError;
    this.onReady = options.onReady;
  }

  get ready(): boolean {
    return this.sendKey !== null;
  }

  /** Starts the handshake by sealing the ephemeral key with the code. */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    const crypto = await getCipher();
    const keyPair = await crypto.generateKeyPair();
    this.privateKey = keyPair.privateKey;
    this.sendPrefix = crypto.randomBytes(4);
    const helloKey = await crypto.deriveKey(this.psk, SALT, new TextEncoder().encode('hello-client'));
    const nonce = crypto.randomBytes(12);
    const payload = new TextEncoder().encode(
      JSON.stringify({ pk: base64(keyPair.publicKey), pn: base64(this.sendPrefix) })
    );
    const cipher = await crypto.seal(
      helloKey,
      nonce,
      payload,
      new TextEncoder().encode('herdr-web/e2e/v1/hello-client')
    );
    this.send(JSON.stringify({ t: 'e2e-hello', n: base64(nonce), c: base64(toBytes(cipher)) }));
  }

  async receive(text: string): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const kind = frame['t'];
    if (kind === 'e2e-hello-ack') {
      await this.acceptAck(frame);
      return;
    }
    if (kind === 'e2e') {
      await this.acceptEncrypted(frame);
      return;
    }
    if (kind === 'e2e-error') {
      this.onError(String(frame['message'] ?? 'e2e error'));
    }
  }

  async sendApp(frame: Record<string, unknown>): Promise<void> {
    const key = this.sendKey;
    if (key === null) {
      return;
    }
    const crypto = await getCipher();
    const nonce = concat(this.sendPrefix, counterBytes(this.sendCounter));
    this.sendCounter += 1;
    const plaintext = new TextEncoder().encode(JSON.stringify(frame));
    const cipher = await crypto.seal(key, nonce, plaintext, FRAME_AAD);
    this.send(JSON.stringify({ t: 'e2e', c: base64(toBytes(cipher)) }));
  }

  private async acceptAck(frame: Record<string, unknown>): Promise<void> {
    if (this.sendKey !== null) {
      return;
    }
    const crypto = await getCipher();
    const nonce = unbase64(String(frame['n'] ?? ''));
    const ciphertext = unbase64(String(frame['c'] ?? ''));
    const ackKey = await crypto.deriveKey(this.psk, SALT, new TextEncoder().encode('hello-agent'));
    let payload: { pk?: string; pn?: string };
    try {
      const plain = await crypto.open(
        ackKey,
        nonce,
        ciphertext,
        new TextEncoder().encode('herdr-web/e2e/v1/hello-agent')
      );
      payload = JSON.parse(new TextDecoder().decode(plain)) as { pk?: string; pn?: string };
    } catch {
      this.onError('pairing code mismatch');
      return;
    }
    const peerPoint = unbase64(String(payload.pk ?? ''));
    this.recvPrefix = unbase64(String(payload.pn ?? ''));
    const shared = await crypto.sharedSecret(this.privateKey, toBytes(peerPoint));
    const sendBytes = await crypto.deriveKey(shared, this.psk, new TextEncoder().encode('session-c2a'));
    const recvBytes = await crypto.deriveKey(shared, this.psk, new TextEncoder().encode('session-a2c'));
    this.sendKey = sendBytes;
    this.recvKey = recvBytes;
    this.onReady();
  }

  private async acceptEncrypted(frame: Record<string, unknown>): Promise<void> {
    const key = this.recvKey;
    if (key === null) {
      return;
    }
    const crypto = await getCipher();
    const nonce = concat(this.recvPrefix, counterBytes(this.recvCounter));
    this.recvCounter += 1;
    try {
      const plain = await crypto.open(
        key,
        nonce,
        unbase64(String(frame['c'] ?? '')),
        FRAME_AAD
      );
      this.onAppFrame(JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>);
    } catch {
      this.onError('e2e frame failed to decrypt');
    }
  }
}
