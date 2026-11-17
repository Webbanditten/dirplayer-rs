# Room photographer

Photographs a Habbo room as the client draws it, without avatars, pets, chat bubbles or interface, for featured
rooms and news. The CMS asks for a photo and gets a job id back straight away; a photo takes 15–25 seconds.

```
POST /jobs                {"roomId": 1241, "roomType": "private"|"public", "sso": "<ticket>"}  -> 202 {"id": ...}
GET  /jobs/<id>           {"status": "queued"|"running"|"done"|"failed", "error", "width", "height", "clipped"}
GET  /jobs/<id>/photo.png the photo: transparent background, cropped to the room
GET  /health
```

Every call but `/health` needs `Authorization: Bearer <API_TOKEN>` when `API_TOKEN` is set. Jobs are kept for 30
minutes, in memory only.

## How it works

- `server.cjs` starts `../dev-server.cjs` (the DirPlayer harness: test page, asset proxy, WebSocket→TCP bridge to Odin)
  and works its queue one job at a time in headless Chromium. The browser closes after a minute without jobs.
- The ticket is a fresh SSO ticket for the **photographer account**: Odin's setting `room.photographer.username`
  (Odin ≥ the room photographer release). That account enters locked, password and full rooms like staff, and other
  players never see it: it isn't in their user lists or status updates, and it isn't counted in `visitors_now`.
- The room is ready when the room visualizer exists, the furni downloader (`#dynamicdownloader`) is idle and the furni
  count has held for 3 seconds. Then every sprite channel that isn't the room's (visualizer sprites and wrapped
  parts) or a furni's (`pSprList` of the active, passive and item objects) is hidden, and every Fuse window is hidden
  through the window API (the info stand would otherwise show itself again). This repeats until a pass hides nothing.
- The stage background is made transparent where it touches the edge, and the picture is cropped to the room. A room
  bigger than the stage is shot in parts: all room sprites are moved by ¾ of the stage, shot again and the parts are
  stitched. `clipped` says the room still touches an edge.

## Settings (env)

| Variable | Default | |
|---|---|---|
| `PORT` | 8095 | API |
| `HARNESS_PORT` | 8090 | the harness, only used inside the container |
| `API_TOKEN` | | bearer token for the API |
| `ROOM_TIMEOUT_MS` | 60000 | how long a room may take to load |
| `CHROMIUM_PATH` | Playwright's | another Chromium / headless shell |
| `ASSETS` | `https://images.habbo-danmark.com` | asset host the harness proxies (may be http, e.g. `http://images-habbo`) |
| `VARS_UPSTREAM` | | variables file on the asset host, e.g. `/gamedata/external_vars_web.php` (the web client's) |
| `POLYFILL_URL` | the local build | e.g. `/assets/dirplayer/<build>/dirplayer-polyfill.js` (a deployed build, through the proxy) |
| `GAME_HOST`, `GAME_PORT`, `MUS_PORT` | 127.0.0.1, 12321, 12322 | Odin's TCP ports (the harness bridges to them) |

## Run

Locally (Odin on 127.0.0.1, `room.photographer.username` set to a local test account):

```bash
API_TOKEN=localtest node habbo/photographer/server.cjs
```

Docker (build context `habbo/`):

```bash
docker build -f photographer/Dockerfile -t room-photographer .
docker run -p 8095:8095 -e API_TOKEN=... -e GAME_HOST=host.docker.internal \
  -e POLYFILL_URL=/assets/dirplayer/<build>/dirplayer-polyfill.js -e VARS_UPSTREAM=/gamedata/external_vars_web.php room-photographer
```
