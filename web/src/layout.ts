import type { Cell, Grid } from "./ansi.js"

/**
 * Lays a screen out for a view that is narrower than the screen.
 *
 * herdr renders the pane on the desktop, so the screen arrives with the
 * columns of that screen, a hundred and twenty nine of them for a normal
 * pane. A phone fits half as many at a readable size. The screen is put
 * together again for the narrow view: the lines a terminal wrapped itself
 * are joined, the text keeps the indent the terminal gave it, and the
 * result is wrapped again at the width of the view. The text keeps the size
 * it has, nothing is scaled down.
 */

const EMPTY_STYLE = {
  fg: "",
  bg: "",
  bold: false,
  italic: false,
  dim: false,
  underline: false,
  reverse: false,
}

function blank(): Cell {
  return { ch: " ", style: { ...EMPTY_STYLE } }
}

function isBlank(cell: Cell | undefined): boolean {
  return cell === undefined || (cell.ch === " " && cell.style.bg === "" && !cell.style.underline && !cell.style.reverse)
}

/**
 * A row of the screen, with the indent of its text.
 */
interface Row {
  cells: Cell[]
  /** The blank columns in front of the text. */
  indent: number
  /** The column where the text starts, the indent of a wrapped line. */
  hanging: number
}

/**
 * The column where the text of a row starts.
 *
 * A terminal indents the lines it wraps itself: the text of a bullet
 * starts behind the bullet, the text of a tree entry behind the branch.
 * The column of the first letter is that indent.
 */
function textColumn(cells: Cell[], indent: number): number {
  for (let index = indent; index < cells.length && index <= indent + 6; index += 1) {
    const cell = cells[index]
    if (cell === undefined) {
      break
    }
    const ch = cell.ch
    if (ch.length > 0 && /[A-Za-z0-9]/.test(ch)) {
      return index
    }
  }
  return indent
}

/**
 * The cells of a row without the blank columns at its end, with the long
 * runs of blanks inside it shortened.
 *
 * A status bar puts its parts apart with a long run of blanks, which would
 * push the last part off the screen.
 */
function prepareRow(cells: Cell[]): Cell[] {
  let end = cells.length
  while (end > 0 && isBlank(cells[end - 1])) {
    end -= 1
  }
  const row = cells.slice(0, end)
  const out: Cell[] = []
  let run = 0
  for (const cell of row) {
    if (isBlank(cell)) {
      run += 1
      continue
    }
    if (run > 0) {
      // The indent in front of the text stays as it is.
      const keep = out.length === 0 ? run : run >= 8 ? 2 : run
      for (let index = 0; index < keep; index += 1) {
        out.push(blank())
      }
      run = 0
    }
    out.push(cell)
  }
  for (let index = 0; index < run; index += 1) {
    out.push(blank())
  }
  return out
}

/**
 * Wraps the cells of a text into lines of the given width.
 *
 * The first line uses the whole width, the lines after it are indented by
 * the hanging indent, the way the terminal indents the lines it wraps.
 */
function wrap(cells: Cell[], width: number, hanging: number): Cell[][] {
  const lines: Cell[][] = []
  let start = 0
  while (start < cells.length) {
    // Leave room for a wide glyph even when the desktop indent is very deep.
    const indent = lines.length === 0 ? 0 : Math.min(hanging, Math.max(0, width - 2))
    const limit = width - indent
    let end = Math.min(cells.length, start + limit)
    let next = end
    if (end < cells.length) {
      // A wide glyph and its trailing column must move together.
      if (cells[end]?.ch === "") end -= 1
      if (end === start) end = Math.min(cells.length, start + 2)
      next = end
      for (let index = end; index >= start; index -= 1) {
        const separator = cells[index]
        if (index === start && isBlank(separator)) continue
        if (separator?.ch === " ") {
          if (isBlank(separator)) {
            end = index
            next = index + 1
          } else {
            // Keep a visible separator on either side of the word boundary.
            end = index < start + limit ? index + 1 : index
            next = end
          }
          break
        }
      }
    }
    const padding = Array.from({ length: indent }, blank)
    lines.push(padding.concat(cells.slice(start, end)))
    start = next
  }
  return lines
}

/**
 * The characters a program draws a line with.
 */
const RULE_CHARS = new Set(["=", "-", "_", "*", "#"])

function isRuleCharacter(ch: string): boolean {
  const point = ch.codePointAt(0)
  if (point === undefined) {
    return false
  }
  // The box drawing characters, the lines of a tree or a table.
  if (point >= 0x2500 && point <= 0x257f) {
    return true
  }
  return RULE_CHARS.has(ch)
}

/**
 * A row that is one character repeated, the line a program draws to divide
 * the screen.
 *
 * A terminal wraps such a line, but the program that drew it would have
 * drawn it again for the narrower screen, so the line is cut to the width of
 * the view instead of being folded into several lines.
 */
function isRule(cells: Cell[]): boolean {
  let mark = ""
  for (const cell of cells) {
    if (isBlank(cell)) {
      continue
    }
    if (mark === "") {
      mark = cell.ch
      continue
    }
    if (cell.ch !== mark) {
      return false
    }
  }
  return mark.length > 0 && isRuleCharacter(mark)
}

/**
 * Lays the screen out for a view of the given width.
 *
 * A screen that fits stays as it is.
 */
export function layoutGrid(grid: Grid, width: number): Grid {
  if (width <= 0 || grid.cols <= width) {
    return grid
  }

  const rows: Row[] = grid.cells.map((cells) => {
    let prepared = prepareRow(cells)
    if (prepared.length > width && isRule(prepared)) {
      prepared = prepared.slice(0, width)
    }
    let indent = 0
    while (indent < prepared.length && isBlank(prepared[indent])) {
      indent += 1
    }
    return {
      cells: prepared,
      indent,
      hanging: textColumn(prepared, indent),
    }
  })

  const out: Cell[][] = []
  let current: Cell[] = []
  let hanging = 0
  let base = 0

  const flush = (): void => {
    if (current.length === 0) {
      return
    }
    for (const line of wrap(current, width, hanging)) {
      out.push(line)
    }
    current = []
  }

  for (const row of rows) {
    // A line the terminal wrapped itself is indented deeper than the text
    // it belongs to, and it starts at the column the text of that line
    // starts at.
    const continues = current.length > 0 && row.cells.length > 0 && row.indent > base && row.indent === hanging
    if (continues) {
      current.push(blank(), ...row.cells.slice(row.indent))
      continue
    }
    flush()
    current = row.cells.slice()
    hanging = row.hanging
    base = row.indent
  }
  flush()

  return { cols: width, rows: out.length, cells: out }
}
