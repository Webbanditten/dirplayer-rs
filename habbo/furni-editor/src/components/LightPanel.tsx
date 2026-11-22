import { Icon } from './Icon';
import { useEffect, useState } from 'react';
import type { CastDocument } from '../../../../vm-rust/pkg/vm_rust.js';
import { stateNames, type Furni } from '../furni';
import { addLight, lightDefaults, type LightOptions } from '../light';
import { lingoValue } from '../lingo';
import { fromHex, hex } from '../paint';

interface Props {
  doc: CastDocument;
  furni: Furni;
  edit: (what: string, fn: () => void) => void;
  setStatus: (text: string) => void;
  onClose: () => void;
}

/** "Add light": a glow layer like the dragon lamp's halo or the HC lamp's pool of light (see light.ts). */
export function LightPanel({ doc, furni, edit, setStatus, onClose }: Props) {
  const cls = furni.className();
  const data = lingoValue((furni.text(`${cls}.data`) ?? '').replace(/[\r\n]/g, ''));
  const hasData = data instanceof Map;
  const states = hasData ? stateNames(data) : ['off', 'on'];
  const [kind, setKind] = useState<LightOptions['kind']>('halo');
  const [color, setColor] = useState(0xffd060);
  const [strength, setStrength] = useState(0.8);
  const [pos, setPos] = useState(() => lightDefaults(furni, 'halo'));
  const [state, setState] = useState<number | null>(states.length > 1 ? states.length - 1 : null);
  useEffect(() => setPos(lightDefaults(furni, kind)), [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = () => {
    let summary = '';
    edit('Added a light', () => {
      summary = addLight(doc, furni, { kind, color, size: pos.size, strength, x: pos.x, y: pos.y, state });
    });
    if (summary) {
      setStatus(summary + (state !== null ? ` · pick state ${state} in the preview to see it` : ''));
      onClose();
    }
  };

  return (
    <div className="light-panel">
      <div className="row">
        <span className="pane-title"><Icon name="sun" size={14} />Add light</span>
        <span className="muted small">an ink 33 (add) layer, like rare_dragonlamp's halo and hc2_biglamp's floor light</span>
        <span className="spacer" />
        <button className="icon ghost" onClick={onClose} title="Cancel"><Icon name="close" /></button>
      </div>
      <div className="row">
        <label><input type="radio" checked={kind === 'halo'} onChange={() => setKind('halo')} /> halo (around a point)</label>
        <label><input type="radio" checked={kind === 'floor'} onChange={() => setKind('floor')} /> floor light (a pool on the tiles)</label>
      </div>
      <div className="row">
        colour <input type="color" value={hex(color)} onChange={(e) => setColor(fromHex(e.target.value))} />
        strength <input type="range" min={10} max={100} value={Math.round(strength * 100)} onChange={(e) => setStrength(+e.target.value / 100)} /> {Math.round(strength * 100)}%
        radius <input type="number" min={4} max={160} value={pos.size} onChange={(e) => setPos({ ...pos, size: +e.target.value })} />
      </div>
      <div className="row">
        centre x <input type="number" value={pos.x} onChange={(e) => setPos({ ...pos, x: +e.target.value })} />
        y <input type="number" value={pos.y} onChange={(e) => setPos({ ...pos, y: +e.target.value })} />
        <span className="muted small">pixels from the furni's tile point (its left corner; the tile centre is 32, 0)</span>
      </div>
      <div className="row">
        shown
        <select value={state === null ? '' : String(state)} onChange={(e) => setState(e.target.value === '' ? null : +e.target.value)}>
          <option value="">always</option>
          {states.map((s, i) => <option key={i} value={i}>only in state {i}: {s}{hasData ? '' : ' (adds .data with off/on)'}</option>)}
        </select>
        <span className="spacer" />
        <button className="primary" onClick={add}>Add light</button>
      </div>
      {!hasData && state !== null && <p className="hint">This furni has no states yet: the light adds a <code>.data</code> with "off" and "on". The hotel only switches it if the furni's definition can be turned on and off.</p>}
      <p className="hint">Afterwards: change the light's colour with "light colour" in Paint (its palette is a black-to-colour ramp), shape it with Paint's gradient and blur, or move it with its registration point. A light only adds brightness: over the preview's transparent background it nearly vanishes, so untick "transparent" to see it against a colour, as it will light up the room's walls and floor.</p>
    </div>
  );
}
