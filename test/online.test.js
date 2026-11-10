'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createHostStore } = require('../src/hoststore');
const { Bot, startServer, connectHost, joinPlayer, sleep, newHostId } = require('./helpers');

test('rooms are isolated: same names, separate state, wrong code rejected', async () => {
  const app = await startServer({ plan: 'free', firstCallDelayMs: 40, claimWindowMs: 100 });
  const hostA = await connectHost(app);
  const hostB = await connectHost(app);
  assert.notEqual(hostA.room, hostB.room);
  assert.match(hostA.room, /^[A-HJKMNP-Z2-9]{5}$/);
  const a1 = await joinPlayer(app, hostA.room, 'Asha', 1);
  const b1 = await joinPlayer(app, hostB.room, 'Asha', 2); // same name, other room: allowed
  await hostA.waitFor((s) => s.players.length === 1);
  await hostB.waitFor((s) => s.players.length === 1);
  assert.equal(hostB.state.players[0].tickets, 2);

  hostA.send({ t: 'config', config: { callSeconds: 30 } });
  hostA.send({ t: 'start' });
  await a1.waitFor((s) => s.phase === 'running');
  await sleep(150);
  assert.equal(hostB.state.phase, 'lobby', 'room B untouched by room A starting');
  assert.equal(b1.state.phase, 'lobby');
  // room code is case-insensitive for players
  const lower = await joinPlayer(app, hostB.room.toLowerCase(), 'Bela', 1);
  await hostB.waitFor((s) => s.players.length === 2);
  // host A cannot control room B
  hostA.send({ t: 'kick', playerId: hostB.state.players[0].id });
  await sleep(80);
  assert.equal(hostB.state.players.length, 2);
  [hostA, hostB, a1, b1, lower].forEach((b) => b.close());
  await app.close();
});

test('plans: free by default, activation code upgrades, codes are single use and expire', async () => {
  let clock = 1_000_000;
  const hostStore = createHostStore({ now: () => clock });
  const app = await startServer({ plan: 'free', hostStore });
  const hid = newHostId();
  const h = await connectHost(app, hid);
  assert.equal(h.info.plan.id, 'free');
  assert.equal(h.state.plan.maxPlayers, 8);

  const [proCode] = hostStore.makeCodes({ plan: 'pro', days: 30 });
  const [passCode] = hostStore.makeCodes({ plan: 'pass', hours: 24 });
  h.send({ t: 'redeem', code: 'PRO-NOPE-NOPE' });
  assert.match((await h.waitMsg('redeemResult')).error, /not valid/);

  h.send({ t: 'redeem', code: ' ' + proCode.toLowerCase() + ' ' }); // sloppy typing still works
  const ok = await h.waitMsg('redeemResult');
  assert.equal(ok.ok, true);
  assert.equal(ok.plan.id, 'pro');
  assert.equal(ok.plan.until, clock + 30 * 86400000);

  // single use, also from another host id
  const other = await connectHost(app, newHostId());
  other.send({ t: 'redeem', code: proCode });
  assert.match((await other.waitMsg('redeemResult')).error, /already used/);

  // a pass cannot replace an active pro plan
  h.send({ t: 'redeem', code: passCode });
  assert.match((await h.waitMsg('redeemResult')).error, /already have/);

  // new rooms get the new plan; the old room keeps its plan
  assert.equal(h.state.plan.id, 'free');
  h.send({ t: 'hostCreate' });
  const s = await h.waitFor((x) => x.t === 'state' && x.plan.id === 'pro');
  assert.equal(s.plan.maxPlayers, 50);
  assert.ok(s.plan.patterns.includes('corners'));

  // pro expires
  clock += 31 * 86400000;
  const again = await connectHost(app, hid);
  assert.equal(again.info.plan.id, 'free');
  [h, other, again].forEach((b) => b.close());
  await app.close();
});

test('party pass gives 30 players; stacking the same plan extends it', async () => {
  let clock = 5_000;
  const hostStore = createHostStore({ now: () => clock });
  const hid = newHostId();
  const [c1, c2] = hostStore.makeCodes({ plan: 'pass', hours: 24, count: 2 });
  assert.equal(hostStore.redeem(hid, c1).ok, true);
  const first = hostStore.planFor(hid).until;
  assert.equal(hostStore.redeem(hid, c2).ok, true);
  assert.equal(hostStore.planFor(hid).until, first + 24 * 3600000);
  const app = await startServer({ plan: 'free', hostStore });
  const h = await connectHost(app, hid);
  assert.equal(h.state.plan.id, 'pass');
  assert.equal(h.state.plan.maxPlayers, 30);
  h.close();
  await app.close();
});

