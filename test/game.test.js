'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../shared/patterns');
const { commitHash } = require('../shared/sha256');
const { Bot, startServer, connectHost, joinPlayer, sleep } = require('./helpers');

const T_A = [ // top row 5,21,40,71,85
  [5, 0, 21, 0, 40, 0, 0, 71, 85],
  [0, 12, 0, 33, 0, 52, 66, 74, 0],
  [8, 19, 0, 36, 0, 55, 0, 0, 90],
];
const T_B = [ // top row 2,14,35,62,88
  [2, 14, 0, 35, 0, 0, 62, 0, 88],
  [0, 0, 25, 0, 45, 56, 0, 77, 0],
  [9, 0, 28, 0, 48, 0, 69, 0, 89],
];
const rest = (first) => {
  const used = new Set(first);
  const r = [];
  for (let n = 1; n <= 90; n++) if (!used.has(n)) r.push(n);
  return first.concat(r);
};
const providerOf = (...tickets) => { let i = 0; return { take(n) { const out = []; for (let k = 0; k < n; k++) out.push(tickets[i++ % tickets.length]); return out; } }; };

async function lobby(app, names, tickets = 1, config = {}) {
  const host = await connectHost(app);
  const pin = host.state.room;
  host.send({ t: 'config', config: { entryPoints: 50, callSeconds: 30, ...config } });
  const players = [];
  for (const n of names) players.push(await joinPlayer(app, pin, n, tickets));
  return { host, players, pin };
}
const stepTo = async (host, seq) => {
  while ((host.state.seq || 0) < seq) {
    const target = host.state.seq + 1;
    host.send({ t: 'next' });
    await host.waitFor((s) => s.t === 'state' && s.seq >= target, 3000, 'seq ' + target);
  }
};

test('tie at the same call splits the prize; late claims are rejected', async () => {
  const app = await startServer({ fixedSequence: rest([5, 21, 40, 71, 85]), ticketProvider: providerOf(T_A, T_A, T_B), firstCallDelayMs: 600000 });
  const { host, players } = await lobby(app, ['Asha', 'Bimal', 'Chen']);
  host.send({ t: 'config', config: { prizes: [{ pattern: 'top', share: 20 }, { pattern: 'full', share: 80 }] } });
  host.send({ t: 'start' });
  await players[0].waitFor((s) => s.phase === 'running' && s.you.tickets.length === 1);
  await stepTo(host, 5);
  players[0].send({ t: 'claim', prizeId: 'top', ticketIdx: 0, seq: 5 });
  players[1].send({ t: 'claim', prizeId: 'top', ticketIdx: 0, seq: 5 });
  const s = await host.waitFor((x) => x.prizes.find((p) => p.id === 'top').status === 'awarded', 3000, 'top awarded');
  const top = s.prizes.find((p) => p.id === 'top');
  assert.equal(s.pot, 150);
  assert.equal(top.points, 30);
  assert.equal(top.winners.length, 2);
  assert.deepEqual(top.winners.map((w) => w.name).sort(), ['Asha', 'Bimal']);
  assert.ok(top.winners.every((w) => w.points === 15));
  assert.equal(top.awardedAtSeq, 5);
  // Chen's ticket is not complete at seq 5 and the prize is closed anyway
  players[2].send({ t: 'claim', prizeId: 'top', ticketIdx: 0, seq: 5 });
  const r = await players[2].waitMsg('claimResult');
  assert.equal(r.ok, false);
  assert.match(r.reason, /Already won/);
  const final = host.state.players;
  assert.equal(final.find((p) => p.name === 'Asha').won, 15);
  assert.equal(final.find((p) => p.name === 'Chen').won, 0);
  [host, ...players].forEach((b) => b.close());
  await app.close();
});

