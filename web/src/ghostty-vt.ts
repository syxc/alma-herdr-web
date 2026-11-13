// Resolve ABI layouts from the WASM manifest instead of hard-coding offsets.
import { rgb, xterm256 } from "./ansi.js"
import { TERMINAL_COLORS, type TerminalColors } from "./terminal-theme.js"

export interface VtCell {
  ch: string // Empty in the trailing column of a wide character.
  fg: string
  bg: string
  bold: boolean
  italic: boolean
  dim: boolean
  underline: boolean
  reverse: boolean
}

export interface VtScreen {
  rows: VtCell[][]
  cols: number
}

interface GhosttyExports {
  memory: WebAssembly.Memory
  ghostty_type_json(): number
  ghostty_wasm_alloc(len: number): number
  ghostty_wasm_free(ptr: number, len: number): void
  ghostty_wasm_alloc_opaque(): number
  ghostty_wasm_free_opaque(ptr: number): void
  ghostty_wasm_take_opaque(slot: number): number
  ghostty_terminal_new(allocator: number, slot: number, cols: number, rows: number): number
  ghostty_terminal_free(terminal: number): void
  ghostty_terminal_resize(terminal: number, cols: number, rows: number): number
  ghostty_terminal_vt_write(terminal: number, ptr: number, len: number): number
  ghostty_terminal_set(terminal: number, option: number, value: number): number
  ghostty_render_state_new(allocator: number, slot: number): number
  ghostty_render_state_update(state: number, terminal: number): number
  ghostty_render_state_set(state: number, option: number, value: number): number
  ghostty_render_state_get(state: number, data: number, out: number): number
  ghostty_render_state_row_iterator_new(allocator: number, slot: number): number
  ghostty_render_state_row_iterator_next(iterator: number): number
  ghostty_render_state_row_get(iterator: number, data: number, out: number): number
  ghostty_render_state_row_cells_new(allocator: number, slot: number): number
  ghostty_render_state_row_cells_select(cells: number, x: number): number
  ghostty_render_state_row_cells_get(cells: number, data: number, out: number): number
}

interface FieldLayout {
  offset: number
  size: number
  type: string
}

interface BitLayout {
  lsb: number
  width: number
  arms?: Record<string, { bits?: Record<string, BitLayout> }>
}

interface TypeLayout {
  size?: number
  fields?: Record<string, FieldLayout>
  bits?: Record<string, BitLayout>
  values?: Record<string, number>
}

interface Manifest {
  types: Record<string, TypeLayout>
  abi: { usize_size: number; pointer_size: number; endian: string }
}

const SCROLLBACK_LINES = 5000

function rgbBytes(color: string): [number, number, number] {
  return [
    Number.parseInt(color.substring(1, 3), 16),
    Number.parseInt(color.substring(3, 5), 16),
    Number.parseInt(color.substring(5, 7), 16),
  ]
}

function paletteBytes(colors: TerminalColors): Uint8Array {
  return Uint8Array.from(Array.from({ length: 256 }, (_, index) => rgbBytes(xterm256(index, colors.palette))).flat())
}

// Overestimate widths so replay never wraps the server-rendered rows.
function widthBound(lines: string[]): number {
  let widest = 0
  for (const line of lines) {
    let width = 0
    for (const ch of line) {
      const point = ch.codePointAt(0)
      width += point !== undefined && point < 0x80 ? 1 : 2
    }
    if (width > widest) {
      widest = width
    }
  }
  return widest + 2
}

export class GhosttyKernel {
  private readonly wasm: GhosttyExports
  private readonly manifest: Manifest
  private readonly terminal: number
  private readonly state: number

  private readonly slots: {
    iterator: number
    cells: number
    view: number
    style: number
    color: number
    foreground: number
    background: number
    palette: number
    scrollback: number
    buffer: number
    text: number
    textCap: number
    overscan: number
  }

