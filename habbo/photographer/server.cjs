#!/usr/bin/env node
/**
 * Room photographer: photographs a Habbo room the way the client draws it, with no avatars, pets, chat bubbles or
 * interface. The CMS asks for a photo and gets a job id straight away; the photo is ready a few seconds later.
 *
 *   POST /jobs           {"roomId": 1406, "roomType": "private"|"public", "sso": "<ticket>"}  -> 202 {"id": "..."}
 *   GET  /jobs/<id>      {"id", "status": "queued"|"running"|"done"|"failed", "error", "width", "height", "clipped"}
 *   GET  /jobs/<id>/photo.png   the photo (transparent background, cropped to the room)
 *   GET  /health
 * Every request but /health needs "Authorization: Bearer <API_TOKEN>" when API_TOKEN is set.
 *
 * How: the DirPlayer harness (../dev-server.cjs) runs alongside (asset proxy + page + WS->TCP bridge to Odin). Per job
 * a headless Chromium opens the client with the job's SSO ticket for the room photographer account (Odin setting
 * room.photographer.username: it enters any room and other players never see it) and a room forward. Once the room and
 * its furni have loaded, every sprite channel that isn't the room's (visualizer: floor, walls, landscape) or a furni's
 * is hidden, the stage is captured, the black background made transparent and the picture cropped to the room. One job
 * at a time; the browser closes when the queue has been empty for a minute.
 *
 * Env: PORT (8095), HARNESS_PORT (8090), API_TOKEN, CHROMIUM_PATH (a Chromium/headless shell, else Playwright's own),
 *      ROOM_TIMEOUT_MS (60000), plus the harness's: ASSETS, GAME_HOST, GAME_PORT, MUS_PORT, POLYFILL_URL, NATIVE_WS.
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = parseInt(process.env.PORT || '8095', 10);
const HARNESS_PORT = parseInt(process.env.HARNESS_PORT || '8090', 10);
const API_TOKEN = process.env.API_TOKEN || '';
const ROOM_TIMEOUT_MS = parseInt(process.env.ROOM_TIMEOUT_MS || '60000', 10);
const IDLE_CLOSE_MS = 60000;
const JOB_TTL_MS = 30 * 60000;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- The harness (child process) ----

const harness = spawn(process.execPath, [path.join(__dirname, '..', 'dev-server.cjs')], {
  env: { ...process.env, PORT: String(HARNESS_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
harness.stdout.on('data', (d) => process.env.DEBUG && process.stdout.write('[harness] ' + d));
harness.stderr.on('data', (d) => process.stderr.write('[harness] ' + d));
harness.on('exit', (code) => { log('harness exited', code); process.exit(1); });

// ---- Jobs ----

const jobs = new Map();
const queue = [];
let working = false;

function publicJob(job) {
  const { id, roomId, roomType, status, error, width, height, clipped, createdAt, finishedAt } = job;
  return { id, roomId, roomType, status, error, width, height, clipped, createdAt, finishedAt };
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
}, 60000).unref();

// ---- Browser ----

let browser = null;
let idleTimer = null;

async function getBrowser() {
  clearTimeout(idleTimer);
  if (!browser) {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--disable-dev-shm-usage'] });
    log('browser started');
  }
  return browser;
}

function closeWhenIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (queue.length || working || !browser) return;
    const b = browser;
    browser = null;
    await b.close().catch(() => {});
    log('browser closed (idle)');
  }, IDLE_CLOSE_MS);
}

// ---- Taking a photo ----

async function takePhoto(job) {
  const context = await (await getBrowser()).newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => { window.alert = (m) => console.error('alert: ' + m); });
    const forward = (job.roomType === 'public' ? 'public' : 'private') + ',' + job.roomId;
    await page.goto(`http://127.0.0.1:${HARNESS_PORT}/?sso=${encodeURIComponent(job.sso)}&forward=${forward}`);
    await page.waitForFunction(() => window.__vm && window.__vm.mcp_eval_lingo, null, { timeout: 60000 });
    // The movie's mouse starts at the stage's top-left and only moves with pointer events on the canvas. Park it far
    // outside the stage, so the room's tile highlighter (it follows the mouse) never shows.
    const mouseAway = () => page.evaluate(() => window.__vm.mouse_move && window.__vm.mouse_move(-10000, -10000));
    await mouseAway();
    const ev = (code) => page.evaluate(async (c) => {
      const r = JSON.parse(await window.__vm.mcp_eval_lingo(c));
      return r.success ? String(r.result_value) : 'ERR ' + r.error;
    }, code);
    const C = 'getThread(#room).getComponent()';
    const V = 'getThread(#room).getInterface().getRoomVisualizer()';

    // The room is ready once its visualizer exists, the furni downloader is idle (a furni whose cast is still on its way
    // shows a placeholder and is rebuilt when the cast arrives) and the furni count has held for a few seconds.
    const D = 'getThread(#dynamicdownloader).getComponent()';
    const deadline = Date.now() + ROOM_TIMEOUT_MS;
    let last = -1, stable = 0;
    while (true) {
      if (Date.now() > deadline) throw new Error('the room did not load (does it exist? is the photographer account set up?)');
      await sleep(1000);
      if ((await ev('objectp(' + V + ')')) !== '1') continue;
      const pending = parseInt(await ev(D + '.pDownloadQueue.count + ' + D + '.pPriorityDownloadQueue.count + ' + D + '.pCurrentDownLoads.count'), 10);
      const count = parseInt(await ev(C + '.pActiveObjList.count + ' + C + '.pPassiveObjList.count + ' + C + '.pItemObjList.count'), 10);
      if (pending !== 0 || Number.isNaN(count)) { stable = 0; continue; }
      stable = count === last ? stable + 1 : 0;
      last = count;
      if (stable >= 3) break;
    }
    await sleep(1500); // the last furni's first frame

    // Keep the room's sprites (visualizer and its wrapped wall/floor parts) and every furni's; hide everything else
    // (avatars, pets, chat bubbles, windows, the room bar, the door arrow, ...). Windows are hidden through Fuse's window
    // API too: the info stand the client opens for the photographer's own avatar refreshes itself and would show its
    // sprites again, a hidden window stays hidden.
    const nums = (s) => (String(s).match(/sprite\s*\(?\s*(\d+)/gi) || []).map((x) => +x.match(/(\d+)/)[1]);
    const listIds = async (code) => {
      const raw = String(await ev(code)).replace(/\\"/g, '"').replace(/^"|"$/g, '');
      return [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    };
    const roomSprites = async () => {
      const keep = new Set(nums(await ev('string(' + V + '.pSpriteList)')));
      const wraps = parseInt(await ev(V + '.pWrappedParts.count'), 10) || 0;
      for (let i = 1; i <= wraps; i++) nums(await ev('string(' + V + '.pWrappedParts[' + i + '].pSprite)')).forEach((n) => keep.add(n));
      for (const list of ['pActiveObjList', 'pPassiveObjList', 'pItemObjList']) {
        const n = parseInt(await ev(C + '.' + list + '.count'), 10) || 0;
        for (let i = 1; i <= n; i++) nums(await ev('string(' + C + '.' + list + '[' + i + '].pSprList)')).forEach((x) => keep.add(x));
      }
      // The tile highlighter is one of the visualizer's sprites; with the mouse parked it is off stage, hide it anyway.
      nums(await ev('string(' + V + '.getSprById("hiliter"))')).forEach((x) => keep.delete(x));
      return keep;
    };
    await mouseAway();
    let keep = new Set();
    for (let pass = 0; pass < 5; pass++) {
      keep = await roomSprites();
      for (const id of await listIds('string(getWindowIDList())')) {
        const safe = id.replace(/"/g, '');
        nums(await ev('string(getWindow("' + safe + '").pSpriteList)')).forEach((n) => keep.delete(n));
        await ev('getWindow("' + safe + '").hide()');
      }
      let hidden = 0;
      for (let channel = 1; channel <= 1000; channel++) {
        if (keep.has(channel)) continue;
        if ((await ev('sprite(' + channel + ').visible')) === '1') {
          await ev('sprite(' + channel + ').visible = 0');
          hidden++;
        }
      }
      await sleep(700);
      if (pass > 0 && hidden === 0) break;
    }

    // A room bigger than the stage is photographed in parts: every room sprite is moved by the same offset, the stage
    // is captured again, and the shots are laid over each other where they belong.
    const canvas = page.locator('canvas').first();
    await mouseAway();
    const shots = [{ ox: 0, oy: 0, png: (await canvas.screenshot()).toString('base64') }];
    let photo = await page.evaluate(composeShots, shots);
    if (!photo) throw new Error('nothing of the room was drawn');
    const { clip } = photo;
    if (clip.left || clip.right || clip.top || clip.bottom) {
      const sx = Math.round(photo.stageWidth * 0.75), sy = Math.round(photo.stageHeight * 0.75);
      const xs = [0, ...(clip.left ? [sx] : []), ...(clip.right ? [-sx] : [])];
      const ys = [0, ...(clip.top ? [sy] : []), ...(clip.bottom ? [-sy] : [])];
      let at = { x: 0, y: 0 };
      for (const oy of ys) for (const ox of xs) {
        if (!ox && !oy) continue;
        const dx = ox - at.x, dy = oy - at.y;
        for (const n of keep) await ev('sprite(' + n + ').loc = sprite(' + n + ').loc + point(' + dx + ', ' + dy + ')');
        at = { x: ox, y: oy };
        await mouseAway();
        await sleep(400);
        shots.push({ ox, oy, png: (await canvas.screenshot()).toString('base64') });
      }
      photo = await page.evaluate(composeShots, shots);
    }
    return { png: photo.png, width: photo.width, height: photo.height, clipped: photo.clipped };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Runs in the page. shots: [{ox, oy, png}], each a capture of the stage with the room moved by (ox, oy). Makes the
 * stage background (its colour at the first shot's corner) transparent where it touches a shot's edge, lays the shots
 * over each other in room coordinates, crops to the room plus a small margin. clip: which sides of the first shot the
 * room touched; clipped: the room still touches an edge of the combined picture.
 */
