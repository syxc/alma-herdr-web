/**
 * Translation of browser key events into the key names herdr accepts.
 *
 * herdr takes herdr style key combos (enter, esc, ctrl+h, alt+x, shift+tab,
 * f1 ...), not raw bytes, so printable characters travel as text instead.
 *
 * herdr 0.9.5 knows these key names: enter, esc, backspace, tab, up, down,
 * left, right, f1 ... f12, and any combo of ctrl, alt or shift in front of a
 * character or an arrow key. It has no home, end, delete, insert, pageup or
 * pagedown, so home and end become ctrl+a and ctrl+e, which is what a shell
 * does with them anyway.
 */
export interface KeyAction {
  kind: 'text' | 'keys';
  text?: string;
  keys?: string[];
}

const NAMED: Record<string, string> = {
  Enter: 'enter',
  Escape: 'esc',
  Backspace: 'backspace',
  Tab: 'tab',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'ctrl+a',
  End: 'ctrl+e'
};

/**
 * The key names of the arrows, so a combo can be built from them.
 */
const ARROWS = new Set(['up', 'down', 'left', 'right']);

export function mapKey(event: KeyboardEvent): KeyAction | null {
  if (event.metaKey) {
    // The shortcuts of the browser stay with the browser.
    return null;
  }
  const named = NAMED[event.key];
  if (named !== undefined) {
    if (named === 'tab') {
      return { kind: 'keys', keys: [event.shiftKey ? 'shift+tab' : 'tab'] };
    }
    if (event.key === 'Home' || event.key === 'End') {
      // These already carry their own meaning.
      return { kind: 'keys', keys: [named] };
    }
    if (event.ctrlKey || event.altKey || event.shiftKey) {
      const prefix = event.ctrlKey ? 'ctrl' : event.altKey ? 'alt' : 'shift';
      if (!ARROWS.has(named)) {
        return { kind: 'keys', keys: [named] };
      }
      return { kind: 'keys', keys: [prefix + '+' + named] };
    }
    return { kind: 'keys', keys: [named] };
  }
  if (/^F\d{1,2}$/.test(event.key)) {
    return { kind: 'keys', keys: [event.key.toLowerCase()] };
  }
  if (event.key.length === 1) {
    const lower = event.key.toLowerCase();
    if (event.ctrlKey) {
      return { kind: 'keys', keys: ['ctrl+' + lower] };
    }
    if (event.altKey) {
      return { kind: 'keys', keys: ['alt+' + lower] };
    }
    // A shift is part of the character itself, so it travels as text.
    return { kind: 'text', text: event.key };
  }
  return null;
}
