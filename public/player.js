/* Player screen: shows the number the host calls, your tickets, and lets you dab and claim.
 * This device stays silent on purpose; the host's phone is the caller. */
(function () {
  'use strict';
  const { h, connect, rhymeLine } = window.TUI;
  const S = window.TambolaShared;
  const app = document.getElementById('app');
  const params = new URLSearchParams(location.search);

  const store = {
    get(k, d) { try { const v = localStorage.getItem('tambola.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tambola.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem('tambola.' + k); } catch (e) { /* ignore */ } },
  };

  let st = null;
  let tickets = [];
  let session = store.get('session', null); // {room, token}
  let closedMsg = '';
  let autoDab = store.get('autoDab', false);
  let hints = store.get('hints', true);
  let dabs = new Set();
  let dabsGame = null;
  let joinError = '';
  let toastTimer = null;
  let sheet = null;          // {prize} when the claim sheet is open
  let lastEventId = null;
  let lastSeq = 0;
  let conn = null;
  let connected = false;

  // ---------- helpers ----------
  function loadDabs(gameId) {
    dabsGame = gameId;
    try { dabs = new Set(JSON.parse(sessionStorage.getItem('tambola.dabs.' + gameId) || '[]')); } catch (e) { dabs = new Set(); }
  }
  function saveDabs() { try { sessionStorage.setItem('tambola.dabs.' + dabsGame, JSON.stringify([...dabs])); } catch (e) { /* ignore */ } }
  const dabKey = (ti, n) => ti + ':' + n;

  function toast(text, kind) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const el = h('div', { class: 'toast ' + (kind || ''), text });
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3500);
  }

  // ---------- connection ----------
  conn = connect({
    onOpen: (c) => {
      connected = true;
      if (session && session.room && session.token) c.send({ t: 'resume', room: session.room, token: session.token });
      else render();
    },
    onClose: () => { connected = false; },
    onMessage: (m) => {
      switch (m.t) {
        case 'joined': session = { room: m.room, token: m.token }; store.set('session', session); joinError = ''; closedMsg = ''; break;
        case 'joinError': joinError = m.error; render(); break;
        case 'resumeFailed': session = null; store.del('session'); st = null; render(); break;
        case 'roomClosed': session = null; store.del('session'); st = null; closedMsg = 'The host closed this room. Ask them for a new room code.'; render(); break;
        case 'kicked': session = null; store.del('session'); st = null; toast('You were removed from the room', 'bogey'); render(); break;
        case 'claimResult':
          if (m.ok) toast('Claim received. Checking...', '');
          else toast(m.reason, m.bogey ? 'bogey' : '');
          if (m.bogey && navigator.vibrate) navigator.vibrate([200, 80, 200]);
          break;
        case 'state': onState(m); break;
        default: break;
      }
    },
  });

  function onState(s) {
    const prev = st;
    st = s;
    if (s.you && s.you.tickets) tickets = s.you.tickets;
    if (s.phase === 'lobby') tickets = s.you && s.you.tickets ? s.you.tickets : [];
    if (s.gameId !== dabsGame) loadDabs(s.gameId);
    // new call: vibrate, auto-dab
    if (s.phase === 'running' && s.seq > lastSeq) {
      const n = s.called[s.called.length - 1];
      if (autoDab) { tickets.forEach((tk, ti) => { if (S.ticketNumbers(tk).includes(n)) dabs.add(dabKey(ti, n)); }); saveDabs(); }
      if (prev && prev.gameId === s.gameId && navigator.vibrate) navigator.vibrate(40);
    }
    lastSeq = s.phase === 'running' || s.phase === 'ended' ? s.seq : 0;
    // toasts for new table events (skip history on first state)
    const lastId = s.events.length ? s.events[s.events.length - 1].id : 0;
    if (lastEventId === null) lastEventId = lastId;
    for (const e of s.events) {
      if (e.id > lastEventId && (e.kind === 'win' || e.kind === 'bogey' || e.kind === 'claim' || e.kind === 'start')) toast(e.text, e.kind === 'win' ? 'win' : e.kind === 'bogey' ? 'bogey' : '');
    }
    lastEventId = Math.max(lastEventId, lastId);
    if (s.gameId !== (prev && prev.gameId)) lastEventId = lastId;
    render();
  }

  // ---------- rendering ----------
  function render() {
    if (sheet) { /* keep sheet; it is re-created below */ }
    if (!st || !st.you) return renderJoin();
    if (st.phase === 'lobby') return renderLobby();
    if (st.phase === 'running') return renderGame();
    return renderEnded();
  }

  function renderJoin() {
    const room = h('input', { id: 'room', maxlength: '5', autocapitalize: 'characters', autocomplete: 'off', placeholder: '5-letter room code', value: (params.get('room') || store.get('room', '')).toUpperCase() });
    const name = h('input', { id: 'name', maxlength: '16', placeholder: 'Your name', value: store.get('name', '') });
    const tix = h('select', { id: 'tix' }, [1, 2, 3, 4, 5, 6].map((n) => h('option', { value: String(n), text: n + (n === 1 ? ' ticket' : ' tickets') })));
    tix.value = String(store.get('tix', 1));
    const err = h('div', { class: 'err', text: joinError });
    const go = () => {
      store.set('name', name.value); store.set('room', room.value.trim().toUpperCase()); store.set('tix', Number(tix.value));
      joinError = ''; err.textContent = '';
      conn.send({ t: 'join', room: room.value.trim().toUpperCase(), name: name.value, tickets: Number(tix.value) });
    };
    app.replaceChildren(
      h('div', { class: 'panel' },
        h('h1', { text: 'Join the Tambola game' }),
        closedMsg ? h('p', { class: 'err', text: closedMsg }) : null,
        h('div', { class: 'field' }, h('label', { for: 'room', text: 'Room code' }), room),
        h('div', { class: 'field' }, h('label', { for: 'name', text: 'Your name' }), name),
        h('div', { class: 'field' }, h('label', { for: 'tix', text: 'How many tickets?' }), tix),
        err,
        h('button', { onclick: go, text: 'Join', disabled: !connected }),
        h('p', { class: 'muted', text: 'Points only. Nothing here handles money.' })));
  }

  function topBar() {
    return h('div', { class: 'row spread panel' },
      h('div', {}, h('b', { text: st.you.name }), h('div', { class: 'muted', text: `${st.you.ticketCount} ticket${st.you.ticketCount > 1 ? 's' : ''}` })),
      h('div', { class: 'row' },
        connected ? null : h('span', { class: 'badge', text: 'Reconnecting...' }),
        h('span', { class: 'badge', text: `${st.you.winnings} pts won` })));
  }

  function renderLobby() {
    const sel = h('select', { onchange: (e) => conn.send({ t: 'setTickets', tickets: Number(e.target.value) }) },
      Array.from({ length: st.config.maxTickets }, (_, i) => i + 1).map((n) => h('option', { value: String(n), text: n + (n === 1 ? ' ticket' : ' tickets') })));
    sel.value = String(st.you.ticketCount);
    app.replaceChildren(
      topBar(),
      h('div', { class: 'panel' },
        h('h2', { text: 'Waiting for the host to start' }),
        h('p', { class: 'muted', text: `Entry is ${st.config.entryPoints} points per ticket.` }),
        h('div', { class: 'field' }, h('label', { text: 'Your tickets' }), sel),
        h('div', {}, st.players.map((p) => h('span', { class: 'chip' + (p.connected ? '' : ' off'), text: p.name })))),
      h('div', { class: 'panel' }, h('h2', { text: 'Prizes' }),
        st.prizes.length ? prizeList() : h('div', {}, st.config.prizes.map((p) => h('span', { class: 'chip', text: `${S.PATTERNS[p.pattern].label} ${p.share}%` })))));
  }

  function prizeList() {
    return h('div', {}, st.prizes.map((p) => h('div', { class: 'row spread', style: 'padding:4px 0' },
      h('span', { text: p.label }),
      h('span', { class: p.status === 'awarded' ? 'ok' : 'muted', text: p.status === 'awarded' ? [...new Set(p.winners.map((w) => w.name))].join(', ') + ' won ' + p.winners[0].points : p.pending ? 'checking...' : p.points + ' pts' }))));
  }

  // numbers one away from completing an open line-type prize, per ticket
  function nearSet(ti) {
    const out = new Set();
    if (!hints) return out;
    const called = new Set(st.called);
    for (const pz of st.prizes) {
      if (pz.status === 'awarded') continue;
      const m = S.missingOne(pz.id, tickets[ti], called);
      if (m) out.add(m);
    }
    return out;
  }

  function ticketEl(grid, ti) {
    const called = new Set(st.called);
    const near = nearSet(ti);
    const cells = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) {
      const n = grid[r][c];
      if (!n) { cells.push(h('div', { class: 'cell blank' })); continue; }
      const dabbed = dabs.has(dabKey(ti, n));
      const el = h('div', { class: 'cell' + (dabbed ? ' dab' : '') + (!dabbed && near.has(n) && !called.has(n) ? ' near' : ''), text: String(n) });
      el.addEventListener('click', () => {
        if (dabbed) { dabs.delete(dabKey(ti, n)); }
        else if (called.has(n)) { dabs.add(dabKey(ti, n)); if (navigator.vibrate) navigator.vibrate(15); }
        else { el.classList.add('shake'); setTimeout(() => el.classList.remove('shake'), 320); return; }
        saveDabs(); render();
      });
      cells.push(el);
    }
    const left = S.ticketNumbers(grid).filter((n) => !dabs.has(dabKey(ti, n))).length;
    return h('div', { class: 'ticket' },
      h('div', { class: 'tname' }, h('span', { text: tickets.length > 1 ? `TICKET ${ti + 1}` : 'YOUR TICKET' }), h('span', { text: `${15 - left} of 15 marked` })),
      h('div', { class: 'tgrid' }, cells));
  }

  let lastRenderSeq = -1;
  function renderGame() {
    const n = st.called[st.called.length - 1];
    const fresh = st.seq !== lastRenderSeq;
    lastRenderSeq = st.seq;
    const open = st.prizes.filter((p) => claimable(p));
    app.replaceChildren(
      topBar(),
      h('div', { class: 'panel stage', style: 'padding:10px' },
        h('div', { class: 'ball' + (n ? (fresh ? ' drop' : '') : ' empty'), text: n ? String(n) : '...' }),
        h('div', { class: 'rhyme', text: n ? rhymeLine(n) : 'Waiting for the first number...' }),
        h('div', { class: 'last' }, st.called.slice(-6, -1).reverse().map((x) => h('span', { text: String(x) }))),
        st.paused ? h('div', { class: 'badge', text: 'PAUSED BY HOST' }) : null),
      ...tickets.map((tk, ti) => ticketEl(tk, ti)),
      h('div', { class: 'panel' },
        h('div', { class: 'row spread' }, h('label', { class: 'row', style: 'margin:0' }, h('input', { type: 'checkbox', checked: autoDab, onchange: (e) => { autoDab = e.target.checked; store.set('autoDab', autoDab); } }), 'Auto-dab'),
          h('label', { class: 'row', style: 'margin:0' }, h('input', { type: 'checkbox', checked: hints, onchange: (e) => { hints = e.target.checked; store.set('hints', hints); render(); } }), 'Glow when one away'))),
      h('div', { class: 'panel' }, h('h2', { text: 'Prizes' }), prizeList()),
      h('div', { class: 'claimbar' }, h('button', { class: 'good', disabled: open.length === 0, onclick: () => { sheet = { step: 'prize' }; renderSheet(); }, text: 'CLAIM A PRIZE' })));
    if (sheet) renderSheet();
  }

  function claimable(p) {
    if (p.status === 'awarded') return false;
    if (st.you.barred.includes(p.id)) return false;
    if (p.id === 'full2') { const f = st.prizes.find((x) => x.id === 'full'); if (f && f.status !== 'awarded') return false; }
    if (p.id === 'full3') { const f = st.prizes.find((x) => x.id === 'full2'); if (f && f.status !== 'awarded') return false; }
    return true;
  }

  function renderSheet() {
    document.querySelectorAll('.sheet').forEach((x) => x.remove());
    if (!sheet) return;
    const close = () => { sheet = null; document.querySelectorAll('.sheet').forEach((x) => x.remove()); };
    const send = (prizeId, ticketIdx) => { conn.send({ t: 'claim', prizeId, ticketIdx, seq: st.seq }); close(); };
    let body;
    if (sheet.step === 'prize') {
      const list = st.prizes.filter(claimable);
      body = [h('h2', { text: 'Which prize are you claiming?' }),
        ...list.map((p) => h('button', {
          class: 'secondary',
          onclick: () => { if (tickets.length === 1) send(p.id, 0); else { sheet = { step: 'ticket', prize: p }; renderSheet(); } },
          text: `${p.label}  (${p.points} pts)`,
        })), h('p', { class: 'muted', text: 'A wrong claim is a Bogey and may bar you from that prize.' })];
    } else {
      body = [h('h2', { text: `Which ticket completed ${sheet.prize.label}?` }),
        ...tickets.map((_, ti) => h('button', { class: 'secondary', onclick: () => send(sheet.prize.id, ti), text: `Ticket ${ti + 1}` }))];
    }
    document.body.appendChild(h('div', { class: 'sheet', onclick: (e) => { if (e.target.classList.contains('sheet')) close(); } },
      h('div', {}, body, h('button', { class: 'secondary', onclick: close, text: 'Cancel' }))));
  }

  function renderEnded() {
    const sm = st.summary;
    const ok = st.reveal && S.commitHash(st.reveal.sequence, st.reveal.salt) === st.commit;
    sheet = null; document.querySelectorAll('.sheet').forEach((x) => x.remove());
    app.replaceChildren(
      topBar(),
      h('div', { class: 'panel' },
        h('h2', { text: 'Game over' }),
        h('table', {},
          h('tr', {}, h('th', { text: 'Player' }), h('th', { text: 'Entry' }), h('th', { text: 'Won' }), h('th', { text: 'Net' })),
          [...sm.players].sort((a, b) => b.net - a.net).map((p) => h('tr', { class: p.name === st.you.name ? 'me' : '' },
            h('td', { text: p.name }), h('td', { text: String(p.entry) }), h('td', { text: String(p.won) }), h('td', { text: (p.net > 0 ? '+' : '') + p.net }))))),
      h('div', { class: 'panel' }, h('h2', { text: 'Prizes' }), prizeList(),
        h('p', { class: ok ? 'ok' : 'err', text: ok ? 'Fair-play check passed on your phone: the number order was fixed before the first call.' : 'Fair-play check failed.' })),
      h('p', { class: 'muted', text: 'Waiting for the host to start another game...' }));
  }

  // keep the screen reasonably alive when returning to the tab
  document.addEventListener('visibilitychange', () => { if (!document.hidden && st) render(); });
})();
