#!/usr/bin/env node
/**
 * Habbo Danmark local web-client harness for DirPlayer (dev only, binds to 127.0.0.1).
 *
 *   node habbo/dev-server.cjs            # http://127.0.0.1:8090/?sso=<ticket>
 *
 * - GET /                      test page: the CMS client page's <embed> + dirplayer-polyfill.js
 *                                (?large=1: the CMS 2x client, a 1440x1080 embed with dynamicResolution=1)
 * - GET /dirplayer-polyfill.js the local build (npm run build-polyfill)
 * - GET /assets/*              reverse proxy to https://images.habbo-danmark.com/* (same-origin: no CORS,
 *                              no mixed content, nothing mirrored locally)
 * - GET /assets/gamedata/external_variables.txt
 *                              the prod file with its asset URLs rewritten to /assets/
 * - WS  /ws/game, /ws/mus      bridges to the game (12321) and MUS (12322) TCP ports, until Odin speaks
 *                              WebSocket itself
 *
 * Env: PORT (8090), ASSETS (https://images.habbo-danmark.com), GAME_HOST (127.0.0.1), GAME_PORT (12321),
 *      MUS_PORT (12322), SITE_URL (http://localhost:5080, the local CMS), NATIVE_WS (Odin's WebSocket
 *      listener, e.g. ws://127.0.0.1:12323; default: the built-in WS->TCP bridges).
 */
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8090', 10);
const ASSETS = (process.env.ASSETS || 'https://images.habbo-danmark.com').replace(/\/$/, '');
const GAME_HOST = process.env.GAME_HOST || '127.0.0.1';
const GAME_PORT = parseInt(process.env.GAME_PORT || '12321', 10);
const MUS_PORT = parseInt(process.env.MUS_PORT || '12322', 10);
// NATIVE_WS=ws://127.0.0.1:12323: connect straight to Odin's WebSocket listener (ws.port) instead of this
// server's WS->TCP bridges.
const NATIVE_WS = (process.env.NATIVE_WS || '').replace(/\/$/, '');
const SITE_URL = (process.env.SITE_URL || 'http://localhost:5080').replace(/\/$/, '');
const POLYFILL = path.join(__dirname, '..', 'dist-polyfill', 'dirplayer-polyfill.js');

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

