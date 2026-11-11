/**
 * The icons of the app.
 *
 * They are drawn as lines, the way the Alma app draws them, so the shapes
 * stay the same on every system.
 */

const LINE = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"'

export const ICONS = {
  folder:
    '<svg viewBox="0 0 20 20" width="15" height="15" ' +
    LINE +
    ' stroke-width="1.3">' +
    '<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h3l1.5 2h8A1.5 1.5 0 0 1 17.5 7.5v7A1.5 1.5 0 0 1 16 16H4a2 2 0 0 1-2-2z"/></svg>',
  agent:
    '<svg viewBox="0 0 20 20" width="15" height="15" ' +
    LINE +
    ' stroke-width="1.3">' +
    '<path d="M10 3v14M4.2 6.5l11.6 7M4.2 13.5l11.6-7"/></svg>',
  chevron:
    '<svg viewBox="0 0 24 24" width="15" height="15" ' +
    LINE +
    ' stroke-width="2">' +
    '<path d="M9.5 5.5l6.5 6.5-6.5 6.5"/></svg>',
  fold:
    '<svg viewBox="0 0 24 24" width="16" height="16" ' +
    LINE +
    ' stroke-width="2.1">' +
    '<path d="M6 9.5l6 6 6-6"/></svg>',
  unfold:
    '<svg viewBox="0 0 24 24" width="16" height="16" ' +
    LINE +
    ' stroke-width="2.1">' +
    '<path d="M6 14.5l6-6 6 6"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" width="22" height="22" ' +
    LINE +
    ' stroke-width="2.4">' +
    '<path d="M4.5 12.5l5 5 10-11"/></svg>',
  width:
    '<svg viewBox="0 0 24 24" width="22" height="22" ' +
    LINE +
    ' stroke-width="2">' +
    '<path d="M3.5 12h17M8 7.5L3.5 12 8 16.5M16 7.5L20.5 12 16 16.5"/></svg>',
  shrink:
    '<svg viewBox="0 0 24 24" width="22" height="22" ' +
    LINE +
    ' stroke-width="2">' +
    '<path d="M12 3v18" stroke-dasharray="2.5 2.5"/>' +
    '<path d="M9.5 7L5 12l4.5 5M14.5 7L19 12l-4.5 5"/></svg>',
  wrap:
    '<svg viewBox="0 0 24 24" width="22" height="22" ' +
    LINE +
    ' stroke-width="2">' +
    '<path d="M20 4v7a3 3 0 0 1-3 3H4"/><path d="M8.5 9.5L4 14.5l4.5 5"/></svg>',
  restart:
    '<svg viewBox="0 0 24 24" width="22" height="22" ' +
    LINE +
    ' stroke-width="2">' +
    '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/></svg>',
  restartContinue:
    '<svg viewBox="0 0 24 24" width="22" height="22" ' +
    LINE +
    ' stroke-width="2">' +
    '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/>' +
    '<path d="M10.2 9.3l4.6 2.7-4.6 2.7z"/></svg>',
}
