# The 32 px picker: where its numbers come from

`src/downscale.ts` makes a furni's small (32 px) pictures from its large ones: every 2x2 block becomes one of its own
four pixels, picked by a small network. `src/downscale-model.ts` holds that network's weights. They are trained here,
on the hotel's own furni: for every furni that has both `hh_furni_xx_<class>.cct` and `hh_furni_xx_s_<class>.cct`, the
large layer pictures and the small ones Sulake's artists drew from them. Nothing in this folder is needed to run or
build the editor.

The pictures are Sulake's: they stay out of the repo (`.gitignore` here covers `data/` and everything the scripts
write).

## Steps

1. **The pairs** (`pairs.ts`, needs a checkout of [shockwave-imager](https://github.com/Webbanditten/shockwave-imager)
   with its `node_modules`):

   ```sh
   NODE_PATH=<shockwave-imager>/node_modules npx esbuild pairs.ts --bundle --platform=node --format=cjs \
     --alias:shockwave-imager=<shockwave-imager> --outfile=pairs.cjs
   NODE_PATH=<shockwave-imager>/node_modules node pairs.cjs data classes.txt
   ```

   `classes.txt`: one class name a line. It writes `data/<class>/L_<member>.png`, `S_<member>.png` and `meta.json`
   (registration points, ink), pictures as the room shows them. `FURNI_HOST` says where the casts are loaded from.
2. **Samples**: `python3 feat.py` writes `train.npz`: per 2x2 block with something in it, what the network sees (the
   6 x 6 window around the block: see `features`) and what Sulake did (kept the top left, top right, bottom left or
   bottom right pixel, or nothing). Each pair is lined up by its registration points, trying both block phases and a
   pixel either way; pairs where under 30 % of the small picture is one of its block's pixels (redrawn, not
   scaled) are left out. Every fifth furni (by a hash of its name) is held out for testing; the rest is also used
   mirrored.
3. **Training** (numpy only, about two minutes): `python3 train.py train.npz 5 128,64 30 model.npz` prints the share of
   held-out blocks it picks like Sulake. Add `all` to train on the held-out furni too: that is the model that ships.
4. **Into the editor**: `python3 export_model.py model.npz ../../src/downscale-model.ts model_q.npz` folds the input
   scaling into the first layer and stores 16-bit weights; `model_q.npz` is that same model for the next step.
5. **Checks**: `python3 reference.py model_q.npz` scores whole pictures of the held-out furni against Sulake's (use a
   model trained without `all`). `python3 vectors.py model_q.npz vectors.json`, then
   `npx esbuild parity.ts --bundle --platform=node --format=cjs --outfile=parity.cjs && node parity.cjs vectors.json`
   compares `src/downscale.ts` with `reference.py` pixel by pixel: it must say 0 differ.

`DS32_DATA` points the Python scripts at the `data` folder when it is somewhere else.

## The numbers (November 2026)

1,366 furni with both sizes, 8,295 picture pairs, 6,743 of them used; 6.2 million blocks with the mirrored ones.

- Blocks of 256 held-out furni picked like Sulake: 65.8 % (always taking the first pixel: 54.6 %). Two thirds of
  Sulake's small pixels are one of their block's four pixels at all; the rest is redrawn by hand.
- Whole pictures of the held-out furni (1,389), against Sulake's small picture:

  | | inside pixels the same | small details the same |
  |---|---|---|
  | the editor's earlier halving (darkest pixel wins, else the commonest) | 48.4 % | 32.6 % |
  | picked | 50.9 % | 35.4 % |

  The numbers are low for both because a hand-drawn picture rarely matches pixel for pixel; what the eye sees is a
  1 px outline instead of a doubled one, and eyes and highlights that are still there.
- Tried and not kept: picking from the 4 x 4 around the block as well (16 candidates: no better), a per-furni choice
  of the block grid by how sure the network is or by how few blocks it cuts (both worse than the grid counted from
  the registration point, which is within 0.01 of the best grid per furni).
