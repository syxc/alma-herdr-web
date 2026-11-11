import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The passphrase that guards the web client.
 *
 * The client goes to a cloud server, so the API must not be open to anyone
 * who knows the address. A server without a passphrase stays open, which
 * keeps the local use on a laptop the way it was.
 */
export const SESSION_COOKIE = 'alma_session';

/** How long a session stays valid. */
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export interface SignInResult {
  ok: boolean;
  token?: string;
  error?: string;
}

export interface Authenticator {
  /** Whether the server asks for a passphrase at all. */
  readonly required: boolean;
  /** Checks a passphrase and hands out a session. */
  signIn(password: string): SignInResult;
  /** Whether a request carries a session that the server knows. */
  verify(headers: { cookie?: string; authorization?: string }): boolean;
  /** Ends the session of a request. */
  signOut(headers: { cookie?: string; authorization?: string }): void;
}

/**
 * Compares two strings without telling how far they differ.
 */
function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Builds the authenticator of a server.
 */
export function createAuth(password: string): Authenticator {
  const required = password.length > 0;
  const sessions = new Map<string, number>();

  const signIn = (candidate: string): SignInResult => {
    if (!required) {
      return { ok: true };
    }
    if (!sameSecret(candidate, password)) {
      return { ok: false, error: 'that passphrase does not open this server' };
    }
    const token = randomBytes(24).toString('base64url');
    sessions.set(token, Date.now() + SESSION_LIFETIME_MS);
    return { ok: true, token };
  };

  const known = (token: string): boolean => {
    const until = sessions.get(token);
    if (until === undefined) {
      return false;
    }
    if (until < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  };

  const verify = (headers: { cookie?: string; authorization?: string }): boolean => {
    if (!required) {
      return true;
    }
    const cookie = headers.cookie ?? '';
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE) {
        const token = rest.join('=');
        if (known(token)) {
          return true;
        }
      }
    }
    const auth = headers.authorization ?? '';
    if (auth.startsWith('Bearer ')) {
      return known(auth.slice('Bearer '.length).trim());
    }
    return false;
  };

  const tokenOf = (headers: { cookie?: string; authorization?: string }): string => {
    const cookie = headers.cookie ?? '';
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE) {
        return rest.join('=');
      }
    }
    const auth = headers.authorization ?? '';
    if (auth.startsWith('Bearer ')) {
      return auth.slice('Bearer '.length).trim();
    }
    return '';
  };

  const signOut = (headers: { cookie?: string; authorization?: string }): void => {
    const token = tokenOf(headers);
    if (token.length > 0) {
      sessions.delete(token);
    }
  };

  return {
    required,
    signIn,
    verify,
    signOut
  };
}