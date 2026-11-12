import { type Cell, type Grid, parseAnsi } from "./ansi.js"
import { IconFontLoader } from "./icon-font.js"
import { layoutGrid } from "./layout.js"
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
  private background = TERMINAL_COLORS.dark.background
  private foreground = TERMINAL_COLORS.dark.foreground
  private mode: FitMode = "wrap"
  private observer: ResizeObserver | null = null
  // Pause auto-follow while the reader is above the latest output.
  private follow = true
  private topRow = 0
  // Anchor by text because newer snapshots can shift every row.
  private anchorText = ""
  private anchorIndex = 0
  private anchorOffset = 0
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
    this.foreground = colors.foreground
    this.background = colors.background
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
    if (this.host !== null) {
      this.host.classList.toggle("scroll-x", mode === "original")
      if (mode !== "original") this.host.scrollLeft = 0
    }
    this.canvas.style.touchAction = mode === "original" ? "auto" : "pan-y"
    this.render()
  }

  followBottom(): void {
    this.follow = true
    this.anchorText = ""
    const host = this.host
    if (host !== null) {
      host.scrollTop = host.scrollHeight
    }
  }

  private captureAnchor(): void {
    if (this.follow) {
      return
    }
    const top = Math.min(this.topRow, Math.max(0, this.laidOut.length - 1))
    for (let index = top; index >= 0; index -= 1) {
      const text = rowText(this.laidOut[index] ?? [])
      if (text.length > 0) {
        this.anchorText = text
        this.anchorIndex = index
        this.anchorOffset = top - index
        return
      }
    }
    this.anchorText = ""
    this.anchorOffset = 0
  }

  private restoreAnchor(): void {
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
    this.topRow = row
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
    this.topRow = Math.round(host.scrollTop / this.rowHeight)
    this.follow = this.topRow + this.visibleRows() >= this.laidOut.length - 1
    if (this.snapTimer !== null) {
      window.clearTimeout(this.snapTimer)
    }
    this.snapTimer = window.setTimeout(() => {
      this.snapTimer = null
      this.snap()
    }, 140)
  }

  private snap(): void {
    const host = this.host
    if (host === null || this.rowHeight === 0) {
      return
    }
    const row = Math.round(host.scrollTop / this.rowHeight)
    const target = row * this.rowHeight
    if (Math.abs(host.scrollTop - target) < 0.5) {
      return
    }
    host.scrollTop = target
  }

  render(): void {
    const ctx = this.context
    const ratio = window.devicePixelRatio || 1
    const host = this.host
    const viewWidth = host === null ? 0 : host.clientWidth
    const viewHeight = host === null ? 0 : host.clientHeight

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.font = `${this.fontSize}px ${this.fontFamily}`
    // A cell is as wide as the widest letter of the font, the way a
    // terminal measures it.
    if (this.layoutWidth < 0) this.cellWidth = Math.max(1, ctx.measureText("W").width)
    this.cellHeight = Math.round(this.fontSize * 1.35)

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

    // The canvas covers the view and grows with the content, so the view
    // scrolls down when the screen is taller than it. A little room is added
    // below the last line, so the view scrolls to a whole line and never
    // shows half a line at the top.
    const lineHeight = this.cellHeight * scale
    this.rowHeight = lineHeight
    const content = contentHeight * scale
    let canvasHeight = Math.max(viewHeight, content)
    if (content > viewHeight && lineHeight > 0) {
      const pad = (lineHeight - ((content - viewHeight) % lineHeight)) % lineHeight
      canvasHeight = content + pad
    }
    this.canvas.style.width = `${this.mode === "shrink" ? viewWidth : Math.max(viewWidth, inset + contentWidth + inset)}px`
    this.canvas.style.height = `${canvasHeight}px`
    this.syncSize()

    if (host !== null) {
      if (this.follow) {
        // The newest line stays in sight while the reader stays at the bottom.
        host.scrollTop = host.scrollHeight
        this.topRow = Math.max(0, this.laidOut.length - this.visibleRows())
      } else {
        this.restoreAnchor()
      }
    }

    const rect = this.canvas.getBoundingClientRect()
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.globalAlpha = 1
    ctx.fillStyle = this.background
    ctx.fillRect(0, 0, rect.width, rect.height)

    ctx.setTransform(ratio * scale, 0, 0, ratio * scale, 0, 0)
    // The margin of the screen is kept in CSS pixels, the text inside it
    // is the thing that gets scaled.
    ctx.translate(inset / scale, 0)
    const rows = this.laidOut.length
    const cols = this.layoutCols
    if (rows === 0 || cols === 0) {
      return
    }

    // Paint backgrounds first so the trailing cell never erases a wide glyph.
    for (let row = 0; row < rows; row += 1) {
      const line = this.laidOut[row] ?? []
      for (let column = 0; column < line.length; column += 1) {
        const style = line[column]?.style
        if (style === undefined) continue
        const background = style.reverse ? style.fg || this.foreground : style.bg
        if (background.length > 0) {
          ctx.fillStyle = background
          ctx.fillRect(column * this.cellWidth, row * this.cellHeight, this.cellWidth, this.cellHeight)
        }
      }
    }
    let font = ""
    for (let row = 0; row < rows; row += 1) {
      const line = this.laidOut[row] ?? []
      for (let column = 0; column < line.length; column += 1) {
        const cell = line[column]
        if (cell === undefined) {
          continue
        }
        const x = column * this.cellWidth
        const y = row * this.cellHeight
        const style = cell.style
        const reversed = style.reverse
        const foreground = reversed ? style.bg || this.background : style.fg || this.foreground
        if (cell.ch.length === 0) continue
        ctx.globalAlpha = style.dim ? 0.6 : 1
        ctx.fillStyle = foreground
        const nextFont = `${(style.bold ? "bold " : "") + (style.italic ? "italic " : "") + this.fontSize}px ${this.fontFamily}`
        if (font !== nextFont) {
          ctx.font = nextFont
          font = nextFont
        }
        if (cell.ch !== " ") ctx.fillText(cell.ch, x, y + this.fontSize)
        if (style.underline) {
          const width = line[column + 1]?.ch === "" ? this.cellWidth * 2 : this.cellWidth
          ctx.fillRect(x, y + this.fontSize + 1, width, 1)
        }
      }
    }
    ctx.globalAlpha = 1
  }

  size(): { cols: number; rows: number } {
    return { cols: this.paneCols, rows: this.paneRows }
  }
}
