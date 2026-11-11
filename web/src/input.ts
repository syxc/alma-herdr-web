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

import { mapKey } from './keys.js';
import { KeyQueue, type KeySink } from './send-queue.js';


/**
 * How the line changes, in the order the pane has to get it.
 */
export interface LineEdit {
  /** How many characters have to be erased before the new text. */
  backspaces: number;
  /** Whether the rest of the line has to be killed as well. */
  killToEnd: boolean;
  /** The text that goes in after the erasing. */
  text: string;
}

/**
 * The change between two states of the line.
 *
 * The comparison runs around the cursor, because text that is typed in the
 * middle of a line erases nothing: only what stands in front of the cursor
 * counts.
 */
export function lineEdit(
  before: string,
  caret: number,
  after: string,
  nextCaret: number
): LineEdit {
  const head = before.slice(0, caret);
  const nextHead = after.slice(0, nextCaret);
  if (nextHead.startsWith(head)) {
    return { backspaces: 0, killToEnd: false, text: after.slice(caret, nextCaret) };
  }
  if (head.startsWith(nextHead)) {
    return { backspaces: caret - nextCaret, killToEnd: false, text: '' };
  }
  // The line was written over, so what is there goes away and the new line
  // is typed again.
  return { backspaces: caret, killToEnd: true, text: after };
}

/**
 * Where the word before the cursor begins.
 */
function wordStart(value: string, caret: number): number {
  let index = caret;
  while (index > 0 && value.charAt(index - 1) === ' ') {
    index -= 1;
  }
  while (index > 0 && value.charAt(index - 1) !== ' ') {
    index -= 1;
  }
  return index;
}

/**
 * Where the word after the cursor ends.
 */
function wordEnd(value: string, caret: number): number {
  let index = caret;
  while (index < value.length && value.charAt(index) === ' ') {
    index += 1;
  }
  while (index < value.length && value.charAt(index) !== ' ') {
    index += 1;
  }
  return index;
}

export class TerminalInput {
  private readonly field: HTMLInputElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly queue: KeyQueue;
  /** The line the pane is holding, as far as the client knows. */
  private line = '';
  /** Where the cursor stands in that line. */
  private caret = 0;
  private enabled = false;

  constructor(field: HTMLInputElement, canvas: HTMLCanvasElement, sink: KeySink) {
    this.field = field;
    this.canvas = canvas;
    this.queue = new KeyQueue(sink);

    this.field.addEventListener('keydown', event => this.onKeyDown(event));
    this.field.addEventListener('input', event => this.onInput(event));
    this.field.addEventListener('click', () => this.onClick());
    this.canvas.addEventListener('keydown', event => this.onCanvasKeyDown(event));
  }

  /**
   * Whether there is a pane that can take the keys.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.forget();
    }
  }

  /**
   * Sends the old pane's pending input before the caller changes its target.
   */
  reset(): void {
    this.queue.flush();
    this.forget();
  }

  /**
   * Puts the cursor into the field, which brings up the keyboard of the phone.
   */
  focusField(): void {
    this.field.focus();
  }

  /**
   * Puts the cursor onto the screen, which is the input surface of a desktop.
   */
  focusScreen(): void {
    this.canvas.focus();
  }

  /**
   * Sends the line and starts a new one.
   */
  submit(): void {
    if (!this.enabled) {
      return;
    }
    this.queue.keys(['enter']);
    this.forget();
  }

  /**
   * Sends text, as if the reader had typed it.
   */
  type(text: string): void {
    if (!this.enabled || text.length === 0) {
      return;
    }
    this.queue.text(text);
    // The field shows the line the pane is holding.
    const value = this.field.value;
    this.field.value = value.slice(0, this.caret) + text + value.slice(this.caret);
    this.line = this.field.value;
    this.caret += text.length;
  }

