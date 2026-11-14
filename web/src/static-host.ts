/**
 * The hosted build is a pure static bundle: it has no local agent API and
 * never asks for a passphrase. The worker build stamps this flag into
 * index.html so the client can skip the local API probes entirely instead of
 * letting two expected 404s show up in the browser console. The local agent
 * serves the unstamped web/index.html, so its behaviour is unchanged.
 */
export function isStaticHost(): boolean {
  return (globalThis as { __ALMA_STATIC__?: boolean }).__ALMA_STATIC__ === true
}
