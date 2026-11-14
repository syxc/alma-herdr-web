export const SCROLL_IDLE_MS = 120

/** Hold expensive snapshot work until all fingers and native inertia have stopped. */
export class TerminalScrollPause {
  timer: number | null = null
  private touching = false

  constructor(
    host: HTMLElement | null,
    private readonly idle: () => void,
  ) {
    // A wheel gesture keeps running at a clamped boundary without scroll events.
    host?.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey && event.deltaY !== 0 && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) this.extend()
      },
      { passive: true },
    )
    host?.addEventListener(
      "touchstart",
      (event) => {
        this.touching = event.touches.length > 0
        this.cancelTimer()
      },
      { passive: true },
    )
    const release = (event: TouchEvent) => {
      if (event.touches.length > 0) return
      this.touching = false
      this.extend()
    }
    host?.addEventListener("touchend", release, { passive: true })
    host?.addEventListener("touchcancel", release, { passive: true })
    host?.ownerDocument?.defaultView?.addEventListener("blur", () => {
      if (!this.touching) return
      this.touching = false
      this.extend()
    })
  }

  get active(): boolean {
    return this.touching || this.timer !== null
  }

  extend(): void {
    this.cancelTimer()
    if (this.touching) return
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.idle()
    }, SCROLL_IDLE_MS)
  }

  clear(): void {
    this.touching = false
    this.cancelTimer()
  }

  private cancelTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
  }
}
