/**
 * Types for the vendored browser libraries.
 *
 * They are copied from node_modules by scripts/copy-vendor.mjs and are not
 * part of the sources, so the shapes the client uses are declared here.
 *
 * The module names are mapped to the vendor folder in tsconfig.json, which
 * keeps the type declaration and the runtime path in step.
 */
declare module 'vendor/hashes/hkdf.js' {
  export function hkdf(
    hash: (message: Uint8Array) => Uint8Array,
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number
  ): Uint8Array;
}

declare module 'vendor/hashes/sha2.js' {
  export const sha256: (message: Uint8Array) => Uint8Array;
}

declare module 'vendor/ciphers/aes.js' {
  export interface Gcm {
    encrypt(plaintext: Uint8Array): Uint8Array;
    decrypt(ciphertext: Uint8Array): Uint8Array;
  }

  export function gcm(
    key: Uint8Array,
    nonce: Uint8Array,
    aad?: Uint8Array
  ): Gcm;
}

declare module 'vendor/curves/p256.js' {
  export interface P256 {
    utils: {
      randomPrivateKey(): Uint8Array;
    };
    getPublicKey(privateKey: Uint8Array, compressed?: boolean): Uint8Array;
    getSharedSecret(
      privateKey: Uint8Array,
      publicKey: Uint8Array,
      compressed?: boolean
    ): Uint8Array;
  }

  export const p256: P256;
}
