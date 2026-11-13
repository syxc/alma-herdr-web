/**
 * The sign in of the web client.
 *
 * Only a local agent can require an access passphrase. Static hosts use
 * desktop pairing instead. The local session uses an HttpOnly cookie.
 */

export interface AuthState {
  /** Whether the server asks for a passphrase. */
  required: boolean
  /** Whether this browser already has a valid local session. */
  authenticated?: boolean
  /** Why the last attempt failed. */
  error?: string
}

/**
 * Whether the server guards its API.
 *
 * A server that does not know the endpoint at all has no guard either, so
 * the client opens the app and lets the calls decide.
 */
export async function authStatus(): Promise<AuthState> {
  try {
    const response = await fetch("/api/auth", {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    })
    if (response.status === 404) {
      return { required: false }
    }
    if (!response.ok) {
      return { required: false, error: "Could not check desktop access. Try again." }
    }
    const body = (await response.json()) as { required?: boolean; authenticated?: boolean }
    if (typeof body.required !== "boolean") throw new Error("invalid access status")
    return { required: body.required, authenticated: body.authenticated === true }
  } catch {
    return { required: false, error: "Could not check desktop access. Try again." }
  }
}

/**
 * Signs in with a passphrase.
 */
export async function signIn(password: string): Promise<AuthState> {
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    })
    if (response.status === 404) {
      // The server has no passphrase, so there is nothing to sign in to.
      return { required: false }
    }
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      error?: string
      required?: boolean
    }
    if (!response.ok || body.ok !== true) {
      return { required: true, error: body.error ?? "that passphrase was refused" }
    }
    return { required: body.required === true }
  } catch (error) {
    return { required: true, error: (error as Error).message }
  }
}

/**
 * Ends the session of this browser.
 */
export async function signOut(): Promise<void> {
  const response = await fetch("/api/logout", { method: "POST", signal: AbortSignal.timeout(15000) })
  if (!response.ok && response.status !== 401) throw new Error("Could not end desktop access. Try again.")
}
