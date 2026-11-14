import { parseAnsi } from "./ansi.js"

const RESET = "\x1b[0m"
const SGR = /\x1b\[[0-9;:]*m/g
const RULE = /^[ \t]*[─━═╌╍┄┅┈┉-]{3,}[ \t]*$/u
const SEPARATOR = /^[\s─━═╌╍┄┅┈┉\-=_*+|│┃┼┿╋]+$/u
const BACK_TO_BOTTOM = "[ ↓ Back to bottom · Ctrl+End ]"

interface Page {
  body: string[]
  footer: string[]
}

function comparable(line: string): string {
  return line.replace(SGR, "").trimEnd()
}

function same(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => comparable(line) === comparable(right[index]!))
}

// Reapply source SGR state when a slice begins inside a styled page.
function slice(lines: string[], start = 0, end = lines.length): string[] {
  const result = lines.slice(start, end)
  if (start > 0 && result.length > 0) {
    const style = lines.slice(0, start).join("\n").match(SGR)?.join("") ?? ""
    result[0] = style + result[0]
  }
  return result
}

// A repeated right-only pane frame is screen decoration, not transcript text.
function withoutFrame(lines: string[], width: number, confirmed: boolean): string[] {
  const rows = parseAnsi(lines.join("\n")).cells
  const edges = rows.flatMap((row, index) =>
    row.length === width && /^[|│┃]$/u.test(row[width - 1]?.ch ?? "") ? [index] : [],
  )
  if (
    edges.length < 3 ||
    (!confirmed &&
      !edges.some((index) => comparable(lines[index]!).trim().length === 1) &&
      edges.length !== rows.length) ||
    edges.some((index) => {
      const value = comparable(lines[index]!).trim()
      return value.length > 1 && /^[|│┃]/u.test(value)
    })
  )
    return lines
  const framed = new Set(edges)
  return lines.map((line, index) =>
    framed.has(index) ? line.replace(/[|│┃]((?:\x1b\[[0-9;:]*m|[ \t\r])*)$/u, "$1") : line,
  )
}

function parse(text: string, frame?: { width: number | null }): Page | null {
  const lines = text.split("\n")
  const plain = lines.map(comparable)
  for (let index = lines.length - 4; index >= 0; index--) {
    if (!RULE.test(plain[index]!) || !/^[❯›>]/u.test(plain[index + 1]!) || !RULE.test(plain[index + 2]!)) continue
    if (!plain.slice(index + 3).some((line) => line.trim().length > 0)) continue
    let end = index
    let marker = index - 1
    while (marker >= 0 && plain[marker]!.trim() === "") marker--
    if (marker >= 0 && plain[marker]!.trim() === BACK_TO_BOTTOM) {
      end = marker
      while (end > 0 && plain[end - 1]!.trim() === "") end--
    }
    const body = lines.slice(0, end)
    const width = plain[index]!.trim().length
    const content = withoutFrame(body, width, frame?.width === width)
    if (frame !== undefined && content !== body) frame.width = width
    return { body: content, footer: slice(lines, index) }
  }
  return null
}

/** Stable viewport identity excludes prompt, status, and scroll-hint changes. */
export function piHistoryKey(text: string): string | null {
  const page = parse(text)
  return page ? JSON.stringify(page.body.map(comparable)) : null
}

function meaningful(line: string): boolean {
  return line.trim().length > 0 && !SEPARATOR.test(line)
}

// Blank rows and decorative rules cannot prove that two viewport edges overlap.
function overlap(left: string[], right: string[]): number {
  const a = left.map(comparable)
  const b = right.map(comparable)
  for (let count = Math.min(a.length, b.length); count > 0; count--) {
    const start = a.length - count
    if (!b.slice(0, count).every((line, index) => line === a[start + index])) continue
    if (count === a.length && count === b.length) return count
    let previous = false
    let content = false
    for (let index = 0; index < count; index++) {
      const current = meaningful(b[index]!)
      if (current && previous) return count
      content ||= current
      previous = current
    }
    // A complete multi-line page is evidence even when blank rows separate its text.
    if (count > 1 && content && (count === a.length || count === b.length)) return count
  }
  return 0
}

/** Assemble trusted pi snapshots without retaining old prompts or status rows. */
export class PiHistoryBuffer {
  supported: boolean
  private latest: Page | null
  private raw: string
  private history: string[][] = []
  private oldest: string[] | null = null
  private capped = false
  private readonly limit: number
  // A partial page may omit the blank border rows that proved the pane frame.
  private readonly frame: { width: number | null } = { width: null }

  constructor(latest: string, limit = 1000) {
    this.limit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1000
    this.raw = latest
    this.latest = parse(latest, this.frame)
    this.supported = this.latest !== null
    this.trim()
  }

  get text(): string {
    if (!this.latest) return this.raw
    const chunks = [...this.history, this.latest.body, this.latest.footer].filter((lines) => lines.length > 0)
    return chunks.map((lines) => RESET + lines.join("\n")).join("\n") + RESET
  }

  get lines(): number {
    if (!this.latest) return this.raw === "" ? 0 : this.raw.split("\n").length
    return (
      this.history.reduce((count, page) => count + page.length, 0) + this.latest.body.length + this.latest.footer.length
    )
  }

  /** Sticky once the supported document reaches its line budget. */
  get full(): boolean {
    return this.capped
  }

  prepend(older: string): boolean {
    if (!this.latest || this.full) return false
    const page = parse(older, this.frame)
    if (!page || page.body.length === 0) return false
    const oldest = this.oldest ?? this.latest.body
    if (same(page.body, oldest)) return false
    const existing = [...this.history.flat(), ...this.latest.body]
    const shared = overlap(page.body, existing)
    const addition = slice(page.body, 0, page.body.length - shared)
    if (addition.length === 0) return false
    this.history.unshift(addition)
    this.oldest = page.body
    this.trim()
    return true
  }

  updateLatest(latest: string): void {
    const page = parse(latest, this.frame)
    if (!page) {
      // An unknown repaint must not inherit a guessed body/footer boundary.
      this.latest = null
      this.supported = false
      this.history = []
      this.oldest = null
      this.frame.width = null
      this.capped = false
      this.raw = latest
      return
    }
    if (this.latest) {
      let shared = overlap(this.latest.body, page.body)
      if (shared === 0 && this.latest.body.length >= 3) {
        // Streaming may extend the final row while earlier rows leave the viewport.
        const last = comparable(this.latest.body.at(-1)!)
        const stable = overlap(this.latest.body.slice(0, -1), page.body)
        if (stable >= 2 && meaningful(last) && comparable(page.body[stable] ?? "").startsWith(last)) {
          shared = stable + 1
        }
      }
      if (shared > 0) {
        const departed = slice(this.latest.body, 0, this.latest.body.length - shared)
        if (departed.length > 0) {
          if (this.history.length === 0) this.oldest = this.latest.body
          this.history.push(departed)
        }
      }
    }
    this.raw = latest
    this.latest = page
    this.supported = true
    this.trim()
  }

  private trim(): void {
    if (!this.latest) return
    let excess = this.lines - this.limit
    if (excess >= 0) this.capped = true
    while (excess > 0 && this.history.length > 0) {
      const first = this.history[0]!
      const remove = Math.min(excess, first.length)
      if (remove === first.length) this.history.shift()
      else this.history[0] = slice(first, remove)
      excess -= remove
    }
    if (excess > 0) {
      const remove = Math.min(excess, this.latest.body.length)
      this.latest.body = slice(this.latest.body, remove)
      excess -= remove
    }
    // Even a budget smaller than the footer is a hard bound.
    if (excess > 0) this.latest.footer = slice(this.latest.footer, excess)
  }
}
