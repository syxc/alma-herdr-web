import type { Cell, CellStyle } from "./ansi.js"
import { withTimeout } from "./deadline.js"
import { GhosttyKernel, type VtCell } from "./ghostty-vt.js"
import { TERMINAL_COLORS, type TerminalColors } from "./terminal-theme.js"

export interface KernelScreen {
  rows: Cell[][]
  cols: number
}

export class TerminalKernel {
  private kernel: GhosttyKernel | null = null
  private loading: Promise<boolean> | null = null
  private retryAt = 0
  private colors = TERMINAL_COLORS.dark
  private rows: Cell[][] = []

  setColors(colors: TerminalColors): void {
    this.colors = colors
    this.kernel?.setColors(colors)
  }

  get ready(): boolean {
    return this.kernel !== null
  }

  async load(): Promise<boolean> {
    if (this.kernel !== null) {
      return true
    }
    if (Date.now() < this.retryAt) return false
    if (this.loading === null) {
      this.loading = (async (): Promise<boolean> => {
        try {
          const url = new URL("../vendor/ghostty/ghostty-vt.wasm", import.meta.url).href
          const bytes = await withTimeout(
            fetch(url).then(async (response) => {
              if (!response.ok) throw new Error(`the kernel answered ${response.status}`)
              return new Uint8Array(await response.arrayBuffer())
            }),
            15000,
            "the terminal kernel download timed out",
          )
          this.kernel = await GhosttyKernel.load(bytes)
          this.kernel.setColors(this.colors)
          return true
        } catch (error) {
          console.warn("the terminal kernel did not load", error)
          this.retryAt = Date.now() + 5000
          return false
        }
      })().finally(() => {
        this.loading = null
      })
    }
    return this.loading
  }

  async setContent(text: string, paneRows: number, paneCols = 0): Promise<KernelScreen | null> {
    if (!(await this.load()) || this.kernel === null) {
      return null
    }
    try {
      const screen = this.kernel.setContent(text, paneRows, paneCols)
      const rows = screen.rows.map((row, index) => toCells(row, this.rows[index]))
      if (rows.length !== this.rows.length || rows.some((row, index) => row !== this.rows[index])) this.rows = rows
      return { rows: this.rows, cols: screen.cols }
    } catch (error) {
      console.warn("the terminal kernel failed", error)
      return null
    }
  }
}

function toCells(cells: VtCell[], previous?: Cell[]): Cell[] {
  // Snapshot replay is complete, but unchanged rows can remain immutable shared data.
  if (
    previous?.length === cells.length &&
    cells.every((cell, index) => {
      const old = previous[index]
      return (
        old !== undefined &&
        old.ch === cell.ch &&
        old.style.fg === cell.fg &&
        old.style.bg === cell.bg &&
        old.style.bold === cell.bold &&
        old.style.italic === cell.italic &&
        old.style.dim === cell.dim &&
        old.style.underline === cell.underline &&
        old.style.reverse === cell.reverse
      )
    })
  )
    return previous
  return cells.map((cell) => ({
    ch: cell.ch,
    style: {
      fg: cell.fg,
      bg: cell.bg,
      bold: cell.bold,
      italic: cell.italic,
      dim: cell.dim,
      underline: cell.underline,
      reverse: cell.reverse,
    } satisfies CellStyle,
  }))
}
