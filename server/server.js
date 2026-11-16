#!/usr/bin/env node
'use strict';

// Number Duel WebSocket relay.
// Hosts and guests connect over wss://<host>/ws (or ws://localhost:9001/ws locally).
// The server keeps an in-memory map of rooms keyed by code, routes peer-to-peer
// messages through itself, and emits peer-joined/peer-left lifecycle events.

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT       = parseInt(process.env.PORT || '9001', 10);
const HOST       = process.env.HOST || '127.0.0.1';
// STATIC_DIR controls dev-mode static-file serving on /.
//  - explicit value → use that path
//  - empty string  → disable (production, nginx serves the front-end)
//  - unset         → default to the parent of this file (project root), so
//                    `node server/server.js` from the repo just works locally.
const STATIC_DIR = process.env.STATIC_DIR === ''
  ? null
  : process.env.STATIC_DIR
    ? path.resolve(process.env.STATIC_DIR)
    : path.resolve(__dirname, '..');

// rooms: code -> { hostSocket, hostId, guests: Map<id, socket> }
const rooms = new Map();
// socket -> { id, role: 'host' | 'guest', code }
const sessions = new WeakMap();

function genGuestId() {
  return 'guest-' + Math.random().toString(36).slice(2, 10);
}

function safeJson(data) {
  try { return JSON.parse(data); } catch { return null; }
}

function send(socket, obj) {
  if (socket && socket.readyState === 1 /* WebSocket.OPEN */) {
    try { socket.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function teardownSession(socket) {
  const s = sessions.get(socket);
  if (!s) return;
  sessions.delete(socket);
  const room = rooms.get(s.code);
  if (!room) return;
  if (s.role === 'host') {
    // Host left — notify every guest, drop the room.
    for (const [gid, gsock] of room.guests) {
      send(gsock, { type: 'peer-left', id: s.id });
      try { gsock.close(1000, 'host left'); } catch (_) {}
    }
    rooms.delete(s.code);
  } else {
    room.guests.delete(s.id);
    send(room.hostSocket, { type: 'peer-left', id: s.id });
  }
}

// ---- Static file server (dev convenience only) ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function serveStatic(req, res) {
  if (!STATIC_DIR) {
    res.writeHead(404);
    res.end('Number Duel relay');
    return;
  }
  const url = decodeURI(req.url.split('?')[0]);
  let rel = url === '/' ? '/index.html' : url;
  const filePath = path.normalize(path.join(STATIC_DIR, rel));
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // Always revalidate code and pages so a deploy reaches every player at once.
    if (ext === '.html' || ext === '.js' || ext === '.css') headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  socket.on('message', (data) => {
    const msg = safeJson(data.toString());
    if (!msg || typeof msg !== 'object') return;

    // ---- Room lifecycle ----
    if (msg.type === 'host') {
      if (sessions.has(socket)) return send(socket, { type: 'error', errorType: 'already-in-room', reason: 'already-in-room' });
      const code = typeof msg.code === 'string' ? msg.code.slice(0, 64) : '';
      if (!code) return send(socket, { type: 'error', errorType: 'bad-code', reason: 'bad-code' });
      if (rooms.has(code)) return send(socket, { type: 'error', errorType: 'unavailable-id', reason: 'code-taken' });
      const id = code; // host's logical id equals the room code (matches the PeerJS-era peer id)
      rooms.set(code, { hostSocket: socket, hostId: id, guests: new Map() });
      sessions.set(socket, { id, role: 'host', code });
      send(socket, { type: 'hosted', id });
      return;
    }

    if (msg.type === 'join') {
      if (sessions.has(socket)) return send(socket, { type: 'error', errorType: 'already-in-room', reason: 'already-in-room' });
      const code = typeof msg.code === 'string' ? msg.code.slice(0, 64) : '';
      const room = rooms.get(code);
      if (!room) {
        // Same 4-character code hosted under another prefix? Then the guest picked a
        // different game, or is running an older/newer cached copy of the app.
        const suffix = code.slice(code.lastIndexOf('-') + 1);
        let other = null;
        if (suffix && suffix !== code) {
          for (const key of rooms.keys()) {
            if (key.endsWith('-' + suffix)) { other = key.slice(0, key.length - suffix.length); break; }
          }
        }
        return send(socket, { type: 'error', errorType: 'peer-unavailable',
          reason: other ? 'other-prefix:' + other : 'no-such-room' });
      }
      const id = genGuestId();
      room.guests.set(id, socket);
      sessions.set(socket, { id, role: 'guest', code });
      send(socket, { type: 'joined', id, hostId: room.hostId });
      send(room.hostSocket, { type: 'peer-joined', id });
      return;
    }

    // ---- In-room messages ----
    const s = sessions.get(socket);
    if (!s) return send(socket, { type: 'error', errorType: 'not-in-room', reason: 'not-in-room' });
    const room = rooms.get(s.code);
    if (!room) return;

    if (msg.type === 'msg') {
      const targetId = msg.to;
      let target = null;
      if (targetId === room.hostId) target = room.hostSocket;
      else if (room.guests.has(targetId)) target = room.guests.get(targetId);
      if (target && target !== socket) {
        send(target, { type: 'msg', from: s.id, payload: msg.payload });
      }
      return;
    }
  });

  socket.on('close', () => teardownSession(socket));
  socket.on('error', () => teardownSession(socket));
});

server.listen(PORT, HOST, () => {
  console.log('Number Duel relay listening on ' + HOST + ':' + PORT +
    (STATIC_DIR ? ' (also serving static from ' + STATIC_DIR + ')' : ''));
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
