import type { CastDocument } from './wasm';

/** Which of the furni's two casts: the 64 px one or the 32 px one (hh_furni_xx_s_<class>.cct). */
export type SideKey = 'large' | 'small';

/** One cast as it was: the document (a copy owned by the history), and which content generation it holds. */
export interface Snap {
  doc: CastDocument;
  name: string;
  gen: number;
}

export interface Step {
  what: string;
  /** Edits with the same group right after each other are one step (a painting session, nudging with the arrow keys). */
  group?: string;
  at: number;
  sides: Partial<Record<SideKey, Snap>>;
}

const MAX_STEPS = 80;
const MAX_BYTES = 192 * 1024 * 1024;
/** Groups other than a painting session only join edits this close together. */
const GROUP_WINDOW_MS = 1500;

/**
 * Undo and redo for the editor's changes. Before a change, the casts it touches are copied (`CastDocument.snapshot`,
 * a memory copy); undoing swaps the copy in and keeps the current document for redo, so no step copies twice.
 */
export class History {
  private past: Step[] = [];
  private future: Step[] = [];
  private bytes = new Map<Step, number>();

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  get undoLabel() {
    return this.past[this.past.length - 1]?.what;
  }
  get redoLabel() {
    return this.future[this.future.length - 1]?.what;
  }

  /** Whether an edit in `group` joins the last step instead of making a new one. */
  joins(group: string | undefined): boolean {
    const top = this.past[this.past.length - 1];
    if (!group || !top || top.group !== group || this.future.length) return false;
    return group.includes('paint:') || Date.now() - top.at < GROUP_WINDOW_MS;
  }

  /** The last step took one more edit of its group. */
  extend(what: string) {
    const top = this.past[this.past.length - 1];
    if (top) {
      top.at = Date.now();
      top.what = what;
    }
  }

  push(step: Step) {
    this.drop(this.future);
    this.future = [];
    this.past.push(step);
    this.bytes.set(step, Object.values(step.sides).reduce((n, s) => n + (s ? s.doc.byteSize() : 0), 0));
    let total = [...this.bytes.values()].reduce((a, b) => a + b, 0);
    while (this.past.length > 1 && (this.past.length > MAX_STEPS || total > MAX_BYTES)) {
      const old = this.past.shift()!;
      total -= this.bytes.get(old) ?? 0;
      this.drop([old]);
    }
  }

  /** Take the step to undo; the caller puts the current casts into `redoWith` and shows the step's. */
  undo(current: (keys: SideKey[]) => Step['sides']): Step | undefined {
    const step = this.past.pop();
    if (!step) return undefined;
    this.bytes.delete(step);
    this.future.push({ what: step.what, at: Date.now(), sides: current(Object.keys(step.sides) as SideKey[]) });
    return step;
  }

  redo(current: (keys: SideKey[]) => Step['sides']): Step | undefined {
    const step = this.future.pop();
    if (!step) return undefined;
    const back: Step = { what: step.what, at: Date.now(), sides: current(Object.keys(step.sides) as SideKey[]) };
    this.past.push(back);
    this.bytes.set(back, Object.values(back.sides).reduce((n, s) => n + (s ? s.doc.byteSize() : 0), 0));
    return step;
  }

  clear() {
    this.drop(this.past);
    this.drop(this.future);
    this.past = [];
    this.future = [];
    this.bytes.clear();
  }

  private drop(steps: Step[]) {
    for (const s of steps) {
      this.bytes.delete(s);
      for (const snap of Object.values(s.sides)) {
        try {
          snap?.doc.free();
        } catch {
          /* already freed */
        }
      }
    }
  }
}
