# Tambola (online, points only)

A playable multiplayer tambola. A **host** opens the host page, creates a room and gets a 5-letter code and QR. **Players** open the site on their phones, enter the code and play from any network (Wi-Fi or mobile data). The server shuffles the 90 numbers, issues tickets, calls on a timer and checks every claim. The host's device speaks the numbers; player phones stay silent and vibrate.

All entry and prizes are **points**. Nothing in this app handles or shows money.

## Run it on your computer

1. Install Node.js 18+.
2. `npm install`, then `npm start` (`npm run start:pro` makes every host Pro for testing).
3. Open `http://localhost:3000/host.html`, press **Create a room**. Open the printed player link (or the QR) on phones on the same Wi-Fi, or in other browser tabs (private windows count as different players).

To run it on the internet for real, read **DEPLOY.md**.

## Plans

| | Free | Party Pass | Pro |
|---|---|---|---|
| Players per room | 8 | 30 | 50 |
| Tickets per player | 3 | 6 | 6 |
| Prizes | Early 5, three lines, Full House | All | All |

Hosts get Party Pass or Pro by pasting an activation code on the host page. Make codes with `node tools/make-codes.js`. Payments and ads are not built in.

## How a game runs

- The host screen speaks each number with the traditional rhyme (browser text-to-speech; tap the page once if sound is blocked).
- Players tap a called number to dab it (or use Auto-dab). To win, press **Claim a prize**, pick the prize and ticket. The server checks the numbers actually called, not what was dabbed.
- Claims within a short window split the prize; if they arrive out of order, the earlier call number wins.
- A false claim is a **Bogey**: by default it bars that player from that prize.
- Before the first call the server publishes a fair-play code (hash of the shuffled order). At the end the order is revealed and every phone checks it.
- Players who lose connection rejoin automatically with the same tickets. A host who reloads gets their room back.

## Tests

`npm test` runs 25 automated tests: ticket generation, prize patterns, points maths, SHA-256 in the browser vs Node, ties, claim ordering, bogeys, reconnects, plan limits, a full simulated game checked for fairness and conservation of points, both pages in a simulated browser, and the online layer (room isolation, activation codes and expiry, host reconnect, room cleanup, abuse limits, origin check, admin endpoint).

## Known limits

- Tested with bots and a simulated browser, not on real phones or under real load.
- Rooms are in memory; a server restart ends live games.
- Speech uses the browser's built-in voice and differs by device. English only for now.

## Legal note

Points that a group settles in cash offline may still be treated as stakes under India's online gaming law. Get a lawyer's written opinion before any public release.

## Layout

```
server.js          start script
src/engine.js      shuffle, ticket sets, prize maths
src/game.js        web server: rooms, limits, static files, admin endpoint
src/room.js        one room's game rules (claims, prizes, timers)
src/hoststore.js   host plans and activation codes
tools/make-codes.js  make activation codes
Dockerfile, DEPLOY.md  hosting
shared/            pattern checks and SHA-256 used by server and browsers
public/            host and player pages
test/              automated tests
```

The engine and message protocol here are the reference for the Flutter app: port `src/engine.js` and `shared/patterns.js` to Dart and keep these tests as the checklist.