  private readonly ids: {
    resultSuccess: number
    resultOutOfSpace: number
    renderStateDataRowIterator: number
    renderStateOptionOverscan: number
    renderStateRowDataCells: number
    renderStateRowDataCellsRaw: number
    rowCellsDataStyle: number
    rowCellsDataBgColor: number
    rowCellsDataFgColor: number
    rowCellsDataGraphemesUtf8: number
    terminalOptColorForeground: number
    terminalOptColorBackground: number
    terminalOptColorPalette: number
    terminalOptScrollbackMaxLines: number
    contentCodepoint: number
    contentCodepointGrapheme: number
    contentBgPalette: number
    contentBgRgb: number
    wideSpacerTail: number
  }

  private readonly cell: {
    contentTagLsb: number
    contentTagWidth: number
    contentLsb: number
    contentWidth: number
    codepointLsb: number
    codepointWidth: number
    styleIdLsb: number
    styleIdWidth: number
    wideLsb: number
    wideWidth: number
  }

  private readonly style: {
    bold: number
    italic: number
    faint: number
    inverse: number
    underline: number
  }

  private readonly decoder = new TextDecoder()
  private colors = TERMINAL_COLORS.dark

  private constructor(wasm: GhosttyExports) {
    this.wasm = wasm
    this.manifest = this.readManifest()
    this.ids = this.readIds()
    this.cell = this.readCellLayout()
    this.style = this.readStyleLayout()

    this.terminal = this.createTerminal(256, 24)
    this.state = this.createRenderState()

    this.slots = {
      iterator: this.alloc(4),
      cells: this.alloc(4),
      view: this.alloc(8),
      style: this.alloc(this.typeSize("GhosttyStyle")),
      color: this.alloc(3),
      foreground: this.alloc(3),
      background: this.alloc(3),
      palette: this.alloc(768),
      scrollback: this.alloc(4),
      buffer: this.alloc(12),
      text: this.alloc(64),
      textCap: 64,
      overscan: this.alloc(4),
    }

    this.setColors()

    // The row iterator and the cell handle have to exist before the render
    // state can hand them out.
    this.wasm.ghostty_render_state_row_iterator_new(0, this.slots.iterator)
    this.wasm.ghostty_render_state_row_cells_new(0, this.slots.cells)
  }

