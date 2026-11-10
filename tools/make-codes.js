#!/usr/bin/env node
'use strict';
/* Make activation codes you can sell (UPI, WhatsApp, or a payment link) and hand to hosts.
 *   node tools/make-codes.js --plan=pro --days=30 --count=10
 *   node tools/make-codes.js --plan=pass --hours=24 --count=20
 * Writes to DATA_FILE (default ./data/hosts.json). A running server picks the codes up automatically. */
const path = require('path');
const { createHostStore } = require('../src/hoststore');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const file = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'hosts.json');
try {
  const store = createHostStore({ file });
  const codes = store.makeCodes({ count: Number(arg('count', 1)), plan: arg('plan', 'pro'), days: Number(arg('days', 0)), hours: Number(arg('hours', 0)) });
  console.log(codes.join('\n'));
  console.error(`\n${codes.length} ${arg('plan', 'pro')} code(s) saved to ${file}. Each works once.`);
} catch (e) {
  console.error('Error:', e.message);
  console.error('Example: node tools/make-codes.js --plan=pro --days=30 --count=5');
  process.exit(1);
}
