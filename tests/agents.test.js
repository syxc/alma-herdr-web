import assert from "node:assert/strict"
import { test } from "node:test"

import { agentKind, agentLabel, agentName, resumeArgs } from "../web/dist/agents.js"
import { restartAgent } from "../web/dist/restart.js"

/**
 * A pane, with the parts the client reads.
 */
function pane(fields) {
  return {
    pane_id: "wB:p1",
    agent: null,
    agent_status: "idle",
    agent_session: null,
    ...fields,
  }
}

/**
 * A pane that runs an agent with a session.
 */
function agentPane(kind, sessionKind, value, extra) {
  return pane({
    agent: kind,
    agent_session: {
      agent: kind,
      kind: sessionKind,
      source: `herdr:${kind}`,
      value,
    },
    ...extra,
  })
}

test("the kind of an agent comes from its session", () => {
  assert.equal(agentKind(agentPane("claude", "id", "abc")), "claude")
})

test("a pane without a session falls back to the agent of the pane", () => {
  assert.equal(agentKind(pane({ agent: "codex" })), "codex")
  assert.equal(agentKind(pane({})), "")
})

test("the label of an agent is the name the reader sees", () => {
  assert.equal(agentLabel("claude"), "Claude Code")
  assert.equal(agentLabel("codex"), "Codex")
  assert.equal(agentLabel("pi"), "Pi")
  assert.equal(agentLabel("opencode"), "OpenCode")
  assert.equal(agentLabel("omp"), "omp")
})

test("an agent the client does not know keeps its own name", () => {
  assert.equal(agentLabel("gemini"), "gemini")
})

test("claude opens its session with --resume", () => {
  assert.deepEqual(resumeArgs(agentPane("claude", "id", "session-1")), ["--resume", "session-1"])
})

test("codex opens its session with the resume command", () => {
  assert.deepEqual(resumeArgs(agentPane("codex", "id", "session-2")), ["resume", "session-2"])
})

test("pi opens its session with --session", () => {
  assert.deepEqual(resumeArgs(agentPane("pi", "path", "/tmp/a.jsonl")), ["--session", "/tmp/a.jsonl"])
  assert.deepEqual(resumeArgs(agentPane("pi", "id", "session-3")), ["--session", "session-3"])
})

test("opencode opens its session with --session", () => {
  assert.deepEqual(resumeArgs(agentPane("opencode", "id", "ses_4")), ["--session", "ses_4"])
})

test("omp opens its session with --resume=", () => {
  assert.deepEqual(resumeArgs(agentPane("omp", "path", "/tmp/b.jsonl")), ["--resume=/tmp/b.jsonl"])
})

test("an agent that takes another kind of session cannot be continued", () => {
  assert.equal(resumeArgs(agentPane("claude", "path", "/tmp/c.jsonl")), null)
  assert.equal(resumeArgs(agentPane("opencode", "path", "/tmp/d.jsonl")), null)
})

test("a pane without a session cannot be continued", () => {
  assert.equal(resumeArgs(pane({ agent: "claude" })), null)
  assert.equal(resumeArgs(agentPane("claude", "id", "")), null)
})

test("an agent the client does not know cannot be continued", () => {
  assert.equal(resumeArgs(agentPane("gemini", "id", "session-5")), null)
})

test("the name of an agent holds the pane, so two panes differ", () => {
  const first = agentName(agentPane("claude", "id", "a"))
  const second = agentName(agentPane("claude", "id", "a", { pane_id: "wB:p2" }))
  assert.notEqual(first, second)
  assert.match(first, /^[a-z][a-z0-9_-]{0,31}$/)
})

test("the name of an agent stays the same when the agent restarts", () => {
  assert.equal(agentName(agentPane("claude", "id", "a")), agentName(agentPane("claude", "id", "b")))
})

/**
 * The calls a restart makes, and the line they leave behind.
 */
