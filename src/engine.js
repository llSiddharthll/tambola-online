'use strict';
/* Game engine: randomness, ticket generation, prize maths. No networking. */
const crypto = require('crypto');
const P = require('../shared/patterns');
const { commitHash } = require('../shared/sha256');

const randInt = (n) => crypto.randomInt(n);

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const range = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

function colNumbers(c) {
  if (c === 0) return range(1, 9);
  if (c === 8) return range(80, 90);
  return range(c * 10, c * 10 + 9);
}

// Extra numbers per column beyond the one every ticket must have: 6 tickets use all 90 numbers once.
const EXTRAS = [3, 4, 4, 4, 4, 4, 4, 4, 5]; // column sizes 9,10x7,11 minus 6; total 36 = 6 tickets x 6 extras

function dealCounts() {
  const slots = [];
  EXTRAS.forEach((n, c) => { for (let i = 0; i < n; i++) slots.push(c); });
  const mixed = shuffle(slots);
  const counts = Array.from({ length: 6 }, () => Array(9).fill(1));
  for (let i = 0; i < mixed.length; i++) {
    const t = Math.floor(i / 6);
    counts[t][mixed[i]]++;
  }
  for (const row of counts) for (const v of row) if (v > 3) return null;
  return counts;
}

// Decide which rows each column's numbers occupy so every row holds exactly 5.
function layoutRows(colCounts) {
  const occ = Array.from({ length: 3 }, () => Array(9).fill(false));
  const fill = [0, 0, 0];
  const order = shuffle(range(0, 8)).sort((a, b) => colCounts[b] - colCounts[a]);
  for (const c of order) {
    const need = colCounts[c];
    const rows = shuffle([0, 1, 2]).filter((r) => fill[r] < 5).sort((a, b) => fill[a] - fill[b]);
    if (rows.length < need) return null;
    for (const r of rows.slice(0, need)) { occ[r][c] = true; fill[r]++; }
  }
  return fill.every((f) => f === 5) ? occ : null;
}

// A set of six tickets that together contain every number 1..90 exactly once.
function generateSet() {
  for (let attempt = 0; attempt < 20000; attempt++) {
    const counts = dealCounts();
    if (!counts) continue;
    const layouts = [];
    let ok = true;
    for (let t = 0; t < 6 && ok; t++) {
      const occ = layoutRows(counts[t]);
      if (!occ) ok = false; else layouts.push(occ);
    }
    if (!ok) continue;
    const grids = layouts.map(() => Array.from({ length: 3 }, () => Array(9).fill(0)));
    for (let c = 0; c < 9; c++) {
      const nums = shuffle(colNumbers(c));
      let idx = 0;
      for (let t = 0; t < 6; t++) {
        const rows = [];
        for (let r = 0; r < 3; r++) if (layouts[t][r][c]) rows.push(r);
        const take = nums.slice(idx, idx + rows.length).sort((a, b) => a - b);
        idx += rows.length;
        rows.forEach((r, i) => { grids[t][r][c] = take[i]; });
      }
    }
    return grids;
  }
  throw new Error('Could not generate a ticket set');
}

// Hands out tickets from successive sets so a room uses full sets where possible.
function makeTicketPool() {
  let queue = [];
  return {
    take(n) {
      const out = [];
      while (out.length < n) {
        if (!queue.length) queue = generateSet();
        out.push(queue.shift());
      }
      return out;
    },
  };
}

function newSequence() { return shuffle(range(1, 90)); }
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function commit(sequence, salt) { return commitHash(sequence, salt); }

// ---- prizes ----
const PLAN_DEFAULTS = {
  free: [['early5', 15], ['top', 15], ['middle', 15], ['bottom', 15], ['full', 40]],
  pro: [['early7', 10], ['top', 10], ['middle', 10], ['bottom', 10], ['corners', 10], ['full', 40], ['full2', 10]],
};

// Returns {ok:true, prizes:[{pattern,share}]} sorted in canonical order, or {ok:false,error}.
function normalizePrizes(list, allowedPatterns) {
  if (!Array.isArray(list) || list.length === 0 || list.length > 12) return { ok: false, error: 'Choose at least one prize' };
  const seen = new Set();
  const out = [];
  let total = 0;
  for (const item of list) {
    if (!item || typeof item.pattern !== 'string' || !P.PATTERNS[item.pattern]) return { ok: false, error: 'Unknown prize' };
    if (!allowedPatterns.includes(item.pattern)) return { ok: false, error: P.PATTERNS[item.pattern].label + ' needs Pro' };
    if (seen.has(item.pattern)) return { ok: false, error: 'Duplicate prize' };
    seen.add(item.pattern);
    const share = Number(item.share);
    if (!Number.isInteger(share) || share < 0 || share > 100) return { ok: false, error: 'Shares must be whole numbers 0 to 100' };
    total += share;
    out.push({ pattern: item.pattern, share });
  }
  if (total > 100) return { ok: false, error: 'Shares add up to ' + total + '%, maximum is 100%' };
  if (!seen.has('full')) return { ok: false, error: 'Full House is required' };
  if (seen.has('full2') === false && seen.has('full3')) return { ok: false, error: 'Third Full House needs the Second' };
  out.sort((a, b) => P.PATTERN_ORDER.indexOf(a.pattern) - P.PATTERN_ORDER.indexOf(b.pattern));
  return { ok: true, prizes: out };
}

function prizePoints(pot, share) { return Math.floor((pot * share) / 100); }

// Split a prize between n winning tickets; returns {each, leftover}.
function splitPrize(points, n) {
  const each = Math.floor(points / n);
  return { each, leftover: points - each * n };
}

module.exports = {
  shuffle, generateSet, makeTicketPool, newSequence, newSalt, commit,
  PLAN_DEFAULTS, normalizePrizes, prizePoints, splitPrize, colNumbers,
};
