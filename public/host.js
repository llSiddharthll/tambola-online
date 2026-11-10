/* Host (caller) screen. This device speaks the numbers; players only see them. */
(function () {
  'use strict';
  const { h, connect, callText, rhymeLine } = window.TUI;
  const S = window.TambolaShared;
  const app = document.getElementById('app');

  const params = new URLSearchParams(location.search);
  // The host id is this browser's secret identity. It owns the room and any plan bought with an activation code.
  function randomId() {
    const b = new Uint8Array(24);
    (window.crypto || window.msCrypto).getRandomValues(b);
    return btoa(String.fromCharCode.apply(null, b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  let hostId = '';
  try { hostId = localStorage.getItem('tambola.hostId') || ''; if (!/^[A-Za-z0-9_-]{8,64}$/.test(hostId)) { hostId = randomId(); localStorage.setItem('tambola.hostId', hostId); } } catch (e) { hostId = hostId || randomId(); }
  let hostPlan = null;      // plan this host holds, from the server
  let redeemMsg = null;     // {ok, text}

  let st = null;            // latest state from the server
  let hostError = '';
  let muted = false;
  let lastSpokenSeq = 0;
  let lastGameId = null;
  let lastEventId = 0;
  let configTimer = null;
  let conn = null;
  let formBuilt = false;

  // ---------- speech ----------
  function pickVoice() {
    const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    return voices.find((v) => /en-IN/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang)) || null;
  }
  function speak(text) {
    if (muted || !window.speechSynthesis) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) u.voice = v;
      u.lang = (v && v.lang) || 'en-IN';
      u.rate = 0.95;
      window.speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }

  // ---------- connection ----------
  conn = connect({
    onOpen: (c) => c.send({ t: 'hostHello', hostId }),
    onMessage: (m) => {
      if (m.t === 'state') { onState(m); }
      else if (m.t === 'hostInfo') { hostPlan = m.plan; if (!st) renderHome(); }
      else if (m.t === 'redeemResult') { redeemMsg = m.ok ? { ok: true, text: 'Activated: ' + m.plan.name + (m.plan.until ? ' until ' + new Date(m.plan.until).toLocaleString() : '') + '. It applies to new rooms.' } : { ok: false, text: m.error }; if (!st) renderHome(); }
      else if (m.t === 'roomClosed' || m.t === 'replaced') { st = null; formBuilt = false; lastGameId = null; hostError = m.t === 'replaced' ? 'This room is now open in another window.' : ''; renderHome(); }
      else if (m.t === 'hostError') { hostError = m.error; paintError(); }
    },
  });

  function onState(s) {
    const prevPhase = st && st.phase;
    st = s;
    hostError = '';
    if (s.gameId !== lastGameId) { lastGameId = s.gameId; lastSpokenSeq = s.seq; lastEventId = s.events.length ? s.events[s.events.length - 1].id : 0; }
    if (s.phase === 'running' && s.seq > lastSpokenSeq) {
      const n = s.called[s.called.length - 1];
      lastSpokenSeq = s.seq;
      speak(callText(n));
    }
    // speak winner announcements
    for (const e of s.events) {
      if (e.id > lastEventId) { lastEventId = e.id; if (e.kind === 'win' || e.kind === 'bogey') speak(e.text.replace(/[:]/g, '.')); }
    }
    if (prevPhase !== s.phase) formBuilt = false;
    render();
  }

  // ---------- rendering ----------
  const errEl = h('div', { class: 'err' });
  function paintError() { errEl.textContent = hostError; }

  // ----- home: plan, create room, activation code -----
  function renderHome() {
    if (!hostPlan) return;
    const until = hostPlan.until ? ' until ' + new Date(hostPlan.until).toLocaleString() : '';
    const code = h('input', { id: 'act', placeholder: 'PRO-XXXX-XXXX or PASS-XXXX-XXXX', autocapitalize: 'characters', autocomplete: 'off' });
    const msg = h('div', { class: redeemMsg && redeemMsg.ok ? 'ok' : 'err', text: redeemMsg ? redeemMsg.text : '' });
    app.replaceChildren(
      h('div', { class: 'panel' },
        h('h1', { text: 'Tambola Host' }),
        h('div', { class: 'muted', text: 'Run a game for friends and family on any network, Wi-Fi or mobile data. Points only, no money in the app.' }),
        h('div', { class: 'row', style: 'margin-top:12px' },
          h('span', { class: 'badge', text: hostPlan.name + ' plan' + until }),
          h('span', { class: 'muted', text: `Up to ${hostPlan.maxPlayers} players, ${hostPlan.maxTickets} tickets each` })),
        h('div', { class: 'err', text: hostError }),
        h('button', { class: 'good', style: 'margin-top:12px', onclick: () => { hostError = ''; conn.send({ t: 'hostCreate' }); }, text: 'Create a room' })),
      h('div', { class: 'panel' },
        h('h2', { text: 'Have an activation code?' }),
        h('div', { class: 'muted', text: 'Party Pass and Pro unlock more players and all prize types. The plan applies to rooms you create after activating.' }),
        h('div', { class: 'field', style: 'margin-top:8px' }, h('label', { for: 'act', text: 'Activation code' }), code),
        h('button', { class: 'secondary', onclick: () => { redeemMsg = null; conn.send({ t: 'redeem', code: code.value }); }, text: 'Activate' }),
        msg));
  }

  function render() {
    if (!st) return renderHome();
    if (st.phase === 'lobby') return renderLobby();
    if (st.phase === 'running') return renderRunning();
    return renderEnded();
  }

  function header() {
    return h('div', { class: 'row spread panel' },
      h('div', {}, h('h1', { text: 'Tambola Host' }), h('div', { class: 'muted', text: 'Only this device speaks the numbers. Points only, no money in the app.' })),
      h('div', { class: 'row' },
        h('span', { class: 'badge', text: 'Room ' + st.room }),
        h('span', { class: 'badge', text: st.plan.name + ' plan' }),
        h('button', { class: 'secondary', onclick: () => { if (confirm('Close this room? Players will be disconnected.')) conn.send({ t: 'closeRoom' }); }, text: 'Close room' }),
        h('button', { class: 'secondary', onclick: () => { muted = !muted; if (muted && window.speechSynthesis) window.speechSynthesis.cancel(); render(); }, text: muted ? 'Voice: off' : 'Voice: on' })));
  }

  // ----- lobby -----
  let cfgEls = null;
  function renderLobby() {
    if (!formBuilt) { buildLobby(); formBuilt = true; }
    syncLobby();
  }

  function buildLobby() {
    cfgEls = {};
    const num = (id, label, attrs) => {
      const input = h('input', { type: 'number', inputmode: 'numeric', id, ...attrs, oninput: scheduleConfig });
      cfgEls[id] = input;
      return h('div', { class: 'field' }, h('label', { for: id, text: label }), input);
    };
    const bogey = h('select', { id: 'bogey', onchange: scheduleConfig }, h('option', { value: 'bar', text: 'Bogey bars the player from that prize' }), h('option', { value: 'none', text: 'Bogey has no penalty' }));
    cfgEls.bogey = bogey;
    const prizeBox = h('div', {});
    cfgEls.prizeRows = {};
    for (const id of S.PATTERN_ORDER) {
      const cb = h('input', { type: 'checkbox', onchange: scheduleConfig });
      const share = h('input', { type: 'number', inputmode: 'numeric', min: '0', max: '100', oninput: scheduleConfig });
      const label = h('div', {}, S.PATTERNS[id].label, ' ', h('span', { class: 'badge', text: 'Pro', style: 'display:none' }));
      const row = h('div', { class: 'prizeRow' }, cb, label, share);
      cfgEls.prizeRows[id] = { cb, share, row, proBadge: label.lastChild };
      prizeBox.appendChild(row);
    }
    cfgEls.total = h('div', { class: 'muted' });
    cfgEls.players = h('div', {});
    cfgEls.startBtn = h('button', { class: 'good', onclick: () => conn.send({ t: 'start' }), text: 'Start game' });
    cfgEls.qr = h('img', { class: 'qr', alt: 'Scan to join', src: '/qr.svg?room=' + encodeURIComponent(st.room) });
    cfgEls.pin = h('div', { class: 'pin' });
    cfgEls.url = h('div', { class: 'code' });
    cfgEls.count = h('h2', {});

    app.replaceChildren(
      header(),
      h('div', { class: 'cols' },
        h('div', {},
          h('div', { class: 'panel' },
            h('h2', { text: '1. Players join' }),
            h('div', { class: 'row' }, cfgEls.qr, h('div', { class: 'grow' }, h('div', { class: 'muted', text: 'Room code' }), cfgEls.pin, h('div', { class: 'muted', text: 'Phones scan the QR code, or open:' }), cfgEls.url))),
          h('div', { class: 'panel' }, cfgEls.count, cfgEls.players)),
        h('div', {},
          h('div', { class: 'panel' },
            h('h2', { text: '2. Game settings' }),
            h('div', { class: 'grid2' },
              num('maxPlayers', 'Max players', { min: '1' }),
              num('maxTickets', 'Max tickets per player', { min: '1' }),
              num('entryPoints', 'Entry points per ticket', { min: '0' }),
              num('callSeconds', 'Seconds between calls', { min: '3', max: '30', step: '1' })),
            h('div', { class: 'field' }, h('label', { text: 'False claims' }), bogey)),
          h('div', { class: 'panel' },
            h('h2', { text: '3. Prizes (share of the points pot)' }),
            prizeBox, cfgEls.total,
            h('div', { class: 'muted', text: 'Pot = players x tickets x entry points. Prizes are paid in points only.' })),
          h('div', { class: 'panel' }, errEl, cfgEls.startBtn))));
    paintError();
  }

  function setIfIdle(el, value) { if (document.activeElement !== el) el.value = value; }

  function syncLobby() {
    const c = st.config;
    setIfIdle(cfgEls.maxPlayers, c.maxPlayers);
    setIfIdle(cfgEls.maxTickets, c.maxTickets);
    setIfIdle(cfgEls.entryPoints, c.entryPoints);
    setIfIdle(cfgEls.callSeconds, c.callSeconds);
    if (document.activeElement !== cfgEls.bogey) cfgEls.bogey.value = c.bogeyPenalty;
    cfgEls.maxPlayers.max = st.plan.maxPlayers;
    cfgEls.maxTickets.max = st.plan.maxTickets;
    const byId = Object.fromEntries(c.prizes.map((p) => [p.pattern, p.share]));
    for (const id of S.PATTERN_ORDER) {
      const r = cfgEls.prizeRows[id];
      const allowed = st.plan.patterns.includes(id);
      r.row.classList.toggle('locked', !allowed);
      r.cb.disabled = !allowed; r.share.disabled = !allowed;
      r.proBadge.style.display = allowed ? 'none' : 'inline-block';
      if (document.activeElement !== r.cb) r.cb.checked = id in byId;
      if (document.activeElement !== r.share) r.share.value = id in byId ? byId[id] : '';
      if (id === 'full') r.cb.disabled = true; // Full House is always on
    }
    const total = c.prizes.reduce((s, p) => s + p.share, 0);
    cfgEls.total.textContent = `Shares add up to ${total}%` + (total < 100 ? ` (${100 - total}% stays unallocated)` : '');
    cfgEls.pin.textContent = st.room;
    cfgEls.url.textContent = st.host.joinUrl;
    cfgEls.count.textContent = `Players (${st.players.length}/${c.maxPlayers})`;
    const list = st.players.length
      ? h('table', {}, h('tr', {}, h('th', { text: 'Name' }), h('th', { text: 'Tickets' }), h('th', { text: '' })),
        st.players.map((p) => h('tr', {},
          h('td', { text: p.name + (p.connected ? '' : ' (offline)') }), h('td', { text: String(p.tickets) }),
          h('td', {}, h('button', { class: 'secondary', onclick: () => conn.send({ t: 'kick', playerId: p.id }), text: 'Remove' })))))
      : h('p', { class: 'muted', text: 'Waiting for players to join...' });
    cfgEls.players.replaceChildren(list);
    const tix = st.players.reduce((s, p) => s + p.tickets, 0);
    cfgEls.startBtn.textContent = `Start game  (pot ${tix * c.entryPoints} points)`;
    cfgEls.startBtn.disabled = st.players.length < 1;
    paintError();
  }

  function scheduleConfig() {
    clearTimeout(configTimer);
    configTimer = setTimeout(() => {
      const prizes = [];
      for (const id of S.PATTERN_ORDER) {
        const r = cfgEls.prizeRows[id];
        if (r.cb.checked || id === 'full') prizes.push({ pattern: id, share: Number(r.share.value || 0) });
      }
      conn.send({
        t: 'config',
        config: {
          maxPlayers: Number(cfgEls.maxPlayers.value), maxTickets: Number(cfgEls.maxTickets.value),
          entryPoints: Number(cfgEls.entryPoints.value), callSeconds: Number(cfgEls.callSeconds.value),
          bogeyPenalty: cfgEls.bogey.value, prizes,
        },
      });
    }, 350);
  }

  // ----- running -----
  function boardEl(called) {
    const last = called[called.length - 1];
    const set = new Set(called);
    const cells = [];
    for (let n = 1; n <= 90; n++) cells.push(h('span', { class: n === last ? 'now' : set.has(n) ? 'on' : '', text: String(n) }));
    return h('div', { class: 'board' }, cells);
  }

  function prizesTable() {
    return h('table', {},
      h('tr', {}, h('th', { text: 'Prize' }), h('th', { text: 'Points' }), h('th', { text: 'Status' })),
      st.prizes.map((p) => h('tr', { class: p.status === 'awarded' ? 'won' : '' },
        h('td', { text: p.label }), h('td', { text: String(p.points) }),
        h('td', { text: p.status === 'awarded' ? [...new Set(p.winners.map((w) => w.name))].join(', ') + (p.winners.length > 1 ? ' (shared)' : '') : p.pending ? 'Checking claim...' : 'Open' }))));
  }

  function eventsEl() {
    return h('div', { class: 'events' }, [...st.events].reverse().map((e) => h('div', { class: e.kind, text: e.text })));
  }

  let lastRenderSeq = -1;
  function renderRunning() {
    const n = st.called[st.called.length - 1];
    const fresh = st.seq !== lastRenderSeq;
    lastRenderSeq = st.seq;
    const ball = h('div', { class: 'ball ' + (n ? (fresh ? 'drop' : '') : 'empty'), text: n ? String(n) : '...' });
    const speed = h('input', { type: 'range', min: '3', max: '15', step: '1', value: String(st.config.callSeconds), oninput: (e) => { speedLabel.textContent = e.target.value + 's'; }, onchange: (e) => conn.send({ t: 'speed', seconds: Number(e.target.value) }) });
    const speedLabel = h('span', { text: st.config.callSeconds + 's' });
    app.replaceChildren(
      header(),
      h('div', { class: 'panel stage' },
        ball,
        h('div', { class: 'rhyme', text: n ? rhymeLine(n) : 'Get ready... first number coming up' }),
        h('div', { class: 'muted', text: `Call ${st.seq} of 90  |  Pot ${st.pot} points  |  Fair-play code ${st.commit.slice(0, 8)}` }),
        h('div', { class: 'last' }, st.called.slice(-6, -1).reverse().map((x) => h('span', { text: String(x) })))),
      h('div', { class: 'panel' },
        h('div', { class: 'row' },
          st.paused
            ? h('button', { class: 'good', onclick: () => conn.send({ t: 'resumeGame' }), text: 'Resume' })
            : h('button', { class: 'secondary', onclick: () => conn.send({ t: 'pauseGame' }), text: 'Pause' }),
          h('button', { onclick: () => conn.send({ t: 'next' }), text: 'Call next now' }),
          h('button', { class: 'danger', onclick: () => { if (confirm('End the game now?')) conn.send({ t: 'end' }); }, text: 'End game' })),
        h('div', { class: 'row', style: 'margin-top:10px' }, h('span', { class: 'muted', text: 'Call speed' }), h('div', { class: 'grow' }, speed), speedLabel),
        errEl, st.paused ? h('div', { class: 'badge', text: 'PAUSED' }) : null),
      h('div', { class: 'cols' },
        h('div', { class: 'panel' }, h('h2', { text: 'Board' }), boardEl(st.called)),
        h('div', {}, h('div', { class: 'panel' }, h('h2', { text: 'Prizes' }), prizesTable()), h('div', { class: 'panel' }, h('h2', { text: 'Table talk' }), eventsEl()))));
    paintError();
    // restart the drop animation only on new numbers
  }

  // ----- ended -----
  function renderEnded() {
    const sm = st.summary;
    const ok = st.reveal && S.commitHash(st.reveal.sequence, st.reveal.salt) === st.commit;
    app.replaceChildren(
      header(),
      h('div', { class: 'panel' },
        h('h2', { text: 'Game over' }),
        h('div', { class: 'muted', text: `${sm.called} numbers called. Pot ${sm.pot} points.` }),
        h('table', {},
          h('tr', {}, h('th', { text: 'Player' }), h('th', { text: 'Tickets' }), h('th', { text: 'Entry' }), h('th', { text: 'Won' }), h('th', { text: 'Net' })),
          [...sm.players].sort((a, b) => b.net - a.net).map((p) => h('tr', {}, h('td', { text: p.name }), h('td', { text: String(p.tickets) }), h('td', { text: String(p.entry) }), h('td', { text: String(p.won) }), h('td', { class: p.net >= 0 ? 'ok' : '', text: (p.net > 0 ? '+' : '') + p.net })))),
        h('div', { class: 'muted', style: 'margin-top:8px', text: (sm.unclaimed ? `Unclaimed prizes: ${sm.unclaimed} points. ` : '') + (sm.rounding ? `Rounding left over: ${sm.rounding} points. ` : '') + (sm.unallocated ? `Unallocated share: ${sm.unallocated} points.` : '') })),
      h('div', { class: 'panel' },
        h('h2', { text: 'Prizes won' }), prizesTable(),
        h('p', { class: ok ? 'ok' : 'err', text: ok ? 'Fair-play check passed: the number order was fixed before the first call.' : 'Fair-play check FAILED.' }),
        h('div', { class: 'code', text: 'Code ' + st.commit })),
      h('div', { class: 'panel' }, errEl, h('button', { class: 'good', onclick: () => conn.send({ t: 'newGame' }), text: 'New game with the same players' })));
    paintError();
  }

  if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = () => {};
})();
