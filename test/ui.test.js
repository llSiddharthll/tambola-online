'use strict';
// Loads the real host and player pages in jsdom against the real server and plays a short round.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { startServer, sleep } = require('./helpers');

function open(url, errors) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.stack || e)));
  vc.on('error', (e) => errors.push(String(e)));
  return JSDOM.fromURL(url, { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc });
}
async function until(fn, ms = 6000, label = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(40); }
  throw new Error('timeout: ' + label);
}

test('host and player pages render, join, play and claim without script errors', async () => {
  const app = await startServer({ plan: 'free', firstCallDelayMs: 200, claimWindowMs: 200, resumeDelayMs: 100, endDelayMs: 100 });
  const base = `http://127.0.0.1:${app.port}`;
  const errors = [];
  const host = await open(`${base}/host.html`, errors);
  const hd = host.window.document;
  await until(() => [...hd.querySelectorAll('button')].find((b) => /Create a room/.test(b.textContent)), 5000, 'host home');
  assert.match(hd.body.textContent, /Free plan/);
  [...hd.querySelectorAll('button')].find((b) => /Create a room/.test(b.textContent)).click();
  await until(() => hd.querySelector('.pin') && /^[A-Z2-9]{5}$/.test(hd.querySelector('.pin').textContent), 5000, 'host lobby with room code');
  const pin = hd.querySelector('.pin').textContent;
  const room = [...app.rooms.values()][0];
  assert.match(hd.body.textContent, /Free plan/);
  assert.ok(hd.querySelector('img.qr'), 'qr shown');
  // pro-only prizes are visibly locked on the free plan
  assert.ok(hd.querySelectorAll('.prizeRow.locked').length >= 4, 'locked pro prizes');

  // the QR endpoint serves an SVG
  const qr = await (await fetch(`${base}/qr.svg?room=${pin}`)).text();
  assert.match(qr, /<svg/);

  const player = await open(`${base}/?room=${pin}`, errors);
  const pd = player.window.document;
  await until(() => pd.querySelector('#name'), 5000, 'player join form');
  assert.equal(pd.querySelector('#room').value, pin);
  pd.querySelector('#name').value = 'Asha';
  pd.querySelector('#tix').value = '2';
  await until(() => !pd.querySelector('button').disabled, 3000, 'join enabled');
  pd.querySelector('button').click();
  await until(() => /Waiting for the host/.test(pd.body.textContent), 5000, 'player in lobby');
  await until(() => /Asha/.test(hd.body.textContent), 5000, 'host sees player');
  assert.match(hd.querySelector('button.good').textContent, /pot 100 points/); // 2 tickets x 50

  // host shortens the call interval via the server, then starts
  hd.querySelector('button.good').click();
  await until(() => pd.querySelectorAll('.ticket').length === 2, 5000, 'two tickets shown');
  assert.equal(pd.querySelectorAll('.cell:not(.blank)').length, 30);
  await until(() => pd.querySelector('.ball') && /^\d+$/.test(pd.querySelector('.ball').textContent), 8000, 'first number shown on player');
  await until(() => /^\d+$/.test(hd.querySelector('.ball').textContent), 5000, 'first number on host');
  assert.equal(pd.querySelector('.ball').textContent, hd.querySelector('.ball').textContent, 'host and player show the same number');

  // tapping a called number dabs it; tapping an uncalled one does not
  const called = room.state.sequence.slice(0, room.state.seq);
  const cells = [...pd.querySelector('.ticket').querySelectorAll('.cell:not(.blank)')];
  const hit = cells.find((c) => called.includes(Number(c.textContent)));
  const miss = cells.find((c) => !called.includes(Number(c.textContent)));
  if (hit) { hit.click(); await sleep(60); assert.ok([...pd.querySelectorAll('.cell.dab')].length >= 1, 'dab applied'); }
  miss.click(); await sleep(60);
  assert.ok(![...pd.querySelectorAll('.cell.dab')].some((c) => c.textContent === miss.textContent), 'uncalled number not dabbed');

  // a premature claim through the real UI gives a bogey
  pd.querySelector('.claimbar button').click();
  await until(() => pd.querySelector('.sheet'), 2000, 'claim sheet');
  [...pd.querySelectorAll('.sheet button')].find((b) => /Full House/.test(b.textContent)).click();
  await until(() => pd.querySelector('.sheet button'), 2000, 'ticket picker');
  [...pd.querySelectorAll('.sheet button')].find((b) => /Ticket 1/.test(b.textContent)).click();
  await until(() => pd.querySelector('.toast.bogey'), 3000, 'bogey toast');
  assert.ok(room.state.players.get([...room.state.players.keys()][0]).barred.has('full'));

  // host controls work from the UI
  [...hd.querySelectorAll('button')].find((b) => b.textContent === 'Pause').click();
  await until(() => /PAUSED/.test(hd.body.textContent), 3000, 'paused badge');
  [...hd.querySelectorAll('button')].find((b) => b.textContent === 'Resume').click();
  await until(() => !/PAUSED/.test(hd.body.textContent), 3000, 'resumed');

  assert.deepEqual(errors, [], 'no script errors in either page:\n' + errors.join('\n'));
  host.window.close(); player.window.close();
  await app.close();
});