  /**
   * Sends keys the reader picked, like the chips under the screen.
   */
  sendSpecial(keys: string[]): void {
    if (!this.enabled) {
      return;
    }
    this.queue.keys(keys);
    if (keys.includes('ctrl+c') || keys.includes('tab')) {
      // The pane threw the line away or filled it with a completion.
      this.forget();
      return;
    }
    if (keys.includes('up') || keys.includes('down')) {
      // The history brought a line the client cannot know.
      this.forget();
      return;
    }
    if (keys.includes('left')) {
      this.setCaret(this.caret - 1);
    }
    if (keys.includes('right')) {
      this.setCaret(this.caret + 1);
    }
  }

  /**
   * The keys of the field.
   */
  private onKeyDown(event: KeyboardEvent): void {
    if (!this.enabled || event.isComposing) {
      return;
    }
    const key = event.key;

    if (key === 'Enter') {
      event.preventDefault();
      this.submit();
      return;
    }
    if (key === 'Tab') {
      event.preventDefault();
      this.queue.keys([event.shiftKey ? 'shift+tab' : 'tab']);
      this.forget();
      return;
    }
    if (key === 'Escape') {
      event.preventDefault();
      this.queue.keys(['esc']);
      return;
    }
    if (key === 'Backspace') {
      event.preventDefault();
      this.eraseBefore();
      return;
    }
    if (key === 'Delete') {
      // herdr has no delete key, and nothing else means the same thing.
      event.preventDefault();
      return;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const action = mapKey(event);
      if (action === null) {
        return;
      }
      event.preventDefault();
      this.queue.keys(action.keys ?? []);
      // History replaces the remote line with text the client does not know.
      this.forget();
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault();
      this.moveCursor(key === 'ArrowLeft' ? -1 : 1, event.ctrlKey || event.altKey);
      return;
    }
    if (key === 'Home' || key === 'End') {
      event.preventDefault();
      if (key === 'Home') {
        this.queue.keys(['ctrl+a']);
        this.setCaret(0);
      } else {
        this.queue.keys(['ctrl+e']);
        this.setCaret(this.field.value.length);
      }
      return;
    }
    if (event.metaKey) {
      // The shortcuts of the browser stay with the browser.
      return;
    }
    if (event.ctrlKey && !event.altKey && key.length === 1) {
      event.preventDefault();
      this.control(key.toLowerCase());
      return;
    }
    if (event.altKey && !event.ctrlKey && key.length === 1) {
      event.preventDefault();
      this.meta(key.toLowerCase());
      return;
    }
    // Everything else is a character: it goes to the pane through the input
    // event, which also carries the text of an input method.
  }

  /**
   * The text of the field changed.
   */
  private onInput(event: Event): void {
    if (!this.enabled) {
      return;
    }
    const input = event as InputEvent;
    if (input.isComposing) {
      // The input method is still working; the text comes with its end.
      return;
    }
    const value = this.field.value;
    const caret = this.field.selectionStart ?? value.length;
    if (value === this.line && caret === this.caret) {
      return;
    }
    const edit = lineEdit(this.line, this.caret, value, caret);
    if (edit.backspaces > 0) {
      this.queue.keys(new Array(edit.backspaces).fill('backspace'));
    }
    if (edit.killToEnd) {
      this.queue.keys(['ctrl+k']);
    }
    if (edit.text.length > 0) {
      this.queue.text(edit.text);
    }
    this.line = value;
    this.caret = caret;
  }

  /**
   * The reader put the cursor somewhere in the field.
   */
  private onClick(): void {
    if (!this.enabled) {
      return;
    }
    const caret = this.field.selectionStart ?? this.field.value.length;
    const steps = caret - this.caret;
    if (steps === 0) {
      return;
    }
    // The pane moves its cursor as well, so both stay in the same place.
    this.queue.keys(new Array(Math.abs(steps)).fill(steps < 0 ? 'left' : 'right'));
    this.caret = caret;
  }

