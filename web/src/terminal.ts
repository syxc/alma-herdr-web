import { type Cell, type Grid, parseAnsi } from "./ansi.js"
import { IconFontLoader } from "./icon-font.js"
import { layoutGrid } from "./layout.js"
import { paintTerminal } from "./terminal-painter.js"
import { TerminalSelection } from "./terminal-selection.js"
import { TERMINAL_COLORS, type Theme } from "./terminal-theme.js"
import { TerminalKernel } from "./vt.js"

export type FitMode = "wrap" | "original" | "shrink"

const SCREEN_INSET = 19

function rowText(cells: Cell[]): string {
  let text = ""
  for (const cell of cells) {
    text += cell.ch
  }
  return text.replace(/\s+$/, "")
}

export class TerminalView {
  private readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D
  private readonly host: HTMLElement | null
  private readonly surface: HTMLDivElement | null
  private readonly selection: TerminalSelection | null
  private pendingContent: { text: string; rows: number } | null = null
  private readonly kernel = new TerminalKernel()
  private readonly iconFonts = new IconFontLoader(() => this.render())
  private rows: Cell[][] = []
  private laidOut: Cell[][] = []
  private paneCols = 0
  private paneRows = 0
  private fontSize = 14
  private readonly fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Symbols Nerd Font Mono", monospace'
  private cellWidth = 8
  private cellHeight = 16
  private rowHeight = 16
  private theme: Theme = "dark"
  private mode: FitMode = "wrap"
  private observer: ResizeObserver | null = null
  // Pause auto-follow while the reader is above the latest output.
  private follow = true
  private topRow = 0
  // Anchor by text because newer snapshots can shift every row.
  private anchorText = ""
  private anchorIndex = 0
  private anchorOffset = 0
  private anchorSource: { text: string; row: number; column: number } | null = null
  private programmaticTop: number | null = null
  private snapTimer: number | null = null
  private text: string | null = null
  private contentRows = 0
  private revision = 0
  private usingKernel = false
  private upgradePending = false
  private layoutDirty = true
  private layoutWidth = -1
  private layoutCols = 0

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const context = canvas.getContext("2d")
    if (context === null) {
      throw new Error("2d canvas context unavailable")
    }
    this.context = context
    // The columns that fit depend on the width of the view, so the view is
    // the thing to observe.
    this.host = canvas.parentElement
    this.surface = this.host === null ? null : document.createElement("div")
    if (this.surface !== null) {
      this.surface.className = "terminal-surface"
      canvas.before(this.surface)
      this.surface.append(canvas)
      canvas.style.position = "sticky"
      canvas.style.top = "0"
    }
    this.selection =
      this.surface !== null && typeof canvas.ownerDocument?.getSelection === "function"
        ? new TerminalSelection(this.surface, canvas, (paused) => {
            if (paused) {
              this.follow = false
              this.captureAnchor()
              return
            }
            const pending = this.pendingContent
            this.pendingContent = null
            if (pending !== null) {
              const revision = this.revision
              void this.setContent(pending.text, pending.rows).then(() => {
                // Unchanged queued text still needs a resize deferred during selection.
                if (revision === this.revision) this.render()
              })
            } else this.render()
          })
        : null
    if (this.host !== null) {
      this.host.addEventListener("scroll", () => this.handleScroll())
    }
    if (this.host !== null && typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.resize())
      this.observer.observe(this.host)
    }
    this.resize()
  }

  async setContent(text: string, paneRows: number): Promise<void> {
    if (this.selection?.active()) {
      this.pendingContent = { text, rows: paneRows }
      return
    }
    const changed = text !== this.text || paneRows !== this.contentRows
    if (!changed && this.usingKernel) return
    if (changed) {
      this.text = text
      this.contentRows = paneRows
      this.revision += 1
      this.usingKernel = false
    }
    if (this.kernel.ready) {
      await this.replay()
      return
    }
    if (changed) this.apply(parseAnsi(text, TERMINAL_COLORS[this.theme].palette).cells, 0, paneRows)
    if (!this.upgradePending) {
      this.upgradePending = true
      void this.kernel.load().then(async (ready) => {
        try {
          if (ready) await this.replay()
        } finally {
          this.upgradePending = false
        }
      })
    }
  }

  private async replay(): Promise<void> {
    if (this.text === null) return
    const revision = this.revision
    const screen = await this.kernel.setContent(this.text, this.contentRows)
    // Loading may finish after another pane or snapshot has replaced this one.
    if (revision !== this.revision) return
    this.usingKernel = screen !== null
    this.apply(
      screen?.rows ?? parseAnsi(this.text, TERMINAL_COLORS[this.theme].palette).cells,
      screen?.cols ?? 0,
      this.contentRows,
    )
  }

  async setTheme(theme: Theme): Promise<void> {
    if (theme === this.theme) return
    this.captureAnchor()
    this.theme = theme
    const colors = TERMINAL_COLORS[theme]
    this.kernel.setColors(colors)
    this.revision += 1
    this.usingKernel = false
    if (this.text !== null) {
      if (this.kernel.ready) await this.replay()
      else this.apply(parseAnsi(this.text, colors.palette).cells, 0, this.contentRows)
    } else {
      this.render()
    }
  }

  private apply(rows: Cell[][], cols: number, paneRows: number): void {
    if (this.selection?.active()) {
      if (this.text !== null) this.pendingContent = { text: this.text, rows: this.contentRows }
      return
    }
    this.captureAnchor()
    this.rows = rows
    this.layoutDirty = true
    this.iconFonts.load(rows.map((row) => row.map((cell) => cell.ch).join("")).join(""))
    if (cols > 0) {
      this.paneCols = cols
    } else {
      let widest = 0
      for (const row of rows) {
        if (row.length > widest) {
          widest = row.length
        }
      }
      this.paneCols = widest
    }
    this.paneRows = paneRows > 0 ? paneRows : rows.length
    this.render()
  }

  private syncSize(): void {
    const ratio = window.devicePixelRatio || 1
    const rect = this.canvas.getBoundingClientRect()
    const width = Math.max(1, Math.floor(rect.width * ratio))
    const height = Math.max(1, Math.floor(rect.height * ratio))
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
  }

  resize(): void {
    this.captureAnchor()
    this.render()
  }

  private columnsFor(width: number): number {
    return Math.max(1, Math.floor(width / this.cellWidth))
  }

  setMode(mode: FitMode): void {
    this.captureAnchor()
    this.mode = mode
    this.layoutDirty = true
    this.selection?.clear()
    if (this.host !== null) {
      this.host.classList.toggle("scroll-x", mode === "original")
      if (mode !== "original") this.host.scrollLeft = 0
    }
    this.canvas.style.touchAction = mode === "original" ? "auto" : "pan-y"
    this.render()
  }

  clearSelection(): void {
    this.pendingContent = null
    this.selection?.clear()
  }

  followBottom(): void {
    this.clearSelection()
    this.follow = true
    this.anchorText = ""
    this.anchorSource = null
    const host = this.host
    if (host !== null) {
      host.scrollTop = host.scrollHeight
    }
  }

  private captureAnchor(): void {
    if (this.follow || this.anchorSource !== null) {
      return
    }
    const top = Math.min(this.topRow, Math.max(0, this.laidOut.length - 1))
    for (let index = top; index >= 0; index -= 1) {
      const text = rowText(this.laidOut[index] ?? [])
      if (text.length > 0) {
        this.anchorText = text
        this.anchorIndex = index
        this.anchorOffset = top - index
        this.anchorSource = null
        const target = this.laidOut[index]?.find((cell) => cell.ch.trim().length > 0)
        if (target !== undefined) {
          for (let row = 0; row < this.rows.length; row += 1) {
            const cells = this.rows[row] ?? []
            const column = cells.indexOf(target)
            if (column < 0) continue
            this.anchorSource = { text: rowText(cells), row, column }
            break
          }
        }
        return
      }
    }
    this.anchorText = ""
    this.anchorOffset = 0
    this.anchorSource = null
  }

  private restoreAnchor(): void {
    const source = this.anchorSource
    if (source !== null) {
      let nearest = -1
      for (let row = 0; row < this.rows.length; row += 1) {
        if (rowText(this.rows[row] ?? []) !== source.text) continue
        if (nearest < 0 || Math.abs(row - source.row) < Math.abs(nearest - source.row)) nearest = row
      }
      const cell = this.rows[nearest]?.[source.column]
      if (cell !== undefined) {
        const row = this.laidOut.findIndex((cells) => cells.includes(cell))
        if (row >= 0) {
          source.row = nearest
          this.scrollToRow(row + this.anchorOffset)
          return
        }
      }
      this.anchorSource = null
    }
    if (this.anchorText.length === 0) {
      return
    }
    const last = this.laidOut.length - 1
    for (let distance = 0; distance <= last; distance += 1) {
      const above = this.anchorIndex - distance
      if (above >= 0 && rowText(this.laidOut[above] ?? []) === this.anchorText) {
        this.scrollToRow(above + this.anchorOffset)
        return
      }
      const below = this.anchorIndex + distance
      if (distance > 0 && below <= last && rowText(this.laidOut[below] ?? []) === this.anchorText) {
        this.scrollToRow(below + this.anchorOffset)
        return
      }
    }
  }

  private scrollToRow(row: number): void {
    const host = this.host
    if (host === null) {
      return
    }
    host.scrollTop = row * this.rowHeight
    this.programmaticTop = host.scrollTop
    this.topRow = Math.round(host.scrollTop / this.rowHeight)
  }

  private visibleRows(): number {
    const host = this.host
    if (host === null || this.rowHeight === 0) {
      return 1
    }
    return Math.max(1, Math.floor(host.clientHeight / this.rowHeight))
  }

  private handleScroll(): void {
    const host = this.host
    if (host === null) {
      return
    }
    const restored = this.programmaticTop !== null && Math.abs(host.scrollTop - this.programmaticTop) < 0.5
    if (!restored) {
      this.anchorSource = null
      this.programmaticTop = null
    }
    this.topRow = Math.round(host.scrollTop / this.rowHeight)
    this.follow = !this.selection?.active() && this.topRow + this.visibleRows() >= this.laidOut.length - 1
    this.paint()
    if (this.snapTimer !== null) {
      window.clearTimeout(this.snapTimer)
    }
    if (this.selection?.active()) return
    this.snapTimer = window.setTimeout(() => {
      this.snapTimer = null
      this.snap()
    }, 140)
  }

  private snap(): void {
    const host = this.host
    if (host === null || this.rowHeight === 0 || this.selection?.active()) {
      return
    }
    const row = Math.round(host.scrollTop / this.rowHeight)
    const target = row * this.rowHeight
    if (Math.abs(host.scrollTop - target) < 0.5) {
      return
    }
    host.scrollTop = target
    this.programmaticTop = host.scrollTop
  }

  render(): void {
    if (this.selection?.active()) return
    const ctx = this.context
    const ratio = window.devicePixelRatio || 1
    const host = this.host
    const viewWidth = host === null ? 0 : host.clientWidth
    const viewHeight = host === null ? 0 : host.clientHeight
    // A hidden detail must not reflow the whole snapshot into one-column DOM rows.
    if (host !== null && (viewWidth <= 0 || viewHeight <= 0)) return

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.font = `${this.fontSize}px ${this.fontFamily}`
    // A cell is as wide as the widest letter of the font, the way a
    // terminal measures it.
    if (this.layoutWidth < 0) this.cellWidth = Math.max(1, ctx.measureText("W").width)
    this.cellHeight = Math.round(this.fontSize * 1.5)

    // The screen keeps its margin, the way the Alma app draws it.
    const inset = viewWidth > 0 ? SCREEN_INSET : 0
    const usable = Math.max(1, viewWidth - inset * 2)

    const grid: Grid = {
      cols: Math.max(1, this.paneCols),
      rows: this.rows.length,
      cells: this.rows,
    }
    if (this.layoutDirty || usable !== this.layoutWidth) {
      const laidOut = this.mode === "wrap" ? layoutGrid(grid, this.columnsFor(usable)) : grid
      this.laidOut = laidOut.cells
      this.layoutCols = laidOut.cols
      this.layoutWidth = usable
      this.layoutDirty = false
    }

    const contentWidth = this.layoutCols * this.cellWidth
    const contentHeight = this.laidOut.length * this.cellHeight

    // A screen that does not fit is scaled down only in the mode that says
    // so. The other modes keep the size of the text.
    const scale = this.mode === "shrink" && contentWidth > 0 ? Math.min(1, usable / contentWidth) : 1

    // The surface carries the scroll range; the canvas only covers the viewport.
    // Pad the surface so the last scroll position lands on a whole row.
    const lineHeight = this.cellHeight * scale
    this.rowHeight = lineHeight
    const content = contentHeight * scale
    let canvasHeight = Math.max(viewHeight, content)
    if (content > viewHeight && lineHeight > 0) {
      const pad = (lineHeight - ((content - viewHeight) % lineHeight)) % lineHeight
      canvasHeight = content + pad
    }
    this.canvas.style.width = `${this.mode === "shrink" ? viewWidth : Math.max(viewWidth, inset + contentWidth + inset)}px`
    this.canvas.style.height = `${host === null ? canvasHeight : Math.max(1, viewHeight)}px`
    if (this.surface !== null) {
      this.surface.style.width = this.canvas.style.width
      this.surface.style.height = `${canvasHeight}px`
    }
    this.syncSize()
    this.selection?.update(this.laidOut, this.rows, {
      width: contentWidth,
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      scale,
      inset,
    })

    if (host !== null) {
      if (this.follow) {
        // The newest line stays in sight while the reader stays at the bottom.
        host.scrollTop = host.scrollHeight
        this.topRow = Math.max(0, this.laidOut.length - this.visibleRows())
      } else {
        this.restoreAnchor()
      }
    }

    this.paint()
  }

  private paint(): void {
    const contentWidth = this.layoutCols * this.cellWidth
    const scale = this.mode === "shrink" && contentWidth > 0 ? Math.min(1, this.layoutWidth / contentWidth) : 1
    paintTerminal(this.canvas, this.context, this.laidOut, {
      scale,
      inset: this.host === null ? 0 : SCREEN_INSET,
      scrollTop: this.host?.scrollTop ?? 0,
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      theme: this.theme,
    })
  }

  size(): { cols: number; rows: number } {
    return { cols: this.paneCols, rows: this.paneRows }
  }
}
