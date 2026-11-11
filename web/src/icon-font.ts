import { iconFontChunks } from './icon-font-ranges.js';
import { withTimeout } from './deadline.js';

const FAMILY = 'Symbols Nerd Font Mono';
const RETRY_DELAY = 5000;
const chunks = [
  ...iconFontChunks,
  { file: 'terminal-symbols/playback.woff2', ranges: [[0x23f4, 0x23fa]] }
] as const;
const chunksByPage = new Map<number, number[]>();
for (const [index, chunk] of chunks.entries()) {
  const page = chunk.ranges[0][0] >>> 8;
  const indexes = chunksByPage.get(page) ?? [];
  indexes.push(index);
  chunksByPage.set(page, indexes);
}

/** Load only the icon pages in the current screen and repaint after each load. */
export class IconFontLoader {
  private readonly loaded = new Set<number>();
  private readonly pending = new Set<number>();
  private readonly retryAt = new Map<number, number>();
  private text = '';
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly repaint: () => void) {
    // CSS can finish loading a face independently of the explicit Canvas load.
    document.fonts.addEventListener?.('loadingdone', repaint);
  }

  load(text: string): void {
    this.text = text;
    const wanted = new Set<number>();
    for (const character of text) {
      const point = character.codePointAt(0)!;
      for (const index of chunksByPage.get(point >>> 8) ?? []) {
        if (chunks[index]!.ranges.some(
          ([start, end]) => point >= start && point <= end
        )) wanted.add(index);
      }
    }
    for (const index of wanted) {
      if (this.loaded.has(index) || this.pending.has(index)) continue;
      const delay = (this.retryAt.get(index) ?? 0) - Date.now();
      if (delay > 0) {
        if (this.retryTimer === null) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.load(this.text);
          }, delay);
        }
        continue;
      }
      this.pending.add(index);
      const chunk = chunks[index]!;
      const url = new URL('../vendor/nerd-fonts/' + chunk.file, import.meta.url);
      const unicodeRange = chunk.ranges.map(([start, end]) =>
        'U+' + start.toString(16) + (start === end ? '' : '-' + end.toString(16))
      ).join(',');
      const normalize = (range: string): string => range.replace(/\s/g, '').toLowerCase();
      const existing = [...document.fonts].find(face =>
        face.family.replace(/["']/g, '') === FAMILY &&
        normalize(face.unicodeRange) === normalize(unicodeRange)
      );
      // Share the CSS face so Canvas and DOM do not download the same page twice.
      // A rejected face cannot load again, so recovery needs a new object.
      const face = !this.retryAt.has(index) && existing !== undefined && existing.status !== 'error' ? existing :
        new FontFace(FAMILY, 'url("' + url.href + '") format("woff2")', {
          unicodeRange, style: 'normal', weight: '400', display: 'swap'
        });
      void withTimeout(face.load(), 15000, 'icon font request timed out').then(() => {
        if (!document.fonts.has(face)) document.fonts.add(face);
        this.pending.delete(index);
        this.retryAt.delete(index);
        this.loaded.add(index);
        this.repaint();
      }).catch(() => {
        this.pending.delete(index);
        this.retryAt.set(index, Date.now() + RETRY_DELAY);
        this.load(this.text);
      });
    }
  }
}
