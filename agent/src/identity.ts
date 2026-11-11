import { createHash, randomBytes } from "node:crypto"

/**
 * Identity of this desktop for the Alma relay.
 *
 * The desktop owns a connect code. The relay only ever sees a routing token,
 * a one way derivation of that code, and addresses the desktop by
 * sha256(token).
 */

/** Hex sha256, the form the relay uses for token hashes. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/**
 * Routing token for a connect code.
 *
 * The relay requires tokens to match [A-Za-z0-9_-]{16,128}; base64url of a
 * sha256 digest is 43 characters of that alphabet.
 */
export function deriveToken(code: string): string {
  // The prefix is part of the wire protocol: changing it would change every
  // routing token and invalidate the pairings that were handed out.
  return createHash("sha256").update(`herdr-web/relay/v1/${code}`, "utf8").digest("base64url")
}

/** A fresh 256 bit connect code. */
export function newConnectCode(): string {
  return randomBytes(32).toString("hex")
}

/** Decodes a hex connect code into raw bytes. */
export function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex, "hex")
}
