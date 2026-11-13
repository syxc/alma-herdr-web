/**
 * The input of the terminal.
 *
 * A terminal is not a form. What the reader types belongs to the pane at
 * once, and the pane echoes it back, so the field under the screen is not a
 * buffer that waits for the send button: it is the line the pane is holding.
 * Every keystroke goes to the pane immediately, and the field follows the
 * same edits, so backspace, the arrow keys and the ctrl combos behave the
 * way they behave in a shell.
 *
 * The Alma app works the same way: the text the reader types shows up in the
 * terminal, not in the field.
 */

import { mapKey } from "./keys.js"
import { adjacentCaret, characterCount, lineEdit, wordEnd, wordStart } from "./line-edit.js"
import { KeyQueue, type KeySink } from "./send-queue.js"
import { clearTerminalSelection, selectTerminalText, terminalSelection } from "./terminal-selection.js"

export class TerminalInput {
  private readonly field: HTMLInputElement
  private readonly canvas: HTMLCanvasElement
  private readonly queue: KeyQueue
  /** The line the pane is holding, as far as the client knows. */
  private line = ""
  /** Where the cursor stands in that line. */
  private caret = 0
  private enabled = false

  constructor(field: HTMLInputElement, canvas: HTMLCanvasElement, sink: KeySink) {
    this.field = field
    this.canvas = canvas
    this.queue = new KeyQueue(sink)

    this.field.addEventListener("focus", () => clearTerminalSelection(this.canvas))
    this.field.addEventListener("keydown", (event) => this.onKeyDown(event))
    this.field.addEventListener("input", (event) => this.onInput(event))
    this.field.addEventListener("compositionend", () => {
      // Some IMEs finish with a composing input event and no later plain input.
      // syncValue also deduplicates a final input event when one follows.
      if (this.enabled) this.syncValue()
    })
    this.field.addEventListener("click", () => this.onClick())
    this.field.addEventListener("keyup", () => this.onClick())
    const screen = canvas.parentElement?.classList?.contains("terminal-surface") ? canvas.parentElement : canvas
    screen.addEventListener("keydown", (event) => this.onCanvasKeyDown(event as KeyboardEvent))
  }

  /**
   * Whether there is a pane that can take the keys.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.forget()
    }
  }

  /**
   * Sends the old pane's pending input before the caller changes its target.
   */
  reset(): void {
    clearTerminalSelection(this.canvas)
    this.queue.flush()
    this.forget()
  }

  /**
   * Puts the cursor into the field, which brings up the keyboard of the phone.
   */
  focusField(): void {
    clearTerminalSelection(this.canvas)
    this.field.focus()
  }

  /**
   * Puts the cursor onto the screen, which is the input surface of a desktop.
   */
  focusScreen(): void {
    this.canvas.focus()
  }

  /**
   * Sends the line and starts a new one.
   */
  submit(): void {
    clearTerminalSelection(this.canvas)
    if (!this.enabled) {
      return
    }
    this.queue.keys(["enter"])
    this.forget()
  }

  /**
   * Sends text, as if the reader had typed it.
   */
  type(text: string): void {
    clearTerminalSelection(this.canvas)
    if (!this.enabled || text.length === 0) {
      return
    }
    this.onClick()
    const start = this.field.selectionStart ?? this.caret
    const end = this.field.selectionEnd ?? start
    if (/[\r\n]/.test(text)) {
      const selected = characterCount(this.line.slice(start, end))
      if (selected > 0) {
        this.queue.keys([...new Array(selected).fill("right"), ...new Array(selected).fill("backspace")])
      }
      this.queue.text(text)
      this.forget()
      return
    }
    if (start !== end) {
      this.field.value = this.line.slice(0, start) + text + this.line.slice(end)
      this.field.setSelectionRange(start + text.length, start + text.length)
      this.syncValue()
      return
    }
    this.queue.text(text)
    // The field shows the line the pane is holding.
    const value = this.field.value
    this.field.value = value.slice(0, this.caret) + text + value.slice(this.caret)
    this.line = this.field.value
    this.setCaret(this.caret + text.length)
  }

  /**
   * Sends keys the reader picked, like the chips under the screen.
   */
  sendSpecial(keys: string[]): void {
    clearTerminalSelection(this.canvas)
    if (!this.enabled) {
      return
    }
    this.onClick()
    for (const key of keys) {
      if (key === "enter") this.submit()
      else if (key === "backspace") this.eraseBefore()
      else if (["left", "right"].includes(key.split("+").at(-1) ?? "")) {
        this.moveCursor(key.endsWith("left") ? -1 : 1, key.includes("ctrl+") || key.includes("alt+"), key)
      } else if (/^ctrl[+][a-z]$/.test(key)) this.control(key.slice(-1))
      else if (/^alt[+][a-z]$/.test(key)) this.meta(key.slice(-1))
      else {
        this.queue.keys([key])
        if (["tab", "shift+tab", "up", "down"].includes(key)) this.forget()
      }
    }
  }

