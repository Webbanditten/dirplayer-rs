/**
 * Furni animation stepped like the client: the room calls update on every furni once per movie frame (24 a second,
 * Fuse's system.tempo). Each `.data` layer counts updates and moves to its next frame every `delay` of them. `loop: 0`
 * repeats forever, `loop: n` plays n times, no `loop` plays once and stays on the last frame; `sequences` picks another
 * sequence at random at the end of one, `random` picks frames at random, a frame -n is random(n), a `blend` list sets
 * the blend per frame. Ported from the furni renderer (animation.mts), with Lingo's random() live instead of seeded.
 */
import { prop, numberList, type LingoValue } from './lingo';
import { layerData, type FrameChoice } from './furni';

export const FPS = 24;

interface LayerAnim {
  frames: number[] | null;
  sequences: number[][] | null;
  delay: number;
  random: boolean;
  blend: number[] | null;
  loopCount: number;
  frameNumber: number;
  frameNumber2: number;
  repeat: number;
  animating: boolean;
  seq: number;
}

const random = (n: number) => 1 + Math.floor(Math.random() * Math.max(1, n));

function layerAnim(data: LingoValue, letter: string, state: number): LayerAnim | null {
  const states = layerData(data, letter);
  if (!Array.isArray(states) || states.length === 0) return null;
  const entry = states[state < states.length ? state : 0];
  const frames = numberList(prop(entry, 'frames')) ?? null;
  const seqList = prop(entry, 'sequences');
  const sequences = Array.isArray(seqList) ? seqList.map((s) => numberList(s) ?? [0]) : null;
  if (!frames && !sequences) return null;
  const delay = Number(prop(entry, 'delay') ?? 1);
  const loop = prop(entry, 'loop');
  return {
    frames,
    sequences,
    delay: Number.isFinite(delay) && delay >= 1 ? Math.floor(delay) : 1,
    random: prop(entry, 'random') !== undefined,
    blend: numberList(prop(entry, 'blend')) ?? null,
    loopCount: loop !== undefined ? Number(loop) - 1 : 1,
    frameNumber: 1,
    frameNumber2: 1,
    repeat: 1,
    animating: true,
    seq: 1,
  };
}

function step(l: LayerAnim) {
  if (!l.animating) return;
  if (l.repeat >= l.delay) {
    let loop = 1;
    const list = l.frames ?? l.sequences?.[l.seq - 1] ?? [];
    const count = list.length;
    const seqCount = l.frames ? 0 : (l.sequences?.length ?? 0);
    if (count > 0) {
      if (l.frameNumber === count) {
        if (l.loopCount > 0) l.loopCount--;
        loop = l.loopCount;
        if (l.loopCount === 0) l.animating = false;
      }
      if (l.frameNumber < count || loop) {
        if (seqCount > 0 && l.frameNumber === count) {
          l.seq = random(seqCount);
          l.frameNumber = 1;
        } else {
          l.frameNumber = (l.frameNumber % count) + 1;
        }
        if (l.random && count > 1) {
          let v = random(count);
          if (v === l.frameNumber2) v = (l.frameNumber2 % count) + 1;
          l.frameNumber2 = v;
        } else {
          l.frameNumber2 = l.frameNumber;
        }
      }
    }
    l.repeat = 1;
    return;
  }
  l.repeat++;
}

function shown(l: LayerAnim) {
  const list = l.frames ?? l.sequences?.[l.seq - 1] ?? [0];
  let frame = list[l.frameNumber2 - 1] ?? 0;
  if (frame < 0) frame = random(-frame);
  const blend = l.blend && l.blend.length >= l.frameNumber2 ? l.blend[l.frameNumber2 - 1] : undefined;
  return { frame, blend };
}

/** One furni's layer animations in one state. */
export class Animator {
  private anims = new Map<string, LayerAnim>();
  /** updates since the state was set */
  tick = 0;

  constructor(data: LingoValue, letters: string[], state: number) {
    for (const letter of letters) {
      const a = layerAnim(data, letter, state);
      if (a) this.anims.set(letter, a);
    }
  }

  /** True when some layer has more than one frame to show. */
  get moves(): boolean {
    for (const a of this.anims.values()) {
      if ((a.frames && a.frames.length > 1) || (a.sequences && (a.sequences.length > 1 || a.sequences[0].length > 1))) return true;
    }
    return false;
  }

  /** The frame each animated layer shows now. */
  choice(): FrameChoice {
    const now = new Map<string, { frame: number; blend?: number }>();
    for (const [letter, a] of this.anims) now.set(letter, shown(a));
    return (letter) => now.get(letter);
  }

  step() {
    for (const a of this.anims.values()) step(a);
    this.tick++;
  }
}
