/**
 * A furni's inventory icon (`<class>_small`): the hand, the trade window and the catalogue show that member's image as
 * it is (hh_furni_classes Item Object Class, Preview Renderer Class), at the 32 px room scale. The hotel's icons were
 * drawn by hand; this one is the furni as the room draws it, in the direction, state and colours the preview shows,
 * cut to its pixels on a transparent background.
 */
import type { CastDocument } from './wasm';
import { floorSetup, type Furni } from './furni';
import { composite, fitRoom, roomLayout } from './room';
import { halve } from './paint';

export interface IconView {
  direction: number;
  state: number;
  colors: string;
}

export interface IconImage {
  rgba: Uint8Array;
  width: number;
  height: number;
  /** the direction actually drawn */
  direction: number;
}

function solid(w: number, h: number, v: number) {
  const px = new Uint8Array(w * h * 4).fill(v);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  return px;
}

/** Render the furni alone, transparent, cropped; a 64 px cast is halved to the icon scale. */
export function renderIcon(doc: CastDocument, furni: Furni, view: IconView, small: boolean): IconImage | null {
  const setup = floorSetup(furni, { ...view, shadow: false, small });
  if (!setup) return null;
  const span = Math.max(setup.dims[0], setup.dims[1]) + 1;
  const placement = { x: 1, y: 1, layers: setup.layersAt() };
  const room = fitRoom(roomLayout({ cols: span + 1, rows: span + 1 }, small ? 32 : 64), [placement], 2);
  const img = composite(doc, room, solid(room.width, room.height, 0), [placement], solid(room.width, room.height, 255));
  const { width: w, height: h, data } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  let px = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const s = ((y + y0) * w + x + x0) * 4, d = (y * cw + x) * 4;
      if (data[s + 3] > 8) px.set([data[s], data[s + 1], data[s + 2], data[s + 3]], d);
      else px.set([255, 255, 255, 0], d);
    }
  }
  let out = { w: cw, h: ch };
  if (!small) {
    const half = halve({ kind: 'rgba', w: cw, h: ch, px }, []);
    px = half.px;
    out = { w: half.w, h: half.h };
  }
  return { rgba: px, width: out.w, height: out.h, direction: setup.direction };
}

/** The members of a furni's icon: `<class>_small` and its colour parts (`<class>_small_c`, ...). */
export function iconMembers(furni: Furni): { slot: number; name: string }[] {
  const base = furni.className().toLowerCase() + '_small';
  return furni.members.filter((m) => m.type === 'bitmap' && (m.name.toLowerCase() === base || m.name.toLowerCase().startsWith(base + '_'))).map((m) => ({ slot: m.slot, name: m.name }));
}
