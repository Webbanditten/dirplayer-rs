# Furni editor

A browser editor for Habbo furni casts (`hh_furni_xx_<class>.cct`), built on DirPlayer: the cast is read, changed
and written by Rust (`vm-rust/src/editor`, exposed as `CastDocument`), and the room preview is drawn by DirPlayer's own
sprite code, so inks, blends, mirrored members and part colours look as they do in the web client.

```bash
export PATH=/opt/homebrew/opt/rustup/bin:$PATH      # rustup is keg-only on Homebrew
npm run build-vm-dev                                 # or build-vm (release, smaller)
npx vite -c habbo/furni-editor/vite.config.js        # http://127.0.0.1:8097/
npx vite build -c habbo/furni-editor/vite.config.js  # static build in habbo/furni-editor/dist
```

## What it does

- **Open** a cast from disk (or drop it on the window), or load one by class name from the hotel's asset host
  (`https://images.habbo-danmark.com/hof_furni/`, which sends CORS headers). **Save .cct** downloads the cast,
  afterburned like Director writes it, named after its class.
- **Furni grid**: the class's layers (a, b, c...) by direction and frame, from the member names
  `<class>_<layer>_0_<length>_<width>_<direction>_<frame>` and `memberalias.index` (dashed cells; ⇋ = mirrored). Then
  the shadow (`_sd`), the icon (`_small`), the 32 px members (`s_<class>`) and anything else. `+` adds a frame (click to
  pick an image, or drop one on it), "New layer" adds a layer, "Mirror 2→4, 0→6" writes the alias lines that show
  directions 2 and 0 mirrored where 4 and 6 have no members of their own.
- **Inspector**: a bitmap's pixels with its registration point (the red cross). Drag the picture or use the arrow keys
  to move it, or type the numbers. **Replace with image** (or drop a PNG on the window) in one of three modes: *auto*
  (8-bit on the member's palette when every colour is in it, else 32-bit), *8-bit* (nearest palette colours; the status
  line says how many pixels moved) or *32-bit* with alpha. **Export PNG**, rename, duplicate, delete.
  Fields (`<class>.props`, `<class>.data`, `memberalias.index`, `asset.index`) open in a text editor that checks they
  still read as Lingo values.
- **Room preview**: the furni on a floor of tiles, any direction (or all four side by side), any `.data` state,
  animated like the client (24 updates a second), with shadow, part colours (`items_definitions.colour`; the dev server
  fetches the class's definitions and their `*n` colour variants from the CMS, `/hotel-api` → `/api/hotel`), layers
  on and off, the tiles the furni covers (as Odin counts them) and click-to-select.
- **New furni from this**: renames every member of the class, its fields and the alias and asset indexes, for a new
  furni based on an existing one.

Transparent pixels are written the way Habbo's white-keyed inks (8, 36, ...) expect: palette index 0 in an 8-bit member,
white (with alpha 0) in a 32-bit one.

## Rules it follows

The client's furni classes (habbo-vibe-playground `decompiled/hh_furni_classes`: Active Object Class, Active Object
Extension Class), as ported in the furni renderer that draws the CMS's furni pictures (habbo-vibe-playground
`tools/furni-renderer`, live on prod): `src/furni.ts` (layers, aliases, props, data, colours), `src/animation.ts`
(stepping). Geometry from hh_room's Room Geometry Class: tile (x, y) is at `((x - y) * 32, (x + y) * 16)` plus the room
offset, the tile's left corner at its vertical centre; a sprite's rect is its loc minus the registration point, a
mirrored one (rotation and skew 180) turned around it and moved 64 px right. Checked against the web client
(`mcp_eval_lingo` on placed chairs: identical locs and rects).

## Trying a cast in the hotel

Put the saved cast in the dev harness's `LOCAL_ASSETS` folder (`habbo/dev-server.cjs`) under its own name and open a
room that has the furni: the client loads it instead of the hotel's copy.

## Not done yet

- Wall items (posters, windows, `leftwall <class>` members) open and edit, but the preview only draws floor furni.
- Furni animated by their class's code (the dice, the smoke machine) don't animate in the preview.
- New members are copies of an existing bitmap or field of the cast (header, palette); a cast with neither can't get one.
- The written casts are checked by DirPlayer's reader and the web client, not by Shockwave.
