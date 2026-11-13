import type { AgentSessionRef, PaneRecord } from "./api.js"

/**
 * What the client knows about one coding agent.
 *
 * Every agent opens its session in its own way, so the way to continue a
 * session belongs to the agent and not to the client. Herdr maps the same
 * kinds the same way when it restores a session, so the client follows that
 * mapping.
 *
 * A new agent joins the list below.
 */
export interface AgentSpec {
  /** The kind herdr knows the agent by. */
  kind: string
  /** The name the reader sees. */
  label: string
  /** The kinds of session the agent can open again. */
  sessionKinds: SessionKind[]
  /** The arguments that open the session again, without the command itself. */
  resumeArgs(value: string): string[]
}

/**
 * How herdr names the session of an agent.
 */
export type SessionKind = "id" | "path"

/**
 * The agents the client can restart and continue.
 *
 * The kinds are the ones herdr knows, and the arguments are the ones each
 * command takes to open a session again.
 */
const SPECS: AgentSpec[] = [
  {
    kind: "claude",
    label: "Claude Code",
    sessionKinds: ["id"],
    resumeArgs: (value) => ["--resume", value],
  },
  {
    kind: "codex",
    label: "Codex",
    sessionKinds: ["id"],
    resumeArgs: (value) => ["resume", value],
  },
  {
    kind: "pi",
    label: "Pi",
    sessionKinds: ["id", "path"],
    resumeArgs: (value) => ["--session", value],
  },
  {
    kind: "opencode",
    label: "OpenCode",
    sessionKinds: ["id"],
    resumeArgs: (value) => ["--session", value],
  },
  {
    kind: "omp",
    label: "omp",
    sessionKinds: ["id", "path"],
    resumeArgs: (value) => [`--resume=${value}`],
  },
]

/**
 * The kind of the agent in a pane, as herdr names it.
 *
 * The session carries the name of the agent, so the pane does not have to be
 * read twice.
 */
export function agentKind(pane: PaneRecord): string {
  const session = pane.agent_session
  if (session !== null && session.agent.length > 0) {
    return session.agent
  }
  const source = session?.source ?? ""
  const after = source.includes(":") ? source.slice(source.indexOf(":") + 1) : ""
  if (after.length > 0) {
    return after
  }
  return pane.agent ?? ""
}

/**
 * What the client knows about the agent of a kind.
 */
export function agentSpec(kind: string): AgentSpec | null {
  return SPECS.find((spec) => spec.kind === kind) ?? null
}

/**
 * The name the reader sees for an agent.
 */
export function agentLabel(kind: string): string {
  return agentSpec(kind)?.label ?? kind
}

/**
 * The arguments that open the session of a pane again.
 *
 * The answer is null when the pane has no session, or when the agent takes
 * another kind of session than the one herdr reported.
 */
export function resumeArgs(pane: PaneRecord): string[] | null {
  const session: AgentSessionRef | null = pane.agent_session
  if (session === null || session.value.length === 0) {
    return null
  }
  const spec = agentSpec(agentKind(pane))
  if (spec === null) {
    return null
  }
  if (!spec.sessionKinds.includes(session.kind as SessionKind)) {
    return null
  }
  return spec.resumeArgs(session.value)
}

/**
 * The prompt that makes a resumed agent carry on.
 */
export const CONTINUE_PROMPT = "继续"

/**
 * The name the agent gets when it starts again.
 *
 * Herdr wants a name that no other live agent carries, so the pane is part
 * of it. The name of a pane stays the same, so the name of the agent stays
 * the same when the agent restarts.
 */
export function agentName(pane: PaneRecord): string {
  const kind = slug(agentKind(pane)) || "agent"
  const paneSlug = slug(pane.pane_id)
  const name = paneSlug.length > 0 ? `${kind}-${paneSlug}` : kind
  return name.slice(0, 32)
}

/**
 * A name herdr accepts: lower case, with dashes between the parts.
 */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