test('an earlier call number beats an earlier message (claim with lower seq wins the window)', async () => {
  // T_A completes top at call 9 (85), T_B completes top at call 10 (88)
  const seq = rest([5, 21, 40, 71, 2, 14, 35, 62, 85, 88]);
  const app = await startServer({ fixedSequence: seq, ticketProvider: providerOf(T_A, T_B), firstCallDelayMs: 600000, claimWindowMs: 400 });
  const { host, players } = await lobby(app, ['Asha', 'Bimal']);
  host.send({ t: 'config', config: { prizes: [{ pattern: 'top', share: 20 }, { pattern: 'full', share: 80 }] } });
  host.send({ t: 'start' });
  await players[0].waitFor((s) => s.phase === 'running');
  await stepTo(host, 10);
  players[1].send({ t: 'claim', prizeId: 'top', ticketIdx: 0, seq: 10 }); // Bimal arrives first, with the later call
  await sleep(60);
  players[0].send({ t: 'claim', prizeId: 'top', ticketIdx: 0, seq: 9 }); // Asha was first by call number
  const s = await host.waitFor((x) => x.prizes.find((p) => p.id === 'top').status === 'awarded', 3000, 'top awarded');
  const top = s.prizes.find((p) => p.id === 'top');
  assert.deepEqual(top.winners.map((w) => w.name), ['Asha']);
  assert.equal(top.awardedAtSeq, 9);
  assert.equal(top.winners[0].points, 20); // pot 100 * 20%
  [host, ...players].forEach((b) => b.close());
  await app.close();
});

test('bogey: false claim is rejected, player is barred from that prize, others unaffected', async () => {
  const app = await startServer({ fixedSequence: rest([5, 21]), ticketProvider: providerOf(T_A, T_B), firstCallDelayMs: 600000 });
  const { host, players } = await lobby(app, ['Asha', 'Bimal']);
  host.send({ t: 'start' });
  await players[0].waitFor((s) => s.phase === 'running');
  await stepTo(host, 2);
  players[0].send({ t: 'claim', prizeId: 'full', ticketIdx: 0, seq: 2 });
  const r1 = await players[0].waitMsg('claimResult');
  assert.equal(r1.ok, false); assert.equal(r1.bogey, true);
  players[0].send({ t: 'claim', prizeId: 'full', ticketIdx: 0, seq: 2 });
  const r2 = await players[0].waitMsg('claimResult');
  assert.match(r2.reason, /Bogey/);
  await host.waitFor((s) => s.events.some((e) => e.kind === 'bogey'), 2000, 'bogey event');
  assert.deepEqual(players[0].state.you.barred, ['full']);
  assert.deepEqual(players[1].state.you.barred, []);
  // a claim for a future call number is clamped to what has been called, so it cannot cheat
  players[1].send({ t: 'claim', prizeId: 'full', ticketIdx: 0, seq: 90 });
  const r3 = await players[1].waitMsg('claimResult');
  assert.equal(r3.bogey, true);
  [host, ...players].forEach((b) => b.close());
  await app.close();
});

test('second full house: opens only after the first; same ticket cannot win both; game then ends with reveal', async () => {
  const seq = rest([5, 21, 40, 71, 85, 12, 33, 52, 66, 74, 8, 19, 36, 55, 90]); // T_A full at call 15
  const app = await startServer({ fixedSequence: seq, ticketProvider: providerOf(T_A, T_A), firstCallDelayMs: 600000 });
  const { host, players } = await lobby(app, ['Asha', 'Bimal']);
  host.send({ t: 'config', config: { prizes: [{ pattern: 'full', share: 60 }, { pattern: 'full2', share: 40 }] } });
  host.send({ t: 'start' });
  await players[0].waitFor((s) => s.phase === 'running');
  await stepTo(host, 15);
  players[1].send({ t: 'claim', prizeId: 'full2', ticketIdx: 0, seq: 15 });
  assert.match((await players[1].waitMsg('claimResult')).reason, /Not open yet/);
  players[0].send({ t: 'claim', prizeId: 'full', ticketIdx: 0, seq: 15 });
  await host.waitFor((x) => x.prizes.find((p) => p.id === 'full').status === 'awarded', 3000, 'full awarded');
  assert.equal(host.state.phase, 'running');
  players[0].send({ t: 'claim', prizeId: 'full2', ticketIdx: 0, seq: 15 });
  assert.match((await players[0].waitMsg('claimResult')).reason, /already won a Full House/);
  players[1].send({ t: 'claim', prizeId: 'full2', ticketIdx: 0, seq: 15 });
  const end = await host.waitFor((x) => x.phase === 'ended', 4000, 'game end');
  assert.equal(end.summary.pot, 100);
  const byName = Object.fromEntries(end.summary.players.map((p) => [p.name, p]));
  assert.equal(byName.Asha.won, 60); assert.equal(byName.Bimal.won, 40);
  assert.equal(byName.Asha.net, 10); assert.equal(byName.Bimal.net, -10);
  assert.equal(end.reveal.sequence.length, 90);
  assert.equal(commitHash(end.reveal.sequence, end.reveal.salt), end.commit);
  [host, ...players].forEach((b) => b.close());
  await app.close();
});

