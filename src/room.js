'use strict';
/* One tambola room: the authoritative game state machine for a single host and their players.
 * The server (src/game.js) owns sockets, rooms and hosts; a room only sees the sockets attached to it.
 * Everything is points. There is no money anywhere in this code on purpose. */
const crypto = require('crypto');
const E = require('./engine');
const P = require('../shared/patterns');

const PLANS = {
  free: { id: 'free', name: 'Free', maxPlayers: 8, maxTickets: 3, patterns: ['early5', 'top', 'middle', 'bottom', 'full'] },
  pass: { id: 'pass', name: 'Party Pass', maxPlayers: 30, maxTickets: 6, patterns: Object.keys(P.PATTERNS) },
  pro: { id: 'pro', name: 'Pro', maxPlayers: 50, maxTickets: 6, patterns: Object.keys(P.PATTERNS) },
};

function sanitizeName(s) {
  return String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

function createRoom(cfg) {
  const { code, hostId, joinUrl = () => '' } = cfg;
  const plan = PLANS[cfg.plan || 'free'];
  const minSeconds = cfg.minSeconds ?? 3;
  const claimWindowMs = cfg.claimWindowMs ?? 1500;
  const resumeDelayMs = cfg.resumeDelayMs ?? 2500;
  const firstCallDelayMs = cfg.firstCallDelayMs ?? 3500;
  const endDelayMs = cfg.endDelayMs ?? 3000;
  const clients = new Set();
  const createdAt = Date.now();
  let lastActive = createdAt;
  let host = null;
  let closed = false;

  function defaultConfig() {
    return {
      maxPlayers: plan.maxPlayers,
      maxTickets: Math.min(3, plan.maxTickets),
      entryPoints: 50,
      callSeconds: 6,
      bogeyPenalty: 'bar',
      prizes: (E.PLAN_DEFAULTS[plan.id] || E.PLAN_DEFAULTS.pro).map(([pattern, share]) => ({ pattern, share })),
    };
  }
  function freshGame(keep) {
    return {
      id: crypto.randomBytes(4).toString('hex'),
      phase: 'lobby',
      config: keep ? keep.config : defaultConfig(),
      players: new Map(), tokens: new Map(),
      sequence: null, seq: 0, salt: null, commit: null,
      pot: 0, prizes: [], paused: false, timer: null, endTimer: null,
      windows: 0, events: [], eventId: 0, summary: null, revealed: null,
    };
  }
  let G = freshGame();

  const touch = () => { lastActive = Date.now(); };

  function addEvent(text, kind) {
    G.events.push({ id: ++G.eventId, text, kind: kind || 'info' });
    if (G.events.length > 12) G.events.shift();
  }

  // ---------- messaging ----------
  function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function publicPrizes() {
    return G.prizes.map((p) => ({
      id: p.id, label: P.PATTERNS[p.id].label, share: p.share, points: p.points,
      status: p.status, pending: !!p.window, winners: p.winners, leftover: p.leftover, awardedAtSeq: p.awardedAtSeq || 0,
    }));
  }

  function stateFor(ws, withTickets) {
    const s = {
      t: 'state',
      room: code,
      gameId: G.id, phase: G.phase, paused: G.paused,
      plan: { id: plan.id, name: plan.name, maxPlayers: plan.maxPlayers, maxTickets: plan.maxTickets, patterns: plan.patterns },
      config: G.config,
      seq: G.seq,
      called: G.sequence ? G.sequence.slice(0, G.seq) : [],
      pot: G.pot, commit: G.commit,
      prizes: publicPrizes(),
      players: [...G.players.values()].map((p) => ({
        id: p.id, name: p.name, tickets: p.ticketCount, connected: p.connected, won: p.winnings,
      })),
      events: G.events,
      summary: G.summary,
      reveal: G.revealed,
    };
    if (ws.role === 'host') s.host = { joinUrl: joinUrl(code) };
    if (ws.player) {
      const p = ws.player;
      s.you = { id: p.id, name: p.name, ticketCount: p.ticketCount, entry: p.entry, winnings: p.winnings, barred: [...p.barred] };
      if (withTickets) s.you.tickets = p.tickets;
    }
    return s;
  }

  function broadcast(withTickets) {
    for (const ws of clients) if (ws.role === 'host' || ws.player) send(ws, stateFor(ws, !!withTickets));
  }

  // ---------- timers ----------
  function clearTimer() { if (G.timer) { clearTimeout(G.timer); G.timer = null; } }
  function clearAllTimers() {
    clearTimer();
    if (G.endTimer) { clearTimeout(G.endTimer); G.endTimer = null; }
    for (const pz of G.prizes) if (pz.window) { clearTimeout(pz.window); pz.window = null; }
  }
  function scheduleNext(delayMs) {
    clearTimer();
    if (closed || G.phase !== 'running' || G.paused || G.windows > 0 || G.endTimer) return;
    const delay = delayMs ?? G.config.callSeconds * 1000;
    G.timer = setTimeout(() => {
      G.timer = null;
      if (G.seq >= 90) endGame(); else callNext();
    }, delay);
  }

  function callNext() {
    if (G.phase !== 'running' || G.windows > 0 || G.seq >= 90) return;
    G.seq++;
    broadcast(false);
    scheduleNext();
  }

  // ---------- host actions ----------
  function applyConfig(patch) {
    const c = { ...G.config };
    const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
    if ('maxPlayers' in patch) { const v = int(patch.maxPlayers, 1, plan.maxPlayers); if (v === null) return `Players: 1 to ${plan.maxPlayers} on the ${plan.name} plan`; c.maxPlayers = v; }
    if ('maxTickets' in patch) { const v = int(patch.maxTickets, 1, plan.maxTickets); if (v === null) return `Tickets per player: 1 to ${plan.maxTickets} on the ${plan.name} plan`; c.maxTickets = v; }
    if ('entryPoints' in patch) { const v = int(patch.entryPoints, 0, 100000); if (v === null) return 'Entry points must be a whole number 0 to 100000'; c.entryPoints = v; }
    if ('callSeconds' in patch) { const v = Number(patch.callSeconds); if (!(v >= minSeconds && v <= 30)) return `Call speed: ${minSeconds} to 30 seconds`; c.callSeconds = v; }
    if ('bogeyPenalty' in patch) { if (!['bar', 'none'].includes(patch.bogeyPenalty)) return 'Bad bogey setting'; c.bogeyPenalty = patch.bogeyPenalty; }
    if ('prizes' in patch) {
      const r = E.normalizePrizes(patch.prizes, plan.patterns);
      if (!r.ok) return r.error;
      c.prizes = r.prizes;
    }
    if (G.players.size > c.maxPlayers) return 'Room already has more players than that';
    for (const p of G.players.values()) if (p.ticketCount > c.maxTickets) p.ticketCount = c.maxTickets;
    G.config = c;
    return null;
  }

  function startGame() {
    if (G.phase !== 'lobby') return 'Game already started';
    if (G.players.size < 1) return 'Need at least one player';
    const provider = cfg.ticketProvider || E.makeTicketPool();
    G.sequence = cfg.fixedSequence ? cfg.fixedSequence.slice() : E.newSequence();
    G.salt = E.newSalt();
    G.commit = E.commit(G.sequence, G.salt);
    G.id = crypto.randomBytes(4).toString('hex');
    let pot = 0;
    for (const p of G.players.values()) {
      p.tickets = provider.take(p.ticketCount);
      p.entry = p.ticketCount * G.config.entryPoints;
      p.winnings = 0; p.barred = new Set(); p.wonFamily = new Set();
      pot += p.entry;
    }
    G.pot = pot;
    G.prizes = G.config.prizes.map((pz) => ({
      id: pz.pattern, share: pz.share, points: E.prizePoints(pot, pz.share),
      status: 'open', winners: [], leftover: 0, pending: [], window: null,
    }));
    G.phase = 'running'; G.paused = false; G.seq = 0; G.windows = 0; G.events = []; G.summary = null; G.revealed = null;
    addEvent(`Game started: ${G.players.size} players, pot ${pot} points. Fair-play code ${G.commit.slice(0, 8)}`, 'start');
    broadcast(true);
    scheduleNext(firstCallDelayMs);
    return null;
  }

  function pause() { if (G.phase !== 'running' || G.paused) return; G.paused = true; clearTimer(); addEvent('Game paused', 'info'); broadcast(false); }
  function resume() { if (G.phase !== 'running' || !G.paused) return; G.paused = false; addEvent('Game resumed', 'info'); broadcast(false); scheduleNext(resumeDelayMs); }

  function endGame() {
    if (G.phase !== 'running') return;
    clearAllTimers();
    G.windows = 0;
    G.phase = 'ended'; G.paused = false;
    const players = [...G.players.values()].map((p) => ({ name: p.name, tickets: p.ticketCount, entry: p.entry, won: p.winnings, net: p.winnings - p.entry }));
    const unclaimed = G.prizes.filter((p) => p.status !== 'awarded').reduce((s, p) => s + p.points, 0);
    const rounding = G.prizes.reduce((s, p) => s + (p.leftover || 0), 0);
    const allocated = G.prizes.reduce((s, p) => s + p.points, 0);
    G.summary = { players, pot: G.pot, unclaimed, rounding, unallocated: G.pot - allocated, called: G.seq };
    G.revealed = { salt: G.salt, sequence: G.sequence };
    addEvent('Game over', 'end');
    broadcast(true);
  }

  function newGame() {
    clearAllTimers();
    const old = G;
    G = freshGame({ config: old.config });
    for (const p of old.players.values()) {
      const np = { ...p, tickets: [], entry: 0, winnings: 0, barred: new Set(), wonFamily: new Set() };
      G.players.set(np.id, np);
      G.tokens.set(np.token, np.id);
      for (const ws of clients) if (ws.player && ws.player.id === np.id) ws.player = np;
    }
    broadcast(true);
  }

  // ---------- claims ----------
  function isClaimable(prize) {
    if (prize.status === 'awarded') return false;
    if (prize.id === 'full2') { const f = G.prizes.find((p) => p.id === 'full'); return !f || f.status === 'awarded'; }
    if (prize.id === 'full3') { const f = G.prizes.find((p) => p.id === 'full2'); return !f || f.status === 'awarded'; }
    return true;
  }

  function handleClaim(ws, m) {
    const player = ws.player;
    const fail = (reason) => send(ws, { t: 'claimResult', ok: false, prizeId: m.prizeId, reason });
    if (!player || G.phase !== 'running') return fail('No game running');
    const prize = G.prizes.find((p) => p.id === m.prizeId);
    if (!prize) return fail('Unknown prize');
    if (!isClaimable(prize)) return fail(prize.status === 'awarded' ? 'Already won' : 'Not open yet');
    if (player.barred.has(prize.id)) return fail('You called Bogey on this prize');
    const idx = m.ticketIdx;
    if (!Number.isInteger(idx) || !player.tickets[idx]) return fail('Pick one of your tickets');
    const family = P.PATTERNS[prize.id].family;
    if (family === 'full' && player.wonFamily.has(idx + ':full')) return fail('That ticket already won a Full House');
    const claimSeq = Math.max(0, Math.min(Number.isInteger(m.seq) ? m.seq : G.seq, G.seq));
    const called = new Set(G.sequence.slice(0, claimSeq));
    const label = P.PATTERNS[prize.id].label;
    if (!P.isComplete(prize.id, player.tickets[idx], called)) {
      if (G.config.bogeyPenalty === 'bar') player.barred.add(prize.id);
      addEvent(`${player.name} called ${label} too early: Bogey!`, 'bogey');
      send(ws, { t: 'claimResult', ok: false, bogey: true, prizeId: prize.id, reason: 'Bogey! That ticket is not complete.' });
      broadcast(false);
      return;
    }
    if (prize.pending.some((c) => c.playerId === player.id && c.ticketIdx === idx)) return fail('Already claimed, checking');
    prize.pending.push({ playerId: player.id, ticketIdx: idx, seq: claimSeq });
    send(ws, { t: 'claimResult', ok: true, prizeId: prize.id, reason: 'Claim received' });
    if (!prize.window) {
      G.windows++;
      clearTimer();
      addEvent(`${player.name} claims ${label}. Checking...`, 'claim');
      prize.window = setTimeout(() => resolvePrize(prize), claimWindowMs);
    }
    broadcast(false);
  }

  function resolvePrize(prize) {
    prize.window = null;
    G.windows = Math.max(0, G.windows - 1);
    if (closed || G.phase !== 'running') return;
    const minSeq = Math.min(...prize.pending.map((c) => c.seq));
    const winnersRaw = prize.pending.filter((c) => c.seq === minSeq);
    const { each, leftover } = E.splitPrize(prize.points, winnersRaw.length);
    prize.status = 'awarded';
    prize.leftover = leftover;
    prize.awardedAtSeq = minSeq;
    prize.winners = winnersRaw.map((c) => {
      const p = G.players.get(c.playerId);
      p.winnings += each;
      if (P.PATTERNS[prize.id].family === 'full') p.wonFamily.add(c.ticketIdx + ':full');
      return { playerId: p.id, name: p.name, ticketIdx: c.ticketIdx, points: each, ticket: p.tickets[c.ticketIdx] };
    });
    prize.pending = [];
    const names = [...new Set(prize.winners.map((w) => w.name))].join(' & ');
    addEvent(`${names} won ${P.PATTERNS[prize.id].label}${prize.winners.length > 1 ? ' (shared)' : ''}: ${each} points each`, 'win');
    const fullIds = G.prizes.filter((p) => P.PATTERNS[p.id].family === 'full');
    if (fullIds.every((p) => p.status === 'awarded')) {
      clearTimer();
      if (!G.endTimer) G.endTimer = setTimeout(() => { G.endTimer = null; endGame(); }, endDelayMs);
    }
    broadcast(false);
    if (G.windows === 0) scheduleNext(resumeDelayMs);
  }

  // ---------- connections ----------
  function attachPlayer(ws, player) {
    ws.role = 'player';
    ws.player = player;
    player.connected = true;
    for (const other of clients) if (other !== ws && other.player && other.player.id === player.id) { other.player = null; other.room = null; try { other.close(); } catch (e) { /* ignore */ } }
  }

  /** Add a socket to this room as host. A newer host socket replaces the old one. */
  function attachHost(ws) {
    if (host && host !== ws) { host.role = null; host.room = null; try { send(host, { t: 'replaced' }); host.close(); } catch (e) { /* ignore */ } clients.delete(host); }
    ws.role = 'host'; ws.room = api; host = ws; clients.add(ws); touch();
    send(ws, stateFor(ws, false));
  }

  function detach(ws) {
    if (!clients.delete(ws)) return;
    if (ws === host) host = null;
    touch();
    if (ws.player && ![...clients].some((c) => c !== ws && c.player && c.player.id === ws.player.id)) {
      ws.player.connected = false;
      broadcast(false);
    }
  }

  // Player messages. Returns nothing; replies go to ws.
  function handle(ws, m) {
    if (closed) return;
    touch();
    switch (m.t) {
      case 'join': {
        if (G.phase !== 'lobby') return send(ws, { t: 'joinError', error: 'Game already started' });
        const name = sanitizeName(m.name);
        if (!name) return send(ws, { t: 'joinError', error: 'Enter your name' });
        if ([...G.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) return send(ws, { t: 'joinError', error: 'That name is taken' });
        if (G.players.size >= G.config.maxPlayers) return send(ws, { t: 'joinError', error: 'Room is full' });
        const tickets = Number.isInteger(m.tickets) ? m.tickets : 1;
        if (tickets < 1 || tickets > G.config.maxTickets) return send(ws, { t: 'joinError', error: `Choose 1 to ${G.config.maxTickets} tickets` });
        const player = {
          id: crypto.randomBytes(4).toString('hex'), token: crypto.randomBytes(16).toString('hex'),
          name, ticketCount: tickets, tickets: [], entry: 0, winnings: 0, barred: new Set(), wonFamily: new Set(), connected: true,
        };
        G.players.set(player.id, player); G.tokens.set(player.token, player.id);
        ws.room = api; clients.add(ws);
        attachPlayer(ws, player);
        send(ws, { t: 'joined', token: player.token, room: code });
        addEvent(`${name} joined`, 'join');
        broadcast(false);
        send(ws, stateFor(ws, true));
        return;
      }
      case 'resume': {
        const id = G.tokens.get(String(m.token));
        const player = id && G.players.get(id);
        if (!player) return send(ws, { t: 'resumeFailed' });
        ws.room = api; clients.add(ws);
        attachPlayer(ws, player);
        send(ws, { t: 'joined', token: player.token, room: code });
        broadcast(false);
        send(ws, stateFor(ws, true));
        return;
      }
      case 'setTickets': {
        if (!ws.player || G.phase !== 'lobby') return;
        const n = m.tickets;
        if (!Number.isInteger(n) || n < 1 || n > G.config.maxTickets) return;
        ws.player.ticketCount = n;
        broadcast(false);
        return;
      }
      case 'claim': return handleClaim(ws, m);
      default: break;
    }
    // ---- host-only below ----
    if (ws.role !== 'host' || ws !== host) return;
    const err = (e) => send(ws, { t: 'hostError', error: e });
    switch (m.t) {
      case 'config': { if (G.phase !== 'lobby') return err('Cannot change settings during a game'); const e = applyConfig(m.config || {}); if (e) err(e); broadcast(false); return; }
      case 'start': { const e = startGame(); if (e) err(e); return; }
      case 'pauseGame': return pause();
      case 'resumeGame': return resume();
      case 'next': {
        if (G.phase !== 'running' || G.windows > 0) return;
        if (G.seq >= 90) return endGame();
        callNext();
        return;
      }
      case 'speed': {
        const v = Number(m.seconds);
        if (!(v >= minSeconds && v <= 30)) return err(`Call speed: ${minSeconds} to 30 seconds`);
        G.config = { ...G.config, callSeconds: v };
        if (G.phase === 'running' && !G.paused && G.windows === 0 && !G.endTimer) scheduleNext();
        broadcast(false);
        return;
      }
      case 'kick': {
        if (G.phase !== 'lobby') return err('Can only remove players in the lobby');
        const p = G.players.get(String(m.playerId));
        if (!p) return;
        G.players.delete(p.id); G.tokens.delete(p.token);
        for (const c of [...clients]) if (c.player && c.player.id === p.id) { send(c, { t: 'kicked' }); c.player = null; c.role = null; c.room = null; clients.delete(c); }
        broadcast(false);
        return;
      }
      case 'end': return endGame();
      case 'newGame': { if (G.phase !== 'ended') return err('Finish the current game first'); newGame(); return; }
      default: return;
    }
  }

  function close(reason) {
    if (closed) return;
    closed = true;
    clearAllTimers();
    for (const ws of [...clients]) {
      send(ws, { t: 'roomClosed', reason: reason || 'closed' });
      ws.room = null; ws.player = null; ws.role = null;
    }
    clients.clear(); host = null;
  }

  const api = {
    code, hostId, plan, createdAt,
    get state() { return G; },
    get lastActive() { return lastActive; },
    get size() { return clients.size; },
    get playerCount() { return G.players.size; },
    get closed() { return closed; },
    attachHost, detach, handle, close, stateFor,
  };
  return api;
}

module.exports = { createRoom, PLANS, sanitizeName };