function page(sso, forward, large) {
  const self = `http://127.0.0.1:${PORT}`;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Same params as OdinCMS Views/Client/Index.cshtml. The game/MUS host+port stay what the client is told;
  // socketProxy maps them to this server's WebSocket bridges.
  const sw = {
    sw1: `site.url=${SITE_URL};url.prefix=${SITE_URL}`,
    sw2: `connection.info.host=${GAME_HOST};connection.info.port=${GAME_PORT}`,
    sw3: `client.reload.url=${SITE_URL}/client;client.allow.cross.domain=1;client.notify.cross.domain=0`,
    sw4: `connection.mus.host=${GAME_HOST};connection.mus.port=${MUS_PORT}`,
    sw5: `external.variables.txt=${self}/assets/gamedata/external_variables.txt;external.texts.txt=${self}/assets/gamedata/external_texts.txt`,
    sw6: `use.sso.ticket=1;sso.ticket=${sso}`,
  };
  // ?forward=public,<roomId> | private,<roomId> | <type>,<id>: the CMS client's sw7 room forward. The client
  // (Navigator Component goStraightToRoom) treats type 1 as public and anything else as private. For public
  // rooms it NAVIGATEs to the node id, and Odin numbers public-room nodes RoomManager.PUBLIC_ROOM_OFFSET
  // (1000) + room id, so a bare room id would be read as a category.
  const fw = /^(public|private|\d+),(\d+)$/.exec(forward || '');
  if (fw) {
    const type = fw[1] === 'public' ? 1 : fw[1] === 'private' ? 2 : parseInt(fw[1], 10);
    const id = fw[1] === 'public' ? 1000 + parseInt(fw[2], 10) : parseInt(fw[2], 10);
    sw.sw7 = `forward.type=${type};forward.id=${id}`;
  }
  const attrs = Object.entries(sw).map(([k, v]) => `${k}="${esc(v)}"`).join('\n         ');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Habbo · DirPlayer dev</title>
<style>body{margin:0;background:#000;color:#ccc;font:12px Verdana,sans-serif}#bar{padding:6px 10px}</style>
<script src="/dirplayer-polyfill.js" data-manual-init></script>
<script>
  DirPlayer.configureFlash({
    disableFlash: true,
    socketProxy: [
      { host: ${JSON.stringify(GAME_HOST)}, port: ${GAME_PORT}, proxyUrl: ${NATIVE_WS ? JSON.stringify(NATIVE_WS + '/game') : "'ws://' + location.host + '/ws/game'"} },
      { host: ${JSON.stringify(GAME_HOST)}, port: ${MUS_PORT}, proxyUrl: ${NATIVE_WS ? JSON.stringify(NATIVE_WS + '/mus') : "'ws://' + location.host + '/ws/mus'"} },
    ],
  });
  window.addEventListener('DOMContentLoaded', () => DirPlayer.init());
</script></head>
<body><div id="bar">DirPlayer dev harness · SSO ${sso ? 'set' : '<b>missing (?sso=)</b>'} · assets via ${esc(ASSETS)}</div>
<embed src="/assets/dcr/latest/habbo.dcr" bgColor="#000000" width="${large ? 1440 : 720}" height="${large ? 1080 : 540}" type="application/x-director"
         ${attrs}${large ? ' dynamicResolution="1"' : ''}>
</body></html>`;
}

function proxyAsset(req, res, assetPath) {
  const target = new URL(ASSETS + assetPath);
  const isVars = /\/gamedata\/external_variables\.txt$/.test(target.pathname);
  const upstream = https.request(target, { method: 'GET', headers: { 'user-agent': 'habbo-dirplayer-dev', accept: '*/*' } }, up => {
    if (isVars && up.statusCode === 200) {
      let body = '';
      up.setEncoding('latin1');
      up.on('data', c => (body += c));
      up.on('end', () => {
        // Point every asset URL at this proxy so downloads stay same-origin.
        const rewritten = body.replace(/https?:\/\/images\.habbo-danmark\.com\//g, `http://127.0.0.1:${PORT}/assets/`);
        // DROP_VARS=cast.entry.27,... removes variables (for experiments, e.g. freeing a cast slot).
        const drop = (process.env.DROP_VARS || '').split(',').filter(Boolean);
        let lines = rewritten.split(/\r?\n/).filter(l => !drop.some(d => l.startsWith(d + '=')));
        // SET_VARS=<file>: `key=value` lines that replace the variable, or are appended when it is missing
        // (to try an external_vars.php change before making it on prod).
        const set = process.env.SET_VARS ? fs.readFileSync(process.env.SET_VARS, 'latin1').split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#')) : [];
        for (const s of set) {
          const key = s.slice(0, s.indexOf('=') + 1);
          const i = lines.findIndex(l => l.startsWith(key));
          if (i >= 0) lines[i] = s; else lines.push(s);
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
        res.end(Buffer.from(lines.join('\n'), 'latin1'));
        log('vars', target.pathname, `(${(body.match(/images\.habbo-danmark\.com/g) || []).length} URLs rewritten${drop.length ? ', dropped ' + drop.join(',') : ''}${set.length ? ', set ' + set.map(s => s.split('=')[0]).join(',') : ''})`);
      });
      return;
    }
    // CORS so other local pages (the CMS web client on localhost:5080) can use this as their asset proxy too.
    const headers = { 'access-control-allow-origin': '*' };
    for (const h of ['content-type', 'content-length', 'last-modified', 'etag']) if (up.headers[h]) headers[h] = up.headers[h];
    res.writeHead(up.statusCode || 502, headers);
    up.pipe(res);
    if ((up.statusCode || 0) >= 400) log('asset', up.statusCode, target.pathname);
  });
  upstream.on('error', e => { log('asset error', target.pathname, e.message); if (!res.headersSent) res.writeHead(502); res.end(); });
  upstream.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page(url.searchParams.get('sso') || '', url.searchParams.get('forward'), url.searchParams.get('large') === '1'));
  }
  if (url.pathname === '/dirplayer-polyfill.js') {
    if (!fs.existsSync(POLYFILL)) { res.writeHead(404); return res.end('run npm run build-polyfill'); }
    res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
    return fs.createReadStream(POLYFILL).pipe(res);
  }
  if (url.pathname.startsWith('/assets/')) return proxyAsset(req, res, url.pathname.slice('/assets'.length) + url.search);
  res.writeHead(404); res.end();
});