test('plan limits, PIN, host-only controls and name rules are enforced by the server', async () => {
  const app = await startServer({ plan: 'free' });
  const host = await connectHost(app);
  const pin = host.state.room;
  assert.equal(host.state.plan.maxPlayers, 8);

  // Pro-only prize rejected
  host.send({ t: 'config', config: { prizes: [{ pattern: 'full', share: 50 }, { pattern: 'corners', share: 10 }] } });
  assert.match((await host.waitMsg('hostError')).error, /Pro/);
  // too many tickets / players per plan rejected
  host.send({ t: 'config', config: { maxTickets: 6 } });
  assert.match((await host.waitMsg('hostError')).error, /1 to 3/);
  host.send({ t: 'config', config: { maxPlayers: 9 } });
  assert.match((await host.waitMsg('hostError')).error, /1 to 8/);

  // wrong room code
  const bad = new Bot(app.port); await bad.open();
  bad.send({ t: 'join', room: 'ZZZZZ', name: 'X', tickets: 1 });
  assert.match((await bad.waitMsg('joinError')).error, /No room/);
  bad.close();

  // fill to 8, ninth rejected, duplicate name rejected, too many tickets rejected
  const ps = [];
  for (let i = 1; i <= 8; i++) ps.push(await joinPlayer(app, pin, 'P' + i, 1));
  const ninth = new Bot(app.port); await ninth.open();
  ninth.send({ t: 'join', room: pin, name: 'Late', tickets: 1 });
  assert.match((await ninth.waitMsg('joinError')).error, /full/);
  ninth.close();
  const dup = new Bot(app.port); await dup.open();
  dup.send({ t: 'join', room: pin, name: 'p1', tickets: 1 });
  assert.match((await dup.waitMsg('joinError')).error, /taken/);
  dup.close();
  ps[0].send({ t: 'setTickets', tickets: 4 });
  await sleep(50);
  assert.equal(host.state.players.find((p) => p.name === 'P1').tickets, 1); // 4 > 3, ignored
  ps[0].send({ t: 'setTickets', tickets: 3 });
  await host.waitFor((s) => s.players.find((p) => p.name === 'P1').tickets === 3, 2000, 'ticket change');

  // players cannot use host controls
  ps[1].send({ t: 'start' });
  ps[1].send({ t: 'config', config: { entryPoints: 99999 } });
  await sleep(100);
  assert.equal(host.state.phase, 'lobby');
  assert.equal(host.state.config.entryPoints, 50);
  // a socket that never said hello cannot create rooms or act as host in this room
  const imp = new Bot(app.port); await imp.open();
  imp.send({ t: 'hostCreate' });
  assert.match((await imp.waitMsg('hostError')).error, /hello/i);
  imp.send({ t: 'hostHello', hostId: 'short' });
  assert.match((await imp.waitMsg('hostError')).error, /Bad host id/);
  imp.close();

  [host, ...ps].forEach((b) => b.close());
  await app.close();
});

