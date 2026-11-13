import assert from "node:assert/strict"
import { test } from "node:test"

import { createAgentTerminal, NEW_TAB_AGENTS } from "../web/dist/new-terminal.js"

function fixture() {
  const state = {
    workspaces: [{ workspace_id: "w1" }, { workspace_id: "w2" }],
    tabs: [
      { tab_id: "t1", workspace_id: "w1" },
      { tab_id: "t2", workspace_id: "w2" },
    ],
    panes: [
      { pane_id: "old", tab_id: "t1", cwd: "/first" },
      { pane_id: "source", tab_id: "t2", cwd: "/project", foreground_cwd: "/other" },
    ],
  }
  const pane = {
    pane_id: "new-pane",
    tab_id: "new-tab",
    workspace_id: "w2",
    cwd: "/project",
    agent: "claude",
    agent_session: { agent: "claude" },
  }
  const next = { ...state, panes: [...state.panes, pane] }
  const log = []
  const calls = {
    create: async (...args) => {
      log.push(["create", ...args])
      return { paneId: pane.pane_id, error: null }
    },
    start: async (...args) => {
      log.push(["start", ...args])
      return null
    },
    state: async () => ({ state: next, connected: true }),
    current: () => true,
    pause: async () => {},
  }
  return { state, next, log, calls }
}

for (const agent of NEW_TAB_AGENTS) {
  test(`new ${agent.label} inherits the chosen workspace and starts the returned pane`, async () => {
    const { state, next, log, calls } = fixture()
    const result = await createAgentTerminal(state, "w2", agent, calls)
    assert.deepEqual(log, [
      ["create", "w2", "/project"],
      ["start", "new-pane", `${agent.kind}-new-pane`, agent.kind, []],
    ])
    assert.deepEqual(result, { paneId: "new-pane", state: next, error: null })
  })
}

test("an empty workspace explicitly requests the desktop home directory", async () => {
  const { state, log, calls } = fixture()
  state.tabs = []
  await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[0], calls)
  assert.deepEqual(log[0], ["create", "w2", "~"])
})

test("creation refusal does not start an agent", async () => {
  const { state, log, calls } = fixture()
  calls.create = async () => ({ paneId: null, error: "refused" })
  const result = await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[0], calls)
  assert.equal(result.error, "refused")
  assert.deepEqual(log, [])
})

test("waits for the returned pane instead of using desktop focus", async () => {
  const { state, next, log, calls } = fixture()
  let reads = 0
  calls.state = async () => ({ state: ++reads === 1 ? state : next, connected: true })
  await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[1], calls)
  assert.equal(reads, 2)
  assert.equal(log[1][1], "new-pane")
})

test("startup refusal preserves the created terminal and reports the failure", async () => {
  const { state, calls } = fixture()
  calls.start = async () => ({ error: "executable not found", code: "missing" })
  calls.pause = async () => assert.fail("permanent startup errors must not be retried")
  const result = await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[1], calls)
  assert.equal(result.paneId, "new-pane")
  assert.match(result.error, /Tab created; Codex could not start: executable not found/)
})

test("startup transport failure also preserves the created terminal", async () => {
  const { state, calls } = fixture()
  calls.start = async () => {
    throw new Error("offline")
  }
  const result = await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[1], calls)
  assert.equal(result.paneId, "new-pane")
  assert.match(result.error, /Tab created; Codex could not start: Error: offline/)
})

test("a connection change after creation stops further requests", async () => {
  const { state, calls, log } = fixture()
  let current = true
  calls.current = () => current
  const create = calls.create
  calls.create = async (...args) => {
    const result = await create(...args)
    current = false
    return result
  }
  calls.state = async () => {
    assert.fail("must not read another desktop")
  }
  const result = await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[0], calls)
  assert.equal(result.error, "connection changed")
  assert.equal(log.length, 1)
})

test("a connection change during state read prevents startup", async () => {
  const { state, next, calls, log } = fixture()
  let current = true
  calls.current = () => current
  calls.state = async () => {
    current = false
    return { state: next, connected: true }
  }
  await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[0], calls)
  assert.equal(log.length, 1)
})

test("missing workspace is rejected before creation", async () => {
  const { state, calls, log } = fixture()
  const result = await createAgentTerminal(state, "removed", NEW_TAB_AGENTS[0], calls)
  assert.match(result.error, /workspace is no longer available/)
  assert.deepEqual(log, [])
})

