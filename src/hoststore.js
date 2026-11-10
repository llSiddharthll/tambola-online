'use strict';
/* Who is allowed which plan. Hosts are anonymous: the browser keeps a random hostId.
 * A host upgrades by redeeming an activation code (sold by you over UPI, WhatsApp, or later by a
 * payment gateway that calls the same redeem path). State is a small JSON file so it survives restarts. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RANK = { free: 0, pass: 1, pro: 2 };
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PREFIX = { pass: 'PASS', pro: 'PRO' };

function randomChunk(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}

function createHostStore({ file = null, now = () => Date.now() } = {}) {
  let data = { hosts: {}, codes: {} };
  let mtime = 0;
  // Re-read the file when another process (tools/make-codes.js) changed it, so a running server sees new codes
  // and never overwrites them with its stale copy.
  function refresh() {
    if (!file) return;
    try {
      const m = fs.statSync(file).mtimeMs;
      if (m === mtime) return;
      data = { hosts: {}, codes: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      mtime = m;
    } catch (e) { /* no file yet */ }
  }
  refresh();

  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file); // atomic replace
    try { mtime = fs.statSync(file).mtimeMs; } catch (e) { /* ignore */ }
  }

  const validHostId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);

  // The plan this host holds right now: {id:'free'|'pass'|'pro', until:ms|null}
  function planFor(hostId) {
    refresh();
    const rec = validHostId(hostId) && data.hosts[hostId];
    if (rec && rec.until > now() && RANK[rec.plan] !== undefined) return { id: rec.plan, until: rec.until };
    return { id: 'free', until: null };
  }

  // Create codes. duration is {hours} or {days}. Returns the new code strings.
  function makeCodes({ count = 1, plan = 'pro', days = 0, hours = 0 }) {
    refresh();
    if (!(plan in PREFIX)) throw new Error('plan must be pass or pro');
    const ms = days * 86400000 + hours * 3600000;
    if (!(ms > 0) || !Number.isInteger(count) || count < 1 || count > 500) throw new Error('bad count or duration');
    const out = [];
    for (let i = 0; i < count; i++) {
      let code;
      do { code = `${PREFIX[plan]}-${randomChunk(4)}-${randomChunk(4)}`; } while (data.codes[code]);
      data.codes[code] = { plan, ms, createdAt: now(), usedBy: null, usedAt: null };
      out.push(code);
    }
    save();
    return out;
  }

  const normalize = (c) => String(c || '').trim().toUpperCase().replace(/\s+/g, '');

  // {ok:true, plan:{id,until}} or {ok:false, error}
  function redeem(hostId, rawCode) {
    refresh();
    if (!validHostId(hostId)) return { ok: false, error: 'Unknown host' };
    const code = normalize(rawCode);
    const rec = data.codes[code];
    if (!rec) return { ok: false, error: 'That code is not valid' };
    if (rec.usedBy) return { ok: false, error: 'That code was already used' };
    const cur = planFor(hostId);
    if (RANK[rec.plan] < RANK[cur.id]) return { ok: false, error: `You already have an active ${cur.id === 'pro' ? 'Pro' : 'Party Pass'} plan` };
    const base = cur.id === rec.plan && cur.until ? cur.until : now();
    data.hosts[hostId] = { plan: rec.plan, until: base + rec.ms };
    rec.usedBy = hostId; rec.usedAt = now();
    save();
    return { ok: true, plan: planFor(hostId) };
  }

  function stats() {
    refresh();
    const codes = Object.values(data.codes);
    return { codes: codes.length, unused: codes.filter((c) => !c.usedBy).length, hosts: Object.keys(data.hosts).length };
  }

  return { planFor, makeCodes, redeem, stats, validHostId, RANK };
}

module.exports = { createHostStore, RANK };
