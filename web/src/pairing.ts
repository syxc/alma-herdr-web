import { parseAlmaLink } from './alma.js';

/**
 * The pairing payload a phone receives with the QR code of our own agent.
 *
 * It carries the relay address, the routing token and the connect code, and
 * travels in the URL fragment so the relay never sees it.
 */
export interface PairingPayload {
  relay: string;
  token: string;
  code: string;
}

/**
 * Everything the client can pair with.
 *
 * The herdr payload comes from our own agent, the Alma payload from the
 * desktop app of Alma, which hands out a deep link with the relay address
 * and the connect code.
 */
export type Pairing =
  | { kind: 'herdr'; payload: PairingPayload }
  | { kind: 'alma'; relay: string; code: string };

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = padded.length % 4;
  const full = remainder === 0 ? padded : padded + '='.repeat(4 - remainder);
  const binary = atob(full);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Reads the pairing out of a location hash or a pasted link.
 *
 * Three shapes are accepted for our own agent:
 *   <url>#pair=<base64url json>   a pairing link
 *   <base64url json>              the payload on its own
 *   {"relay":…,"token":…,"code":…}  the payload as plain JSON
 *
 * The deep link of the Alma desktop is accepted as well.
 */
export function readPairing(source: string): Pairing | null {
  const alma = parseAlmaLink(source);
  if (alma !== null) {
    return { kind: 'alma', relay: alma.relay, code: alma.code };
  }
  const payload = readHerdrPayload(source);
  if (payload === null) {
    return null;
  }
  return { kind: 'herdr', payload };
}

/**
 * Reads only our own pairing payload.
 */
export function readHerdrPayload(source: string): PairingPayload | null {
  try {
    const match = /[#&]pair=([^&\s]+)/.exec(source);
    if (match !== null && match[1] !== undefined) {
      return parsePayload(decodeBase64Url(match[1]));
    }
    const trimmed = source.trim();
    return parsePayload(trimmed.startsWith('{') ? trimmed : decodeBase64Url(trimmed));
  } catch {
    return null;
  }
}

/**
 * Turns a decoded payload into a pairing, or null when it is not one.
 */
function parsePayload(text: string): PairingPayload | null {
  try {
    const parsed = JSON.parse(text) as Partial<PairingPayload>;
    if (
      typeof parsed.relay !== 'string' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.code !== 'string'
    ) {
      return null;
    }
    return { relay: parsed.relay, token: parsed.token, code: parsed.code };
  } catch {
    return null;
  }
}

/** Hex string to raw bytes, used for the connect code. */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}


const PAIRING_KEY = 'alma-herdr-web:pairing';

/** Keep credentials in this tab's session, so reloads do not require a new scan. */
export function savePairing(pairing: Pairing): void {
  try {
    sessionStorage.setItem(PAIRING_KEY, JSON.stringify(pairing));
  } catch {
    // A browser that blocks session storage can still use the current connection.
  }
}

export function readSavedPairing(): Pairing | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PAIRING_KEY) ?? 'null') as Pairing | null;
    if (saved?.kind === 'alma' && typeof saved.relay === 'string' && typeof saved.code === 'string' && saved.code.length > 0) {
      return { kind: 'alma', relay: saved.relay, code: saved.code };
    }
    if (saved?.kind === 'herdr') {
      const payload = parsePayload(JSON.stringify(saved.payload));
      if (payload !== null) return { kind: 'herdr', payload };
    }
  } catch {
    // Missing or corrupt storage does not stop the pairing screen from opening.
  }
  return null;
}

export function forgetPairing(): void {
  try {
    sessionStorage.removeItem(PAIRING_KEY);
  } catch {
    // The active connection can still be closed if storage is unavailable.
  }
}