async function composeShots(shots) {
  const decoded = [];
  for (const shot of shots) {
    const img = new Image();
    img.src = 'data:image/png;base64,' + shot.png;
    await img.decode();
    decoded.push({ ...shot, img });
  }
  const w = decoded[0].img.naturalWidth, h = decoded[0].img.naturalHeight;
  let bg = null;
  const layers = decoded.map((shot) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(shot.img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    if (!bg) bg = [px[0], px[1], px[2]];
    const seen = new Uint8Array(w * h);
    const stack = [];
    for (let x = 0; x < w; x++) stack.push(x, x + (h - 1) * w);
    for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
    while (stack.length) {
      const p = stack.pop();
      if (seen[p]) continue;
      seen[p] = 1;
      const i = p * 4;
      if (px[i] !== bg[0] || px[i + 1] !== bg[1] || px[i + 2] !== bg[2]) continue;
      px[i + 3] = 0;
      const x = p % w, y = (p - x) / w;
      if (x > 0) stack.push(p - 1);
      if (x < w - 1) stack.push(p + 1);
      if (y > 0) stack.push(p - w);
      if (y < h - 1) stack.push(p + w);
    }
    ctx.putImageData(data, 0, 0);
    return { canvas: c, ox: shot.ox, oy: shot.oy };
  });

  const minX = Math.min(...layers.map((l) => -l.ox)), minY = Math.min(...layers.map((l) => -l.oy));
  const maxX = Math.max(...layers.map((l) => w - l.ox)), maxY = Math.max(...layers.map((l) => h - l.oy));
  const W = maxX - minX, H = maxY - minY;
  const all = document.createElement('canvas');
  all.width = W; all.height = H;
  const actx = all.getContext('2d');
  for (const l of layers) actx.drawImage(l.canvas, -l.ox - minX, -l.oy - minY);

  const bbox = (ctx, cw, ch) => {
    const px = ctx.getImageData(0, 0, cw, ch).data;
    let left = cw, top = ch, right = -1, bottom = -1;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      if (px[(y * cw + x) * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
    return right < 0 ? null : { left, top, right, bottom };
  };
  const first = bbox(layers[0].canvas.getContext('2d'), w, h);
  const box = bbox(actx, W, H);
  if (!first || !box) return null;

  const m = 4;
  const cl = Math.max(0, box.left - m), ct = Math.max(0, box.top - m);
  const cr = Math.min(W, box.right + 1 + m), cb = Math.min(H, box.bottom + 1 + m);
  const out = document.createElement('canvas');
  out.width = cr - cl; out.height = cb - ct;
  out.getContext('2d').drawImage(all, cl, ct, out.width, out.height, 0, 0, out.width, out.height);
  return {
    png: out.toDataURL('image/png').split(',')[1],
    width: out.width,
    height: out.height,
    stageWidth: w,
    stageHeight: h,
    clip: { left: first.left === 0, top: first.top === 0, right: first.right === w - 1, bottom: first.bottom === h - 1 },
    clipped: box.left === 0 || box.top === 0 || box.right === W - 1 || box.bottom === H - 1,
  };
}

async function work() {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      job.status = 'running';
      const started = Date.now();
      try {
        const photo = await takePhoto(job);
        job.photo = Buffer.from(photo.png, 'base64');
        Object.assign(job, { status: 'done', width: photo.width, height: photo.height, clipped: photo.clipped });
        log(`job ${job.id}: room ${job.roomType} ${job.roomId} ${photo.width}x${photo.height}${photo.clipped ? ' (clipped)' : ''} in ${Date.now() - started} ms`);
      } catch (e) {
        Object.assign(job, { status: 'failed', error: e.message });
        log(`job ${job.id}: room ${job.roomType} ${job.roomId} failed: ${e.message}`);
        if (browser && !browser.isConnected()) browser = null;
      }
      job.sso = undefined;
      job.finishedAt = Date.now();
    }
  } finally {
    working = false;
    closeWhenIdle();
  }
}

