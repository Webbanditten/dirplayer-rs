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

## Status (2026-11-16)
- Hotel view, SSO login, navigator, entering a room, room rendering and chat work.
- VM fix needed so far: `the displayTemplate` (Director 11 movie property) was missing, and the client reads
  it at start-up.
- The polyfill is about 15 MB (6.9 MB gzipped) because the WASM is embedded.
