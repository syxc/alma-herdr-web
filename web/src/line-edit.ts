/**
 * How the line changes, in the order the pane has to get it.
 */
export interface LineEdit {
  /** How many characters have to be erased before the new text. */
  backspaces: number
  /** Whether the rest of the line has to be killed as well. */
  killToEnd: boolean
  /** The text that goes in after the erasing. */
  text: string
}

/**
 * The change between two states of the line.
 *
 * The comparison runs around the cursor, because text that is typed in the
 * middle of a line erases nothing: only what stands in front of the cursor
 * counts.
 */
export function lineEdit(before: string, caret: number, after: string, nextCaret: number): LineEdit {
  const head = before.slice(0, caret)
  const nextHead = after.slice(0, nextCaret)
  const sameTail = before.slice(caret) === after.slice(nextCaret)
  if (sameTail && nextHead.startsWith(head)) {
    return { backspaces: 0, killToEnd: false, text: after.slice(caret, nextCaret) }
  }
  if (sameTail && head.startsWith(nextHead)) {
    return { backspaces: characterCount(head.slice(nextCaret)), killToEnd: false, text: "" }
  }
  // The line was written over, so what is there goes away and the new line
  // is typed again.
  return { backspaces: characterCount(head), killToEnd: true, text: after }
}

/**
 * Where the word before the cursor begins.
 */
export function wordStart(value: string, caret: number): number {
  let index = caret
  while (index > 0 && value.charAt(index - 1) === " ") {
    index -= 1
  }
  while (index > 0 && value.charAt(index - 1) !== " ") {
    index -= 1
  }
  return index
}

/**
 * Where the word after the cursor ends.
 */
export function wordEnd(value: string, caret: number): number {
  let index = caret
  while (index < value.length && value.charAt(index) === " ") {
    index += 1
  }
  while (index < value.length && value.charAt(index) !== " ") {
    index += 1
  }
  return index
}

/** DOM positions use UTF-16; terminal key counts use Unicode code points. */
export function characterCount(value: string): number {
  return Array.from(value).length
}

export function adjacentCaret(value: string, caret: number, direction: -1 | 1): number {
  if (direction > 0) {
    const point = value.codePointAt(caret) ?? 0
    return Math.min(value.length, caret + (point > 0xffff ? 2 : 1))
  }
  const point = value.codePointAt(Math.max(0, caret - 2)) ?? 0
  return Math.max(0, caret - (caret >= 2 && point > 0xffff ? 2 : 1))
}
