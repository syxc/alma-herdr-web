export type ScrollDirection = -1 | 1

/** Extend native scrolling only when a deliberate gesture reaches its boundary. */
export function terminalScroll(
  host: HTMLElement,
  paused: () => boolean,
  move: (direction: ScrollDirection) => void,
): void {
  let lastRequest = 0
  let wheelDistance = 0
  let touch: { x: number; y: number; direction: ScrollDirection | null } | null = null
  const boundary = (direction: ScrollDirection) =>
    direction < 0 ? host.scrollTop <= 1 : host.scrollTop + host.clientHeight >= host.scrollHeight - 1
  const request = (direction: ScrollDirection) => {
    if (paused() || !boundary(direction) || Date.now() - lastRequest < 350) return
    lastRequest = Date.now()
    wheelDistance = 0
    move(direction)
  }
  host.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.deltaY === 0) return
      const direction = event.deltaY < 0 ? -1 : 1
      if (!boundary(direction)) {
        wheelDistance = 0
        return
      }
      if (Math.sign(wheelDistance) !== direction) wheelDistance = 0
      wheelDistance += event.deltaY * (event.deltaMode === 1 ? 21 : event.deltaMode === 2 ? host.clientHeight : 1)
      if (Math.abs(wheelDistance) >= 40) request(direction)
    },
    { passive: true },
  )
  host.addEventListener(
    "touchstart",
    (event) => {
      const point = event.touches[0]
      touch =
        event.touches.length === 1 && point !== undefined
          ? { x: point.clientX, y: point.clientY, direction: boundary(-1) ? -1 : boundary(1) ? 1 : null }
          : null
    },
    { passive: true },
  )
  host.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length !== 1) touch = null
    },
    { passive: true },
  )
  host.addEventListener(
    "touchcancel",
    () => {
      touch = null
    },
    { passive: true },
  )
  host.addEventListener(
    "touchend",
    (event) => {
      const start = touch
      touch = null
      const point = event.changedTouches[0]
      if (start === null || point === undefined || event.touches.length !== 0) return
      const distance = point.clientY - start.y
      const direction = distance > 0 ? -1 : 1
      if (
        Math.abs(distance) >= 48 &&
        Math.abs(distance) > Math.abs(point.clientX - start.x) &&
        (start.direction === direction || host.scrollHeight <= host.clientHeight + 1)
      )
        request(direction)
    },
    { passive: true },
  )
  host.addEventListener("keydown", (event) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey
    )
      return
    if (event.key === "PageUp" && boundary(-1)) request(-1)
    else if (event.key === "PageDown" && boundary(1)) request(1)
  })
}

/** A larger read handles host history; pi keeps its transcript behind application paging. */
export class TerminalHistory {
  lines = 120
  truncated = false
  busy = false

  async move(
    direction: ScrollDirection,
    agent: string | null,
    send: (text: string) => Promise<string | null>,
  ): Promise<boolean> {
    if (this.busy) return false
    if (direction < 0 && this.truncated && this.lines < 1000) {
      this.lines = Math.min(1000, this.lines * 2)
      return true
    }
    if (agent !== "pi") return false
    this.busy = true
    try {
      // The TUI key-name encoder has no PageUp/PageDown; send their VT sequences.
      const error = await send(direction < 0 ? "\x1b[5~" : "\x1b[6~")
      if (error !== null) throw new Error(error)
      return true
    } finally {
      this.busy = false
    }
  }
}
