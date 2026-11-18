# Habbo Danmark on DirPlayer (fork-specific)

Tooling for running the Habbo Danmark Shockwave client (`habbo.dcr` from images.habbo-danmark.com) in the
browser with DirPlayer. Everything Habbo-specific lives in this folder, so the fork stays easy to rebase on
`upstream/main`.

## Local dev harness

Prereqs: a local Odin server (game `127.0.0.1:12321`, MUS `12322`) with its DB, and a built polyfill.

```bash
export PATH=/opt/homebrew/opt/rustup/bin:$PATH   # rustup is keg-only on Homebrew
npm install
npm run build-vm && npm run build-polyfill
node habbo/dev-server.cjs                        # http://127.0.0.1:8090/?sso=<ticket>
```

Get a ticket by logging in to the local CMS and opening `/client`, or set `users.sso_ticket` in the **local**
DB.

What the harness does:
- Serves a page with the same `<embed sw1…sw6>` params as OdinCMS's `Views/Client/Index.cshtml`.
- Proxies `/assets/*` to `https://images.habbo-danmark.com`. Assets are same-origin and nothing is mirrored
  locally. `external_variables.txt` gets its asset URLs rewritten to the proxy.
- Bridges `ws://…/ws/game` and `/ws/mus` to Odin's TCP ports, through `DirPlayer.configureFlash({ socketProxy })`.
  With `NATIVE_WS` set the page talks to Odin's own WebSocket listener instead.

Env overrides: `PORT`, `ASSETS`, `GAME_HOST`, `GAME_PORT`, `MUS_PORT`, `SITE_URL`, and `NATIVE_WS` (for example
`ws://127.0.0.1:12323`): connect straight to Odin's WebSocket listener (`ws.port` in `server.ini`, paths `/game`
and `/mus`) instead of the harness's WS→TCP bridges.

Page params:
- `?sso=<ticket>`: the SSO ticket (`sw6`).
- `?forward=public,<roomId>`, `private,<roomId>` or `<type>,<id>`: room forward (`sw7`), as the CMS does it.
  For public rooms the harness adds Odin's `PUBLIC_ROOM_OFFSET` (1000), because the client navigates to the
  node id. Example: `forward=public,67` is the SnowStorm lobby.

Debug switches (env):
- `LOG_PACKETS=1`: log client→server header ids (with the start of each body) and server→client header
  counts per second, on the game socket.
- `LOG_BODIES=244,…`: with `LOG_PACKETS`, also log these server messages' bodies when they change.
- `DROP_VARS=cast.entry.27,…`: remove lines from `external_variables.txt` (experiments, e.g. freeing a cast slot).
- `SET_VARS=<file>`: `key=value` lines that replace (or add) variables in `external_variables.txt`, to try an
  `external_vars.php` change before making it on prod.
- `SET_TEXTS=<file>`: the same for `external_texts.txt` (e.g. `purse_ad_url=...` to try the purse ad).
- `LOCAL_ASSETS=<dir>`: serve a file from that folder instead of prod when its name matches the requested asset (try a
  rebuilt cast, e.g. `hh_room_private_wc.cct`, before uploading it).

## Room photographer

`photographer/`: a small service that photographs rooms (no avatars, pets, chat or interface) with this harness in
headless Chromium, for the CMS's featured rooms. See [photographer/README.md](photographer/README.md).

## Status (2026-11-16)
- Hotel view, SSO login, navigator, entering a room, room rendering and chat work.
- BattleBall and SnowStorm: full 2-player games work (lobby, create, join, start, walk, throw, score).
- Cast slots: the client has 38 dynamic cast slots. Prod's 27 `cast.entry.*` + 8 new `room.cast.*` + 4 game casts
  need 39, so a game's last cast fails to load. Fix (config only): drop `cast.entry.27=hh_window_class` and load it
  with the private room casts, `room.cast.private=["hh_room_private", "hh_room_landscapes", "hh_window_class"]`.
  Window furni only exist in private rooms, and those casts are temporary, so a game afterwards uses exactly 38.
  Test it with `DROP_VARS=cast.entry.27 SET_VARS=<file with that room.cast.private line>`.
- VM fixes so far:
  - `the displayTemplate` (Director 11 movie property) was missing, and the client reads it at start-up.
  - Assigning `ancestor` on an instance whose script doesn't declare `property ancestor` now delegates down
    the existing chain instead of replacing it. Without that the gamesystem modules lose their ID, the
    SnowStorm turn manager never gets `update` calls, and nobody can walk.
  - Multiuser: a dropped `xtra("Multiuser")` instance now closes its socket, as Director's finalizer does.
    The client's SSO login connects twice and replaces the first instance; its socket used to stay open until
    the server timed it out. `breakConnection` now really closes the socket as well.
- The polyfill is about 15 MB (6.9 MB gzipped) because the WASM is embedded.

## Habbo-specific deviations from upstream

This fork runs Habbo Danmark only. Where Habbo and another movie need opposite behaviour, Habbo wins, and the
change is listed here so a rebase onto upstream can keep or drop it on purpose.

- **No sprite tint on 32-bit bitmaps under ink 0/8/9** (WebGL2 `sprite_tints_32bit`, Canvas2D `sprite_tints` in
  `drawing.rs`). Fuse windows pass an element's `#color`/`#bgColor` to `copyPixels` (into the element's 32-bit
  buffer, which tints it) and to the sprite that shows the buffer, so tinting on the sprite too applied it twice
  (pet status window: 224 grey instead of #EFEFEF). Upstream tints there for Coke Studios' DiscoLight. Explicit
  `copyPixels` colours, text, shapes, film loops, indexed bitmaps and ink 36 are unchanged.
