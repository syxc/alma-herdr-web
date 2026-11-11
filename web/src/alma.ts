/**
 * Client for an Alma desktop that is paired through an Alma relay.
 *
 * The Alma app hands out a deep link that carries the relay address and the
 * connect code:
 *
 *   alma://connect?u=<relay url>&k=<connect code>&e2e=1
 *
 * The relay routes the client to the desktop under a routing token that both
 * sides derive from the connect code, so the phone needs no account. After
 * that everything travels through an end to end encrypted socket: the connect
 * code is the pre shared key, ephemeral P-256 keys are exchanged through it,
 * and every frame afterwards is sealed with AES-256-GCM.
 *
 * Inside the tunnel the desktop serves its own HTTP API, which exposes the
 * same herdr calls the local agent uses.
 */

import { getCipher, type Bytes, type Cipher } from './e2e.js';
import { withTimeout } from './deadline.js';

export const ALMA_E2E_PATH = '/__alma_e2e__';

/** The label both sides mix into the session keys. */
const LABEL = 'alma-relay-e2e/v1';

/** The salt that turns the connect code into the relay routing token. */
const ROUTING_SALT = 'alma-relay-e2e/v1/routing';

/** The first byte of a frame that carries a binary payload. */
const FRAME_MAGIC = 0;

/** How often the client tries to reach the relay before it gives up. */
const CONNECT_ATTEMPTS = 5;

/** How long the desktop has to answer the handshake. */
const HANDSHAKE_TIMEOUT_MS = 10000;

/** The pairing details of an Alma deep link. */
export interface AlmaLink {
  relay: string;
  code: string;
}

/** One response from the desktop, inside the tunnel. */
export interface AlmaResponse {
  status: number;
  headers: Record<string, string>;
  body: Bytes;
}

export interface AlmaTunnelOptions {
  relay: string;
  code: string;
}

interface Pending {
  resolve: (response: AlmaResponse) => void;
  reject: (error: Error) => void;
  status: number;
  headers: Record<string, string>;
  chunks: Bytes[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function utf8(text: string): Bytes {
  return encoder.encode(text);
}

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

function base64Url(bytes: Bytes): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Bytes {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = padded.length % 4;
  const full = remainder === 0 ? padded : padded + '='.repeat(4 - remainder);
  const binary = atob(full);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function equalBytes(left: Bytes, right: Bytes): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/**
 * The nonce of a sealed frame: four zero bytes and a counter.
 */
function sealNonce(counter: number): Bytes {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(counter), false);
  return nonce;
}

/**
 * Reads the pairing details out of an Alma deep link.
 */
export function parseAlmaLink(source: string): AlmaLink | null {
  const trimmed = source.trim();
  if (!trimmed.toLowerCase().startsWith('alma://')) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'alma:') {
    return null;
  }
  const relay = url.searchParams.get('u');
  const code = url.searchParams.get('k');
  if (relay === null || code === null || relay.length === 0 || code.length === 0) {
    return null;
  }
  return { relay, code };
}

/**
 * Derives the routing token the relay uses to find the desktop.
 *
 * The relay hashes the path token, so both sides derive it from the connect
 * code with the same salt.
 */
export async function deriveRoutingToken(code: string): Promise<string> {
  const crypto = await getCipher();
  const bytes = await crypto.deriveKey(utf8(code), utf8(ROUTING_SALT), new Uint8Array(0), 16);
  return base64Url(bytes);
}

/**
 * Encodes one frame for the tunnel.
 *
 * A frame with a binary payload carries a small header in front of it, a
 * frame without one stays plain JSON.
 */
export function encodeAlmaFrame(frame: Record<string, unknown>): Bytes {
  const payload = frame['b'];
  if (!(payload instanceof Uint8Array)) {
    return utf8(JSON.stringify(frame));
  }
  const header: Record<string, unknown> = { ...frame, $: 'b' };
  delete header['b'];
  const headerBytes = utf8(JSON.stringify(header));
  const out = new Uint8Array(5 + headerBytes.length + payload.length);
  out[0] = FRAME_MAGIC;
  new DataView(out.buffer).setUint32(1, headerBytes.length, false);
  out.set(headerBytes, 5);
  out.set(payload, 5 + headerBytes.length);
  return out;
}

/**
 * Decodes one frame that came out of the tunnel.
 */
export function decodeAlmaFrame(bytes: Bytes): Record<string, unknown> {
  if (bytes.length > 0 && bytes[0] === FRAME_MAGIC) {
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
    const header = JSON.parse(decoder.decode(bytes.subarray(5, 5 + length))) as Record<string, unknown>;
    const kind = header['$'];
    delete header['$'];
    const payload = bytes.subarray(5 + length);
    if (kind === 'b') {
      header['b'] = new Uint8Array(payload);
    } else if (kind === 's') {
      header['s'] = decoder.decode(payload);
    }
    return header;
  }
  const frame = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
  if (typeof frame['b'] === 'string') {
    frame['b'] = fromBase64Url(frame['b']);
  }
  return frame;
}

/**
 * The encrypted channel to an Alma desktop.
 *
 * The handshake happens in the clear, because it carries the ephemeral keys
 * the session keys are derived from. Everything after it is sealed.
 */
export class AlmaTunnel {
  private socket: WebSocket | null = null;
  private crypto: Cipher | null = null;
  private privateKey: unknown = null;
  private publicKey: Bytes = new Uint8Array(0);
  private nonce: Bytes = new Uint8Array(0);
  private sendKey: Bytes | null = null;
  private recvKey: Bytes | null = null;
  private sendCounter = 0;
  private counter = 0;
  /** The frames that go out, one after the other. */
  private outgoing: Promise<void> = Promise.resolve();
  /** The frames that come in, one after the other. */
  private incoming: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, Pending>();
  private ready: Promise<void> = Promise.resolve();
  private markReady: () => void = () => undefined;
  private failReady: (error: Error) => void = () => undefined;

