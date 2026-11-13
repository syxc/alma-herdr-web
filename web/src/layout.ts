import type { Cell, Grid } from "./ansi.js"

const EMPTY_STYLE = {
  fg: "",
  bg: "",
  bold: false,
  italic: false,
  dim: false,
  underline: false,
  reverse: false,
}
const MARKER = /^(?:[⏺●•◦▪‣▸❯]|[-*+]|\d+[.)]|⎿)\s+/u
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const NO_START = /^[，。！？、；：）】》〉」』〕〗〙〛…％,.!?;:%)\]}»”’]/u
const NO_END = /[（【《〈「『〔〖〘〚([{«“‘]$/u
const RULE_CHARS = new Set(["=", "-", "_", "*", "#"])

function blank(): Cell {
  return { ch: " ", style: { ...EMPTY_STYLE } }
}

function isBlank(cell: Cell | undefined): boolean {
  return cell === undefined || (cell.ch === " " && cell.style.bg === "" && !cell.style.underline && !cell.style.reverse)
}

function text(cells: Cell[]): string {
  return cells.map((cell) => cell.ch).join("")
}

interface Row {
  cells: Cell[]
  indent: number
  hanging: number
  structured: boolean
  fence: string
}

function prepareRow(cells: Cell[]): Cell[] {
  let end = cells.length
  while (end > 0 && isBlank(cells[end - 1])) end -= 1
  const row = cells.slice(0, end)
  // Only a recognised status row may compact the gap between its fields.
  // Code, tables and arbitrary prose must retain their original spaces.
  if (!/^\s*●\s+.*(?:\$\d|\b\d+(?:ms|s|m)\b).*\s{8,}\S/u.test(text(row))) return row
  const out: Cell[] = []
  let run: Cell[] = []
  for (const cell of row) {
    if (isBlank(cell)) {
      run.push(cell)
      continue
    }
    out.push(...(out.length > 0 && run.length >= 8 ? run.slice(0, 2) : run), cell)
    run = []
  }
  out.push(...run)
  return out
}

function prepare(cells: Cell[], width: number): Row {
  let row = prepareRow(cells)
  if (row.length > width && isRule(row)) row = row.slice(0, width)
  let indent = 0
  while (indent < row.length && isBlank(row[indent])) indent += 1
  const body = text(row.slice(indent))
  const prefix = MARKER.exec(body)?.[0] ?? ""
  let hanging = indent
  let prefixLength = 0
  while (hanging < row.length && prefixLength < prefix.length) {
    prefixLength += row[hanging]?.ch.length ?? 0
    hanging += 1
  }
  const content = body.slice(prefix.length)
  const structured =
    /^(?:[|│┌┐└┘├┤╭╮╰╯{}[\]]|@@|---|\+\+\+|(?:const|let|var|function|class|import|export|return|def|if|else|for|while|fn|pub|func)\b)/u.test(
      content,
    ) || /(?:\s{2,}\S|\s[|│]\s|=>|[{};]\s*$)/u.test(content)
  return { cells: row, indent, hanging, structured, fence: /^(`{3,}|~{3,})/u.exec(body)?.[0] ?? "" }
}

function previousGlyph(cells: Cell[], end: number): number {
  let index = end - 1
  while (index > 0 && cells[index]?.ch === "") index -= 1
  return index
}

function canBreak(cells: Cell[], at: number): boolean {
  const left = cells[previousGlyph(cells, at)]?.ch ?? ""
  const right = cells[at]?.ch ?? ""
  if (!left || !right || NO_START.test(right) || NO_END.test(left)) return false
  if (/[\u00a0\u202f\u2060\ufeff]/u.test(left + right)) return false
  return CJK.test(left) || CJK.test(right)
}

/** Wrap at word or CJK boundaries without separating a glyph from its tail cell. */
function wrap(cells: Cell[], width: number, hanging: number, leading: number, preserveSpaces = false): Cell[][] {
  if (cells.length <= width) return [cells]
  let end = cells.length
  const padding = cells[end - 1]
  if (padding?.ch === " " && padding.style.bg && !padding.style.underline && !padding.style.reverse) {
    while (end > 0) {
      const cell = cells[end - 1]
      if (cell?.ch !== " " || cell.style.bg !== padding.style.bg || cell.style.underline || cell.style.reverse) break
      end -= 1
    }
    // A screen-wide fill is decoration, not more text to wrap onto empty rows.
    const rows = end === 0 ? [[]] : wrap(cells.slice(0, end), width, hanging, leading, preserveSpaces)
    return rows.map((row) => row.concat(Array.from({ length: width - row.length }, () => ({ ...padding }))))
  }
  const lines: Cell[][] = []
  // A desktop indent can consume the entire phone. Keep room for actual text.
  const maxIndent = Math.max(0, Math.min(Math.floor(width / 3), width - 2))
  const firstIndent = Math.min(leading, maxIndent)
  const continuation = Math.min(hanging, maxIndent)
  const content = cells.slice(leading)
  let start = 0
  while (start < content.length) {
    const indent = lines.length === 0 ? firstIndent : continuation
    const limit = width - indent
    let end = Math.min(content.length, start + limit)
    if (content[end]?.ch === "") end -= 1
    if (end === start) end = Math.min(content.length, start + 2)
    let next = end
    if (end < content.length) {
      for (let at = end; at >= start; at -= 1) {
        const separator = content[at]
        if (at === start && isBlank(separator)) continue
        if (separator?.ch === " ") {
          const backgroundSeparator =
            separator.style.bg !== "" &&
            !separator.style.underline &&
            !separator.style.reverse &&
            separator.style.bg === content[at - 1]?.style.bg &&
            separator.style.bg === content[at + 1]?.style.bg
          if ((isBlank(separator) || backgroundSeparator) && !preserveSpaces) {
            end = at
            next = at + 1
          } else {
            // Styled blanks are visible content, including at the right edge.
            end = at < end ? at + 1 : at
            next = end
          }
          break
        }
        if (at > start && canBreak(content, at)) {
          end = at
          next = at
          break
        }
      }
    }
    lines.push(Array.from({ length: indent }, blank).concat(content.slice(start, end)))
    start = next
  }
  return lines.length > 0 ? lines : [cells]
}

function isRule(cells: Cell[]): boolean {
  let mark = ""
  for (const cell of cells) {
    if (isBlank(cell)) continue
    if (mark === "") mark = cell.ch
    else if (cell.ch !== mark) return false
  }
  const point = mark.codePointAt(0) ?? 0
  return (point >= 0x2500 && point <= 0x257f) || RULE_CHARS.has(mark)
}

function startsProse(value: string): boolean {
  return CJK.test(value[0] ?? "") || NO_START.test(value) || /^[A-Za-z0-9]/u.test(value)
}

function continuesProse(previous: Row | null, row: Row): boolean {
  if (previous === null || previous.structured || row.structured || previous.fence || row.fence) return false
  if (previous.indent !== row.indent || previous.hanging !== previous.indent || row.hanging !== row.indent) return false
  const left = text(previous.cells).trim()
  const right = text(row.cells).trimStart()
  // Long CJK prose is also hard-wrapped by CLI renderers. A blank row, a
  // sentence ending, or structured content remains a paragraph boundary.
  return (
    previous.cells.length >= 40 &&
    startsProse(left) &&
    startsProse(right) &&
    CJK.test(left) &&
    CJK.test(right) &&
    !/[。！？.!?]$/u.test(left)
  )
}

/** Reflow recognised prose continuations; snapshots do not carry soft-wrap flags. */
export function layoutGrid(grid: Grid, width: number): Grid {
  if (width <= 0) return grid
  width = Math.max(1, Math.floor(width))
  const rows = grid.cells.map((cells) => prepare(cells, width))
  if (grid.cols <= width && !rows.some((row, index) => continuesProse(rows[index - 1] ?? null, row))) return grid
  const out: Cell[][] = []
  let current: Cell[] = []
  let hanging = 0
  let base = 0
  let joins = false
  let fence = ""
  let previous: Row | null = null
  const flush = (): void => {
    if (current.length === 0) return
    out.push(...wrap(current, width, hanging, base))
    current = []
  }
  for (const row of rows) {
    if (row.cells.length === 0) {
      flush()
      out.push([])
      joins = false
      previous = null
      continue
    }
    if (row.fence || fence || row.structured) {
      flush()
      out.push(...wrap(row.cells, width, row.indent, row.indent, true))
      if (row.fence) {
        if (!fence) fence = row.fence
        else if (row.fence[0] === fence[0] && row.fence.length >= fence.length) fence = ""
      }
      joins = false
      previous = null
      continue
    }
    const continues =
      (joins && row.indent > base && row.indent === hanging && row.hanging === row.indent) ||
      continuesProse(previous, row)
    previous = row
    if (continues) {
      const rest = row.cells.slice(row.indent)
      const left = current[previousGlyph(current, current.length)]?.ch ?? ""
      const right = rest[0]?.ch ?? ""
      // CJK source rows have no word separator; do not invent spaces in a sentence.
      const cjkJoin = (CJK.test(left) || /[，。！？、；：）】》」』]/u.test(left)) && CJK.test(right)
      if (!cjkJoin && !NO_START.test(right) && !NO_END.test(left)) current.push(blank())
      current.push(...rest)
      continue
    }
    flush()
    current = row.cells.slice()
    hanging = row.hanging
    base = row.indent
    joins = hanging > base
  }
  flush()
  return { cols: width, rows: out.length, cells: out }
}
