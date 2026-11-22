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

Published at **https://webbanditten.github.io/dirplayer-rs/furni-editor/** (GitHub Pages of the fork, branch
`gh-pages`): `habbo/furni-editor/deploy-pages.sh` builds the release VM and the editor and force-pushes them there as one
commit (`SKIP_VM=1` when `vm-rust/pkg` is already a release build). Only the editor's files are published; casts load
from the asset host at runtime (it sends CORS headers). The hotel's colour variants come through the dev server's
`/hotel-api` proxy, so on Pages the preview has no hotel colours (type them, or they come from an imported Flash file).

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
- **Import Flash furni**: a Flash-era furni (`<sprite>.swf`, button or drop it on the window) becomes a Shockwave cast,
  ready to save and edit; "32 px" also converts the small pictures (`s_` members). See below.
- The room can be drawn on a transparent background (rendered on black and on white, alpha from the difference), and
  **Save picture** downloads it as a PNG.
- **Undo and redo** (toolbar, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y) for every change, the 64 and 32 px cast
  together: before a change the casts it touches are copied in memory (`CastDocument.snapshot()`), undo swaps the copy
  back in and keeps the current one for redo. A painting session and arrow-key nudges of a registration point are one
  step each (Paint keeps its own stroke-by-stroke undo while it's open). Undoing back to the saved state marks the cast
  clean again. At most 80 steps or ~190 MB.
- **Autosave**: while a cast has unsaved changes, both casts are kept in this browser's IndexedDB (2 s after the last
  change); after a reload or a crash the start page offers to restore them. Cleared once everything is saved or
  published. The undo history isn't kept.
- **Check furni** (toolbar; the badge counts errors, else warnings): Housekeeping's rules (lower-case class, bitmaps,
  fields and palettes only, no scripts, only the furni's own member names, asset.index's `#id` and classes, alias lines
  naming only the furni's own members), and what the client would draw differently: aliases to members that aren't
  there, bitmaps whose palette member isn't a palette, fields that don't read as Lingo, no layer a, odd directions,
  layers never drawn (the client stops at the first missing letter unless .data lists the layer), a layer missing a
  direction the others have (the client shows its direction 0 picture), frame gaps, frames .data asks for that aren't
  there, no icon, no shadow, no 32 px cast, and 32 px pictures missing for large ones. "Show" selects the member (in the
  other size when needed); some rows can be fixed from the list. Publishing to Housekeeping waits until there are no
  errors. On 140 hotel furni the drawing checks found nothing but real gaps (the hotel's 32 px chair_norja has no
  layer b and c for direction 4).
- **Make icon** (the picture button under the room): `<class>_small`, the picture the hand, trades and the catalogue
  show, from the preview's direction, state and part colours at 32 px (the 32 px cast's own pictures when it's open,
  else the large ones halved), cut out on transparency, in both casts. A drawn icon's colour parts (`_small_c`) are
  removed, since the client would tint them over the new picture.

Transparent pixels are written the way Habbo's white-keyed inks (8, 36, ...) expect: palette index 0 in an 8-bit member,
white (with alpha 0) in a 32-bit one.

## Paint and palettes

**How Shockwave stores colours.** An 8-bit bitmap member stores one palette *index* per pixel; the colours come from a
palette: a built-in one (System Mac, System Win, Grayscale, ...) or a palette member of the cast (a `CLUT` of 256
colours; the bitmap's header points at it by member number, `clutCastLib` -1 = the same cast, as in every Habbo cast).
Several bitmaps can share a palette member, so changing one of its colours changes all of them. Index 0 is white in
Director's palettes and is the background the white-keyed inks drop (8 matte: where it touches the edge, 36 everywhere).
Habbo's tinted layers (ink 41: the client swaps white for the part colour, black stays) are grey, often on the built-in
Grayscale palette, as chair_norja's seat. A 32-bit member has no palette: colours and alpha per pixel.

**Paint** (Paint… in the inspector, or double-click a member in the grid or list) draws on the member's own pixels:
indices for an 8-bit member, colours with alpha for a 32-bit one. The room preview stays beside it and follows every
stroke.

- Tools like Windows XP Paint: pencil, brush, eraser (index 0 / transparent), fill, colour picker, magnifier, airbrush,
  line (Shift: 45°), rectangle and ellipse (outline, outline + fill, fill; Shift: square/circle), a radial gradient, and
  a registration point tool; Blur (radius 1 to 8). Left button = primary colour, right button = secondary. Letters pick tools (P, B, E, F, K, Z, A, L, R, O,
  G), Ctrl/Cmd+Z / Y undo and redo, Esc closes.
- Colour box: the member's palette (256 swatches; double-click one to change that palette colour; a built-in palette has
  to be copied first) or, for 32-bit, XP's colours, transparent and a custom colour.