test("state timeout is bounded and does not create a second tab", async () => {
  const { state, calls, log } = fixture()
  let reads = 0
  calls.state = async () => {
    reads += 1
    return { state, connected: true }
  }
  const result = await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[0], calls)
  assert.equal(reads, 40)
  assert.equal(log.length, 1)
  assert.match(result.error, /tab was created.*refresh the list/)
})

test("new tabs retry only shell readiness errors on the same created pane", async () => {
  const { state, log, calls } = fixture()
  let attempts = 0
  const pauses = []
  calls.start = async (...args) => {
    log.push(["start", ...args])
    attempts += 1
    return attempts < 3 ? { code: "agent_pane_busy", error: "not an available shell" } : null
  }
  calls.pause = async (milliseconds) => pauses.push(milliseconds)
  const result = await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[1], calls)
  assert.equal(result.error, null)
  assert.equal(log.filter((call) => call[0] === "create").length, 1)
  assert.equal(attempts, 3)
  assert.deepEqual(pauses, [250, 250])
  assert.ok(log.filter((call) => call[0] === "start").every((call) => call[1] === "new-pane"))
})

test("shell readiness retries stop after a connection change", async () => {
  const { state, calls } = fixture()
  let current = true
  let attempts = 0
  calls.current = () => current
  calls.start = async () => {
    attempts += 1
    return { code: "agent_pane_busy", error: "not an available shell" }
  }
  calls.pause = async () => {
    current = false
  }
  const result = await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[1], calls)
  assert.equal(result.error, "connection changed")
  assert.equal(attempts, 1)
})

test("shell readiness timeout is bounded and keeps the created pane", async () => {
  const { state, calls } = fixture()
  let attempts = 0
  calls.start = async () => {
    attempts += 1
    return { code: "agent_pane_busy", error: "not an available shell" }
  }
  const result = await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[1], calls)
  assert.equal(attempts, 20)
  assert.equal(result.paneId, "new-pane")
  assert.match(result.error, /Tab created; Codex could not start/)
})

test("state transport failure reports partial creation without starting another tab", async () => {
  const { state, calls, log } = fixture()
  calls.state = async () => {
    throw new Error("offline")
  }
  const result = await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[0], calls)
  assert.match(result.error, /tab was created.*state could not be read/)
  assert.equal(log.length, 1)
})

test("inherits the first available pane directory across tabs of the target workspace", async () => {
  const { state, calls, log } = fixture()
  state.panes.find((pane) => pane.pane_id === "source").cwd = ""
  state.tabs.push({ tab_id: "t3", workspace_id: "w2" })
  state.panes.push({ pane_id: "later", tab_id: "t3", cwd: "/project" })
  await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[0], calls)
  assert.deepEqual(log[0], ["create", "w2", "/project"])
})

test("inherits a later split pane cwd instead of falling back to home", async () => {
  const { state, calls, log } = fixture()
  state.panes.find((pane) => pane.pane_id === "source").cwd = null
  state.panes.push({ pane_id: "split", tab_id: "t2", cwd: "/project" })
  await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[0], calls)
  assert.deepEqual(log[0], ["create", "w2", "/project"])
})

test("a desktop directory fallback is reported without starting the agent", async () => {
  const { state, next, calls, log } = fixture()
  next.panes.at(-1).cwd = "/desktop-home"
  const result = await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[0], calls)
  assert.equal(result.paneId, "new-pane")
  assert.match(result.error, /Working directory.*fallback directory; agent was not started/)
  assert.deepEqual(log, [["create", "w2", "/project"]])
})

test("waits for a new pane directory before starting the agent", async () => {
  const { state, next, calls, log } = fixture()
  let reads = 0
  calls.state = async () => ({
    connected: true,
    state: {
      ...next,
      panes: next.panes.map((pane) => (pane.pane_id === "new-pane" && reads++ === 0 ? { ...pane, cwd: null } : pane)),
    },
  })
  const result = await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[0], calls)
  assert.equal(result.error, null)
  assert.equal(reads, 2)
  assert.equal(log.filter((call) => call[0] === "start").length, 1)
})

test("a missing directory never starts an agent and preserves the created pane", async () => {
  const { state, next, calls, log } = fixture()
  next.panes.at(-1).cwd = null
  const result = await createAgentTerminal(state, "w2", NEW_TAB_AGENTS[0], calls)
  assert.equal(result.paneId, "new-pane")
  assert.match(result.error, /working directory could not be confirmed; agent was not started/)
  assert.deepEqual(log, [["create", "w2", "/project"]])
})