  constructor(private readonly options: AlmaTunnelOptions) {}

  /**
   * Opens the socket and completes the handshake.
   *
   * A relay that was quiet for a while can drop the first attempt, so the
   * connection is tried again a few times before it counts as a failure.
   */
  async connect(): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
      try {
        await this.openSocket();
        return;
      } catch (error) {
        lastError = error as Error;
        this.closeSocket();
        if (attempt < CONNECT_ATTEMPTS) {
          await pause(attempt * 1000);
        }
      }
    }
    throw lastError ?? new Error('the relay connection failed');
  }

  private async openSocket(): Promise<void> {
    const routing = await deriveRoutingToken(this.options.code);
    const base = this.options.relay.replace(/\/+$/, '');
    const origin = base.replace(/^https?:\/\//, '');
    const scheme = base.startsWith('https') ? 'wss://' : 'ws://';
    const socket = new WebSocket(scheme + origin + '/c/' + routing + ALMA_E2E_PATH);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.ready = new Promise((resolve, reject) => {
      this.markReady = resolve;
      this.failReady = reject;
    });

    socket.addEventListener('open', () => {
      if (this.socket === socket) void this.startHandshake().catch(error => this.failReady(error));
    });
    socket.addEventListener('message', event => {
      if (this.socket !== socket) return;
      // The frames of one request have to be read in the order they came in:
      // the frame that ends the request must not overtake the one that
      // carries the body, or the answer comes back empty.
      this.incoming = this.incoming.then(
        () => this.receive(event.data),
        () => this.receive(event.data)
      );
    });
    socket.addEventListener('error', () => {
      if (this.socket !== socket) return;
      this.failReady(new Error('the relay connection failed'));
    });
    socket.addEventListener('close', event => {
      if (this.socket !== socket) return;
      const reason = String(event.reason ?? '');
      const message = reason.length > 0
        ? 'the relay closed the connection: ' + reason
        : 'the relay closed the connection';
      this.failReady(new Error(message));
      for (const pending of this.pending.values()) {
        pending.reject(new Error(message));
      }
      this.pending.clear();
    });

    const timeout = setTimeout(() => {
      this.failReady(new Error('the relay did not answer the handshake'));
    }, HANDSHAKE_TIMEOUT_MS);
    try {
      await this.ready;
    } finally {
      clearTimeout(timeout);
    }
  }

  private closeSocket(): void {
    try {
      this.socket?.close();
    } catch {
      // the socket was already gone
    }
    this.socket = null;
  }

  /**
   * Sends one request through the tunnel.
   */
  async request(
    method: string,
    path: string,
    body?: Bytes,
    headers: Record<string, string> = {}
  ): Promise<AlmaResponse> {
    await this.ready;
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('the relay is disconnected');
    const id = 'q' + (++this.counter);
    const answer = new Promise<AlmaResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, status: 200, headers: {}, chunks: [] });
    });
    const frame: Record<string, unknown> = { t: 'hreq', id, method, path, headers };
    if (body !== undefined) {
      frame['b'] = body;
    }
    try {
      const [, response] = await withTimeout(
        Promise.all([this.sendFrame(frame), answer]), 15000, 'the desktop request timed out'
      );
      return response;
    } catch (error) {
      this.close();
      throw error;
    } finally {
      this.pending.delete(id);
    }
  }

  close(): void {
    const error = new Error('the relay connection was closed');
    this.failReady(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.closeSocket();
  }

  private async startHandshake(): Promise<void> {
    const crypto = await getCipher();
    this.crypto = crypto;
    const keyPair = await crypto.generateKeyPair();
    this.privateKey = keyPair.privateKey;
    this.publicKey = keyPair.publicKey;
    this.nonce = crypto.randomBytes(16);
    this.socket?.send(JSON.stringify({
      t: 'hi',
      epk: base64Url(this.publicKey),
      n: base64Url(this.nonce),
      bin: 1
    }));
  }

  /**
   * Answers the hello of the desktop and turns the session keys on.
   */
  private async acceptHello(frame: Record<string, unknown>): Promise<void> {
    const crypto = this.crypto;
    if (crypto === null) {
      return;
    }
    const peerPublic = fromBase64Url(String(frame['epk'] ?? ''));
    const peerNonce = fromBase64Url(String(frame['n'] ?? ''));
    const shared = await crypto.sharedSecret(this.privateKey, peerPublic);
    const digest = await crypto.digest(
      concat(utf8(LABEL), this.publicKey, peerPublic, this.nonce, peerNonce)
    );
    const salt = utf8(this.options.code);
    const info = (tag: string): Bytes => concat(utf8(tag + '|'), digest);
    const confirmResponder = await crypto.deriveKey(shared, salt, info('confirm-r'));
    if (!equalBytes(confirmResponder, fromBase64Url(String(frame['cr'] ?? '')))) {
      this.failReady(new Error('the pairing code does not match the desktop'));
      return;
    }
    this.sendKey = await crypto.deriveKey(shared, salt, info('c2s'));
    this.recvKey = await crypto.deriveKey(shared, salt, info('s2c'));
    const confirmInitiator = await crypto.deriveKey(shared, salt, info('confirm-i'));
    this.socket?.send(JSON.stringify({ t: 'ok', ci: base64Url(confirmInitiator) }));
    this.markReady();
  }

  private async receive(data: unknown): Promise<void> {
    if (typeof data === 'string') {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (frame['t'] === 'err') {
        this.failReady(new Error(String(frame['message'] ?? 'the desktop refused the handshake')));
        return;
      }
      if (frame['t'] === 'hi') {
        await this.acceptHello(frame);
      }
      return;
    }
    const crypto = this.crypto;
    const key = this.recvKey;
    if (crypto === null || key === null) {
      return;
    }
    const bytes = data instanceof Uint8Array
      ? new Uint8Array(data)
      : new Uint8Array(data as ArrayBuffer);
    let plain: Bytes;
    try {
      plain = await crypto.open(key, bytes.subarray(0, 12), bytes.subarray(12));
    } catch {
      this.failReady(new Error('the encrypted frame could not be opened'));
      return;
    }
    this.handleFrame(decodeAlmaFrame(plain));
  }

  private async sendFrame(frame: Record<string, unknown>): Promise<void> {
    // The frames go out in the order they were made, so that the counter of
    // the nonce matches the order on the wire.
    this.outgoing = this.outgoing.then(
      () => this.sendNow(frame),
      () => this.sendNow(frame)
    );
    return this.outgoing;
  }

  private async sendNow(frame: Record<string, unknown>): Promise<void> {
    const crypto = this.crypto;
    const key = this.sendKey;
    const socket = this.socket;
    if (crypto === null || key === null || socket?.readyState !== WebSocket.OPEN) {
      throw new Error('the relay is disconnected');
    }
    const nonce = sealNonce(this.sendCounter);
    this.sendCounter += 1;
    const sealed = await crypto.seal(key, nonce, encodeAlmaFrame(frame));
    // The frame travels with its nonce in front of the cipher text.
    const out = new Uint8Array(nonce.length + sealed.length);
    out.set(nonce, 0);
    out.set(sealed, nonce.length);
    socket.send(out);
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const id = String(frame['id'] ?? '');
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    if (frame['t'] === 'hres') {
      pending.status = Number(frame['status'] ?? 200);
      pending.headers = (frame['headers'] ?? {}) as Record<string, string>;
      return;
    }
    if (frame['t'] === 'hchunk') {
      const payload = frame['b'];
      if (payload instanceof Uint8Array) {
        pending.chunks.push(new Uint8Array(payload));
      }
      return;
    }
    if (frame['t'] === 'herr') {
      this.pending.delete(id);
      pending.reject(new Error(String(frame['message'] ?? 'the request failed')));
      return;
    }
    if (frame['t'] === 'hend') {
      this.pending.delete(id);
      const total = pending.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of pending.chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      pending.resolve({ status: pending.status, headers: pending.headers, body });
    }
  }
}
