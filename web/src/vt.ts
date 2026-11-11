import { type Cell, type CellStyle } from './ansi.js';
import { GhosttyKernel, type VtCell } from './ghostty-vt.js';

export interface KernelScreen {
  rows: Cell[][];
  cols: number;
}

export class TerminalKernel {
  private kernel: GhosttyKernel | null = null;
  private loading: Promise<boolean> | null = null;

  get ready(): boolean {
    return this.kernel !== null;
  }

  async load(): Promise<boolean> {
    if (this.kernel !== null) {
      return true;
    }
    if (this.loading === null) {
      this.loading = (async (): Promise<boolean> => {
        try {
          const url = new URL('../vendor/ghostty/ghostty-vt.wasm', import.meta.url).href;
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error('the kernel answered ' + response.status);
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          this.kernel = await GhosttyKernel.load(bytes);
          return true;
        } catch (error) {
          console.warn('the terminal kernel did not load', error);
          return false;
        }
      })();
    }
    return this.loading;
  }

  async setContent(text: string, paneRows: number): Promise<KernelScreen | null> {
    if (!(await this.load()) || this.kernel === null) {
      return null;
    }
    try {
      const screen = this.kernel.setContent(text, paneRows);
      return { rows: screen.rows.map(toCells), cols: screen.cols };
    } catch (error) {
      console.warn('the terminal kernel failed', error);
      return null;
    }
  }
}

function toCells(cells: VtCell[]): Cell[] {
  return cells.map((cell) => ({
    ch: cell.ch,
    style: {
      fg: cell.fg,
      bg: cell.bg,
      bold: cell.bold,
      italic: cell.italic,
      dim: cell.dim,
      underline: cell.underline,
      reverse: cell.reverse
    } satisfies CellStyle
  }));
}
