/** Keep a bounded strip of pixels in native scroll coordinates. */
export class TerminalViewport {
  private top = -1
  private height = 0

  syncSize(canvas: HTMLCanvasElement): void {
    const ratio = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const width = Math.max(1, Math.floor(rect.width * ratio))
    const height = Math.max(1, Math.floor(rect.height * ratio))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
  }

  update(canvas: HTMLCanvasElement, host: HTMLElement, rowHeight: number, contentHeight: number): number {
    const height = Math.min(contentHeight, host.clientHeight * 3)
    const scrollTop = Math.max(0, host.scrollTop)
    const margin = host.clientHeight / 2
    const end = this.top + height
    const nearTop = this.top > 0 && scrollTop < this.top + margin
    const nearBottom = end < contentHeight && scrollTop + host.clientHeight > end - margin
    if (this.top < 0 || height !== this.height || this.top + height > contentHeight || nearTop || nearBottom) {
      // Reserve one screen in each direction; rebase before the reader reaches an edge.
      const desired = Math.floor(Math.max(0, scrollTop - host.clientHeight) / rowHeight) * rowHeight
      this.top = Math.max(0, Math.min(desired, contentHeight - height))
      canvas.style.top = `${this.top}px`
    }
    if (height !== this.height) canvas.style.height = `${height}px`
    this.height = height
    return this.top
  }
}
