/**
 * Lingo `value()` for the literals furni casts carry in their .props and .data fields: lists `[1, 2]`, property
 * lists `["a": [#ink: 41]]` / `[states: [1, 2]]` (bare words before a colon are symbol keys), strings, #symbols,
 * numbers, point(x, y). Property lists come back as Map (insertion order; symbol and string keys both as plain
 * strings). Ported from habbo-vibe-playground's furni renderer (lingo-value.mts).
 */

export type LingoValue = number | string | LingoValue[] | Map<string, LingoValue> | { point: [number, number] } | undefined;

export class LingoError extends Error {}

/** Parse; throws LingoError with the position on a syntax error. */
export function parseLingo(text: string): LingoValue {
  const p = new Parser(text.replace(/[\r\n]/g, ' '));
  const v = p.value();
  if (p.rest().trim()) throw new LingoError(`Unexpected text after the value at ${p.pos}`);
  return v;
}

export function lingoValue(text: string): LingoValue {
  try {
    return parseLingo(text);
  } catch {
    return undefined;
  }
}

class Parser {
  pos = 0;
  constructor(private readonly s: string) {}
  rest() {
    return this.s.slice(this.pos);
  }
  private ws() {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++;
  }
  private peek() {
    this.ws();
    return this.s[this.pos];
  }
  value(): LingoValue {
    const c = this.peek();
    if (c === undefined) throw new LingoError('Value expected at the end');
    if (c === '[') return this.list();
    if (c === '"') return this.str();
    if (c === '#') {
      this.pos++;
      return this.word();
    }
    if (c === '-' || c === '+' || /[0-9.]/.test(c)) return this.num();
    const w = this.word();
    const lower = w.toLowerCase();
    if (this.peek() === '(') {
      const args = this.args();
      if (lower === 'point' && args.length === 2) return { point: [Number(args[0]), Number(args[1])] };
      return undefined;
    }
    if (lower === 'void') return undefined;
    if (lower === 'true') return 1;
    if (lower === 'false') return 0;
    return w;
  }
  private args(): LingoValue[] {
    this.pos++;
    const out: LingoValue[] = [];
    while (this.peek() !== ')') {
      if (this.pos >= this.s.length) throw new LingoError('Unclosed (');
      out.push(this.value());
      if (this.peek() === ',') this.pos++;
    }
    this.pos++;
    return out;
  }
  private word(): string {
    this.ws();
    const start = this.pos;
    while (this.pos < this.s.length && /[A-Za-z0-9_.]/.test(this.s[this.pos])) this.pos++;
    if (start === this.pos) throw new LingoError(`Unexpected "${this.s[this.pos]}" at ${this.pos}`);
    return this.s.slice(start, this.pos);
  }
  private str(): string {
    this.pos++;
    const start = this.pos;
    while (this.pos < this.s.length && this.s[this.pos] !== '"') this.pos++;
    if (this.pos >= this.s.length) throw new LingoError('Unclosed string');
    const out = this.s.slice(start, this.pos);
    this.pos++;
    return out;
  }
  private num(): number {
    this.ws();
    const m = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(this.s.slice(this.pos));
    if (!m) throw new LingoError(`Number expected at ${this.pos}`);
    this.pos += m[0].length;
    return Number(m[0]);
  }
  private list(): LingoValue[] | Map<string, LingoValue> {
    this.pos++;
    if (this.peek() === ':') {
      this.pos++;
      if (this.peek() !== ']') throw new LingoError(`"]" expected at ${this.pos}`);
      this.pos++;
      return new Map();
    }
    const items: LingoValue[] = [];
    let map: Map<string, LingoValue> | null = null;
    while (this.peek() !== ']') {
      if (this.pos >= this.s.length) throw new LingoError('Unclosed [');
      const v = this.value();
      if (this.peek() === ':') {
        this.pos++;
        map ??= new Map();
        // A repeated property keeps its first value: getaProp finds the first.
        const key = String(v);
        const value = this.value();
        if (!map.has(key)) map.set(key, value);
      } else {
        items.push(v);
      }
      if (this.peek() === ',') this.pos++;
      else if (this.peek() !== ']') throw new LingoError(`"," or "]" expected at ${this.pos}`);
    }
    this.pos++;
    return map ?? items;
  }
}

/** A property of a property list (case-insensitive, like Lingo symbols). */
export function prop(v: LingoValue, key: string): LingoValue {
  if (!(v instanceof Map)) return undefined;
  if (v.has(key)) return v.get(key);
  const lower = key.toLowerCase();
  for (const [k, value] of v) if (k.toLowerCase() === lower) return value;
  return undefined;
}

export function numberList(v: LingoValue): number[] | undefined {
  return Array.isArray(v) ? v.map((x) => (typeof x === 'number' ? x : Number(x) || 0)) : undefined;
}
