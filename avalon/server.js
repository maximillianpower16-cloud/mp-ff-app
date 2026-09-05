'use strict';

/**
 * Avalon server: static files + JSON actions + one Server-Sent-Events stream
 * per connected phone. No dependencies, no build step.
 *
 * Every state change re-renders a *personalised* view for each listener, so a
 * client physically never receives information its player is not entitled to.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomInt } = require('node:crypto');

const game = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.AVALON_STATE || path.join(__dirname, '.data', 'rooms.json');
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // rooms idle for 12h are dropped
const HEARTBEAT_MS = 20000;

/** code -> room */
const rooms = new Map();
/** code -> Set<{ playerId, res }> */
const listeners = new Map();

// ---------------------------------------------------------------- persistence

function snapshot() {
  const out = {};
  for (const [code, room] of rooms) {
    out[code] = { ...room, players: room.players.map((p) => ({ ...p, connected: false })) };
  }
  return out;
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
      await fsp.writeFile(DATA_FILE, JSON.stringify(snapshot()), 'utf8');
    } catch (err) {
      console.error('state save failed:', err.message);
    }
  }, 400);
}

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    for (const [code, room] of Object.entries(parsed)) {
      if (Date.now() - (room.updatedAt || 0) > ROOM_TTL_MS) continue;
      rooms.set(code, room);
    }
    if (rooms.size) console.log(`restored ${rooms.size} room(s) from disk`);
  } catch {
    /* first boot, or unreadable snapshot — start clean */
  }
}

// ---------------------------------------------------------------- broadcast

function broadcast(code) {
  const room = rooms.get(code);
  const set = listeners.get(code);
  if (!room || !set) return;
  for (const listener of set) {
    send(listener.res, 'state', game.viewFor(room, listener.playerId));
  }
  scheduleSave();
}

function send(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* the socket is gone; the close handler will clean up */
  }
}

function markConnections(code) {
  const room = rooms.get(code);
  if (!room) return;
  const live = new Set([...(listeners.get(code) || [])].map((l) => l.playerId));
  let changed = false;
  for (const p of room.players) {
    const connected = live.has(p.id);
    if (p.connected !== connected) {
      p.connected = connected;
      changed = true;
    }
  }
  if (changed) broadcast(code);
}

// ---------------------------------------------------------------- room codes

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O — they read as 1 and 0

function newRoomCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('could not allocate a room code');
}

function newId() {
  return randomBytes(12).toString('hex');
}

function cleanName(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

// ---------------------------------------------------------------- HTTP plumbing

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(res, relPath) {
  const safe = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  try {
    const body = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': body.length,
    });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

// ---------------------------------------------------------------- API

async function handleCreate(req, res) {
  const body = await readBody(req);
  const name = cleanName(body.name);
  if (!name) return json(res, 400, { error: 'Enter a name.' });

  const code = newRoomCode();
  const room = game.createRoom(code);
  rooms.set(code, room);

  const playerId = newId();
  const result = game.addPlayer(room, playerId, name);
  if (result.error) return json(res, 400, result);

  scheduleSave();
  json(res, 200, { code, playerId, name });
}

async function handleJoin(req, res) {
  const body = await readBody(req);
  const code = String(body.code || '').toUpperCase().trim();
  const name = cleanName(body.name);
  const room = rooms.get(code);

  if (!room) return json(res, 404, { error: 'No room with that code.' });
  if (!name) return json(res, 400, { error: 'Enter a name.' });

  // 1. Known device token for this room — always the same seat.
  if (body.playerId && game.findPlayer(room, body.playerId)) {
    const player = game.findPlayer(room, body.playerId);
    if (room.phase === game.PHASE.LOBBY && player.name !== name) {
      if (room.players.some((p) => p.id !== player.id && p.name.toLowerCase() === name.toLowerCase())) {
        return json(res, 409, { error: 'Someone else is already using that name.' });
      }
      player.name = name;
      game.touch(room);
      broadcast(code);
    }
    return json(res, 200, { code, playerId: player.id, name: player.name });
  }

  // 2. Reconnect by name — a fresh browser, a cleared tab, a new phone.
  const byName = room.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (byName) {
    if (byName.connected) {
      return json(res, 409, {
        error: `"${byName.name}" is already connected. Pick another name, or close the other tab.`,
      });
    }
    return json(res, 200, { code, playerId: byName.id, name: byName.name });
  }

  // 3. Brand new player.
  const playerId = newId();
  const result = game.addPlayer(room, playerId, name);
  if (result.error) return json(res, 409, result);
  broadcast(code);
  json(res, 200, { code, playerId, name });
}

async function handleAction(req, res) {
  const body = await readBody(req);
  const code = String(body.code || '').toUpperCase().trim();
  const room = rooms.get(code);
  if (!room) return json(res, 404, { error: 'That room no longer exists.' });
  if (!game.findPlayer(room, body.playerId)) return json(res, 403, { error: 'You are not in this room.' });

  const result = game.applyAction(room, body.playerId, body.action || {});
  if (result.error) return json(res, 400, result);
  broadcast(code);
  json(res, 200, { ok: true });
}

function handleStream(req, res, url) {
  const code = String(url.searchParams.get('code') || '').toUpperCase().trim();
  const playerId = String(url.searchParams.get('playerId') || '');
  const room = rooms.get(code);

  if (!room || !game.findPlayer(room, playerId)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('unknown room or player');
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // stop nginx-style proxies buffering the stream
  });
  res.write('retry: 2000\n\n');

  const listener = { playerId, res };
  if (!listeners.has(code)) listeners.set(code, new Set());
  listeners.get(code).add(listener);

  send(res, 'state', game.viewFor(room, playerId));
  markConnections(code);

  const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(beat);
    const set = listeners.get(code);
    if (set) {
      set.delete(listener);
      if (!set.size) listeners.delete(code);
    }
    markConnections(code);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

// ---------------------------------------------------------------- routing

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return json(res, 400, { error: 'bad request' });
  }
  const pathname = url.pathname;

  try {
    if (req.method === 'POST' && pathname === '/api/create') return await handleCreate(req, res);
    if (req.method === 'POST' && pathname === '/api/join') return await handleJoin(req, res);
    if (req.method === 'POST' && pathname === '/api/action') return await handleAction(req, res);
    if (req.method === 'GET' && pathname === '/api/stream') return handleStream(req, res, url);
    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { ok: true, rooms: rooms.size });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'method not allowed' });
    }

    // /room/ABCD and / are both the single-page app.
    if (pathname === '/' || /^\/room\/[A-Za-z]{4}\/?$/.test(pathname)) {
      return await serveStatic(res, 'index.html');
    }
    return await serveStatic(res, pathname.slice(1));
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message || 'server error' });
  }
});

// Drop rooms nobody has touched in a long time.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.updatedAt > ROOM_TTL_MS && !listeners.has(code)) {
      rooms.delete(code);
      scheduleSave();
    }
  }
}, 10 * 60 * 1000).unref();

loadState();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Avalon running on http://localhost:${PORT}`);
  });
}

module.exports = { server, rooms };
