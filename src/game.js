'use strict';
/* HTTP + WebSocket front door: many rooms, one per host. Handles static files, abuse limits,
 * host identity and plans. The game rules live in room.js. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { createRoom, PLANS } = require('./room');
const { createHostStore } = require('./hoststore');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function lanIp() {
  const cands = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) cands.push(i.address);
  }
  const pref = cands.find((a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
  return pref || cands[0] || '127.0.0.1';
}

/** Sliding-window counter per key. */
function makeLimiter(max, windowMs, now = () => Date.now()) {
  const hits = new Map();
  return {
    take(key) {
      const t = now();
      const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
      if (arr.length >= max) { hits.set(key, arr); return false; }
      arr.push(t); hits.set(key, arr); return true;
    },
    full(key) {
      const t = now();
      return (hits.get(key) || []).filter((x) => t - x < windowMs).length >= max;
    },
    sweep() { const t = now(); for (const [k, v] of hits) { const f = v.filter((x) => t - x < windowMs); if (f.length) hits.set(k, f); else hits.delete(k); } },
  };
}

function createGameServer(opts = {}) {
  const o = {
    defaultPlan: opts.defaultPlan || opts.plan || 'free', // 'free' normally; 'pro' for LAN/dev use
    maxRooms: opts.maxRooms ?? 300,
    maxConnections: opts.maxConnections ?? 4000,
    maxConnectionsPerIp: opts.maxConnectionsPerIp ?? 200,
    failedJoinsPerIp: opts.failedJoinsPerIp ?? 30,
    roomsPerIpPerHour: opts.roomsPerIpPerHour ?? 30,
    idleMs: opts.idleMs ?? 15 * 60 * 1000,
    endedMs: opts.endedMs ?? 60 * 60 * 1000,
    maxAgeMs: opts.maxAgeMs ?? 8 * 60 * 60 * 1000,
    sweepMs: opts.sweepMs ?? 30 * 1000,
    trustProxy: opts.trustProxy ?? process.env.TRUST_PROXY === '1',
    publicUrl: (opts.publicUrl ?? process.env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
    adminToken: opts.adminToken ?? process.env.ADMIN_TOKEN ?? '',
    roomTiming: {
      minSeconds: opts.minSeconds, claimWindowMs: opts.claimWindowMs, resumeDelayMs: opts.resumeDelayMs,
      firstCallDelayMs: opts.firstCallDelayMs, endDelayMs: opts.endDelayMs,
      ticketProvider: opts.ticketProvider, fixedSequence: opts.fixedSequence,
    },
  };
  const store = opts.hostStore || createHostStore({ file: opts.dataFile || null });
  const rooms = new Map(); // code -> room
  const roomByHost = new Map(); // hostId -> room
  const sockets = new Set();
  const perIp = new Map();
  const failedJoin = makeLimiter(o.failedJoinsPerIp, 10 * 60 * 1000);
  const roomCreate = makeLimiter(o.roomsPerIpPerHour, 60 * 60 * 1000);
  const redeemTries = makeLimiter(10, 10 * 60 * 1000);
  let httpPort = 0;

  // ---------- helpers ----------
  function clientIp(req) {
    if (o.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1]; // the hop our own proxy appended
    }
    return req.socket.remoteAddress || 'unknown';
  }
  function baseUrl(req) {
    if (o.publicUrl) return o.publicUrl;
    const proto = o.trustProxy && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const hostHdr = String(req.headers.host || '').replace(/[^A-Za-z0-9.:\-\[\]]/g, '');
    return `${proto}://${hostHdr || `${lanIp()}:${httpPort}`}`;
  }
  function publicPlan(p, until) {
    const pl = PLANS[p.id || p];
    return { id: pl.id, name: pl.name, maxPlayers: pl.maxPlayers, maxTickets: pl.maxTickets, until: until ?? p.until ?? null };
  }
  function hostPlan(hostId) {
    const held = store.planFor(hostId);
    if (held.id === 'free' && o.defaultPlan !== 'free') return { id: o.defaultPlan, until: null };
    return held;
  }
  function newCode() {
    for (let tries = 0; tries < 50; tries++) {
      let c = '';
      for (let i = 0; i < 5; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(c)) return c;
    }
    return null;
  }
  const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  function dropRoom(room, reason) {
    room.close(reason);
    rooms.delete(room.code);
    if (roomByHost.get(room.hostId) === room) roomByHost.delete(room.hostId);
  }

  function joinUrlFor(base) { return (code) => `${base()}/?room=${code}`; }

  function makeRoom(hostId, ip) {
    if (rooms.size >= o.maxRooms) return { error: 'Server is busy right now. Try again in a few minutes.' };
    const code = newCode();
    if (!code) return { error: 'Could not create a room. Try again.' };
    const held = hostPlan(hostId);
    const room = createRoom({
      code, hostId, plan: held.id,
      joinUrl: (c) => `${o.publicUrl || `http://${lanIp()}:${httpPort}`}/?room=${c}`,
      ...Object.fromEntries(Object.entries(o.roomTiming).filter(([, v]) => v !== undefined)),
    });
    rooms.set(code, room);
    roomByHost.set(hostId, room);
    return { room };
  }

  // ---------- websocket messages ----------
  function onMessage(ws, m) {
    switch (m.t) {
      case 'hostHello': {
        if (!store.validHostId(m.hostId)) return send(ws, { t: 'hostError', error: 'Bad host id' });
        ws.hostId = m.hostId;
        const held = hostPlan(ws.hostId);
        send(ws, { t: 'hostInfo', plan: publicPlan(held.id, held.until) });
        const existing = roomByHost.get(ws.hostId);
        if (existing && !existing.closed) { ws.room = existing; existing.attachHost(ws); }
        return;
      }
      case 'hostCreate': {
        if (!ws.hostId) return send(ws, { t: 'hostError', error: 'Say hello first' });
        if (!roomCreate.take(ws.ip)) return send(ws, { t: 'hostError', error: 'Too many rooms from this network. Try later.' });
        const old = roomByHost.get(ws.hostId);
        if (old) dropRoom(old, 'replaced');
        const r = makeRoom(ws.hostId, ws.ip);
        if (r.error) return send(ws, { t: 'hostError', error: r.error });
        ws.room = r.room; r.room.attachHost(ws);
        return;
      }
      case 'closeRoom': {
        if (!ws.hostId) return;
        const r = roomByHost.get(ws.hostId);
        if (r && ws.room === r) { dropRoom(r, 'closed by host'); send(ws, { t: 'roomClosed', reason: 'closed by host' }); }
        return;
      }
      case 'redeem': {
        if (!ws.hostId) return send(ws, { t: 'hostError', error: 'Say hello first' });
        if (!redeemTries.take(ws.ip)) return send(ws, { t: 'redeemResult', ok: false, error: 'Too many tries. Wait a few minutes.' });
        const res = store.redeem(ws.hostId, m.code);
        if (!res.ok) return send(ws, { t: 'redeemResult', ok: false, error: res.error });
        const held = hostPlan(ws.hostId);
        send(ws, { t: 'redeemResult', ok: true, plan: publicPlan(held.id, held.until) });
        send(ws, { t: 'hostInfo', plan: publicPlan(held.id, held.until) });
        return;
      }
      case 'join':
      case 'resume': {
        const code = String(m.room || '').trim().toUpperCase();
        if (failedJoin.full(ws.ip)) return send(ws, { t: 'joinError', error: 'Too many wrong attempts. Wait a few minutes.' });
        const room = rooms.get(code);
        if (!room) {
          failedJoin.take(ws.ip);
          return send(ws, m.t === 'resume' ? { t: 'resumeFailed' } : { t: 'joinError', error: 'No room with that code' });
        }
        if (ws.room && ws.room !== room) ws.room.detach(ws);
        return room.handle(ws, m);
      }
      default:
        if (ws.room) return ws.room.handle(ws, m);
    }
  }

  // ---------- http ----------
  function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(JSON.stringify(obj));
  }

  async function onRequest(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, rooms: rooms.size });
      if (url.pathname === '/qr.svg') {
        const code = String(url.searchParams.get('room') || '').toUpperCase();
        if (!rooms.has(code)) { res.writeHead(404, SECURITY_HEADERS); return res.end('No such room'); }
        const svg = await QRCode.toString(`${baseUrl(req)}/?room=${code}`, { type: 'svg', margin: 1, width: 260 });
        res.writeHead(200, { 'Content-Type': MIME['.svg'], 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
        return res.end(svg);
      }
      if (url.pathname === '/admin/codes') {
        if (!o.adminToken || o.adminToken.length < 16) return sendJson(res, 404, { error: 'disabled' });
        const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
        const want = Buffer.from(o.adminToken);
        if (req.method !== 'POST' || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return sendJson(res, 401, { error: 'unauthorized' });
        const q = url.searchParams;
        try {
          const codes = store.makeCodes({ count: Number(q.get('count') || 1), plan: q.get('plan') || 'pro', days: Number(q.get('days') || 0), hours: Number(q.get('hours') || 0) });
          return sendJson(res, 200, { codes });
        } catch (e) { return sendJson(res, 400, { error: e.message }); }
      }
      let p = url.pathname === '/' ? '/index.html' : url.pathname === '/host' ? '/host.html' : url.pathname;
      p = decodeURIComponent(p);
      let base;
      if (p.startsWith('/shared/')) { base = path.join(ROOT, 'shared'); p = p.slice('/shared'.length); } else base = path.join(ROOT, 'public');
      const file = path.normalize(path.join(base, p));
      if (!file.startsWith(base + path.sep)) { res.writeHead(403, SECURITY_HEADERS); return res.end('Forbidden'); }
      fs.readFile(file, (e, data) => {
        if (e) { res.writeHead(404, SECURITY_HEADERS); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
        res.end(data);
      });
    } catch (e) { res.writeHead(400, SECURITY_HEADERS); res.end('Bad request'); }
  }

  const server = http.createServer(onRequest);

  // Origin check: browsers always send Origin on WebSocket handshakes. Reject other sites using our server.
  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients (tests, bots) are limited by the other caps
    try {
      const u = new URL(origin);
      if (o.publicUrl) return u.host === new URL(o.publicUrl).host;
      return u.host === String(req.headers.host || '');
    } catch (e) { return false; }
  }

  const wss = new WebSocketServer({
    server, maxPayload: 16 * 1024,
    verifyClient: (info, cb) => {
      const ip = clientIp(info.req);
      if (!originAllowed(info.req)) return cb(false, 403, 'Bad origin');
      if (sockets.size >= o.maxConnections) return cb(false, 503, 'Busy');
      if ((perIp.get(ip) || 0) >= o.maxConnectionsPerIp) return cb(false, 429, 'Too many connections');
      cb(true);
    },
  });

  wss.on('connection', (ws, req) => {
    ws.ip = clientIp(req);
    perIp.set(ws.ip, (perIp.get(ws.ip) || 0) + 1);
    sockets.add(ws);
    ws.isAlive = true;
    ws.bucket = 30; ws.bucketAt = Date.now(); ws.drops = 0;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      // token bucket: 30 burst, 10 messages per second sustained
      const t = Date.now();
      ws.bucket = Math.min(30, ws.bucket + ((t - ws.bucketAt) / 1000) * 10); ws.bucketAt = t;
      if (ws.bucket < 1) { if (++ws.drops > 100) ws.terminate(); return; }
      ws.bucket -= 1;
      let m;
      try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (!m || typeof m.t !== 'string') return;
      try { onMessage(ws, m); } catch (e) { console.error('handler error', e); }
    });
    ws.on('close', () => {
      sockets.delete(ws);
      const n = (perIp.get(ws.ip) || 1) - 1;
      if (n <= 0) perIp.delete(ws.ip); else perIp.set(ws.ip, n);
      if (ws.room) ws.room.detach(ws);
    });
    ws.on('error', () => {});
  });

  const hb = setInterval(() => {
    for (const ws of sockets) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) { /* ignore */ } }
  }, 15000);
  hb.unref();

  function sweep() {
    const t = Date.now();
    for (const room of [...rooms.values()]) {
      const st = room.state;
      const idle = t - room.lastActive;
      if (room.size === 0 && idle > o.idleMs) dropRoom(room, 'idle');
      else if (st.phase === 'ended' && idle > o.endedMs) dropRoom(room, 'finished');
      else if (t - room.createdAt > o.maxAgeMs) dropRoom(room, 'too old');
    }
    failedJoin.sweep(); roomCreate.sweep(); redeemTries.sweep();
  }
  const sw = setInterval(sweep, o.sweepMs);
  sw.unref();

  function listen(port = opts.port ?? 3000, bindHost = opts.host ?? '0.0.0.0') {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, bindHost, () => { httpPort = server.address().port; resolve(httpPort); });
    });
  }
  function close() {
    return new Promise((resolve) => {
      clearInterval(hb); clearInterval(sw);
      for (const r of [...rooms.values()]) dropRoom(r, 'server stopping');
      for (const ws of sockets) try { ws.terminate(); } catch (e) { /* ignore */ }
      wss.close(() => server.close(() => resolve()));
    });
  }

  return {
    listen, close, sweep, store,
    get port() { return httpPort; },
    get rooms() { return rooms; },
    roomByHost: (id) => roomByHost.get(id),
    hostUrl: () => `${o.publicUrl || `http://${lanIp()}:${httpPort}`}/host.html`,
    joinUrl: (code) => `${o.publicUrl || `http://${lanIp()}:${httpPort}`}/?room=${code}`,
  };
}

module.exports = { createGameServer, PLANS, lanIp, makeLimiter };