test('host store persists across restarts and rejects malformed input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-'));
  const file = path.join(dir, 'hosts.json');
  const a = createHostStore({ file });
  const [code] = a.makeCodes({ plan: 'pro', days: 1 });
  const hid = newHostId();
  assert.equal(a.redeem(hid, code).ok, true);
  const b = createHostStore({ file });
  assert.equal(b.planFor(hid).id, 'pro');
  assert.equal(b.redeem(newHostId(), code).ok, false);
  assert.throws(() => b.makeCodes({ plan: 'free', days: 1 }));
  assert.throws(() => b.makeCodes({ plan: 'pro', days: 0 }));
  assert.throws(() => b.makeCodes({ plan: 'pro', days: 1, count: 100000 }));
  assert.equal(b.redeem('x', code).ok, false);
  assert.equal(b.planFor('../../etc').id, 'free');
  // a second process (the CLI) adds codes while the first store is alive: both see them, nothing is lost
  const [late] = createHostStore({ file }).makeCodes({ plan: 'pass', hours: 1 });
  const h2 = newHostId();
  assert.equal(b.redeem(h2, late).ok, true, 'running store sees codes made by another process');
  assert.equal(createHostStore({ file }).planFor(h2).id, 'pass');
  assert.equal(createHostStore({ file }).planFor(hid).id, 'pro', 'earlier redemption still there');
  fs.rmSync(dir, { recursive: true });
});

test('host can reconnect to their room; creating or closing a room notifies players', async () => {
  const app = await startServer({ plan: 'free' });
  const hid = newHostId();
  const h = await connectHost(app, hid);
  const p = await joinPlayer(app, h.room, 'Asha', 1);
  h.close();
  await p.waitFor((s) => s.t === 'state' && true);
  // same browser comes back: gets the same room without creating one
  const back = await connectHost(app, hid);
  assert.equal(back.room, h.room);
  assert.equal(back.state.players.length, 1);
  assert.equal(app.rooms.size, 1);
  // a stranger with a different id gets their own room, not this one
  const stranger = await connectHost(app, newHostId());
  assert.notEqual(stranger.room, h.room);
  // close
  back.send({ t: 'closeRoom' });
  const closed = await p.waitMsg('roomClosed');
  assert.match(closed.reason, /host/);
  assert.equal(app.rooms.has(h.room), false);
  // joining a closed room fails
  const late = new Bot(app.port); await late.open();
  late.send({ t: 'join', room: h.room, name: 'X', tickets: 1 });
  assert.match((await late.waitMsg('joinError')).error, /No room/);
  // creating a second room replaces the first
  const old = stranger.room;
  const p2 = await joinPlayer(app, old, 'Bimal', 1);
  stranger.send({ t: 'hostCreate' });
  await p2.waitMsg('roomClosed');
  await stranger.waitFor((s) => s.t === 'state' && s.room !== old);
  assert.equal(app.rooms.size, 1);
  [back, stranger, p, p2, late].forEach((b) => b.close());
  await app.close();
});

test('sweep removes idle, finished and too-old rooms but keeps active ones', async () => {
  const app = await startServer({ plan: 'free', idleMs: 50, endedMs: 50, maxAgeMs: 100000 });
  const idle = await connectHost(app);
  const idleRoom = idle.room;
  idle.close();
  const live = await connectHost(app);
  await sleep(120);
  app.sweep();
  assert.equal(app.rooms.has(idleRoom), false, 'abandoned room dropped');
  assert.equal(app.rooms.has(live.room), true, 'room with a connected host kept');
  live.close();
  await app.close();
  const app2 = await startServer({ plan: 'free', maxAgeMs: 30 });
  const old = await connectHost(app2);
  await sleep(60);
  app2.sweep();
  assert.equal(app2.rooms.size, 0, 'room past max age dropped even if connected');
  old.close();
  await app2.close();
});

