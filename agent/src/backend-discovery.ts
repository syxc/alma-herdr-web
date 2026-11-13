import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { isAbsolute, join } from "node:path"

const endpointKeys = [
  "XDG_CONFIG_HOME",
  "HERDR_SESSION",
  "HERDR_SOCKET_PATH",
  "HERDR_SOCKET",
  "HC_SOCKET",
  "HC_SESSION",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
] as const

export function tuiSocketPaths(
  environments: NodeJS.ProcessEnv[],
  home = homedir(),
  platform = process.platform,
): string[] {
  const socket = (env: NodeJS.ProcessEnv, session?: string): string => {
    const explicit = env.HERDR_SOCKET_PATH || env.HERDR_SOCKET
    if (!session && explicit) return explicit
    const config = env.XDG_CONFIG_HOME || (platform === "win32" ? env.APPDATA : undefined) || join(home, ".config")
    const root = join(config, "herdr")
    return !session || session === "default" ? join(root, "herdr.sock") : join(root, "sessions", session, "herdr.sock")
  }
  const paths: string[] = []
  for (const env of environments) {
    paths.push(socket(env, env.HERDR_SESSION || undefined))
    if (env.HERDR_SESSION) paths.push(socket(env))
  }
  paths.push(socket({}))
  return [...new Set(paths)].map((path) => pipePath(path, platform))
}

function pipePath(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" && !/^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(path) ? `\\\\.\\pipe\\${path}` : path
}

function configuredCoreSocket(env: NodeJS.ProcessEnv, home: string): string | null {
  const root = env.XDG_CONFIG_HOME || join(home, ".config")
  try {
    const content = readFileSync(join(root, "herdr-core", "config.toml"), "utf8")
    const path = /^\s*socket\s*=\s*["']([^"']+)["']/m.exec(content)?.[1]
    return path?.startsWith("~/") ? join(home, path.slice(2)) : path || null
  } catch {
    return null
  }
}

function sessionSockets(root: string): string[] {
  try {
    const entries = readdirSync(root, { withFileTypes: true })
    return [
      ...entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name, `${entry.name}.sock`)),
      ...entries
        .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".sock") && !entry.name.includes(".holder."))
        .map((entry) => join(root, entry.name)),
    ].filter((path) => existsSync(path))
  } catch {
    return []
  }
}

export function coreSocketPaths(
  environments: NodeJS.ProcessEnv[],
  home = homedir(),
  platform = process.platform,
): string[] {
  const paths: string[] = []
  const roots: string[] = []
  const sessions: string[] = []
  for (const env of environments) {
    if (env.HC_SOCKET) paths.push(env.HC_SOCKET)
    const configured = configuredCoreSocket(env, home)
    if (configured) paths.push(configured)
    const session = env.HC_SESSION && /^[\w.-]+$/.test(env.HC_SESSION) ? env.HC_SESSION : "default"
    sessions.push(session)
    if (platform === "win32") {
      let username = env.USERNAME
      if (!username) {
        try {
          username = userInfo().username
        } catch {
          /* No account name available. */
        }
      }
      if (username) paths.push(`\\\\.\\pipe\\herdr-core-${username}-${session}.sock`)
    } else {
      for (const base of [env.XDG_RUNTIME_DIR, env.XDG_STATE_HOME]) {
        if (!base) continue
        const root = join(base, "herdr-core")
        roots.push(root)
        paths.push(join(root, session, `${session}.sock`), join(root, `${session}.sock`))
      }
    }
  }
  if (platform === "win32") {
    try {
      const pipes = readdirSync("\\\\.\\pipe\\").filter(
        (path) => /^herdr-core-.+\.sock$/i.test(path) && !/\.holder\./i.test(path),
      )
      const rank = (path: string): number => {
        const index = sessions.findIndex((session) => path.toLowerCase().endsWith(`-${session.toLowerCase()}.sock`))
        return index >= 0 ? index : path.toLowerCase().endsWith("-default.sock") ? sessions.length : sessions.length + 1
      }
      paths.push(...pipes.sort((a, b) => rank(a) - rank(b)).map((path) => `\\\\.\\pipe\\${path}`))
    } catch {
      /* Named pipes may not be enumerable. */
    }
  } else {
    const state = join(home, ".local", "state", "herdr-core")
    roots.push(state)
    paths.push(join(state, "default", "default.sock"))
    for (const root of new Set(roots)) paths.push(...sessionSockets(root))
  }
  return [...new Set(paths)]
}

export function parseLoginEndpoints(output: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const marker = "__HERDR_WEB_ENDPOINTS__"
  const index = output.lastIndexOf(marker)
  if (index < 0) return env
  for (const line of output.slice(index + marker.length).split("\n")) {
    const separator = line.indexOf("=")
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1).trim()
    if (!endpointKeys.some((allowed) => allowed === key) || !value) continue
    const session = key === "HERDR_SESSION" || key === "HC_SESSION"
    if (session ? /^[\w.-]+$/.test(value) : isAbsolute(value)) env[key] = value
  }
  return env
}

/** Only endpoint variables leave the login shell; never capture its complete environment. */
export function loginEndpoints(env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  if (process.platform === "win32") return Promise.resolve({})
  const fields = endpointKeys.map((key) => `printf '%s=%s\\n' ${key} "$${key}"`).join("; ")
  return new Promise((resolve) => {
    execFile(
      env.SHELL || "/bin/zsh",
      ["-ilc", `echo __HERDR_WEB_ENDPOINTS__; ${fields}`],
      {
        env,
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 64 * 1024,
        killSignal: "SIGKILL",
      },
      (error, stdout) => resolve(error ? {} : parseLoginEndpoints(stdout)),
    )
  })
}
