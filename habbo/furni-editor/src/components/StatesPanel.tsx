import type React from 'react';
import { useState } from 'react';
import type { CastDocument } from '../../../../vm-rust/pkg/vm_rust.js';
import { Icon } from './Icon';
import { Thumb } from './Thumb';
import { furniSetup, isWallItem, stateNames, type Furni } from '../furni';
import { addState, framesOf, ownName, readData, removeState, renameState, setStateEntry, stateCount, stateEntry } from '../layers';
import { FPS } from '../animation';
import type { Edit } from '../App';

interface Props {
  doc: CastDocument;
  furni: Furni;
  rev: number;
  edit: Edit;
  direction: number;
  /** the state the room shows (0-based), and switching it */
  state: number;
  setState: (s: number) => void;
  setStatus: (s: string) => void;
}

const hue = (letter: string) => (28 + (letter.charCodeAt(0) - 97) * 67) % 360;

/**
 * The States tab: what the furni looks like in each state (a lamp's off and on), and which layers move: a layer shows
 * one frame, or steps through several. Instead of writing `.data` by hand.
 */
export function StatesPanel({ doc, furni, rev, edit, direction, state, setState, setStatus }: Props) {
  const [picking, setPicking] = useState<string | null>(null);
  const wall = isWallItem(furni);
  const setup = furniSetup(furni, { direction, state, shadow: false });
  if (!setup) return <p className="hint">No layers yet: add a picture in the Furni tab.</p>;
  const data = readData(furni);
  const letters = setup.letters;
  const count = stateCount(data);
  const names = data ? stateNames(data) : ['the only look'];
  const shown = Math.min(state, count - 1);
  const cls = ownName(furni);
  const memberOf = (letter: string, frame: number) =>
    wall
      ? furni.bitmap(`${furni.isSmallCast() ? 's_' : ''}${setup.direction === 4 ? 'rightwall' : 'leftwall'} ${furni.className()}_${letter}_${frame}`)
      : furni.bitmap(`${cls}_${letter}_0_${setup.dims[0]}_${setup.dims[1]}_${setup.direction}_${frame}`) ?? furni.bitmap(`${cls}_${letter}_0_${setup.dims[0]}_${setup.dims[1]}_0_${frame}`);

  const newState = (name?: string) => {
    edit(`Added state ${count + 1}`, () => addState(doc, furni, letters, shown, name));
    setState(count);
    setStatus(`State ${count + 1} starts as a copy of state ${shown + 1}: change what its layers show. In the hotel a furni switches states when its definition can be used (the kind "Lamp / switches on and off" when publishing)`);
  };

  return (
    <div className="states-panel">
      <p className="hint">
        What the furni shows in each state, and what moves. {count === 1 ? 'It has one state: add another to make it switchable (a lamp: off and on).' : 'Pick a state to edit; the room shows it.'}
      </p>
      <div className="sp-states">
        {Array.from({ length: count }, (_, i) => (
          <button key={i} className={`sp-state${i === shown ? ' on' : ''}`} onClick={() => setState(i)} title={`State ${i + 1}`}>
            <b>{i + 1}</b>{names[i] && !/^state \d+$/.test(names[i]) ? names[i] : ''}
          </button>
        ))}
        <button className="sp-state add" onClick={() => newState(count === 1 && !data ? 'on' : undefined)} title="A new state, starting as a copy of this one">
          <Icon name="plus" size={12} />state
        </button>
      </div>
      {count > 1 && (
        <div className="row sp-state-edit">
          <label title="A name for the state (statestrings), for you: the hotel goes by its number">
            name
            <input key={`${shown}:${rev}`} defaultValue={/^state \d+$/.test(names[shown] ?? '') ? '' : names[shown]} placeholder={`state ${shown + 1}`} onBlur={(e) => e.target.value !== (names[shown] ?? '') && edit(`Named state ${shown + 1}`, () => renameState(doc, furni, letters, shown, e.target.value))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          </label>
          <span className="spacer" />
          <button
            className="ghost danger"
            onClick={() => {
              if (!confirm(`Delete state ${shown + 1}${names[shown] ? ` (${names[shown]})` : ''}?`)) return;
              edit(`Deleted state ${shown + 1}`, () => removeState(doc, furni, letters, shown));
              setState(Math.max(0, shown - 1));
            }}
          >
            <Icon name="trash" size={14} />Delete state
          </button>
        </div>
      )}
      {letters.map((letter) => {
        const e = stateEntry(data, letter, shown);
        const all = framesOf(furni, letter, setup.direction);
        const available = all.length ? all : framesOf(furni, letter, 0);
        const moves = e.frames.length > 1 || e.sequences;
        const change = (what: string, c: Parameters<typeof setStateEntry>[5]) => edit(`Layer ${letter}, state ${shown + 1}: ${what}`, () => setStateEntry(doc, furni, letters, letter, shown, c), { group: `data:${letter}:${shown}:${Object.keys(c).join()}` });
        return (
          <div key={letter} className="sp-row">
            <span className="layer-name" style={{ '--hue': hue(letter) } as React.CSSProperties}>{letter}</span>
            <div className="sp-body">
              <div className="sp-frames">
                {e.frames.map((f, i) => {
                  const m = f >= 0 ? memberOf(letter, f) : undefined;
                  const b = m?.member.bitmap;
                  return (
                    <span key={i} className={`sp-frame${m ? '' : ' missing'}`} title={f < 0 ? `A random frame from 1 to ${-f}` : m ? `Frame ${f}: ${m.member.name}` : `Frame ${f}: no picture (the layer shows nothing)`}>
                      {m && b && (b.width > 1 || b.height > 1) ? <Thumb doc={doc} slot={m.slot} header={b} flip={m.flip} rev={rev} /> : <span className="empty-frame">{m ? 'empty' : '?'}</span>}
                      <span className="frame-no">{f}</span>
                      {e.frames.length > 1 && <button className="sp-x" onClick={() => change(`frame ${f} taken out`, { frames: e.frames.filter((_, k) => k !== i) })} title="Take it out of the sequence">×</button>}
                    </span>
                  );
                })}
                <button className="add" onClick={() => setPicking(picking === letter ? null : letter)} title={e.frames.length > 1 ? 'Add a frame to the sequence' : 'Show another frame, or add frames to make it move'}>+</button>
              </div>
              {picking === letter && (
                <div className="sp-pick">
                  <span className="muted small">{available.length ? 'Click a frame: add it to the sequence (Alt-click: show only that one)' : 'This layer has no pictures in this direction'}</span>
                  <div className="sp-frames">
                    {available.map((f) => {
                      const m = memberOf(letter, f);
                      const b = m?.member.bitmap;
                      return (
                        <button
                          key={f}
                          className="sp-frame pick"
                          title={m?.member.name}
                          onClick={(ev) => {
                            const only = ev.altKey || (e.frames.length === 1 && e.frames[0] === 0 && f === 0);
                            change(only ? `shows frame ${f}` : `frame ${f} added`, { frames: only ? [f] : [...e.frames, f], ...(only || e.frames.length !== 1 ? {} : { loop: 0, delay: Math.max(e.delay, 4) }) });
                          }}
                        >
                          {m && b && (b.width > 1 || b.height > 1) ? <Thumb doc={doc} slot={m.slot} header={b} flip={m.flip} rev={rev} /> : <span className="empty-frame">empty</span>}
                          <span className="frame-no">{f}</span>
                        </button>
                      );
                    })}
                  </div>
                  {e.frames.length > 1 && <button className="ghost" onClick={() => change('one frame', { frames: [e.frames[0]] })}>Stop it moving (keep frame {e.frames[0]})</button>}
                </div>
              )}
              {e.sequences && <span className="muted small">This state has several sequences picked at random (<code>sequences</code>): edit them in {cls}.data; changing the frames here replaces them with one sequence.</span>}
              {moves && !e.sequences && (
                <div className="row sp-timing">
                  <label title={`The client updates ${FPS} times a second: a frame stays for this many updates`}>
                    each frame for
                    <input type="number" min={1} max={240} value={e.delay} onChange={(ev) => change(`each frame for ${ev.target.value} updates`, { delay: Math.max(1, Math.round(+ev.target.value || 1)) })} />
                    <span className="muted small">/{FPS} s ({(FPS / e.delay).toFixed(e.delay > FPS ? 2 : 1)} a second)</span>
                  </label>
                  <label>
                    plays
                    <select value={e.loop === null ? 'once' : e.loop === 0 ? 'forever' : 'times'} onChange={(ev) => change(ev.target.value === 'forever' ? 'plays forever' : ev.target.value === 'once' ? 'plays once' : 'plays 2 times', { loop: ev.target.value === 'forever' ? 0 : ev.target.value === 'once' ? null : 2 })}>
                      <option value="forever">forever</option>
                      <option value="once">once, then stays on the last frame</option>
                      <option value="times">a number of times</option>
                    </select>
                    {e.loop !== null && e.loop > 0 && <input type="number" min={1} max={99} value={e.loop} onChange={(ev) => change(`plays ${ev.target.value} times`, { loop: Math.max(1, Math.round(+ev.target.value || 1)) })} />}
                  </label>
                  <label className="chip" title="Frames in a random order instead of one after another (flames, sparkles)"><input type="checkbox" checked={e.random} onChange={(ev) => change(ev.target.checked ? 'random order' : 'in order', { random: ev.target.checked })} />random</label>
                </div>
              )}
            </div>
          </div>
        );
      })}
      {!data && <p className="hint">Nothing is written until you change something: a furni with one still look needs no <code>{cls}.data</code>.</p>}
    </div>
  );
}