test('abuse limits: rooms cap, connections per IP, failed joins, bad origin, message flood', async () => {
  // room cap
  const app = await startServer({ plan: 'free', maxRooms: 2 });
  const h1 = await connectHost(app); const h2 = await connectHost(app);
  const h3 = new Bot(app.port); await h3.open();
  h3.send({ t: 'hostHello', hostId: newHostId() });
  await h3.waitMsg('hostInfo');
  h3.send({ t: 'hostCreate' });
  assert.match((await h3.waitMsg('hostError')).error, /busy/i);
  [h1, h2, h3].forEach((b) => b.close());
  await app.close();

  // connections per IP
  const app2 = await startServer({ plan: 'free', maxConnectionsPerIp: 2 });
  const c1 = new Bot(app2.port); await c1.open();
  const c2 = new Bot(app2.port); await c2.open();
  const c3 = new Bot(app2.port);
  await assert.rejects(c3.open(), /429/);
  c1.close(); await sleep(60);
  const c4 = new Bot(app2.port); await c4.open(); // slot freed
  [c2, c4].forEach((b) => b.close());
  await app2.close();

  // failed room-code guesses are throttled per IP
  const app3 = await startServer({ plan: 'free', failedJoinsPerIp: 3 });
  const g = new Bot(app3.port); await g.open();
  for (let i = 0; i < 3; i++) { g.send({ t: 'join', room: 'ABCD' + i, name: 'X', tickets: 1 }); assert.match((await g.waitMsg('joinError')).error, /No room/); }
  g.send({ t: 'join', room: 'ABCDE', name: 'X', tickets: 1 });
  assert.match((await g.waitMsg('joinError')).error, /Too many/);
  // even a correct code is refused while throttled
  const hh = await connectHost(app3);
  g.send({ t: 'join', room: hh.room, name: 'X', tickets: 1 });
  assert.match((await g.waitMsg('joinError')).error, /Too many/);
  g.close(); hh.close();
  await app3.close();

  // origin check: only our own site may open sockets when PUBLIC_URL is set
  const app4 = await startServer({ plan: 'free', publicUrl: 'https://tambola.example.com' });
  const evil = new WebSocket(`ws://127.0.0.1:${app4.port}`, { headers: { Origin: 'https://evil.example.org' } });
  await assert.rejects(new Promise((res, rej) => { evil.on('open', res); evil.on('error', rej); }), /403/);
  const good = new WebSocket(`ws://127.0.0.1:${app4.port}`, { headers: { Origin: 'https://tambola.example.com' } });
  await new Promise((res, rej) => { good.on('open', res); good.on('error', rej); });
  good.close();
  await app4.close();

  // message flood: server stays up, flooder is cut off, others unaffected
  const app5 = await startServer({ plan: 'pro' });
  const host = await connectHost(app5);
  const flood = new Bot(app5.port); await flood.open();
  for (let i = 0; i < 400; i++) flood.send({ t: 'join', room: host.room, name: 'F' + i, tickets: 1 });
  await sleep(300);
  assert.ok(host.state.players.length <= 40, 'rate limit capped accepted joins, got ' + host.state.players.length);
  const ok = await joinPlayer(app5, host.room, 'Normal', 1);
  assert.ok(ok.state.you);
  [host, flood, ok].forEach((b) => b.close());
  await app5.close();
});

test('http: security headers, health, QR only for live rooms, admin endpoint is locked down', async () => {
  const token = 'a'.repeat(24);
  const app = await startServer({ plan: 'free', adminToken: token });
  const base = `http://127.0.0.1:${app.port}`;
  const idx = await fetch(base + '/');
  assert.equal(idx.headers.get('x-content-type-options'), 'nosniff');
  assert.match(idx.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(idx.headers.get('x-frame-options'), 'DENY');
  assert.equal((await (await fetch(base + '/healthz')).json()).ok, true);
  assert.equal((await fetch(base + '/qr.svg?room=NOPE1')).status, 404);
  assert.equal((await fetch(base + '/qr.svg')).status, 404);
  assert.equal((await fetch(base + '/..%2f..%2fpackage.json')).status >= 400, true);
  assert.equal((await fetch(base + '/src/game.js')).status, 404, 'server source is not served');

  const host = await connectHost(app);
  const qr = await fetch(base + '/qr.svg?room=' + host.room);
  assert.equal(qr.status, 200);
  assert.match(await qr.text(), /<svg/);

  assert.equal((await fetch(base + '/admin/codes?count=1&plan=pro&days=30')).status, 401, 'GET without token');
  assert.equal((await fetch(base + '/admin/codes?count=1&plan=pro&days=30', { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + '/admin/codes?count=1&plan=pro&days=30', { method: 'POST', headers: { Authorization: 'Bearer ' + 'b'.repeat(24) } })).status, 401);
  const res = await fetch(base + '/admin/codes?count=2&plan=pass&hours=24', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  assert.equal(res.status, 200);
  const { codes } = await res.json();
  assert.equal(codes.length, 2);
  assert.match(codes[0], /^PASS-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((await fetch(base + '/admin/codes?count=1&plan=free&days=1', { method: 'POST', headers: { Authorization: 'Bearer ' + token } })).status, 400);
  host.send({ t: 'redeem', code: codes[0] });
  assert.equal((await host.waitMsg('redeemResult')).ok, true);
  host.close();
  await app.close();

  // admin is off entirely without a strong token
  const app2 = await startServer({ plan: 'free', adminToken: 'short' });
  assert.equal((await fetch(`http://127.0.0.1:${app2.port}/admin/codes?count=1&plan=pro&days=1`, { method: 'POST', headers: { Authorization: 'Bearer short' } })).status, 404);
  await app2.close();
});

test('redeem attempts are throttled', async () => {
  const app = await startServer({ plan: 'free' });
  const h = await connectHost(app);
  let last;
  for (let i = 0; i < 12; i++) { h.send({ t: 'redeem', code: 'PRO-AAAA-BBB' + (i % 10) }); last = await h.waitMsg('redeemResult'); }
  assert.match(last.error, /Too many/);
  h.close();
  await app.close();
});
