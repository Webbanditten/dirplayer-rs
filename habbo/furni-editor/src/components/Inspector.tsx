import { Icon } from './Icon';
import { useEffect, useRef, useState } from 'react';
import type { CastDocument } from '../../../../vm-rust/pkg/vm_rust.js';
import { parseLingo, LingoError } from '../lingo';
import { ALIAS_INDEX, type Furni, type Member } from '../furni';
import { paintMember } from './Thumb';

export type ImportMode = 'auto' | 'indexed' | 'rgba';

interface Props {
  doc: CastDocument;
  furni: Furni;
  rev: number;
  slot: number;
  /** the memberalias.index name the member was picked through */
  alias?: string;
  importMode: ImportMode;
  setImportMode: (m: ImportMode) => void;
  edit: (what: string, fn: () => void) => void;
  onImport: (slot: number) => void;
  onExport: (slot: number) => void;
  onDuplicate: (slot: number) => void;
  onDelete: (slot: number) => void;
  onPaint: (slot: number) => void;
}

const LINGO_FIELDS = /\.(props|data)$|^asset\.index$/i;

function BitmapEditor({ doc, member, rev, edit }: { doc: CastDocument; member: Member; rev: number; edit: Props['edit'] }) {
  const h = member.bitmap!;
  const [zoom, setZoom] = useState(() => Math.max(1, Math.min(8, Math.floor(256 / Math.max(h.width, h.height, 1)))));
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; regX: number; regY: number } | null>(null);
  const pad = 24;
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const img = document.createElement('canvas');
    paintMember(img, doc, member.slot, h, zoom, false, true);
    c.width = img.width + pad * 2;
    c.height = img.height + pad * 2;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(img, pad, pad);
    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    ctx.strokeRect(pad - 0.5, pad - 0.5, img.width + 1, img.height + 1);
    const rx = pad + h.regX * zoom + zoom / 2;
    const ry = pad + h.regY * zoom + zoom / 2;
    ctx.strokeStyle = '#e0245e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx - 10, Math.round(ry) + 0.5);
    ctx.lineTo(rx + 10, Math.round(ry) + 0.5);
    ctx.moveTo(Math.round(rx) + 0.5, ry - 10);
    ctx.lineTo(Math.round(rx) + 0.5, ry + 10);
    ctx.stroke();
  }, [doc, member, rev, zoom, h]);

  const setReg = (x: number, y: number) => edit(`Registration point ${x}, ${y}`, () => doc.setRegPoint(member.slot, x, y));

  return (
    <div className="bitmap-editor">
      <div className="row">
        <span className="muted">
          {h.width}×{h.height}, {h.depth}-bit{h.depth <= 8 ? `, palette ${h.paletteId > 0 ? `member ${h.paletteId}` : h.paletteId}` : h.useAlpha ? ', alpha' : ''}
        </span>
        <span className="spacer" />
        zoom
        <input type="range" min={1} max={12} value={zoom} onChange={(e) => setZoom(+e.target.value)} />
      </div>
      <div className="canvas-box checker">
        <canvas
          ref={canvas}
          tabIndex={0}
          title="Drag the picture to move it against its registration point (the cross); arrow keys move 1 px"
          onMouseDown={(e) => (drag.current = { x: e.clientX, y: e.clientY, regX: h.regX, regY: h.regY })}
          onMouseMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dx = Math.round((e.clientX - d.x) / zoom);
            const dy = Math.round((e.clientY - d.y) / zoom);
            if (d.regX - dx !== h.regX || d.regY - dy !== h.regY) setReg(d.regX - dx, d.regY - dy);
          }}
          onMouseUp={() => (drag.current = null)}
          onMouseLeave={() => (drag.current = null)}
          onKeyDown={(e) => {
            const k = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
            if (k) {
              e.preventDefault();
              setReg(h.regX + k[0], h.regY + k[1]);
            }
          }}
        />
      </div>
      <div className="row">
        <label>
          reg x <input type="number" value={h.regX} onChange={(e) => setReg(+e.target.value, h.regY)} />
        </label>
        <label>
          reg y <input type="number" value={h.regY} onChange={(e) => setReg(h.regX, +e.target.value)} />
        </label>
      </div>
    </div>
  );
}

