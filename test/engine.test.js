'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const E = require('../src/engine');
const P = require('../shared/patterns');
const { sha256Hex, commitHash } = require('../shared/sha256');

test('ticket sets: valid tickets and every number 1..90 exactly once per set', () => {
  for (let i = 0; i < 300; i++) {
    const set = E.generateSet();
    assert.equal(set.length, 6);
    const all = [];
    for (const t of set) {
      assert.ok(P.validTicket(t), 'invalid ticket ' + JSON.stringify(t));
      all.push(...P.ticketNumbers(t));
    }
    assert.equal(all.length, 90);
    assert.deepEqual([...all].sort((a, b) => a - b), Array.from({ length: 90 }, (_, k) => k + 1));
  }
});

test('ticket pool hands out valid tickets across set boundaries', () => {
  const pool = E.makeTicketPool();
  const got = pool.take(14);
  assert.equal(got.length, 14);
  got.forEach((t) => assert.ok(P.validTicket(t)));
});

test('shuffle is a permutation and varies', () => {
  const a = E.newSequence(), b = E.newSequence();
  assert.deepEqual([...a].sort((x, y) => x - y), Array.from({ length: 90 }, (_, k) => k + 1));
  assert.notDeepEqual(a, b);
});

// A fixed, structurally valid ticket for pattern tests:
//  row0: 5  .  21 .  40 .  .  71 85     corners: 5, 85 (top) and 8, 90 (bottom)
//  row1: .  12 .  33 .  52 66 74 .
//  row2: 8  19 .  36 .  55 .  .  90
const T = [
  [5, 0, 21, 0, 40, 0, 0, 71, 85],
  [0, 12, 0, 33, 0, 52, 66, 74, 0],
  [8, 19, 0, 36, 0, 55, 0, 0, 90],
];
const set = (...n) => new Set(n);

test('patterns: lines, corners, early N, full house', () => {
  assert.equal(P.isComplete('top', T, set(5, 21, 40, 71, 85)), true);
  assert.equal(P.isComplete('top', T, set(5, 21, 40, 71)), false);
  assert.equal(P.missingOne('top', T, set(5, 21, 40, 71)), 85);
  assert.ok(P.validTicket(T));
  assert.equal(P.isComplete('middle', T, set(12, 33, 52, 74)), false);
  assert.equal(P.isComplete('middle', T, set(12, 33, 52, 66, 74)), true);
  assert.equal(P.missingOne('middle', T, set(12, 33, 52, 74)), 66);
  assert.equal(P.missingOne('early5', T, set(5)), null);
  assert.equal(P.isComplete('corners', T, set(5, 85, 8, 90)), true);
  assert.equal(P.isComplete('corners', T, set(5, 85, 8)), false);
  assert.equal(P.isComplete('early5', T, set(5, 21, 8, 90, 33, 99)), true);
  assert.equal(P.isComplete('early5', T, set(5, 21, 8, 90)), false);
  assert.equal(P.isComplete('early7', T, set(5, 21, 8, 90, 33, 36, 12)), true);
  const all = new Set(P.ticketNumbers(T));
  assert.equal(P.isComplete('full', T, all), true);
  all.delete(19);
  assert.equal(P.isComplete('full', T, all), false);
});

test('prize normalisation enforces plan, shares and dependencies', () => {
  const free = ['early5', 'top', 'middle', 'bottom', 'full'];
  assert.equal(E.normalizePrizes([{ pattern: 'full', share: 100 }], free).ok, true);
  assert.equal(E.normalizePrizes([{ pattern: 'full', share: 60 }, { pattern: 'top', share: 50 }], free).ok, false);
  assert.match(E.normalizePrizes([{ pattern: 'full', share: 50 }, { pattern: 'corners', share: 10 }], free).error, /Pro/);
  assert.equal(E.normalizePrizes([{ pattern: 'top', share: 10 }], free).ok, false); // full required
  assert.equal(E.normalizePrizes([{ pattern: 'full', share: 10 }, { pattern: 'full', share: 10 }], free).ok, false);
  assert.equal(E.normalizePrizes([{ pattern: 'full', share: 10.5 }], free).ok, false);
  const all = Object.keys(P.PATTERNS);
  const r = E.normalizePrizes([{ pattern: 'full', share: 40 }, { pattern: 'early7', share: 10 }], all);
  assert.deepEqual(r.prizes.map((p) => p.pattern), ['early7', 'full']);
  assert.equal(E.normalizePrizes([{ pattern: 'full', share: 40 }, { pattern: 'full3', share: 10 }], all).ok, false);
  // defaults must sum to 100 and be valid for their plan
  for (const [plan, list] of Object.entries(E.PLAN_DEFAULTS)) {
    const prizes = list.map(([pattern, share]) => ({ pattern, share }));
    assert.equal(prizes.reduce((s, p) => s + p.share, 0), 100);
    assert.equal(E.normalizePrizes(prizes, plan === 'free' ? free : all).ok, true);
  }
});

test('points maths: worked example 10 players x 2 tickets x 50 points = 1000', () => {
  const pot = 10 * 2 * 50;
  assert.equal(pot, 1000);
  const shares = [10, 10, 10, 10, 10, 40, 10];
  const pts = shares.map((s) => E.prizePoints(pot, s));
  assert.deepEqual(pts, [100, 100, 100, 100, 100, 400, 100]);
  assert.equal(pts.reduce((a, b) => a + b, 0), 1000);
  assert.deepEqual(E.splitPrize(100, 3), { each: 33, leftover: 1 });
  assert.deepEqual(E.splitPrize(400, 1), { each: 400, leftover: 0 });
  assert.equal(E.prizePoints(333, 15), 49); // floors
});

test('browser sha256 matches Node crypto, including unicode and block boundaries', () => {
  const cases = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(1000), 'नमस्ते 🎲 tambola'];
  for (let i = 0; i < 50; i++) cases.push(crypto.randomBytes(i * 7).toString('hex'));
  for (const s of cases) {
    assert.equal(sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s).slice(0, 40));
  }
  const seq = E.newSequence(), salt = E.newSalt();
  assert.equal(E.commit(seq, salt), commitHash(seq, salt));
  assert.equal(E.commit(seq, salt), crypto.createHash('sha256').update(salt + ':' + seq.join(','), 'utf8').digest('hex'));
});