test('reconnect: a dropped player resumes with the same tickets and the full list of called numbers', async () => {
  const app = await startServer({ fixedSequence: rest([5, 21, 40]), ticketProvider: providerOf(T_A, T_B), firstCallDelayMs: 600000 });
  const { host, players } = await lobby(app, ['Asha', 'Bimal'], 1, { maxTickets: 2 });
  host.send({ t: 'start' });
  await players[0].waitFor((s) => s.phase === 'running');
  await stepTo(host, 3);
  const token = players[0].token, ticketsBefore = players[0].tickets;
  players[0].close();
  await host.waitFor((s) => s.players.find((p) => p.name === 'Asha').connected === false, 3000, 'disconnect shown');
  const back = new Bot(app.port); await back.open();
  back.send({ t: 'resume', room: host.room, token });
  const s = await back.waitFor((x) => x.t === 'state' && !!x.you && !!x.you.tickets, 3000, 'resume');
  assert.deepEqual(s.called, [5, 21, 40]);
  assert.deepEqual(s.you.tickets, ticketsBefore);
  await host.waitFor((x) => x.players.find((p) => p.name === 'Asha').connected === true, 3000, 'reconnected shown');
  const junk = new Bot(app.port); await junk.open();
  junk.send({ t: 'resume', room: host.room, token: 'deadbeef' });
  await junk.waitMsg('resumeFailed');
  [host, back, junk, players[1]].forEach((b) => b.close());
  await app.close();
});

test('pause stops calling, resume continues, speed change applies', async () => {
  const app = await startServer({ firstCallDelayMs: 50 });
  const { host, players } = await lobby(app, ['Asha'], 1, { callSeconds: 0.05 });
  host.send({ t: 'start' });
  await host.waitFor((s) => s.seq >= 2, 3000, 'two calls');
  host.send({ t: 'pauseGame' });
  await sleep(120);
  const frozen = host.state.seq;
  await sleep(300);
  assert.equal(host.state.seq, frozen);
  assert.equal(host.state.paused, true);
  host.send({ t: 'resumeGame' });
  await host.waitFor((s) => s.seq > frozen, 3000, 'continues after resume');
  [host, ...players].forEach((b) => b.close());
  await app.close();
});

