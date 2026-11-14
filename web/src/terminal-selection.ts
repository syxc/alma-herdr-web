import type { Cell } from "./ansi.js"

function textLayer(canvas: HTMLCanvasElement): HTMLElement | null {
  return canvas.parentElement?.querySelector?.<HTMLElement>(".terminal-text") ?? null
}

export function terminalSelection(canvas: HTMLCanvasElement): Selection | null {
  const layer = textLayer(canvas)
  const selection = canvas.ownerDocument?.getSelection()
  if (layer === null || !selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  return range.intersectsNode(layer) ? selection : null
}

export function clearTerminalSelection(canvas: HTMLCanvasElement): void {
  terminalSelection(canvas)?.removeAllRanges()
}

export function selectTerminalText(canvas: HTMLCanvasElement): void {
  const layer = textLayer(canvas)
  if (layer === null) return
  const range = canvas.ownerDocument.createRange()
  range.selectNodeContents(layer)
  const selection = canvas.ownerDocument.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

interface TextMetrics {
  width: number
  cellWidth: number
  cellHeight: number
  fontSize: number
  fontFamily: string
  scale: number
  inset: number
}

interface SourceRange {
  start: number
  end: number
}

interface TextRun extends SourceRange {
  node: Text
  grapheme: boolean
}

/** Native selection sits over the painted cells; clipboard text uses source rows. */
export class TerminalSelection {
  readonly element: HTMLDivElement
  private readonly doc: Document
  private runs: TextRun[] = []
  private lines: { key: string; node: HTMLDivElement; runs: TextRun[]; cells: Cell[]; start: number; end: number }[] =
    []
  private source: Cell[][] = []
  private sourceLines: string[] = []
  private sourceOffsets: number[] = []
  private readonly positions = new WeakMap<Cell, SourceRange>()
  private sourceText = ""
  private rows: Cell[][] | null = null
  private metrics = ""
  private pointing = false
  private paused = false

  constructor(
    surface: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly changed: (paused: boolean) => void,
  ) {
    this.doc = canvas.ownerDocument
    this.element = this.doc.createElement("div")
    this.element.className = "terminal-text"
    this.element.tabIndex = 0
    this.element.setAttribute("role", "region")
    this.element.setAttribute("aria-label", "Terminal output; select text to copy")
    surface.append(this.element)
    this.element.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0) return
      this.pointing = true
      this.notify()
    })
    const release = () => {
      if (!this.pointing) return
      this.pointing = false
      // Native selection can finish after the pointer event default action.
      queueMicrotask(() => this.notify())
    }
    this.doc.addEventListener("pointerup", release)
    this.doc.addEventListener("pointercancel", release)
    this.doc.defaultView?.addEventListener("blur", release)
    this.doc.addEventListener("selectionchange", () => this.notify())
    this.doc.addEventListener("copy", (event) => {
      const text = this.selectedText()
      if (text === null || event.clipboardData === null) return
      event.clipboardData.setData("text/plain", text)
      event.preventDefault()
    })
  }

  active(): boolean {
    return this.pointing || terminalSelection(this.canvas) !== null
  }

  clear(): void {
    this.pointing = false
    clearTerminalSelection(this.canvas)
    this.notify()
  }

  private notify(): void {
    const paused = this.active()
    if (paused === this.paused) return
    this.paused = paused
    this.changed(paused)
  }

  selectedText(): string | null {
    const selection = terminalSelection(this.canvas)
    if (selection === null) return null
    const range = selection.getRangeAt(0)
    let start: number | null = null
    let end = 0
    for (const run of this.runs) {
      if (range.comparePoint(run.node, run.node.length) < 0 || range.comparePoint(run.node, 0) > 0) continue
      const from = range.startContainer === run.node ? range.startOffset : 0
      const to = range.endContainer === run.node ? range.endOffset : run.node.length
      if (from === to) continue
      // Native handles must not split a combining sequence or joined emoji.
      const low = run.grapheme ? 0 : from
      const high = run.grapheme ? run.node.length : to
      start ??= run.start + low
      end = Math.min(run.end, run.start + high)
    }
    return start === null ? "" : this.sourceText.slice(start, end)
  }

  update(rows: Cell[][], source: Cell[][], metrics: TextMetrics): void {
    const signature = JSON.stringify(metrics)
    if (this.rows === rows && this.metrics === signature) return
    this.rows = rows
    const metricsChanged = this.metrics !== signature
    this.metrics = signature
    const positions = this.positions
    const lines: string[] = []
    let offset = 0
    for (const [index, row] of source.entries()) {
      const unchanged = row === this.source[index]
      const text = unchanged
        ? (this.sourceLines[index] ?? "")
        : row
            .map((cell) => cell.ch)
            .join("")
            .replace(/\s+$/, "")
      lines.push(text)
      if (unchanged && this.sourceOffsets[index] === offset) {
        offset += text.length + 1
        continue
      }
      this.sourceOffsets[index] = offset
      let column = 0
      for (const cell of row) {
        if (cell.ch && column < text.length)
          positions.set(cell, { start: offset + column, end: offset + column + cell.ch.length })
        column += cell.ch.length
      }
      offset += text.length + 1
    }
    this.source = source
    this.sourceLines = lines
    this.sourceOffsets.length = source.length
    this.sourceText = lines.join("\n")
    this.runs = []
    const previous = this.lines
    this.lines = []
    for (const [index, cells] of rows.entries()) {
      const prior = previous[index]
      const firstCell = cells.find((cell) => positions.has(cell))
      const start = firstCell === undefined ? -1 : (positions.get(firstCell)?.start ?? -1)
      let sourceFinish = -1
      for (let column = cells.length - 1; column >= 0; column -= 1) {
        const cell = cells[column]
        const position = cell === undefined ? undefined : positions.get(cell)
        if (position === undefined) continue
        sourceFinish = position.end
        break
      }
      if (
        !metricsChanged &&
        prior !== undefined &&
        prior.start === start &&
        prior.end === sourceFinish &&
        prior.cells.length === cells.length &&
        cells.every((cell, column) => cell === prior.cells[column])
      ) {
        this.lines.push(prior)
        this.runs.push(...prior.runs)
        continue
      }
      let mapping = ""
      let last = -1
      for (const [column, cell] of cells.entries()) {
        const position = positions.get(cell)
        if (position === undefined) continue
        if (position.start !== last) mapping += `${column}:${position.start};`
        last = position.end
      }
      const key = `${cells.map((cell) => cell.ch || "\0").join("")}\u0001${mapping}${last}:${metrics.cellWidth * metrics.scale}`
      if (prior?.key === key) {
        prior.cells = cells
        prior.start = start
        prior.end = sourceFinish
        this.lines.push(prior)
        this.runs.push(...prior.runs)
        continue
      }
      const runs: TextRun[] = []
      const line = this.doc.createElement("div")
      line.className = "terminal-text-row"
      let end = cells.length
      while (end > 0 && (cells[end - 1]?.ch ?? "").trim() === "") end -= 1
      // A wide glyph retains its trailing column even though that cell has no text.
      if (cells[end]?.ch === "") end += 1
      for (let column = 0; column < end; ) {
        const cell = cells[column]
        if (cell === undefined || cell.ch === "") {
          column += 1
          continue
        }
        const position = positions.get(cell)
        let text = cell.ch
        let next = column + (cells[column + 1]?.ch === "" ? 2 : 1)
        let sourceEnd = position?.end ?? -1
        if (/^[\x20-\x7e]$/.test(text)) {
          while (next < end) {
            const candidate = cells[next]
            const point = candidate === undefined ? undefined : positions.get(candidate)
            if (candidate === undefined || !/^[\x20-\x7e]$/.test(candidate.ch) || point?.start !== sourceEnd) break
            text += candidate.ch
            sourceEnd = point.end
            next += 1
          }
        }
        const span = this.doc.createElement("span")
        span.style.width = `${(next - column) * metrics.cellWidth * metrics.scale}px`
        span.textContent = text
        line.append(span)
        if (position !== undefined) {
          runs.push({
            node: span.firstChild as Text,
            start: position.start,
            end: sourceEnd,
            grapheme: !/^[\x20-\x7e]+$/.test(text),
          })
        }
        column = next
      }
      this.lines.push({ key, node: line, runs, cells, start, end: sourceFinish })
      this.runs.push(...runs)
      if (prior === undefined) this.element.append(line)
      else prior.node.replaceWith(line)
    }
    for (let index = rows.length; index < previous.length; index += 1) previous[index]?.node.remove()
    const style = this.element.style
    style.left = `${metrics.inset}px`
    style.width = `${metrics.width * metrics.scale}px`
    style.font = `${metrics.fontSize * metrics.scale}px / ${metrics.cellHeight * metrics.scale}px ${metrics.fontFamily}`
    style.setProperty("--terminal-line-height", `${metrics.cellHeight * metrics.scale}px`)
  }
}
