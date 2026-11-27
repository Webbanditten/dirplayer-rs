/**
 * A Habbo in the preview room: standing beside the furni (for its size), sitting on it or lying on it, placed the way
 * the client places one (hh_human "Human Class"):
 *
 * - Its picture is a canvas (`human.canvas.h` 64 x 106 in a 64 px room, `sh` 32 x 62 in a 32 px one; lying 89 x 70 /
 *   62 x 40) whose registration point is (0, height - 8): the canvas hangs from the tile point with its left edge on
 *   it and its bottom 8 px below.
 * - Sitting, the server sends the seat's height (the furni definition's `top_height`); the Habbo is drawn
 *   `height - 1` levels up (a level is 32 px, 16 in the small zoom), so 1.0 is a seat at the usual height.
 * - Lying, it is also moved onto the bed by its direction (10, 30 px when drawn as direction 2, -47, 32 as 0; the
 *   small zoom -10, 18 and -17, 18).
 * - Its depth is its tile's (1000 per tile further front) plus 2, lying plus 2000 more: a furni layer whose depth
 *   (`#zshift` plus its place among the layers) is above that is drawn in front of the Habbo, the rest behind.
 *
 * The picture comes from the hotel's own Habbo pictures (`/habbo-imaging/avatarimage`, drawn from the game's casts
 * like the client draws a Habbo): Avatara's frame is the client's canvas 4 px lower (64 x 110), cut 7 px at the top in
 * the small size (32 x 55).
 */

export type HabboPose = 'none' | 'stand' | 'sit' | 'lay';

export interface HabboPicture {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

/** A plain figure for the preview (the hotel's 25-digit look). */
export const DEFAULT_FIGURE = '1000118001270012900121001';

const cache = new Map<string, Promise<HabboPicture | null>>();

export function habboUrl(site: string, figure: string, pose: Exclude<HabboPose, 'none'>, direction: number, small: boolean) {
  const action = pose === 'stand' ? 'std' : pose;
  return `${site.replace(/\/$/, '')}/habbo-imaging/avatarimage?figure=${figure}&action=${action}&direction=${direction}&head_direction=${direction}&size=${small ? 's' : 'b'}`;
}

/** The picture's pixels (null when the hotel can't be reached or doesn't let other pages read its pictures). */
export function loadHabbo(url: string): Promise<HabboPicture | null> {
  let p = cache.get(url);
  if (!p) {
    p = new Promise<HabboPicture | null>((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          resolve({ rgba: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height });
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
    cache.set(url, p);
  }
  return p;
}

/** Where the picture's top left goes for a Habbo on a tile at (locH, locV), `seat` = the seat's height (sitting or
 *  lying; 1.0 = the usual height). */
export function habboRect(pose: Exclude<HabboPose, 'none'>, small: boolean, picture: HabboPicture, locH: number, locV: number, seat: number, direction = 2) {
  const level = small ? 16 : 32;
  const lift = pose === 'stand' ? 0 : Math.round((seat - 1) * level);
  if (pose === 'lay') {
    // Lying, the client moves the Habbo onto the bed by its direction (action_lay: the directions drawn as 2, and
    // those drawn as 0).
    const as2 = [1, 2, 3, 4, 5].includes(direction);
    const [dx, dy] = small ? (as2 ? [-10, 18] : [-17, 18]) : as2 ? [10, 30] : [-47, 32];
    return { left: locH + dx, top: locV - lift + dy - (picture.height - 8) };
  }
  // Avatara's frame around the client's canvas: 4 px taller (64 x 110 around 64 x 106), 7 px shorter in the small size.
  const canvasHeight = small ? 62 : 106;
  const frameOffset = picture.height - canvasHeight; // +4, or -7
  return { left: locH, top: locV - lift - (canvasHeight - 8) - frameOffset };
}

/** The Habbo's depth, from the tile it is on: `tiles` = x + y of that tile. */
export const habboDepth = (tiles: number, pose: HabboPose) => 1000 * (tiles + 1) + 2 + (pose === 'lay' ? 2000 : 0);

/** Draw a picture over `dst` (RGBA, opaque), alpha blended. */
export function blendOnto(dst: Uint8Array, dw: number, dh: number, src: HabboPicture, left: number, top: number) {
  for (let y = 0; y < src.height; y++) {
    const ty = y + top;
    if (ty < 0 || ty >= dh) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = x + left;
      if (tx < 0 || tx >= dw) continue;
      const s = (y * src.width + x) * 4, d = (ty * dw + tx) * 4;
      const a = src.rgba[s + 3];
      if (!a) continue;
      if (a === 255) {
        dst[d] = src.rgba[s];
        dst[d + 1] = src.rgba[s + 1];
        dst[d + 2] = src.rgba[s + 2];
      } else {
        for (let k = 0; k < 3; k++) dst[d + k] = Math.round((src.rgba[s + k] * a + dst[d + k] * (255 - a)) / 255);
      }
      dst[d + 3] = 255;
    }
  }
}
