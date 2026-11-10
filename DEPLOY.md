# Putting the online tambola on the internet

The app is one Node process. It serves the web pages and the game over WebSockets, and keeps every room in memory. Hosts open `/host.html`, create a room and get a 5-letter code and QR. Players open the site, type the code and join from any network: Wi-Fi or mobile data.

## What you need from a hosting provider

- Runs Node 18+ (or a Docker image) and keeps it running **all the time**. Hosting that sleeps when idle drops live games.
- WebSocket support and free HTTPS (nearly all do). Browsers need HTTPS before they will let a phone speak or vibrate reliably.
- **Exactly one instance.** Rooms live in memory, so two copies would split players across different servers. Scale up the machine, not the count.
- A small **persistent disk** for `/data/hosts.json` (who bought which plan, which codes were used). Without it, every restart wipes activations and codes.

## Settings (environment variables)

| Name | What it does |
|---|---|
| `PUBLIC_URL` | Your address, e.g. `https://tambola.example.com`. Used for QR codes and to reject WebSockets opened from other websites. Set it. |
| `TRUST_PROXY=1` | Set when a proxy or platform sits in front (true on almost all hosts; the Dockerfile sets it). Needed so rate limits see each phone's real address. Do not set it when the server is directly on the internet. |
| `ADMIN_TOKEN` | 16+ random characters. Turns on `POST /admin/codes` for making activation codes remotely. Leave unset to disable. |
| `DATA_FILE` | Where plans and codes are saved. Default `/data/hosts.json` in Docker. |
| `DEFAULT_PLAN` | `free` (default). `pro` gives every host Pro; only for LAN or testing. |
| `PORT` | Default 3000. |

## Docker

```
docker build -t tambola .
docker run -d --name tambola -p 3000:3000 -v tambola-data:/data \
  -e PUBLIC_URL=https://tambola.example.com -e ADMIN_TOKEN=$(openssl rand -hex 16) tambola
```
Put an HTTPS proxy (Caddy, nginx, or your platform's) in front. Check `GET /healthz`.

## Without Docker

```
npm ci --omit=dev
PORT=3000 PUBLIC_URL=https://tambola.example.com TRUST_PROXY=1 DATA_FILE=/var/lib/tambola/hosts.json node server.js
```
Run it under systemd, pm2 or your host's process manager so it restarts on crash.

## Selling plans with activation codes

Hosts are anonymous. A host's browser keeps a secret id; a code ties a plan to that id for a set time. Make codes on the server:

```
node tools/make-codes.js --plan=pass --hours=24 --count=20     # Party Pass, 30 players
node tools/make-codes.js --plan=pro --days=30 --count=10       # Pro, 50 players
```
or remotely: `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$PUBLIC_URL/admin/codes?plan=pro&days=30&count=5"`.

Each code works once, looks like `PRO-7KQ2-XM4D`, and the host pastes it on the host page. A running server picks up new codes without a restart. Selling them (UPI, WhatsApp, a payment link) is manual for now. Later, a payment webhook can call the same code-making function.

Limits worth knowing: a host who clears browser data loses their plan (you can re-issue a code). Codes are bearer tokens, so treat them like cash.

## Built-in protections

Per-address caps on connections, wrong room-code guesses, room creation and activation attempts; a cap on total rooms; a message-rate limit per connection; rooms are removed when abandoned (15 min), long finished (1 h) or older than 8 h; WebSocket origin check; security headers; a content security policy. The server never trusts the phones: tickets, numbers and claims are all checked on the server.

## Not yet done (be honest with yourself before launch)

- **Not load-tested.** Tests use a handful of bot players. A 10-player game measured about 320 KB of traffic per player; one small server should carry dozens of rooms, but measure with your provider before promising numbers.
- **No automatic payments, no ads.** Plans are sold by hand. Ads and in-app payments need the Flutter app or a web payment integration.
- **Single server, in-memory rooms.** A restart ends live games (plans survive if the disk does).
- **Legal.** Points with offline cash settlement may count as stakes under India's online gaming law. Get a written lawyer's opinion before a public launch, and avoid any wording about money or winnings in the app, store listings and marketing.
- **Real phones.** Tested in a simulated browser only. Try iPhone Safari and Android Chrome on mobile data before a party.
