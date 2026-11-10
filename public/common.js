/* Small helpers shared by the host and player pages. */
(function () {
  'use strict';

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
    }
    return el;
  }

  // WebSocket with automatic reconnect. Calls onOpen on every (re)connect.
  function connect(handlers) {
    let ws = null, closedByUs = false, delay = 400;
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const target = (window.TAMBOLA_SERVER || '').replace(/\/+$/, '') || proto + location.host;
    function open() {
      ws = new WebSocket(target);
      ws.onopen = () => { delay = 400; handlers.onOpen && handlers.onOpen(api); };
      ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } handlers.onMessage && handlers.onMessage(m, api); };
      ws.onclose = () => { handlers.onClose && handlers.onClose(); if (!closedByUs) setTimeout(open, delay = Math.min(delay * 1.6, 3000)); };
      ws.onerror = () => {};
    }
    const api = {
      send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); },
      get open() { return !!ws && ws.readyState === 1; },
      close() { closedByUs = true; if (ws) ws.close(); },
    };
    open();
    return api;
  }

  // Traditional caller rhymes for some numbers; others are just read out.
  const RHYMES = {
    1: "Kelly's eyes", 2: 'One little duck', 3: 'Cup of tea', 4: 'Knock at the door', 5: 'Man alive', 6: 'Half a dozen',
    7: 'Lucky seven', 8: 'Garden gate', 9: "Doctor's orders", 10: 'Downing Street', 11: 'Legs eleven', 12: 'One dozen',
    13: 'Unlucky for some', 16: 'Sweet sixteen', 21: 'Key of the door', 22: 'Two little ducks', 26: 'Pick and mix',
    27: 'Duck and a crutch', 33: 'All the threes', 44: 'Droopy drawers', 45: 'Halfway there', 50: 'Bullseye',
    55: 'Snakes alive', 66: 'Clickety click', 69: 'Either way up', 77: 'Sunset strip', 88: 'Two fat ladies',
    90: 'Top of the shop',
  };
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  // What the caller says. Two-digit numbers are read as digits first, as in a real hall.
  function callText(n) {
    const digits = n > 9 ? WORDS[Math.floor(n / 10)] + ' and ' + WORDS[n % 10] + '. ' : '';
    return (RHYMES[n] ? RHYMES[n] + '. ' : '') + digits + 'Number ' + n;
  }
  function rhymeLine(n) { return RHYMES[n] || ''; }

  window.TUI = { h, connect, callText, rhymeLine, RHYMES };
})();