// ---- HTTP API ----

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function authorised(req) {
  if (!API_TOKEN) return true;
  const header = req.headers.authorization || '';
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
  const wanted = Buffer.from(API_TOKEN);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return send(res, 200, { ok: true, queued: queue.length, working, browser: !!browser });
  if (!authorised(req)) return send(res, 401, { error: 'unauthorised' });

  if (req.method === 'POST' && url.pathname === '/jobs') {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 10000) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch (e) { return send(res, 400, { error: 'invalid JSON' }); }
      const roomId = parseInt(body.roomId, 10);
      const roomType = body.roomType === 'public' ? 'public' : 'private';
      if (!(roomId > 0) || !body.sso || typeof body.sso !== 'string') return send(res, 400, { error: 'roomId and sso are required' });
      const job = { id: crypto.randomUUID(), roomId, roomType, sso: body.sso, status: 'queued', createdAt: Date.now() };
      jobs.set(job.id, job);
      queue.push(job);
      work();
      send(res, 202, publicJob(job));
    });
    return;
  }

  const m = /^\/jobs\/([0-9a-f-]{36})(\/photo\.png)?$/.exec(url.pathname);
  if (req.method === 'GET' && m) {
    const job = jobs.get(m[1]);
    if (!job) return send(res, 404, { error: 'no such job' });
    if (!m[2]) return send(res, 200, publicJob(job));
    if (job.status !== 'done') return send(res, 409, { error: 'not done', status: job.status });
    return send(res, 200, job.photo, 'image/png');
  }

  send(res, 404, { error: 'not found' });
}).listen(PORT, () => log(`room photographer on :${PORT} (harness :${HARNESS_PORT})`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    harness.kill();
    if (browser) await browser.close().catch(() => {});
    process.exit(0);
  });
}
