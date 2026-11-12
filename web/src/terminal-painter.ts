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

/** Paint only the rows covered by the viewport-sized backing store. */
export function paintTerminal(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  cells: Cell[][],
  metrics: PaintMetrics,
): void {
  const { scale, inset, scrollTop, cellWidth, cellHeight, fontSize, fontFamily, theme } = metrics
  const ratio = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.globalAlpha = 1
  ctx.fillStyle = TERMINAL_COLORS[theme].background
  ctx.fillRect(0, 0, rect.width, rect.height)

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
    const key = `${style.fg};${style.bg};${style.reverse}`
    let colors = colorCache.get(key)
    if (colors === undefined) {
      colors = cellColors(style, theme)
      colorCache.set(key, colors)
    }
    return colors
  }

  // Paint backgrounds first so the trailing cell never erases a wide glyph.
  for (let row = first; row < last; row += 1) {
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
      ctx.globalAlpha = style.dim ? 0.6 : 1
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
