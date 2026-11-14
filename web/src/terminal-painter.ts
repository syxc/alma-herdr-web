import type { Cell } from "./ansi.js"
import { cellColors, TERMINAL_COLORS, type Theme } from "./terminal-theme.js"

interface PaintMetrics {
  scale: number
  inset: number
  scrollTop: number
  cellWidth: number
  cellHeight: number
  fontSize: number
  fontFamily: string
  theme: Theme
}

function sameRow(left: Cell[] | undefined, right: Cell[] | undefined): boolean {
  if (left === right) return true
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false
  return (left ?? []).every((cell, index) => {
    const old = right?.[index]
    if (cell === old) return true
    if (old === undefined || cell.ch !== old.ch) return false
    const a = cell.style
    const b = old.style
    return (
      a.fg === b.fg &&
      a.bg === b.bg &&
      a.bold === b.bold &&
      a.italic === b.italic &&
      a.dim === b.dim &&
      a.underline === b.underline &&
      a.reverse === b.reverse
    )
  })
}

/** Retain unchanged pixels while the viewport, font and theme stay fixed. */
export class TerminalPainter {
  private previous: { signature: string; rows: Cell[][] } | null = null

  paint(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    rows: Cell[][],
    metrics: PaintMetrics,
    force = false,
  ): void {
    const rect = canvas.getBoundingClientRect()
    const signature = JSON.stringify([
      metrics,
      rect.width,
      rect.height,
      canvas.width,
      canvas.height,
      window.devicePixelRatio,
    ])
    const previous = this.previous
    let dirty: Set<number> | undefined
    if (!force && previous?.signature === signature) {
      dirty = new Set()
      const height = metrics.cellHeight * metrics.scale
      const first = Math.floor(metrics.scrollTop / height)
      const last = Math.ceil((metrics.scrollTop + rect.height) / height)
      for (let index = first; index < last; index += 1) {
        if (sameRow(rows[index], previous.rows[index])) continue
        // Neighbours share glyph overhangs, so repaint them together.
        for (let row = Math.max(first, index - 1); row <= Math.min(last - 1, index + 1); row += 1) dirty.add(row)
      }
    }
    this.previous = { signature, rows }
    if (dirty?.size === 0) return
    const ratio = window.devicePixelRatio || 1
    // Clearing a fractional pixel edge blends over retained pixels differently from a full repaint.
    if (!Number.isInteger(metrics.cellHeight * metrics.scale * ratio) || !Number.isInteger(metrics.scrollTop * ratio)) {
      dirty = undefined
    }
    paintTerminal(canvas, ctx, rows, metrics, dirty)
  }
}

/** Paint only the rows covered by the bounded backing store. */
export function paintTerminal(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  cells: Cell[][],
  metrics: PaintMetrics,
  dirty?: Set<number>,
): void {
  const { scale, inset, scrollTop, cellWidth, cellHeight, fontSize, fontFamily, theme } = metrics
  const ratio = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.globalAlpha = 1
  ctx.fillStyle = TERMINAL_COLORS[theme].background
  if (dirty === undefined) ctx.fillRect(0, 0, rect.width, rect.height)
  else
    for (const row of dirty) {
      ctx.fillRect(0, row * cellHeight * scale - scrollTop, rect.width, cellHeight * scale)
    }

  ctx.setTransform(ratio * scale, 0, 0, ratio * scale, 0, 0)
  // The margin of the screen is kept in CSS pixels, the text inside it
  // is the thing that gets scaled.
  ctx.translate(inset / scale, 0)
  const rows = cells.length
  if (rows === 0) {
    return
  }

  const first = Math.max(0, Math.floor(scrollTop / (cellHeight * scale)))
  const last = Math.min(rows, Math.ceil((scrollTop + rect.height) / (cellHeight * scale)))
  const colorCache = new Map<string, ReturnType<typeof cellColors>>()
  const colorsFor = (style: Cell["style"]) => {
    const key = `${style.fg};${style.bg};${style.reverse};${style.dim}`
    let colors = colorCache.get(key)
    if (colors === undefined) {
      colors = cellColors(style, theme)
      colorCache.set(key, colors)
    }
    return colors
  }

  // Paint backgrounds first so the trailing cell never erases a wide glyph.
  for (let row = first; row < last; row += 1) {
    if (dirty !== undefined && !dirty.has(row)) continue
    const line = cells[row] ?? []
    let start = 0
    let background = ""
    // Fractional cell widths create seams when one solid fill is painted cell by cell.
    for (let column = 0; column <= line.length; column += 1) {
      const style = line[column]?.style
      const next = style === undefined ? "" : colorsFor(style).background
      if (next === background) continue
      if (background.length > 0) {
        ctx.fillStyle = background
        ctx.fillRect(start * cellWidth, row * cellHeight - scrollTop / scale, (column - start) * cellWidth, cellHeight)
      }
      start = column
      background = next
    }
  }
  let font = ""
  for (let row = first; row < last; row += 1) {
    if (dirty !== undefined && !dirty.has(row)) continue
    const line = cells[row] ?? []
    for (let column = 0; column < line.length; column += 1) {
      const cell = line[column]
      if (cell === undefined) {
        continue
      }
      const x = column * cellWidth
      const y = row * cellHeight - scrollTop / scale
      const style = cell.style
      const foreground = colorsFor(style).foreground
      if (cell.ch.length === 0) continue
      ctx.globalAlpha = 1
      ctx.fillStyle = foreground
      const nextFont = `${(style.bold ? "bold " : "") + (style.italic ? "italic " : "") + fontSize}px ${fontFamily}`
      if (font !== nextFont) {
        ctx.font = nextFont
        font = nextFont
      }
      if (cell.ch !== " ") ctx.fillText(cell.ch, x, y + fontSize)
      if (style.underline) {
        const width = line[column + 1]?.ch === "" ? cellWidth * 2 : cellWidth
        ctx.fillRect(x, y + fontSize + 1, width, 1)
      }
    }
  }
  ctx.globalAlpha = 1
}
