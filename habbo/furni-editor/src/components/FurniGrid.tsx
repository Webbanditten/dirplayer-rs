import type { CastDocument } from '../../../../vm-rust/pkg/vm_rust.js';
import { parseMemberName, type Furni, type Member } from '../furni';
import { Thumb } from './Thumb';

export interface Cell {
  name: string;
  slot: number;
  flip: boolean;
  aliasOf?: string;
}

export interface LayerRow {
  letter: string;
  /** direction -> frame -> cell */
  dirs: Map<number, Map<number, Cell>>;
}

export interface GridModel {
  cls: string;
  dims: [number, number];
  rows: LayerRow[];
  shadows: Cell[];
  icons: Cell[];
  /** the 32 px room zoom's members (s_<class>_...) */
  small: Member[];
  other: Member[];
}

/** The class's bitmaps as layers x directions x frames (own members and memberalias.index names). */
export function gridModel(furni: Furni, smallZoom = furni.isSmallCast()): GridModel {
  const cls = (smallZoom ? 's_' : '') + furni.className();
  const lowerCls = cls.toLowerCase();
  const rows = new Map<string, LayerRow>();
  const shadows: Cell[] = [];
  const icons: Cell[] = [];
  const used = new Set<number>();
  let dims: [number, number] = [1, 1];
  const display = new Map(furni.members.map((m) => [m.name.toLowerCase(), m.name]));
  for (const [key, e] of furni.names) {
    const m = furni.bySlot.get(e.slot);
    if (!m || m.type !== 'bitmap') continue;
    const name = display.get(key) ?? key;
    const cell: Cell = { name, slot: e.slot, flip: e.flip, aliasOf: e.aliasOf };
    const p = parseMemberName(key);
    if (p && p.cls === lowerCls) {
      dims = [p.width, p.length];
      let row = rows.get(p.letter);
      if (!row) rows.set(p.letter, (row = { letter: p.letter, dirs: new Map() }));
      let frames = row.dirs.get(p.direction);
      if (!frames) row.dirs.set(p.direction, (frames = new Map()));
      frames.set(p.frame, cell);
      used.add(e.slot);
    } else if (key === `${lowerCls}_sd` || key.startsWith(`${lowerCls}_sd_`)) {
      shadows.push(cell);
      used.add(e.slot);
    } else if (key.startsWith(`${lowerCls}_small`)) {
      icons.push(cell);
      used.add(e.slot);
    }
  }
  const smallPrefix = `s_${lowerCls}`;
  const rest = furni.members.filter((m) => m.type === 'bitmap' && !used.has(m.slot));
  const small = rest.filter((m) => m.name.toLowerCase().startsWith(smallPrefix));
  const other = rest.filter((m) => !m.name.toLowerCase().startsWith(smallPrefix));
  return {
    cls,
    dims,
    rows: [...rows.values()].sort((a, b) => a.letter.localeCompare(b.letter)),
    shadows: shadows.sort((a, b) => a.name.localeCompare(b.name)),
    icons: icons.sort((a, b) => a.name.localeCompare(b.name)),
    small,
    other,
  };
}

interface Props {
  doc: CastDocument;
  furni: Furni;
  rev: number;
  small: boolean;
  selected: number | null;
  onSelect: (slot: number, alias?: string) => void;
  onPaint?: (slot: number) => void;
  onAddFrame: (letter: string, direction: number, frame: number, file?: File) => void;
  onAddLayer: (letter: string) => void;
  onMirror: () => void;
  onAddLight?: () => void;
}

function CellView({ doc, furni, cell, rev, selected, onSelect, onPaint }: { doc: CastDocument; furni: Furni; cell: Cell; rev: number; selected: boolean; onSelect: () => void; onPaint?: (slot: number) => void }) {
  const m = furni.bySlot.get(cell.slot);
  if (!m?.bitmap) return null;
  const title = cell.aliasOf ? `${cell.name}\n= ${cell.aliasOf}${cell.flip ? ' (mirrored)' : ''}` : cell.name;
  const placeholder = m.bitmap.width <= 1 && m.bitmap.height <= 1;
  return (
    <button className={`cell${selected ? ' selected' : ''}${cell.aliasOf ? ' alias' : ''}`} title={title + '\n(double-click to paint)'} onClick={onSelect} onDoubleClick={() => onPaint?.(cell.slot)}>
      {placeholder ? <span className="empty-frame">empty</span> : <Thumb doc={doc} slot={cell.slot} header={m.bitmap} flip={cell.flip} rev={rev} />}
      {cell.aliasOf && <span className="badge">{cell.flip ? '⇋' : '='}</span>}
    </button>
  );
}