function recorder() {
  const calls = []
  const lines = []
  return {
    calls,
    lines,
    sendKeys: async (paneId, keys) => {
      calls.push(["sendKeys", paneId, keys])
      return null
    },
    startAgent: async (paneId, name, kind, args) => {
      calls.push(["startAgent", paneId, name, kind, args])
      return null
    },
    promptAgent: async (target, text) => {
      calls.push(["promptAgent", target, text])
      return null
    },
    status: (message, isError) => {
      lines.push([message, isError])
    },
    pause: async () => undefined,
  }
}

test("a restart stops the agent and starts it again", async () => {
  const calls = recorder()
  await restartAgent(agentPane("claude", "id", "session-1"), false, calls)
  assert.deepEqual(
    calls.calls.map((call) => call[0]),
    ["sendKeys", "startAgent"],
  )
  assert.deepEqual(calls.calls[0][2], ["ctrl+c", "ctrl+c"])
  assert.deepEqual(calls.calls[1][3], "claude")
  assert.deepEqual(calls.calls[1][4], [])
})

test("a restart that continues opens the session and asks the agent to carry on", async () => {
  const calls = recorder()
  await restartAgent(agentPane("codex", "id", "session-2"), true, calls)
  assert.deepEqual(
    calls.calls.map((call) => call[0]),
    ["sendKeys", "startAgent", "promptAgent"],
  )
  assert.deepEqual(calls.calls[1][4], ["resume", "session-2"])
  assert.deepEqual(calls.calls[2][2], "继续")
})

test("a restart waits for the pane to become a shell again", async () => {
  const calls = recorder()
  let tries = 0
  calls.startAgent = async (paneId, name, kind, args) => {
    calls.calls.push(["startAgent", paneId, name, kind, args])
    tries += 1
    return tries === 1 ? { error: "agent target pane wB:p1 is not an available shell", code: "agent_pane_busy" } : null
  }
  await restartAgent(agentPane("claude", "id", "session-1"), false, calls)
  assert.deepEqual(
    calls.calls.map((call) => call[0]),
    ["sendKeys", "startAgent", "startAgent"],
  )
  assert.equal(calls.lines[calls.lines.length - 1][0], "restarted Claude Code")
})

test("a restart waits for the agent that just started", async () => {
  const calls = recorder()
  let tries = 0
  calls.promptAgent = async (target, text) => {
    calls.calls.push(["promptAgent", target, text])
    tries += 1
    return tries === 1 ? { error: "agent wB:p1 is not an active named agent", code: "agent_not_ready" } : null
  }
  await restartAgent(agentPane("claude", "id", "session-1"), true, calls)
  assert.deepEqual(
    calls.calls.map((call) => call[0]),
    ["sendKeys", "startAgent", "promptAgent", "promptAgent"],
  )
  assert.equal(calls.lines[calls.lines.length - 1][0], "restarted Claude Code")
})

test("a restart that keeps failing says so", async () => {
  const calls = recorder()
  calls.promptAgent = async (target, text) => {
    calls.calls.push(["promptAgent", target, text])
    return { error: "agent wB:p1 is not an active named agent", code: "agent_not_ready" }
  }
  await restartAgent(agentPane("claude", "id", "session-1"), true, calls)
  const last = calls.lines[calls.lines.length - 1]
  assert.equal(last[0], "continue failed: agent wB:p1 is not an active named agent")
  assert.equal(last[1], true)
})

test("a restart without a session only starts the agent", async () => {
  const calls = recorder()
  await restartAgent(pane({ agent: "claude" }), true, calls)
  assert.deepEqual(
    calls.calls.map((call) => call[0]),
    [],
  )
  assert.equal(calls.lines[0][1], true)
})

test("a restart that fails says so and stops there", async () => {
  const calls = recorder()
  calls.startAgent = async () => ({ error: "pane is busy", code: "agent_pane_busy" })
  await restartAgent(agentPane("claude", "id", "session-1"), false, calls)
  const last = calls.lines[calls.lines.length - 1]
  assert.equal(last[0], "restart failed: pane is busy")
  assert.equal(last[1], true)
})

test("a restart of a pane without an agent says so", async () => {
  const calls = recorder()
  await restartAgent(pane({}), false, calls)
  assert.equal(calls.lines[0][0], "this pane does not run an agent")
  assert.deepEqual(calls.calls, [])
})
