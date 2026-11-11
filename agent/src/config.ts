import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where herdr keeps its control socket.
 *
 * The order mirrors the resolution herdr itself documents: an explicit path
 * wins, then a named session, then the default session of the current user.
 */
export function resolveSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['HERDR_SOCKET_PATH'];
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  const session = env['HERDR_SESSION'];
  if (session && session.length > 0) {
    return join(configDir(env), 'sessions', session, 'herdr.sock');
  }
  return join(configDir(env), 'herdr.sock');
}

/**
 * Root of the herdr configuration directory.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg && xdg.length > 0) {
    return join(xdg, 'herdr');
  }
  return join(homedir(), '.config', 'herdr');
}

export interface AgentConfig {
  host: string;
  port: number;
  socketPath: string;
  /** The passphrase that guards the web client, empty when the server is open. */
  password: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = Number.parseInt(env['HERDR_WEB_PORT'] ?? '7331', 10);
  return {
    host: env['HERDR_WEB_HOST'] ?? '127.0.0.1',
    port: Number.isFinite(parsed) ? parsed : 7331,
    socketPath: env['HERDR_SOCKET_PATH'] ?? resolveSocketPath(env),
    password: env['HERDR_WEB_PASSWORD'] ?? ''
  };
}