  /**
   * The keys of the field.
   */
  private onKeyDown(event: KeyboardEvent): void {
    if (!this.enabled || event.metaKey || event.isComposing || event.keyCode === 229) {
      return
    }
    const key = event.key
    if (
      (key === "ArrowLeft" || key === "ArrowRight") &&
      this.field.selectionStart !== this.field.selectionEnd &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      event.preventDefault()
      const target =
        (key === "ArrowLeft" ? this.field.selectionStart : this.field.selectionEnd) ?? this.field.value.length
      this.field.setSelectionRange(target, target)
      this.onClick()
      return
    }
    // Native Cmd navigation can change the DOM caret between key events.
    this.onClick()

    if (key === "Enter") {
      event.preventDefault()
      this.submit()
      return
    }
    if (key === "Tab") {
      event.preventDefault()
      this.queue.keys([event.shiftKey ? "shift+tab" : "tab"])
      this.forget()
      return
    }
    if (key === "Escape") {
      event.preventDefault()
      this.queue.keys(["esc"])
      return
    }
    if (key === "Backspace") {
      if (this.field.selectionStart !== this.field.selectionEnd) return
      event.preventDefault()
      this.eraseBefore()
      return
    }
    if (key === "Delete") {
      if (this.field.selectionStart !== this.field.selectionEnd) return
      // herdr has no delete key, and nothing else means the same thing.
      event.preventDefault()
      return
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      const action = mapKey(event)
      if (action?.kind !== "keys") {
        return
      }
      event.preventDefault()
      this.queue.keys(action.keys)
      // History replaces the remote line with text the client does not know.
      this.forget()
      return
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault()
      this.moveCursor(key === "ArrowLeft" ? -1 : 1, event.ctrlKey || event.altKey)
      return
    }
    if (key === "Home" || key === "End") {
      event.preventDefault()
      if (key === "Home") {
        this.queue.keys(["ctrl+a"])
        this.setCaret(0)
      } else {
        this.queue.keys(["ctrl+e"])
        this.setCaret(this.field.value.length)
      }
      return
    }
    if (event.ctrlKey && !event.altKey && key.length === 1) {
      event.preventDefault()
      this.control(key.toLowerCase())
      return
    }
    if (event.altKey && !event.ctrlKey && key.length === 1) {
      event.preventDefault()
      this.meta(key.toLowerCase())
      return
    }
    // Everything else is a character: it goes to the pane through the input
    // event, which also carries the text of an input method.
  }

  /**
   * The text of the field changed.
   */
  private onInput(event: Event): void {
    if (!this.enabled) {
      return
    }
    const input = event as InputEvent
    if (input.isComposing) {
      // The input method is still working; the text comes with its end.
      return
    }
    this.syncValue()
  }

  private syncValue(): void {
    const value = this.field.value
    const caret = this.field.selectionStart ?? value.length
    if (value === this.line) {
      this.onClick()
      return
    }
    const edit = lineEdit(this.line, this.caret, value, caret)
    if (edit.backspaces > 0) {
      this.queue.keys(new Array(edit.backspaces).fill("backspace"))
    }
    if (edit.killToEnd) {
      this.queue.keys(["ctrl+k"])
    }
    if (edit.text.length > 0) {
      this.queue.text(edit.text)
    }
    if (edit.killToEnd) {
      const steps = characterCount(value.slice(caret))
      if (steps > 0) this.queue.keys(new Array(steps).fill("left"))
    }
    this.line = value
    this.caret = caret
  }

  /**
   * The reader put the cursor somewhere in the field.
   */
  private onClick(): void {
    if (!this.enabled || this.field.value !== this.line) {
      return
    }
    const caret = this.field.selectionStart ?? this.field.value.length
    const steps = characterCount(this.line.slice(0, caret)) - characterCount(this.line.slice(0, this.caret))
    if (steps === 0) {
      return
    }
    // The pane moves its cursor as well, so both stay in the same place.
    this.queue.keys(new Array(Math.abs(steps)).fill(steps < 0 ? "left" : "right"))
    this.caret = caret
  }

