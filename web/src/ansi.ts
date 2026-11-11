/**
 * Parser for the ANSI text herdr returns from pane.read.
 *
 * herdr emulates the terminal on its own side, so what arrives here is a
 * rendered screen: the layout is already applied and the only escape
 * sequences left are SGR attributes. Parsing them into a cell grid is
 * therefore enough to draw the pane faithfully.
 */

export interface CellStyle {
  fg: string
  bg: string
  bold: boolean
  italic: boolean
  dim: boolean
  underline: boolean
  reverse: boolean
}

export interface Cell {
  ch: string
  style: CellStyle
}

export interface Grid {
  cols: number
  rows: number
  cells: Cell[][]
}

const BASE_COLORS = [
  "#1c1f24",
  "#e05252",
  "#4fb56a",
  "#c9a227",
  "#4a90d9",
  "#a86fd6",
  "#3fa8a8",
  "#c8ccd4",
  "#5a6270",
  "#ff6b6b",
  "#7fd98a",
  "#f0d264",
  "#7cb8f0",
  "#cf9cf0",
  "#6fdede",
  "#f2f4f8",
]

function defaultStyle(): CellStyle {
  return {
    fg: "",
    bg: "",
    bold: false,
    italic: false,
    dim: false,
    underline: false,
    reverse: false,
  }
}

export function xterm256(index: number): string {
  if (index < 0 || index > 255) {
    return ""
  }
  if (index < 16) {
    return BASE_COLORS[index] ?? ""
  }
  if (index < 232) {
    const n = index - 16
    const r = Math.floor(n / 36)
    const g = Math.floor((n % 36) / 6)
    const b = n % 6
    const scale = (value: number): number => (value === 0 ? 0 : 55 + value * 40)
    return rgb(scale(r), scale(g), scale(b))
  }
  const level = 8 + (index - 232) * 10
  return rgb(level, level, level)
}

export function rgb(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`
}

/**
 * Applies one SGR parameter list to a style.
 */
function applySgr(style: CellStyle, params: number[]): void {
  if (params.length === 0) {
    params = [0]
  }
  let index = 0
  while (index < params.length) {
    const code = params[index] ?? 0
    if (code === 0) {
      Object.assign(style, defaultStyle())
    } else if (code === 1) {
      style.bold = true
    } else if (code === 2) {
      style.dim = true
    } else if (code === 3) {
      style.italic = true
    } else if (code === 4) {
      style.underline = true
    } else if (code === 7) {
      style.reverse = true
    } else if (code === 22) {
      style.bold = false
      style.dim = false
    } else if (code === 23) {
      style.italic = false
    } else if (code === 24) {
      style.underline = false
    } else if (code === 27) {
      style.reverse = false
    } else if (code >= 30 && code <= 37) {
      style.fg = BASE_COLORS[code - 30] ?? ""
    } else if (code === 39) {
      style.fg = ""
    } else if (code >= 40 && code <= 47) {
      style.bg = BASE_COLORS[code - 40] ?? ""
    } else if (code === 49) {
      style.bg = ""
    } else if (code >= 90 && code <= 97) {
      style.fg = BASE_COLORS[code - 90 + 8] ?? ""
    } else if (code >= 100 && code <= 107) {
      style.bg = BASE_COLORS[code - 100 + 8] ?? ""
    } else if (code === 38 || code === 48) {
      const mode = params[index + 1] ?? 0
      let color = ""
      if (mode === 5) {
        color = xterm256(params[index + 2] ?? 0)
        index += 2
      } else if (mode === 2) {
        color = rgb(params[index + 2] ?? 0, params[index + 3] ?? 0, params[index + 4] ?? 0)
        index += 4
      }
      if (color.length > 0) {
        if (code === 38) {
          style.fg = color
        } else {
          style.bg = color
        }
      }
    }
    index += 1
  }
}

function parseParams(raw: string): number[] {
  const parts = raw.split(";")
  const out: number[] = []
  for (const part of parts) {
    if (part.length === 0) {
      out.push(0)
      continue
    }
    const value = Number.parseInt(part, 10)
    out.push(Number.isFinite(value) ? value : 0)
  }
  return out
}

/**
 * Turns herdr's ANSI text into a grid of styled cells.
 */
export function parseAnsi(text: string): Grid {
  const rows: Cell[][] = []
  let row: Cell[] = []
  const style = defaultStyle()
  let column = 0

  const pushRow = (): void => {
    rows.push(row)
    row = []
    column = 0
  }

  const put = (ch: string): void => {
    if (column < row.length) {
      // Carriage return or backspace moved the cursor onto an existing cell.
      row[column] = { ch, style: { ...style } }
    } else {
      while (row.length < column) {
        row.push({ ch: " ", style: defaultStyle() })
      }
      row.push({ ch, style: { ...style } })
    }
    column += 1
  }

  let index = 0
  while (index < text.length) {
    const ch = text[index] ?? ""
    if (ch === "\u001b" && text[index + 1] === "[") {
      let end = index + 2
      while (end < text.length && !/[A-Za-z]/.test(text[end] ?? "")) {
        end += 1
      }
      const final = text[end] ?? ""
      if (final === "m") {
        applySgr(style, parseParams(text.substring(index + 2, end)))
      }
      index = end + 1
      continue
    }
    if (ch === "\n") {
      pushRow()
      index += 1
      continue
    }
    if (ch === "\r") {
      column = 0
      index += 1
      continue
    }
    if (ch === "\b") {
      column = Math.max(0, column - 1)
      index += 1
      continue
    }
    if (ch === "\t") {
      const next = Math.floor(column / 8 + 1) * 8
      while (column < next) {
        put(" ")
      }
      index += 1
      continue
    }
    if (ch === "\u0007") {
      index += 1
      continue
    }
    put(ch)
    index += 1
  }
  rows.push(row)

  let cols = 0
  for (const line of rows) {
    if (line.length > cols) {
      cols = line.length
    }
  }
  for (const line of rows) {
    while (line.length < cols) {
      line.push({ ch: " ", style: defaultStyle() })
    }
  }
  return { cols, rows: rows.length, cells: rows }
}

/**
 * Plain text of a grid, used for copying and for the agent transcript view.
 */
export function gridToText(grid: Grid): string {
  const lines: string[] = []
  for (const line of grid.cells) {
    let text = ""
    for (const cell of line) {
      text += cell.ch
    }
    lines.push(text.replace(/\s+$/, ""))
  }
  return lines.join("\n")
}
