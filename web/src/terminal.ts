import { type Cell, type Grid, parseAnsi } from "./ansi.js"
import { IconFontLoader } from "./icon-font.js"
import { layoutGrid } from "./layout.js"
import { TerminalPainter } from "./terminal-painter.js"
import { type ScrollDirection, terminalScroll } from "./terminal-scroll.js"
import { TerminalSelection } from "./terminal-selection.js"
import { TERMINAL_COLORS, type Theme } from "./terminal-theme.js"
import { TerminalViewport } from "./terminal-viewport.js"
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
  private pendingContent: { text: string; rows: number; cols: number } | null = null
  private readonly kernel = new TerminalKernel()
  private readonly painter = new TerminalPainter()
  private readonly viewport = new TerminalViewport()
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
  private paintFrame: number | null = null
  private scrollTimer: number | null = null
  private text: string | null = null
  private contentRows = 0
  private contentCols = 0
  private revision = 0
  private usingKernel = false
  private upgradePending = false
  private layoutDirty = true
  private layoutWidth = -1
  private layoutCols = 0

  constructor(canvas: HTMLCanvasElement, onBoundary?: (direction: ScrollDirection) => void) {
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
      canvas.style.position = "absolute"
      canvas.style.left = "0"
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
              void this.setContent(pending.text, pending.rows, pending.cols).then(() => {
                // Unchanged queued text still needs a resize deferred during selection.
                if (revision === this.revision && this.scrollTimer === null) this.render()
              })
            } else this.render()
          })
        : null
    if (this.host !== null) {
      this.host.addEventListener("scroll", () => this.handleScroll(), { passive: true })
      terminalScroll(
        this.host,
        () => this.selection?.active() ?? false,
        (direction) => {
          if (direction < 0) {
            this.follow = false
            this.captureAnchor()
          }
          onBoundary?.(direction)
        },
      )
    }
    if (this.host !== null && typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.resize())
      this.observer.observe(this.host)
    }
    this.resize()
  }

  async setContent(text: string, paneRows: number, paneCols = 0): Promise<void> {
    if (this.selection?.active() || this.scrollTimer !== null) {
      this.pendingContent = { text, rows: paneRows, cols: paneCols }
      return
    }
    const changed = text !== this.text || paneRows !== this.contentRows || paneCols !== this.contentCols
    if (!changed && this.usingKernel) return
    if (changed) {
      this.text = text
      this.contentRows = paneRows
      this.contentCols = paneCols
      this.revision += 1
      this.usingKernel = false
    }
    if (paneCols > 0 && !(await this.kernel.load())) {
      throw new Error("The terminal kernel is required to display native core output")
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
    const screen = await this.kernel.setContent(this.text, this.contentRows, this.contentCols)
    if (this.contentCols > 0 && screen === null) throw new Error("The native core screen could not be rendered")
    // Loading may finish after another pane or snapshot has replaced this one.
    if (revision !== this.revision) return
    this.usingKernel = screen !== null && !this.selection?.active() && this.scrollTimer === null
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
    if (this.selection?.active() || this.scrollTimer !== null) {
      if (this.text !== null)
        this.pendingContent ??= { text: this.text, rows: this.contentRows, cols: this.contentCols }
      return
    }
    this.captureAnchor()
    if (cols > 0 && cols !== this.paneCols) this.layoutDirty = true
    if (this.rows !== rows) {
      this.rows = rows
      this.layoutDirty = true
      this.iconFonts.load(rows.map((row) => row.map((cell) => cell.ch).join("")).join(""))
    }
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
    this.render(false)
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
    if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer)
    this.scrollTimer = null
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
        const fraction = this.host === null ? 0 : this.host.scrollTop / this.rowHeight - this.topRow
        this.anchorOffset = top - index + fraction
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
    // Even assigning the same offset cancels native smooth scrolling.
    if (Math.abs(host.scrollTop - row * this.rowHeight) > 0.5) host.scrollTop = row * this.rowHeight
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
    if (!restored && !this.follow) {
      if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer)
      // Replaying a full snapshot blocks scrolling and restoring its anchor cancels inertia.
      this.scrollTimer = window.setTimeout(() => {
        this.scrollTimer = null
        const pending = this.pendingContent
        this.pendingContent = null
        if (pending !== null) void this.setContent(pending.text, pending.rows, pending.cols)
      }, 120)
    }
    if (this.paintFrame !== null) return
    // Native scrolling owns the offset; paint its latest position once per frame.
    this.paintFrame = window.requestAnimationFrame(() => {
      this.paintFrame = null
      this.paint()
    })
  }

  render(force = true): void {
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

    // The surface carries history; the canvas retains a bounded strip around the viewport.
    this.rowHeight = this.cellHeight * scale
    const canvasHeight = Math.max(viewHeight, contentHeight * scale)
    this.canvas.style.width = `${this.mode === "shrink" ? viewWidth : Math.max(viewWidth, inset + contentWidth + inset)}px`
    if (host === null) this.canvas.style.height = `${canvasHeight}px`
    if (this.surface !== null) {
      this.surface.style.width = this.canvas.style.width
      this.surface.style.height = `${canvasHeight}px`
    }
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
        this.programmaticTop = host.scrollTop
        this.topRow = Math.max(0, this.laidOut.length - this.visibleRows())
      } else {
        this.restoreAnchor()
      }
    }

    this.paint(force)
  }

  private paint(force = false): void {
    if (this.paintFrame !== null) {
      window.cancelAnimationFrame(this.paintFrame)
      this.paintFrame = null
    }
    if (this.host !== null && (this.host.clientWidth <= 0 || this.host.clientHeight <= 0)) return
    const contentWidth = this.layoutCols * this.cellWidth
    const scale = this.mode === "shrink" && contentWidth > 0 ? Math.min(1, this.layoutWidth / contentWidth) : 1
    const scrollTop =
      this.host === null
        ? 0
        : this.viewport.update(
            this.canvas,
            this.host,
            this.rowHeight,
            Math.max(this.host.clientHeight, this.laidOut.length * this.rowHeight),
          )
    this.viewport.syncSize(this.canvas)
    this.painter.paint(
      this.canvas,
      this.context,
      this.laidOut,
      {
        scale,
        inset: this.host === null ? 0 : SCREEN_INSET,
        scrollTop,
        cellWidth: this.cellWidth,
        cellHeight: this.cellHeight,
        fontSize: this.fontSize,
        fontFamily: this.fontFamily,
        theme: this.theme,
      },
      force,
    )
  }

  size(): { cols: number; rows: number } {
    return { cols: this.paneCols, rows: this.paneRows }
  }
}