function TextEditor({ doc, member, rev, edit }: { doc: CastDocument; member: Member; rev: number; edit: Props['edit'] }) {
  const original = doc.text(member.slot) ?? '';
  const [text, setText] = useState(original);
  useEffect(() => setText(doc.text(member.slot) ?? ''), [doc, member.slot, rev]);
  let problem = '';
  if (LINGO_FIELDS.test(member.name) && text.trim()) {
    try {
      parseLingo(text);
    } catch (e) {
      problem = e instanceof LingoError ? e.message : String(e);
    }
  }
  const changed = text !== original;
  return (
    <div className="text-editor">
      <textarea value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && changed) edit(`Text of ${member.name}`, () => doc.setText(member.slot, text));
      }} />
      <div className="row">
        {problem ? <span className="error">{problem}</span> : LINGO_FIELDS.test(member.name) ? <span className="ok">Reads as a Lingo value</span> : null}
        <span className="spacer" />
        <button disabled={!changed} onClick={() => setText(original)}>Revert</button>
        <button className="primary" disabled={!changed} onClick={() => edit(`Text of ${member.name}`, () => doc.setText(member.slot, text))} title="Ctrl/Cmd+Enter">
          Apply
        </button>
      </div>
      {member.name.toLowerCase() === ALIAS_INDEX && <p className="hint">One alias per line: <code>name=target</code>, <code>*</code> after the target = mirrored. Later lines win.</p>}
      {/\.props$/i.test(member.name) && <p className="hint">Per layer: <code>#ink</code> (8 matte, 36 background transparent, 33 add, 41 tint...), <code>#blend</code>, <code>#zshift: [per direction]</code>, <code>#locshift</code>.</p>}
      {/\.data$/i.test(member.name) && <p className="hint"><code>states</code>, <code>statestrings</code>, <code>layers: [a: [[frames: [0, 1], delay: 2, loop: 0], ...one per state]]</code>; also <code>sequences</code>, <code>random</code>, <code>blend</code>.</p>}
    </div>
  );
}

export function Inspector(props: Props) {
  const { doc, furni, rev, slot, alias, edit } = props;
  const member = furni.bySlot.get(slot);
  const [name, setName] = useState(member?.name ?? '');
  useEffect(() => setName(member?.name ?? ''), [member?.name, slot]);
  if (!member) return <div className="inspector muted">Nothing selected.</div>;
  return (
    <div className="inspector">
      <div className="inspector-head">
        <div className="meta"><span className="type-badge">{member.type}</span><span className="muted small">member #{member.slot}</span></div>
        <div className="row">
          <input className="name" value={name} onChange={(e) => setName(e.target.value)} />
          <button disabled={name === member.name || !name} onClick={() => edit(`Renamed to ${name}`, () => doc.setName(slot, name))}>Rename</button>
        </div>
        {alias && <div className="hint">Picked through the alias <code>{alias}</code> (memberalias.index); edits change the member it points at.</div>}
      </div>
      {member.type === 'bitmap' && member.bitmap && (
        <>
          <BitmapEditor doc={doc} member={member} rev={rev} edit={edit} />
          <div className="row">
            <button className="primary" onClick={() => props.onPaint(slot)} title="Draw on the pixels, in the member's own palette (also: double-click it in the grid)"><Icon name="brush" size={14} />Paint…</button>
            <button onClick={() => props.onImport(slot)}><Icon name="image" size={14} />Replace…</button>
            <select value={props.importMode} onChange={(e) => props.setImportMode(e.target.value as ImportMode)} title="How imported pixels are stored">
              <option value="auto">auto (8-bit if every colour is in the palette)</option>
              <option value="indexed">8-bit, nearest palette colours</option>
              <option value="rgba">32-bit with alpha</option>
            </select>
          </div>
          <div className="row">
            <button onClick={() => props.onExport(slot)}><Icon name="export" size={14} />PNG</button>
            <button onClick={() => props.onDuplicate(slot)}><Icon name="copy" size={14} />Duplicate…</button>
            <span className="spacer" />
            <button className="danger ghost" onClick={() => props.onDelete(slot)}><Icon name="trash" size={14} />Delete</button>
          </div>
        </>
      )}
      {(member.type === 'field' || member.type === 'text') && (
        <>
          <TextEditor doc={doc} member={member} rev={rev} edit={edit} />
          <div className="row">
            <button onClick={() => props.onDuplicate(slot)}>Duplicate…</button>
            <button className="danger" onClick={() => props.onDelete(slot)}>Delete</button>
          </div>
        </>
      )}
      {member.type === 'palette' && <Palette doc={doc} slot={slot} />}
      {!['bitmap', 'field', 'text', 'palette'].includes(member.type) && <p className="muted">This member type can't be edited here.</p>}
    </div>
  );
}

function Palette({ doc, slot }: { doc: CastDocument; slot: number }) {
  const raw = doc.paletteColors(slot);
  const swatches = [];
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const c = `rgb(${raw[i]},${raw[i + 1]},${raw[i + 2]})`;
    swatches.push(<span key={i} className="swatch" style={{ background: c }} title={`${i / 3}: ${c}`} />);
  }
  return <div className="palette">{swatches}</div>;
}
