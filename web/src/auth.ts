/**
 * The sign in of the web client.
 *
 * The client is meant to run on a cloud server, so the server can ask for a
 * passphrase before it hands out any state. The session itself lives in a
 * cookie that the browser sends on its own, so nothing secret is kept in
 * the page.
 */

export interface AuthState {
  /** Whether the server asks for a passphrase. */
  required: boolean;
  /** Why the last attempt failed. */
  error?: string;
}

/**
 * Whether the server guards its API.
 *
 * A server that does not know the endpoint at all has no guard either, so
 * the client opens the app and lets the calls decide.
 */
export async function authStatus(): Promise<AuthState> {
  try {
    const response = await fetch('/api/auth', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (response.status === 404) {
      return { required: false };
    }
    if (!response.ok) {
      return { required: true, error: 'the server did not answer' };
    }
    const body = (await response.json()) as { required?: boolean };
    return { required: body.required === true };
  } catch {
    return { required: false };
  }
}

/**
 * Signs in with a passphrase.
 */
export async function signIn(password: string): Promise<AuthState> {
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (response.status === 404) {
      // The server has no passphrase, so there is nothing to sign in to.
      return { required: false };
    }
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      required?: boolean;
    };
    if (!response.ok || body.ok !== true) {
      return { required: true, error: body.error ?? 'that passphrase was refused' };
    }
    return { required: body.required === true };
  } catch (error) {
    return { required: true, error: (error as Error).message };
  }
}

/**
 * Ends the session of this browser.
 */
export async function signOut(): Promise<void> {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {
    // The session ends on the server or not at all, the client moves on.
  }
}