  /**
   * The keys of the screen, which is the input surface of a desktop.
   */
  private onCanvasKeyDown(event: KeyboardEvent): void {
    if (!this.enabled) {
      return;
    }
    const action = mapKey(event);
    if (action === null) {
      return;
    }
    event.preventDefault();
    if (action.kind === 'text') {
      this.queue.text(action.text ?? '');
    } else {
      this.queue.keys(action.keys ?? []);
    }
  }

  /**
   * The ctrl combos that a shell knows.
   */
  private control(letter: string): void {
    switch (letter) {
      case 'a':
        this.queue.keys(['ctrl+a']);
        this.setCaret(0);
        return;
      case 'e':
        this.queue.keys(['ctrl+e']);
        this.setCaret(this.field.value.length);
        return;
      case 'u':
        this.queue.keys(['ctrl+u']);
        this.eraseToStart();
        return;
      case 'k':
        this.queue.keys(['ctrl+k']);
        this.eraseToEnd();
        return;
      case 'w':
        this.queue.keys(['ctrl+w']);
        this.eraseWord();
        return;
      case 'c':
        this.queue.keys(['ctrl+c']);
        this.forget();
        return;
      default:
        this.queue.keys(['ctrl+' + letter]);
    }
  }

  /**
   * The alt combos that a shell knows.
   */
  private meta(letter: string): void {
    if (letter === 'b') {
      this.queue.keys(['alt+b']);
      this.setCaret(wordStart(this.field.value, this.caret));
      return;
    }
    if (letter === 'f') {
      this.queue.keys(['alt+f']);
      this.setCaret(wordEnd(this.field.value, this.caret));
      return;
    }
    this.queue.keys(['alt+' + letter]);
  }

  /**
   * Moves the cursor of the line.
   */
  private moveCursor(direction: -1 | 1, byWord: boolean): void {
    const value = this.field.value;
    const target = byWord
      ? direction < 0
        ? wordStart(value, this.caret)
        : wordEnd(value, this.caret)
      : Math.max(0, Math.min(value.length, this.caret + direction));
    this.queue.keys([
      byWord ? (direction < 0 ? 'ctrl+left' : 'ctrl+right') : direction < 0 ? 'left' : 'right'
    ]);
    this.setCaret(target);
  }

  /**
   * Erases the character in front of the cursor.
   */
  private eraseBefore(): void {
    if (this.caret === 0) {
      // The field has nothing left, but the line of the pane may have.
      this.queue.keys(['backspace']);
      return;
    }
    const value = this.field.value;
    this.field.value = value.slice(0, this.caret - 1) + value.slice(this.caret);
    this.line = this.field.value;
    this.caret -= 1;
    this.queue.keys(['backspace']);
  }

  /**
   * Erases everything in front of the cursor.
   */
  private eraseToStart(): void {
    const value = this.field.value;
    this.field.value = value.slice(this.caret);
    this.line = this.field.value;
    this.caret = 0;
  }

  /**
   * Erases everything behind the cursor.
   */
  private eraseToEnd(): void {
    this.field.value = this.field.value.slice(0, this.caret);
    this.line = this.field.value;
  }

  /**
   * Erases the word in front of the cursor.
   */
  private eraseWord(): void {
    const value = this.field.value;
    const end = wordStart(value, this.caret);
    this.field.value = value.slice(0, end) + value.slice(this.caret);
    this.line = this.field.value;
    this.caret = end;
  }

  /**
   * Puts the cursor of the field somewhere.
   */
  private setCaret(position: number): void {
    const value = this.field.value;
    const clamped = Math.max(0, Math.min(value.length, position));
    this.field.setSelectionRange(clamped, clamped);
    this.caret = clamped;
  }

  /**
   * Gives up on the line, because the pane holds a line the client cannot
   * know any more.
   */
  private forget(): void {
    this.field.value = '';
    this.line = '';
    this.caret = 0;
  }
}
