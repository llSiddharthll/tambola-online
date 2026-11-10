'use strict';
/* Online tambola server. One process, many rooms (one per host).
 * Env: PORT, PUBLIC_URL (https://your-domain), TRUST_PROXY=1 behind a proxy/PaaS, ADMIN_TOKEN (>=16 chars) to
 * mint activation codes, DATA_FILE (default ./data/hosts.json), DEFAULT_PLAN=free|pass|pro (use pro for LAN/dev). */
const path = require('path');
const { createGameServer, lanIp } = require('./src/game');

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.split('=')[1]) : Number(process.env.PORT || 3000);
const defaultPlan = args.includes('--pro') || process.env.PLAN === 'pro' ? 'pro' : (process.env.DEFAULT_PLAN || 'free');
const dataFile = process.env.DATA_FILE || path.join(__dirname, 'data', 'hosts.json');

const app = createGameServer({ defaultPlan, port, dataFile });
app.listen(port).then(() => {
  const base = process.env.PUBLIC_URL || `http://${lanIp()}:${app.port}`;
  console.log(`Tambola server listening on :${app.port}  (default plan: ${defaultPlan})`);
  console.log(`  Host page:   ${base}/host.html`);
  console.log(`  Players:     ${base}/  (they enter the 5-letter room code, or scan the QR code)`);
  if (!process.env.ADMIN_TOKEN) console.log('  Activation codes: set ADMIN_TOKEN (16+ chars) or run tools/make-codes.js to create them.');
  if (!process.env.PUBLIC_URL) console.log('  Tip: set PUBLIC_URL to your https address so QR codes and the origin check use it.');
  console.log('  Points only. No money is handled by this app.');
}).catch((e) => { console.error('Could not start:', e.message); process.exit(1); });

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => app.close().then(() => process.exit(0)));
