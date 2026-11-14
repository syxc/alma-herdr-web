import { agentKind, agentLabel, agentName, CONTINUE_PROMPT, resumeArgs } from "./agents.js"
import type { ApiFailure, PaneRecord } from "./api.js"

export interface RestartCalls {
  sendKeys(paneId: string, keys: string[]): Promise<string | null>
  startAgent(paneId: string, name: string, kind: string, args: string[]): Promise<ApiFailure | null>
  promptAgent(target: string, text: string): Promise<ApiFailure | null>
  status(message: string, isError: boolean): void
  pause?(milliseconds: number): Promise<void>
}

// Exiting the agent and returning to the shell is asynchronous.
const START_GAP = 1200

const START_TRIES = 2

// agent.start responds before the new agent is ready for prompts.
const READY_GAP = 1500
const READY_TRIES = 12

export async function restartAgent(pane: PaneRecord, continueAfter: boolean, calls: RestartCalls): Promise<void> {
  const kind = agentKind(pane)
  if (kind.length === 0) {
    calls.status("this pane does not run an agent", true)
    return
  }
  const label = agentLabel(kind)
  const args = continueAfter ? (resumeArgs(pane) ?? []) : []
  if (continueAfter && args.length === 0) {
    calls.status("this pane has no session to open", true)
    return
  }
  calls.status(`restarting ${label}…`, false)

  // Two interrupts in one request leave the agent and put the caret back on
  // the shell. An agent that is working needs the second one to quit.
  const stopError = await calls.sendKeys(pane.pane_id, ["ctrl+c", "ctrl+c"])
  if (stopError !== null) {
    calls.status(`stop failed: ${stopError}`, true)
    return
  }
  await wait(calls, START_GAP)

  const error = await startAgent(pane, kind, args, calls)
  if (error !== null) {
    calls.status(`restart failed: ${error.error}`, true)
    return
  }
  if (continueAfter) {
    const promptError = await promptAgent(pane, calls)
    if (promptError !== null) {
      calls.status(`continue failed: ${promptError.error}`, true)
      return
    }
  }
  calls.status(`restarted ${label}`, false)
}

async function startAgent(
  pane: PaneRecord,
  kind: string,
  args: string[],
  calls: RestartCalls,
): Promise<ApiFailure | null> {
  const name = agentName(pane)
  let failure = await calls.startAgent(pane.pane_id, name, kind, args)
  for (let round = 1; failure?.code === "agent_pane_busy" && round < START_TRIES; round += 1) {
    await wait(calls, START_GAP)
    failure = await calls.startAgent(pane.pane_id, name, kind, args)
  }
  return failure
}

async function promptAgent(pane: PaneRecord, calls: RestartCalls): Promise<ApiFailure | null> {
  let failure = await calls.promptAgent(pane.pane_id, CONTINUE_PROMPT)
  for (let round = 1; failure !== null && notReady(failure) && round < READY_TRIES; round += 1) {
    await wait(calls, READY_GAP)
    failure = await calls.promptAgent(pane.pane_id, CONTINUE_PROMPT)
  }
  return failure
}

function notReady(failure: ApiFailure): boolean {
  if (failure.code === "agent_not_ready" || failure.code === "agent_not_found") {
    return true
  }
  return failure.error.includes("not an active named agent") || failure.error.includes("not found")
}

function wait(calls: RestartCalls, milliseconds: number): Promise<void> {
  if (calls.pause !== undefined) {
    return calls.pause(milliseconds)
  }
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}