  /**
   * The keys of the screen, which is the input surface of a desktop.
   */
  private onCanvasKeyDown(event: KeyboardEvent): void {
    const selection = terminalSelection(this.canvas)
    const command = event.ctrlKey || event.metaKey
    if (selection !== null && command && event.key.toLowerCase() === "c") return
    if (command && event.key.toLowerCase() === "a" && (selection !== null || event.target !== this.canvas)) {
      selectTerminalText(this.canvas)
      event.preventDefault()
      return
    }
    if (selection !== null && event.key === "Escape") {
      clearTerminalSelection(this.canvas)
      event.preventDefault()
      return
    }
    if (selection !== null && !command && !["Shift", "Control", "Alt", "Meta"].includes(event.key)) {
      clearTerminalSelection(this.canvas)
    }
    if (!this.enabled) {
      return
    }
    const action = mapKey(event)
    if (action === null) {
      return
    }
    event.preventDefault()
    if (action.kind === "text") {
      this.queue.text(action.text)
    } else {
      this.queue.keys(action.keys)
    }
  }

  /**
   * The ctrl combos that a shell knows.
   */
  private control(letter: string): void {
    switch (letter) {
      case "a":
        this.queue.keys(["ctrl+a"])
        this.setCaret(0)
        return
      case "e":
        this.queue.keys(["ctrl+e"])
        this.setCaret(this.field.value.length)
        return
      case "u":
        this.queue.keys(["ctrl+u"])
        this.eraseToStart()
        return
      case "k":
        this.queue.keys(["ctrl+k"])
        this.eraseToEnd()
        return
      case "w":
        this.queue.keys(["ctrl+w"])
        this.eraseWord()
        return
      case "c":
        this.queue.keys(["ctrl+c"])
        this.forget()
        return
      default:
        this.queue.keys([`ctrl+${letter}`])
    }
  }

  /**
   * The alt combos that a shell knows.
   */
  private meta(letter: string): void {
    if (letter === "b") {
      this.queue.keys(["alt+b"])
      this.setCaret(wordStart(this.field.value, this.caret))
      return
    }
    if (letter === "f") {
      this.queue.keys(["alt+f"])
      this.setCaret(wordEnd(this.field.value, this.caret))
      return
    }
    this.queue.keys([`alt+${letter}`])
  }

  /**
   * Moves the cursor of the line.
   */
  private moveCursor(direction: -1 | 1, byWord: boolean, key?: string): void {
    const value = this.field.value
    const target = byWord
      ? direction < 0
        ? wordStart(value, this.caret)
        : wordEnd(value, this.caret)
      : adjacentCaret(value, this.caret, direction)
    this.queue.keys([key ?? (byWord ? (direction < 0 ? "ctrl+left" : "ctrl+right") : direction < 0 ? "left" : "right")])
    this.setCaret(target)
  }

  /**
   * Erases the character in front of the cursor.
   */
  private eraseBefore(): void {
    const start = this.field.selectionStart ?? this.caret
    const end = this.field.selectionEnd ?? start
    if (start !== end) {
      this.field.value = this.line.slice(0, start) + this.line.slice(end)
      this.field.setSelectionRange(start, start)
      this.syncValue()
      return
    }
    if (this.caret === 0) {
      // The field has nothing left, but the line of the pane may have.
      this.queue.keys(["backspace"])
      return
    }
    const value = this.field.value
    const previous = adjacentCaret(value, this.caret, -1)
    this.field.value = value.slice(0, previous) + value.slice(this.caret)
    this.line = this.field.value
    this.setCaret(previous)
    this.queue.keys(["backspace"])
  }

  /**
   * Erases everything in front of the cursor.
   */
  private eraseToStart(): void {
    const value = this.field.value
    this.field.value = value.slice(this.caret)
    this.line = this.field.value
    this.setCaret(0)
  }

  /**
   * Erases everything behind the cursor.
   */
  private eraseToEnd(): void {
    this.field.value = this.field.value.slice(0, this.caret)
    this.line = this.field.value
  }

  /**
   * Erases the word in front of the cursor.
   */
  private eraseWord(): void {
    const value = this.field.value
    const end = wordStart(value, this.caret)
    this.field.value = value.slice(0, end) + value.slice(this.caret)
    this.line = this.field.value
    this.setCaret(end)
  }

  /**
   * Puts the cursor of the field somewhere.
   */
  private setCaret(position: number): void {
    const value = this.field.value
    const clamped = Math.max(0, Math.min(value.length, position))
    this.field.setSelectionRange(clamped, clamped)
    this.caret = clamped
  }

  /**
   * Gives up on the line, because the pane holds a line the client cannot
   * know any more.
   */
  private forget(): void {
    this.field.value = ""
    this.line = ""
    this.caret = 0
  }
}