// LOG_PACKETS=1: log Habbo protocol headers. Client->server frames are a 3-char Base64 length, then a 2-char
// Base64 header id. Server->client messages are a 2-char header id, then the body, terminated by \x01.
const LOG_PACKETS = process.env.LOG_PACKETS === '1';
const LOG_BODIES = new Set((process.env.LOG_BODIES || '').split(',').filter(Boolean).map(Number));
const b64 = s => [...s].reduce((v, ch) => (v << 6) | (ch.charCodeAt(0) - 64), 0);
function packetLogger(name) {
  let up = Buffer.alloc(0), down = Buffer.alloc(0);
  const counts = new Map();
  const lastBody = new Map();
  const timer = setInterval(() => {
    if (!counts.size) return;
    log(name, '<', [...counts].map(([h, n]) => n > 1 ? `${h}x${n}` : `${h}`).join(' '));
    counts.clear();
  }, 1000);
  return {
    clientData(d) {
      up = Buffer.concat([up, d]);
      while (up.length >= 5) {
        const len = b64(up.subarray(0, 3).toString('latin1'));
        if (up.length < 3 + len) break;
        const msg = up.subarray(3, 3 + len);
        log(name, '>', b64(msg.subarray(0, 2).toString('latin1')), JSON.stringify(msg.subarray(2, 40).toString('latin1')));
        up = up.subarray(3 + len);
      }
    },
    serverData(d) {
      down = Buffer.concat([down, d]);
      let i;
      while ((i = down.indexOf(1)) >= 0) {
        const h = b64(down.subarray(0, 2).toString('latin1'));
        counts.set(h, (counts.get(h) || 0) + 1);
        // LOG_BODIES=244,...: also log bodies of these server messages (only when they differ from the last one).
        if (LOG_BODIES.has(h)) {
          const body = down.subarray(2, i).toString('latin1');
          if (body !== lastBody.get(h)) { log(name, '<', h, `(${body.length}B)`, JSON.stringify(body.slice(0, 160))); lastBody.set(h, body); }
        }
        down = down.subarray(i + 1);
      }
    },
    stop() { clearInterval(timer); },
  };
}
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  const port = p === '/ws/game' ? GAME_PORT : p === '/ws/mus' ? MUS_PORT : null;
  if (!port) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => {
    const name = p.slice(4);
    const tcp = net.createConnection({ host: GAME_HOST, port }, () => log(name, 'connected to', `${GAME_HOST}:${port}`));
    let up = 0, down = 0;
    const pl = LOG_PACKETS && name === 'game' ? packetLogger(name) : null;
    tcp.on('data', d => { down += d.length; if (pl) pl.serverData(d); if (ws.readyState === ws.OPEN) ws.send(d); });
    ws.on('message', d => { up += d.length; if (pl) pl.clientData(Buffer.from(d)); if (tcp.writable) tcp.write(d); });
    const close = why => { if (pl) pl.stop(); log(name, 'closed', `(${why}; client->server ${up}B, server->client ${down}B)`); try { ws.close(); } catch {} tcp.destroy(); };
    tcp.on('close', () => close('tcp closed'));
    tcp.on('error', e => close('tcp error ' + e.message));
    ws.on('close', () => close('ws closed'));
  });
});

server.listen(PORT, '127.0.0.1', () => log(`DirPlayer Habbo harness on http://127.0.0.1:${PORT}/?sso=<ticket>  (assets: ${ASSETS}, game: ${GAME_HOST}:${GAME_PORT}/${MUS_PORT})`));