- Palette: switch the member to another palette (with "remap colours" each index goes to the nearest colour, so the
  picture looks the same; without it the indices stay and the colours change), **New palette…** (a copy, one from the
  picture's colours (median cut, white at 0 and black at 255), or a grey ramp for tinted layers), **Make 32-bit** /
  **Make 8-bit on…** (a palette of the cast, a built-in one, or a new one from the picture).
- Image: flip (the registration point flips with it), canvas size with an anchor (bottom keeps the furni on its tile).

A new palette member is written the way Director writes them (a named `CASt` of type 4 without specific data, and a
256-entry `CLUT`). Checked in the web client: chair_norja's seat moved onto a new palette with a changed entry draws the
same as in the preview.

## Lights (the glow of the dragon lamp and the HC lamps)

Sulake's lamps have no blur: the glow is an extra layer drawn with **ink 33 (Add Pin)**, which adds its colours to what
is under it. Its picture is black (adds nothing) with a soft bright spot (adds light), so it lights up the furni, the
floor and the wall behind; `#transparent: 1` lets clicks through. rare_dragonlamp's layer g is a yellow halo, hc2_biglamp's
layer c a large teal pool of light on the floor, hc_lmp's layer c a warm glow (on white, the background colour the ink
drops). A lamp shows it only when on: in `.data` the layer's frame is 0 (a 1x1 "nothing") off and 1 on; a flickering
flame is another layer with a blend and a looping frame list.

**Add light…** (in the furni grid) makes such a layer: a halo around a point or a floor light (a flattened pool on the
furni's tiles, drawn below the furni and above its shadow), its colour, strength, radius and centre (relative to the
tile point), always or in one state (a furni without `.data` gets one with "off" and "on"; the hotel only switches it
when the furni's definition can be turned on and off). It writes:

- the picture, 8-bit on a new light palette: index 1 black up to index 255 at the light's colour, so index = brightness;
- `.props` `#ink: 33, #transparent: 1` (+ `#zshift: [-1000]` for a floor light), `.data` the frames per state;
- memberalias.index names for the furni's other directions (mirrored where the furni is, which mirrors the light around
  the tile with it).

Then in Paint: **light colour** (on a light palette) makes the ramp again in another colour; the **radial gradient** tool
(drag from the centre, primary to secondary) paints more glow; **Blur** softens any picture (draw a bright shape on black
and blur it). A light only adds brightness, so it nearly vanishes over the preview's transparent background: untick
"transparent" to see it against a colour.

## Flash furni

`src/flash.ts` (rules) on top of the Rust `SwfDocument` (`vm-rust/src/editor/swf.rs`: binary data, symbol names,
lossless and JPEG bitmaps, alpha un-premultiplied; zlib `CWS` and plain `FWS` files, not LZMA `ZWS`). The XML
(`_assets`, `_logic`, `_visualization`, `_index`) and the pictures, exported as `<sprite>_<asset>`, map to the Shockwave
client's conventions the way the hotel's own converted casts have them (cf. Quackster's Elias, which does the same with
JPEXS, swfmill and a Director projector):

| Flash | Shockwave cast |
|---|---|
| `<sprite>_64_<layer>_<dir>_<frame>`, x, y | `<sprite>_<layer>_0_<x>_<y>_<dir>_<frame>` (logic.xml dimensions), registration point (x − 32, y) |
| `_32_` pictures | `s_<sprite>_...`, (x − 16, y) |
| `_64_sd_<dir>_0` / `_icon_a`, `_icon_<l>` | `<sprite>_sd_<dir>` / `<sprite>_small`, `<sprite>_small_<l>` |
| `source` (+ `flipH`) with the source's offsets | `memberalias.index` line (`*` = mirrored) |
| `source` with other offsets | a member of its own (mirrored copy: registration x = width − x − 32) |
| layer `z`, per-direction `z` | `#zshift: [z]`, 8 entries (direction d and d + 1) |
| `alpha`, ink `ADD`/`SUBTRACT`/`LIGHTEN`/`DARKEN`, `ignoreMouse` | `#blend` (alpha / 255 × 100), `#ink` 33/35/37/39, `#transparent: 1` |
| layers in `<colors>` | `#ink: 41` (tinted by the part colour) |
| `<animations>` (id < 100) | `.data`: animation n = state n + 1; `frames`, `loop` (loopCount), `delay` (frameRepeat), `random` |
| `<colors>` | the preview's colour variants, as `items_definitions.colour` strings |

Pictures are stored 32-bit with their alpha. Every layer and direction gets a frame 0 (a 1x1 placeholder if Flash has
none), which the client's layer detection needs. The cast itself is built from a template, the hotel's
`hh_furni_xx_chair_norja.cct` (localStorage `furniEditor.template` picks another), whose members are replaced, so the
container and chunk layout are Director's. Checked: chair_norja.swf gives Sulake's chair_norja cast (same member names
and registration points, same aliases and zshift); rare_dragonlamp, tv_flat and ads_calip_lava look like the hotel's
casts in the preview, and the converted lava lamp, dragon lamp and sofa load and draw in the web client.

Not converted: wall items (their `leftwall`/`rightwall` naming), transition animations (ids 100+), Flash inks without a
Shockwave equivalent (MULTIPLY, SCREEN; reported in the status line).

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
