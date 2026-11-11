/**
 * The order in which the keys reach the pane.
 *
 * A burst of typing is sent as one call: the letters go as one text, the
 * keys as one list. The order never changes, because a keystroke that
 * arrives after the one before it means something else on the pane.
 *
 * The waiting matters for the relay: one letter per round trip turns the
 * typing into slow motion.
 */

/**
 * Where the keys go.
 */
export interface KeySink {
  /** Sends text to the pane. */
  sendText(text: string): void
  /** Sends key names to the pane. */
  sendKeys(keys: string[]): void
}

/**
 * One thing the reader did.
 */
export type Action = { kind: "text"; text: string } | { kind: "keys"; keys: string[] }

/**
 * Puts the neighbours of the same kind into one call.
 */
export function groupActions(actions: Action[]): Action[] {
  const groups: Action[] = []
  for (const action of actions) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.kind === action.kind) {
      if (last.kind === "text" && action.kind === "text") {
        last.text += action.text
      } else if (last.kind === "keys" && action.kind === "keys") {
        last.keys = last.keys.concat(action.keys)
      }
      continue
    }
    groups.push(
      action.kind === "text" ? { kind: "text", text: action.text } : { kind: "keys", keys: action.keys.slice() },
    )
  }
  return groups
}

/**
 * How long the sends wait for each other.
 */
const FLUSH_DELAY = 16

export class KeyQueue {
  private readonly sink: KeySink
  private readonly delay: number
  /** The actions that are not sent yet. */
  private pending: Action[] = []
  private timer: number | null = null

  constructor(sink: KeySink, delay = FLUSH_DELAY) {
    this.sink = sink
    this.delay = delay
  }

  /**
   * Queues text for the pane.
   */
  text(value: string): void {
    if (value.length === 0) {
      return
    }
    this.pending.push({ kind: "text", text: value })
    this.schedule()
  }

  /**
   * Queues key names for the pane.
   */
  keys(names: string[]): void {
    if (names.length === 0) {
      return
    }
    this.pending.push({ kind: "keys", keys: names })
    this.schedule()
  }

  /**
   * Sends what is waiting right away.
   */
  flush(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
    this.send()
  }

  private schedule(): void {
    if (this.timer !== null) {
      return
    }
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.send()
    }, this.delay)
  }

  private send(): void {
    if (this.pending.length === 0) {
      return
    }
    const batch = this.pending
    this.pending = []
    for (const group of groupActions(batch)) {
      if (group.kind === "text") {
        this.sink.sendText(group.text)
      } else {
        this.sink.sendKeys(group.keys)
      }
    }
  }
}
