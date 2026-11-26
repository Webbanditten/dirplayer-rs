import type React from 'react';
import type { CastDocument } from '../../../../vm-rust/pkg/vm_rust.js';
import { Icon } from './Icon';
import { Thumb } from './Thumb';
import { furniSetup, isWallItem, parseColors, type Furni } from '../furni';
import { INKS, deleteLayer, depthAt, layerProps, readProps, setLayerProps } from '../layers';
import type { Edit } from '../App';

interface Props {
  doc: CastDocument;
  furni: Furni;
  rev: number;
  edit: Edit;
  /** the direction and state the room shows: depth is per direction */
  direction: number;
  state: number;
  /** the part colours the room shows (items_definitions.colour), and changing them */
  colors: string;
  setColors: (c: string) => void;
  selected: number | null;
  onSelect: (slot: number) => void;
  setStatus: (s: string) => void;
}

const hue = (letter: string) => (28 + (letter.charCodeAt(0) - 97) * 67) % 360;

/** The Layers tab: how each layer is drawn (ink, see-through, depth, clicks), instead of writing `.props` by hand. */
export function LayersPanel({ doc, furni, rev, edit, direction, state, colors, setColors, selected, onSelect, setStatus }: Props) {
  const wall = isWallItem(furni);
  const setup = furniSetup(furni, { direction, state, colors, shadow: false });
  if (!setup) return <p className="hint">No layers yet: add a picture in the Furni tab.</p>;
  const props = readProps(furni);
  const drawn = new Map(setup.layersAt().map((l) => [l.letter, l]));
  const colourList = parseColors(colors);
  const shownDir = setup.direction;

  const setColour = (index: number, value: string) => {
    const list = (colors.trim() ? colors.split(',').map((c) => c.trim()) : []) as string[];
    while (list.length <= index) list.push('#FFFFFF');
    list[index] = value.toUpperCase();
    setColors(list.join(','));
  };

  return (
    <div className="layers-panel">
      <p className="hint">How each layer is drawn. The room beside it shows every change; later letters are drawn on top unless their depth says otherwise.</p>
      {setup.letters.map((letter, i) => {
        const p = layerProps(props, letter);
        const layer = drawn.get(letter);
        const depth = depthAt(p.zshift, shownDir);
        const perDirection = p.zshift.length > 1;
        const change = (what: string, c: Parameters<typeof setLayerProps>[3]) => edit(`Layer ${letter}: ${what}`, () => setLayerProps(doc, furni, letter, c), { group: `props:${letter}:${Object.keys(c).join()}` });
        const setDepth = (z: number, all: boolean) => {
          if (all) return change(`depth ${z}`, { zshift: [z] });
          const list = Array.from({ length: 8 }, (_, d) => depthAt(p.zshift, d));
          list[shownDir] = z;
          // the client's furni face 0, 2, 4 and 6; the direction after each takes the same depth, as Sulake's lists do
          if (shownDir % 2 === 0) list[shownDir + 1] = z;
          change(`depth ${z} in direction ${shownDir}`, { zshift: list });
        };
        return (
          <div key={letter} className={`lp-row${layer && selected === layer.slot ? ' selected' : ''}`}>
            <button className="lp-thumb" onClick={() => layer && onSelect(layer.slot)} title={layer ? layer.name : `Layer ${letter} shows nothing in this state`}>
              <span className="layer-name" style={{ '--hue': hue(letter) } as React.CSSProperties}>{letter}</span>
              {layer ? <Thumb doc={doc} slot={layer.slot} header={furni.bySlot.get(layer.slot)!.bitmap!} flip={layer.flip} rev={rev} /> : <span className="empty-frame">empty</span>}
            </button>
            <div className="lp-fields">
              <div className="row">
                <label title={INKS.find((k) => k.ink === p.ink)?.hint ?? 'A Director ink number'}>
                  drawn
                  <select value={p.ink} onChange={(e) => change(INKS.find((k) => k.ink === +e.target.value)?.name ?? `ink ${e.target.value}`, { ink: +e.target.value })}>
                    {INKS.map((k) => <option key={k.ink} value={k.ink} title={k.hint}>{k.name}</option>)}
                    {!INKS.some((k) => k.ink === p.ink) && <option value={p.ink}>ink {p.ink}</option>}
                  </select>
                </label>
                {p.ink === 41 && (
                  <label title={`Part colour ${i + 1} of the furni's definition (items_definitions.colour): what this layer is tinted with. A colour variant of the furni (${furni.className()}*2…) is another list of these`}>
                    colour
                    <input type="color" value={/^#[0-9a-f]{6}$/i.test(colourList[i] ?? '') ? colourList[i] : '#ffffff'} onChange={(e) => setColour(i, e.target.value)} />
                  </label>
                )}
                <label title="How solid it is: 100 = solid, lower lets what is behind show through">
                  solid
                  <input type="range" min={0} max={100} step={5} value={p.blend} onChange={(e) => change(`${e.target.value}% solid`, { blend: +e.target.value })} />
                  <span className="lp-num">{p.blend}%</span>
                </label>
              </div>
              <div className="row">
                {!wall && (
                  <>
                    <label title="Depth (#zshift): higher is drawn further in front. Layers start a step apart (a, b, c...); a Habbo on the same tile sits between them, so a seat's back usually gets a low depth and its arm rests a high one">
                      depth
                      <input type="number" step={1} value={depth} onChange={(e) => setDepth(Math.round(+e.target.value || 0), !perDirection)} />
                    </label>
                    <label className="chip" title="One depth for every direction, or its own per direction (a chair's back is behind you from the front and in front of you from the back): turn the room to set each">
                      <input type="checkbox" checked={perDirection} onChange={(e) => (e.target.checked ? change('its own depth per direction', { zshift: Array.from({ length: 8 }, () => depth) }) : change(`depth ${depth} in every direction`, { zshift: [depth] }))} />per direction{perDirection ? ` (now ${shownDir})` : ''}
                    </label>
                  </>
                )}
                <label className="chip" title="Clicks go through this layer to what is behind it (glows, shadows, big see-through parts)">
                  <input type="checkbox" checked={p.clickThrough} onChange={(e) => change(e.target.checked ? 'clicks go through' : 'takes clicks', { clickThrough: e.target.checked })} />clicks pass
                </label>
                <span className="spacer" />
                {!wall && setup.letters.length > 1 && (
                  <button
                    className="icon ghost danger"
                    title={`Delete layer ${letter}: its pictures and settings${i < setup.letters.length - 1 ? '; the layers after it move up a letter' : ''}`}
                    onClick={() => {
                      if (!confirm(`Delete layer ${letter} with all its pictures?`)) return;
                      let summary = '';
                      edit(`Deleted layer ${letter}`, () => {
                        summary = deleteLayer(doc, furni, letter, setup.letters);
                      });
                      if (summary) setStatus(summary);
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