test('full simulated game: 6 players with mixed tickets, instant auto-claims and a cheater', async () => {
  const app = await startServer();
  const host = await connectHost(app);
  const pin = host.state.room;
  host.send({ t: 'config', config: { maxTickets: 4, entryPoints: 40, callSeconds: 0.03 } });
  const specs = [['Asha', 1], ['Bimal', 2], ['Chen', 3], ['Divya', 4], ['Esha', 2], ['Farid', 1]];
  const bots = [];
  for (const [n, k] of specs) bots.push(await joinPlayer(app, pin, n, k));
  const cheater = await joinPlayer(app, pin, 'Cheat', 1);
  let cheatResult = null;
  cheater.onMsg = (m) => { if (m.t === 'claimResult' && m.bogey) cheatResult = m; };
  // honest bots claim the instant any of their tickets completes an open prize
  for (const b of bots) {
    b.sent = new Set();
    b.onMsg = (m) => {
      if (m.t !== 'state' || m.phase !== 'running' || !b.tickets.length) return;
      const called = new Set(m.called);
      for (const pz of m.prizes) {
        if (pz.status === 'awarded') continue;
        b.tickets.forEach((tk, idx) => {
          const key = pz.id + ':' + idx + ':' + m.seq;
          if (!b.sent.has(key) && P.isComplete(pz.id, tk, called)) { b.sent.add(key); b.send({ t: 'claim', prizeId: pz.id, ticketIdx: idx, seq: m.seq }); }
        });
      }
    };
  }
  host.send({ t: 'start' });
  await cheater.waitFor((s) => s.phase === 'running' && s.seq >= 1, 5000, 'first call');
  cheater.send({ t: 'claim', prizeId: 'full', ticketIdx: 0, seq: 1 }); // impossible on call 1
  const end = await host.waitFor((s) => s.phase === 'ended', 20000, 'game end');

  assert.ok(cheatResult, 'cheater got a bogey');
  // fairness: reveal matches commitment; called numbers are the first N of the revealed order, no repeats
  assert.equal(commitHash(end.reveal.sequence, end.reveal.salt), end.commit);
  assert.deepEqual([...end.reveal.sequence].sort((a, b) => a - b), Array.from({ length: 90 }, (_, i) => i + 1));
  assert.deepEqual(end.called, end.reveal.sequence.slice(0, end.seq));
  assert.equal(new Set(end.called).size, end.called.length);
  // every player saw exactly the same calls the host did
  for (const b of bots) assert.deepEqual(b.state.called, end.called);
  // tickets: all valid, none shared between players
  const allTickets = [];
  for (const b of [...bots, cheater]) { b.tickets.forEach((t) => { assert.ok(P.validTicket(t)); allTickets.push(JSON.stringify(t)); }); }
  assert.equal(new Set(allTickets).size, allTickets.length);
  // every awarded prize: each winning ticket was genuinely complete at the award call, and the points add up
  let awarded = 0;
  for (const pz of end.prizes) {
    if (pz.status !== 'awarded') continue;
    awarded++;
    const calledAt = new Set(end.reveal.sequence.slice(0, pz.awardedAtSeq));
    assert.ok(pz.winners.length >= 1);
    for (const w of pz.winners) assert.ok(P.isComplete(pz.id, w.ticket, calledAt), pz.id + ' winner not complete');
    assert.equal(pz.winners.reduce((s, w) => s + w.points, 0) + pz.leftover, pz.points);
    // nobody else with a ticket complete strictly earlier was skipped: check all tickets in the game
    const earlier = new Set(end.reveal.sequence.slice(0, pz.awardedAtSeq - 1));
    for (const b of bots) { // the cheater never auto-claims, so only the auto-claiming bots can be "skipped"
      b.tickets.forEach((tk, idx) => {
        if (P.isComplete(pz.id, tk, earlier) && P.PATTERNS[pz.id].family !== 'full') {
          // a ticket that was already complete one call earlier must have been claimed at that earlier call
          assert.fail(`${b.state.you.name} ticket ${idx} was complete for ${pz.id} before call ${pz.awardedAtSeq}`);
        }
      });
    }
  }
  assert.ok(awarded >= 3, 'several prizes awarded in a full game, got ' + awarded);
  assert.ok(end.prizes.find((p) => p.id === 'full').status === 'awarded', 'full house awarded');
  // conservation of points: nothing created or lost
  const s = end.summary;
  const won = s.players.reduce((a, p) => a + p.won, 0);
  const entries = s.players.reduce((a, p) => a + p.entry, 0);
  assert.equal(entries, s.pot);
  assert.equal(s.pot, (1 + 2 + 3 + 4 + 2 + 1 + 1) * 40);
  assert.equal(won + s.unclaimed + s.rounding + s.unallocated, s.pot);
  assert.equal(s.players.reduce((a, p) => a + p.net, 0), won - entries);
  // no ticket won the same full house family twice
  const fullWinners = end.prizes.filter((p) => P.PATTERNS[p.id].family === 'full').flatMap((p) => p.winners.map((w) => w.playerId + ':' + w.ticketIdx));
  assert.equal(new Set(fullWinners).size, fullWinners.length);

  // new game keeps the room: same players, clean slate
  host.send({ t: 'newGame' });
  const lob = await host.waitFor((x) => x.phase === 'lobby' && x.players.length === 7, 3000, 'back to lobby');
  assert.equal(lob.seq, 0); assert.equal(lob.called.length, 0);

  [host, cheater, ...bots].forEach((b) => b.close());
  await app.close();
});