export function FurniGrid({ doc, furni, rev, small, selected, onSelect, onPaint, onAddFrame, onAddLayer, onMirror, onAddLight }: Props) {
  const g = gridModel(furni, small || furni.isSmallCast());
  const dirsUsed = [...new Set(g.rows.flatMap((r) => [...r.dirs.keys()]))].sort((a, b) => a - b);
  const nextLetter = String.fromCharCode(97 + g.rows.length);
  return (
    <div className="grid">
      <div className="grid-head">
        <b>{g.cls || '(no class)'}</b> <span className="muted">{g.dims[0]}×{g.dims[1]} tiles</span>
        <span className="spacer" />
        {onAddLight && <button onClick={onAddLight} title="Add a glow layer (ink 33), like the dragon lamp's halo or the HC lamp's floor light">Add light…</button>}
        <button onClick={onMirror} title="Add memberalias.index lines so directions 4 and 6 show 2 and 0 mirrored, where they have no members of their own">
          Mirror 2→4, 0→6
        </button>
      </div>
      {g.rows.map((row) => (
        <div key={row.letter} className="layer-row">
          <div className="layer-name">{row.letter}</div>
          <div className="layer-dirs">
            {dirsUsed.map((d) => {
              const frames = row.dirs.get(d);
              const list = frames ? [...frames.entries()].sort((a, b) => a[0] - b[0]) : [];
              const next = list.length ? list[list.length - 1][0] + 1 : 0;
              return (
                <div key={d} className="dir-group">
                  <div className="dir-label">dir {d}</div>
                  <div className="frames">
                    {list.map(([f, cell]) => (
                      <div key={f} className="frame">
                        <CellView onPaint={onPaint} doc={doc} furni={furni} cell={cell} rev={rev} selected={selected === cell.slot && !cell.aliasOf} onSelect={() => onSelect(cell.slot, cell.aliasOf ? cell.name : undefined)} />
                        <div className="frame-no">{f}</div>
                      </div>
                    ))}
                    <button
                      className="add"
                      title={`New frame ${next} for layer ${row.letter}, direction ${d}: click to pick an image, or drop one here`}
                      onClick={() => onAddFrame(row.letter, d, next)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        const file = e.dataTransfer.files?.[0];
                        if (!file) return;
                        e.preventDefault();
                        e.stopPropagation();
                        onAddFrame(row.letter, d, next, file);
                      }}
                    >
                      +
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="layer-row">
        <div className="layer-name">+</div>
        <button className="add wide" onClick={() => onAddLayer(nextLetter)} title="Import an image as a new layer (direction and frame 0 of the first direction)">
          New layer {nextLetter}
        </button>
      </div>
      {g.shadows.length > 0 && (
        <div className="layer-row">
          <div className="layer-name">sd</div>
          <div className="frames">
            {g.shadows.map((c) => (
              <div key={c.name} className="frame">
                <CellView onPaint={onPaint} doc={doc} furni={furni} cell={c} rev={rev} selected={selected === c.slot && !c.aliasOf} onSelect={() => onSelect(c.slot, c.aliasOf ? c.name : undefined)} />
                <div className="frame-no">{c.name.replace(/^.*_sd_?/, '') || '–'}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {g.icons.length > 0 && (
        <div className="layer-row">
          <div className="layer-name">icon</div>
          <div className="frames">
            {g.icons.map((c) => (
              <div key={c.name} className="frame">
                <CellView onPaint={onPaint} doc={doc} furni={furni} cell={c} rev={rev} selected={selected === c.slot} onSelect={() => onSelect(c.slot)} />
                <div className="frame-no">{c.name.replace(/^.*_small_?/, '') || 'main'}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {g.small.length > 0 && (
        <div className="layer-row">
          <div className="layer-name" title="The small room zoom (s_ members)">32 px</div>
          <div className="frames">
            {g.small.map((m) => (
              <div key={m.slot} className="frame">
                <CellView onPaint={onPaint} doc={doc} furni={furni} cell={{ name: m.name, slot: m.slot, flip: false }} rev={rev} selected={selected === m.slot} onSelect={() => onSelect(m.slot)} />
                <div className="frame-no" title={m.name}>{m.name.replace(/^s_.*?_([a-z])_0_\d+_\d+_(\d+)_(\d+)$/i, '$1 d$2 f$3')}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {g.other.length > 0 && (
        <div className="layer-row">
          <div className="layer-name">other</div>
          <div className="frames">
            {g.other.map((m) => (
              <div key={m.slot} className="frame">
                <CellView onPaint={onPaint} doc={doc} furni={furni} cell={{ name: m.name, slot: m.slot, flip: false }} rev={rev} selected={selected === m.slot} onSelect={() => onSelect(m.slot)} />
                <div className="frame-no" title={m.name}>{m.name}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
