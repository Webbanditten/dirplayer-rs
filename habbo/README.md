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
  This is temporary, until Odin has a native WebSocket listener.

Env overrides: `PORT`, `ASSETS`, `GAME_HOST`, `GAME_PORT`, `MUS_PORT`, `SITE_URL`.

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
- The polyfill is about 15 MB (6.9 MB gzipped) because the WASM is embedded.