  static async load(bytes: Uint8Array): Promise<GhosttyKernel> {
    const built = (await WebAssembly.instantiate(
      bytes as unknown as BufferSource,
      {},
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource
    return new GhosttyKernel(built.instance.exports as unknown as GhosttyExports)
  }

  setContent(text: string, paneRows: number, paneCols = 0): VtScreen {
    // Native core paint includes cursor positions and terminal modes, unlike SGR snapshots.
    this.write("\x1bc")
    this.setColors(this.colors)
    if (paneCols > 0) {
      this.resize(paneCols, Math.max(1, paneRows))
      this.write("\x1b[?2027h")
      this.write(text)
      return { ...this.read(SCROLLBACK_LINES), cols: paneCols }
    }
    const lines = text.split(/\r\n|\n/)
    if (lines.length > 1 && (lines[lines.length - 1] ?? "") === "") {
      lines.pop()
    }
    const cols = widthBound(lines)
    const rows = Math.max(1, paneRows > 0 ? paneRows : lines.length)

    // The screen and the scrollback are emptied first, so the terminal holds
    // exactly what was read this time. Lines that do not fit on the screen
    // end up in the scrollback, which is where the older lines belong.
    // Snapshots contain complete Unicode graphemes, including ZWJ emoji and flags.
    this.write("\u001b[?2027h\u001b[0m\u001b[3J\u001b[2J\u001b[H")
    this.resize(cols, rows)
    this.write(lines.join("\r\n"))

    return this.read(lines.length)
  }

  free(): void {
    this.wasm.ghostty_terminal_free(this.terminal)
  }

  private read(historyRows: number): VtScreen {
    // The rows above the screen are asked for as well, so the lines that
    // scrolled out of the screen come back with it.
    const overscan = this.slots.overscan
    const view = this.view()
    view.setUint16(overscan, Math.min(0xffff, Math.max(0, historyRows)), true)
    view.setUint16(overscan + 2, 0, true)
    this.wasm.ghostty_render_state_set(this.state, this.ids.renderStateOptionOverscan, overscan)
    this.wasm.ghostty_render_state_update(this.state, this.terminal)

    this.wasm.ghostty_render_state_get(this.state, this.ids.renderStateDataRowIterator, this.slots.iterator)
    const iterator = this.view().getUint32(this.slots.iterator, true)

    const rows: VtCell[][] = []
    const styles = new Map<number, VtCell>()
    while (this.wasm.ghostty_render_state_row_iterator_next(iterator) !== 0) {
      rows.push(this.readRow(iterator, styles))
    }
    while (rows.length > 0 && rowIsBlank(rows[rows.length - 1] ?? [])) {
      rows.pop()
    }
    return { rows, cols: usedWidth(rows) }
  }

  private readRow(iterator: number, styles: Map<number, VtCell>): VtCell[] {
    this.wasm.ghostty_render_state_row_get(iterator, this.ids.renderStateRowDataCellsRaw, this.slots.view)
    const view = this.view()
    const pointer = view.getUint32(this.slots.view, true)
    const length = view.getUint32(this.slots.view + 4, true)

    // The handle that reads the style and the colours of a single cell.
    this.wasm.ghostty_render_state_row_get(iterator, this.ids.renderStateRowDataCells, this.slots.cells)
    const cells = this.view().getUint32(this.slots.cells, true)

    const out: VtCell[] = []
    for (let index = 0; index < length; index += 1) {
      const value = this.cellValue(pointer + index * 8)
      const contentTag = this.bits(value, this.cell.contentTagLsb, this.cell.contentTagWidth)
      const content = this.bits(value, this.cell.contentLsb, this.cell.contentWidth)
      const styleId = this.bits(value, this.cell.styleIdLsb, this.cell.styleIdWidth)
      const wide = this.bits(value, this.cell.wideLsb, this.cell.wideWidth)

      let style = styles.get(styleId)
      if (style === undefined) {
        style = this.readStyle(cells, index)
        styles.set(styleId, style)
      }

      let ch = " "
      if (contentTag === this.ids.contentCodepoint) {
        const codepoint = this.bits(content, this.cell.codepointLsb, this.cell.codepointWidth)
        ch = codepoint === 0 ? " " : String.fromCodePoint(codepoint)
      } else if (contentTag === this.ids.contentCodepointGrapheme) {
        ch = this.readGrapheme(cells, index)
      } else if (contentTag === this.ids.contentBgPalette || contentTag === this.ids.contentBgRgb) {
        // A cell that holds nothing but a background colour.
        ch = " "
      }

      if (wide === this.ids.wideSpacerTail) {
        // The column after a character that is wider than one column.
        ch = ""
      }

      let bg = style.bg
      if (contentTag === this.ids.contentBgPalette || contentTag === this.ids.contentBgRgb) {
        bg = this.readColor(cells, this.ids.rowCellsDataBgColor)
      }

      out.push({
        ch,
        fg: style.fg,
        bg,
        bold: style.bold,
        italic: style.italic,
        dim: style.dim,
        underline: style.underline,
        reverse: style.reverse,
      })
    }
    while (out.length > 0 && cellIsBlank(out[out.length - 1] ?? EMPTY_CELL)) {
      out.pop()
    }
    return out
  }

  private readStyle(cells: number, x: number): VtCell {
    this.wasm.ghostty_render_state_row_cells_select(cells, x)
    const result = this.wasm.ghostty_render_state_row_cells_get(cells, this.ids.rowCellsDataStyle, this.slots.style)
    const style: VtCell = { ...EMPTY_CELL }
    if (result === this.ids.resultSuccess) {
      const view = this.view()
      style.bold = view.getUint8(this.slots.style + this.style.bold) !== 0
      style.italic = view.getUint8(this.slots.style + this.style.italic) !== 0
      style.dim = view.getUint8(this.slots.style + this.style.faint) !== 0
      style.reverse = view.getUint8(this.slots.style + this.style.inverse) !== 0
      style.underline = view.getInt32(this.slots.style + this.style.underline, true) !== 0
    }
    style.fg = this.readColor(cells, this.ids.rowCellsDataFgColor)
    style.bg = this.readColor(cells, this.ids.rowCellsDataBgColor)
    return style
  }

  private readColor(cells: number, kind: number): string {
    const result = this.wasm.ghostty_render_state_row_cells_get(cells, kind, this.slots.color)
    if (result !== this.ids.resultSuccess) {
      return ""
    }
    const view = this.view()
    return rgb(
      view.getUint8(this.slots.color),
      view.getUint8(this.slots.color + 1),
      view.getUint8(this.slots.color + 2),
    )
  }

  private readGrapheme(cells: number, x: number): string {
    this.wasm.ghostty_render_state_row_cells_select(cells, x)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const view = this.view()
      view.setUint32(this.slots.buffer, this.slots.text, true)
      view.setUint32(this.slots.buffer + 4, this.slots.textCap, true)
      view.setUint32(this.slots.buffer + 8, 0, true)
      const result = this.wasm.ghostty_render_state_row_cells_get(
        cells,
        this.ids.rowCellsDataGraphemesUtf8,
        this.slots.buffer,
      )
      if (result === this.ids.resultOutOfSpace) {
        const needed = this.view().getUint32(this.slots.buffer + 8, true)
        this.wasm.ghostty_wasm_free(this.slots.text, this.slots.textCap)
        this.slots.textCap = Math.max(needed + 16, this.slots.textCap * 2)
        this.slots.text = this.alloc(this.slots.textCap)
        continue
      }
      if (result !== this.ids.resultSuccess) {
        return ""
      }
      const after = this.view()
      const pointer = after.getUint32(this.slots.buffer, true)
      const length = after.getUint32(this.slots.buffer + 8, true)
      return this.decoder.decode(this.bytes().subarray(pointer, pointer + length))
    }
    return ""
  }

  private cellValue(pointer: number): number {
    const view = this.view()
    const low = view.getUint32(pointer, true)
    const high = view.getUint32(pointer + 4, true)
    return low + high * 0x100000000
  }

  private bits(value: number, lsb: number, width: number): number {
    const mask = width >= 32 ? 0xffffffff : (1 << width) - 1
    return Math.floor(value / 2 ** lsb) & mask
  }

  private write(text: string): void {
    const bytes = new TextEncoder().encode(text)
    if (bytes.length === 0) {
      return
    }
    const pointer = this.alloc(bytes.length)
    this.bytes().set(bytes, pointer)
    this.wasm.ghostty_terminal_vt_write(this.terminal, pointer, bytes.length)
    this.wasm.ghostty_wasm_free(pointer, bytes.length)
  }

  private resize(cols: number, rows: number): void {
    this.wasm.ghostty_terminal_resize(this.terminal, cols, rows)
  }

  setColors(colors: TerminalColors = TERMINAL_COLORS.dark): void {
    this.colors = colors
    const { foreground, background, palette: palettePointer, scrollback } = this.slots
    const view = this.view()
    const fg = rgbBytes(colors.foreground)
    const bg = rgbBytes(colors.background)
    view.setUint8(foreground, fg[0])
    view.setUint8(foreground + 1, fg[1])
    view.setUint8(foreground + 2, fg[2])
    view.setUint8(background, bg[0])
    view.setUint8(background + 1, bg[1])
    view.setUint8(background + 2, bg[2])
    this.wasm.ghostty_terminal_set(this.terminal, this.ids.terminalOptColorForeground, foreground)
    this.wasm.ghostty_terminal_set(this.terminal, this.ids.terminalOptColorBackground, background)

    const palette = paletteBytes(colors)
    this.bytes().set(palette, palettePointer)
    this.wasm.ghostty_terminal_set(this.terminal, this.ids.terminalOptColorPalette, palettePointer)

    this.view().setUint32(scrollback, SCROLLBACK_LINES, true)
    this.wasm.ghostty_terminal_set(this.terminal, this.ids.terminalOptScrollbackMaxLines, scrollback)
  }

  private createTerminal(cols: number, rows: number): number {
    const slot = this.wasm.ghostty_wasm_alloc_opaque()
    if (slot === 0) {
      throw new Error("the kernel is out of memory")
    }
    const result = this.wasm.ghostty_terminal_new(0, slot, cols, rows)
    if (result !== this.ids.resultSuccess) {
      this.wasm.ghostty_wasm_free_opaque(slot)
      throw new Error("the kernel could not open a terminal")
    }
    const terminal = this.wasm.ghostty_wasm_take_opaque(slot)
    this.wasm.ghostty_wasm_free_opaque(slot)
    return terminal
  }

  private createRenderState(): number {
    const slot = this.wasm.ghostty_wasm_alloc_opaque()
    if (slot === 0) {
      throw new Error("the kernel is out of memory")
    }
    const result = this.wasm.ghostty_render_state_new(0, slot)
    if (result !== this.ids.resultSuccess) {
      this.wasm.ghostty_wasm_free_opaque(slot)
      throw new Error("the kernel could not open a render state")
    }
    const state = this.wasm.ghostty_wasm_take_opaque(slot)
    this.wasm.ghostty_wasm_free_opaque(slot)
    return state
  }

  private readManifest(): Manifest {
    const pointer = this.wasm.ghostty_type_json()
    const bytes = this.bytes()
    let end = pointer
    while (end < bytes.length && bytes[end] !== 0) {
      end += 1
    }
    return JSON.parse(this.decoder.decode(bytes.subarray(pointer, end))) as Manifest
  }

  private readIds(): GhosttyKernel["ids"] {
    return {
      resultSuccess: this.enumValue("GhosttyResult", "SUCCESS"),
      resultOutOfSpace: this.enumValue("GhosttyResult", "OUT_OF_SPACE"),
      renderStateDataRowIterator: this.enumValue("GhosttyRenderStateData", "ROW_ITERATOR"),
      renderStateOptionOverscan: this.enumValue("GhosttyRenderStateOption", "OVERSCAN"),
      renderStateRowDataCells: this.enumValue("GhosttyRenderStateRowData", "CELLS"),
      renderStateRowDataCellsRaw: this.enumValue("GhosttyRenderStateRowData", "CELLS_RAW"),
      rowCellsDataStyle: this.enumValue("GhosttyRenderStateRowCellsData", "STYLE"),
      rowCellsDataBgColor: this.enumValue("GhosttyRenderStateRowCellsData", "BG_COLOR"),
      rowCellsDataFgColor: this.enumValue("GhosttyRenderStateRowCellsData", "FG_COLOR"),
      rowCellsDataGraphemesUtf8: this.enumValue("GhosttyRenderStateRowCellsData", "GRAPHEMES_UTF8"),
      terminalOptColorForeground: this.enumValue("GhosttyTerminalOption", "COLOR_FOREGROUND"),
      terminalOptColorBackground: this.enumValue("GhosttyTerminalOption", "COLOR_BACKGROUND"),
      terminalOptColorPalette: this.enumValue("GhosttyTerminalOption", "COLOR_PALETTE"),
      terminalOptScrollbackMaxLines: this.enumValue("GhosttyTerminalOption", "SCROLLBACK_MAX_LINES"),
      contentCodepoint: this.enumValue("GhosttyCellContentTag", "CODEPOINT"),
      contentCodepointGrapheme: this.enumValue("GhosttyCellContentTag", "CODEPOINT_GRAPHEME"),
      contentBgPalette: this.enumValue("GhosttyCellContentTag", "BG_COLOR_PALETTE"),
      contentBgRgb: this.enumValue("GhosttyCellContentTag", "BG_COLOR_RGB"),
      wideSpacerTail: this.enumValue("GhosttyCellWide", "SPACER_TAIL"),
    }
  }

  private readCellLayout(): GhosttyKernel["cell"] {
    const type = this.types("GhosttyCell")
    const bits = type.bits ?? {}
    const content = bits.content
    const codepoint = content?.arms?.CODEPOINT?.bits?.codepoint
    if (content === undefined || codepoint === undefined) {
      throw new Error("the kernel does not describe its cells")
    }
    const tag = bits.content_tag
    const styleId = bits.style_id
    const wide = bits.wide
    if (tag === undefined || styleId === undefined || wide === undefined) {
      throw new Error("the kernel does not describe its cells")
    }
    return {
      contentTagLsb: tag.lsb,
      contentTagWidth: tag.width,
      contentLsb: content.lsb,
      contentWidth: content.width,
      codepointLsb: codepoint.lsb,
      codepointWidth: codepoint.width,
      styleIdLsb: styleId.lsb,
      styleIdWidth: styleId.width,
      wideLsb: wide.lsb,
      wideWidth: wide.width,
    }
  }

  private readStyleLayout(): GhosttyKernel["style"] {
    return {
      bold: this.fieldOffset("GhosttyStyle", "bold"),
      italic: this.fieldOffset("GhosttyStyle", "italic"),
      faint: this.fieldOffset("GhosttyStyle", "faint"),
      inverse: this.fieldOffset("GhosttyStyle", "inverse"),
      underline: this.fieldOffset("GhosttyStyle", "underline"),
    }
  }

  private types(name: string): TypeLayout {
    const type = this.manifest.types[name]
    if (type === undefined) {
      throw new Error(`the kernel does not know ${name}`)
    }
    return type
  }

  private typeSize(name: string): number {
    return this.types(name).size ?? 0
  }

  private fieldOffset(type: string, field: string): number {
    const info = this.types(type).fields?.[field]
    if (info === undefined) {
      throw new Error(`the kernel does not describe ${type}.${field}`)
    }
    return info.offset
  }

  private enumValue(type: string, name: string): number {
    const value = this.types(type).values?.[name]
    if (value === undefined) {
      throw new Error(`the kernel does not know ${type}.${name}`)
    }
    return value
  }

  private bytes(): Uint8Array {
    return new Uint8Array(this.wasm.memory.buffer)
  }

  private view(): DataView {
    return new DataView(this.wasm.memory.buffer)
  }

  private alloc(len: number): number {
    const pointer = this.wasm.ghostty_wasm_alloc(len)
    if (pointer === 0) {
      throw new Error("the kernel is out of memory")
    }
    return pointer
  }
}

const EMPTY_CELL: VtCell = {
  ch: "",
  fg: "",
  bg: "",
  bold: false,
  italic: false,
  dim: false,
  underline: false,
  reverse: false,
}

function cellIsBlank(cell: VtCell): boolean {
  return cell.ch === " " && cell.bg === "" && !cell.underline && !cell.reverse
}

function rowIsBlank(row: VtCell[]): boolean {
  for (const cell of row) {
    if (!cellIsBlank(cell)) {
      return false
    }
  }
  return true
}

function usedWidth(rows: VtCell[][]): number {
  let widest = 0
  for (const row of rows) {
    if (row.length > widest) {
      widest = row.length
    }
  }
  return widest
}
