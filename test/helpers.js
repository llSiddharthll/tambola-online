'use strict';
const WebSocket = require('ws');
const { createGameServer } = require('../src/game');

class Bot {
  constructor(port) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.state = null;
    this.tickets = [];
    this.msgs = [];
    this.waiters = [];
    this.token = null;
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      this.msgs.push(m);
      if (m.t === 'state') {
        this.state = m;
        if (m.you && m.you.tickets) this.tickets = m.you.tickets;
      }
      if (m.t === 'joined') this.token = m.token;
      this.waiters = this.waiters.filter((w) => !w(m));
      if (this.onMsg) this.onMsg(m);
    });
  }
  open() { return new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); }); }
  send(o) { this.ws.send(JSON.stringify(o)); }
  close() { try { this.ws.terminate(); } catch (e) { /* ignore */ } }
  // resolves with the first message (new or current state) satisfying pred
  waitFor(pred, ms = 8000, label = 'condition') {
    return new Promise((resolve, reject) => {
      if (this.state && pred(this.state)) return resolve(this.state);
      const timer = setTimeout(() => reject(new Error('timeout waiting for ' + label + '; last phase=' + (this.state && this.state.phase) + ' seq=' + (this.state && this.state.seq))), ms);
      this.waiters.push((m) => {
        if (pred(m)) { clearTimeout(timer); resolve(m); return true; }
        return false;
      });
    });
  }
  waitMsg(type, ms = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for msg ' + type)), ms);
      this.waiters.push((m) => { if (m.t === type) { clearTimeout(timer); resolve(m); return true; } return false; });
    });
  }
}

async function startServer(over = {}) {
  const app = createGameServer({
    plan: 'pro', port: 0, host: '127.0.0.1', minSeconds: 0.01, claimWindowMs: 150,
    resumeDelayMs: 40, firstCallDelayMs: 80, endDelayMs: 80, ...over,
  });
  await app.listen(0, '127.0.0.1');
  return app;
}

const newHostId = () => require('crypto').randomBytes(18).toString('base64url');

// Connects a host, says hello and creates a room. h.hostId and h.room are set for convenience.
async function connectHost(app, hostId = newHostId()) {
  const h = new Bot(app.port);
  await h.open();
  h.hostId = hostId;
  const info = h.waitMsg('hostInfo');
  h.send({ t: 'hostHello', hostId });
  h.info = await info;
  if (!(h.state && h.state.host)) {
    h.send({ t: 'hostCreate' });
    await h.waitFor((s) => s.t === 'state' && !!s.host);
  }
  h.room = h.state.room;
  return h;
}

async function joinPlayer(app, room, name, tickets) {
  const b = new Bot(app.port);
  await b.open();
  b.send({ t: 'join', room, name, tickets });
  await Promise.race([
    b.waitFor((s) => s.t === 'state' && !!s.you, 3000, 'join of ' + name),
    b.waitMsg('joinError', 3000).then((m) => { throw new Error('joinError: ' + m.error); }),
  ]);
  return b;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { Bot, startServer, connectHost, joinPlayer, sleep, newHostId };
