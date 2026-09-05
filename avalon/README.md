# Avalon

[![Avalon tests](https://github.com/maximillianpower16-cloud/mp-ff-app/actions/workflows/avalon-tests.yml/badge.svg)](https://github.com/maximillianpower16-cloud/mp-ff-app/actions/workflows/avalon-tests.yml)

The Resistance: Avalon for a group of phones. One person creates a room, shares
a link, everyone else joins from it. No cards, no app store, no accounts — just
a display name.

5–10 players. Optional Percival, Morgana, Mordred and Oberon.

## Run it

```
cd avalon
npm start          # http://localhost:3000
```

No dependencies and no build step — Node 18+ and nothing else. `npm test` runs
the rules suite.

To play on a phone on the same Wi-Fi, hit `http://<your-laptop-ip>:3000`. For a
group that isn't in the room with you, deploy it (below).

## Deploy

Everything is pre-configured; pick a host and click.

**Render** — free tier, no card. The blueprint at the repo root already sets the
root directory, start command and health check:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/maximillianpower16-cloud/mp-ff-app)

**Fly.io** — `fly.toml` and the `Dockerfile` are in this directory:

```
cd avalon
fly launch --copy-config --no-deploy    # pick a name
fly deploy
```

**Railway** — new project from this repo, set the root directory to `avalon`.
`railway.json` supplies the rest.

**Any VPS with Docker:**

```
cd avalon && docker compose up -d       # then reverse-proxy port 3000
```

Doing it by hand anywhere else: **build command** none, **start command**
`npm start`, **root directory** `avalon`. The app reads `PORT` from the
environment and answers a health check at `/api/health`.

Three constraints worth knowing:

- **It needs a real server.** GitHub Pages and other static hosts can't run
  this, because role assignment and secret-filtering happen server-side by
  design (see below). That's also why the draft board at the repo root and this
  app can't share a host.
- **Run exactly one instance.** Rooms live in that process's memory; a second
  replica would answer with a different game.
- **Sleeping hosts end games.** Render's free tier suspends after ~15 minutes
  idle and Fly stops machines under a group by default (`fly.toml` disables
  that). Rooms snapshot to disk — `avalon/.data/rooms.json`, or wherever
  `AVALON_STATE` points — so an ordinary restart is survivable, but a platform
  that also wipes the filesystem is not. Mount a volume at `/data` if a game
  must outlive a redeploy.

**No live instance exists yet.** The `/room/ABCD` link players join is minted at
runtime by whatever host you deploy to, so it's `https://<your-host>/room/ABCD`
once one of the above is done. If you just want to play tonight and everyone is
on the same Wi-Fi, skip all of this and run `npm start` — your phones can reach
`http://<your-laptop-ip>:3000` directly.

## How the secrecy works

The whole point of Avalon is that different players know different things, so
the server never sends a client anything that client shouldn't know.

- Roles are dealt on the server (`game.js`) with `crypto.randomInt`.
- Every client's state comes from `viewFor(room, playerId)` — the single place
  allowed to decide what one player may see. Other players' roles simply aren't
  in the payload until the game ends.
- Each player's knowledge (who Merlin sees, who evil sees, Percival's two
  candidates) is computed once at deal time and stored per player, then only
  ever sent to that player.
- Votes are withheld from everyone until the last player has voted, then
  released together.
- Quest cards are never attributed. The server sends counts only ("2 Success,
  1 Fail"); who played what is not in any payload, ever.
- Rules are enforced server-side, not by the UI. A good player literally cannot
  fail a quest, a bystander cannot play a card, and only the leader can
  propose — the buttons are a convenience, the server is the referee.

Opening devtools tells you nothing you weren't dealt.

## Rules implemented

| Players | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|
| Evil | 2 | 2 | 3 | 3 | 3 | 4 |
| Quest sizes | 2,3,2,3,3 | 2,3,4,3,4 | 2,3,3,4,4 | 3,4,4,5,5 | 3,4,4,5,5 | 3,4,4,5,5 |

- Quest 4 requires **two** fails at 7+ players. The header marks it.
- Rotating leader; a rejected proposal passes leadership on.
- Five consecutive rejections = evil wins.
- Three failed quests = evil wins immediately.
- Three successful quests = the Assassin gets a private screen to name Merlin.
  Correct, evil wins; wrong, good wins.
- A tied vote is a rejection.
- The host can't enable more special evil roles than there are evil seats —
  the start button explains what to turn off instead of silently dropping one.

## Playing

1. Host taps **Create a room**, gets a 4-letter code and a `/room/ABCD` link.
2. Everyone else opens the link and enters a name. The lobby updates live.
3. Host flips optional roles on, then starts once 5–10 people are in.
4. Everyone reveals their role privately (tap to reveal, tap to hide) and taps
   ready. **My role** in the header brings the card back at any point.
5. Leader picks a team; everyone votes; votes reveal all at once.
6. The team plays Success/Fail; results come back as counts.
7. At the end every role is revealed, and the host can deal a fresh round with
   the same players.

**If a phone locks or the page reloads**, it comes straight back to where the
game is — the browser remembers its seat for that room. On a different device,
or with storage cleared, just join the same room with the same name and you
reclaim your seat.

## Layout

```
avalon/
  server.js        HTTP + Server-Sent Events, static files, room lifecycle
  game.js          all the rules, all the secrets, and viewFor() — the trust boundary
  game.test.js     32 rules tests: dealing, knowledge filtering, every win condition,
                   plus a soak that plays 600 random games and checks the invariants
  e2e.test.mjs     boots the server, plays a full 5-player game over HTTP (74 checks)
  public/
    index.html     app shell
    app.js         renders whatever the server says; holds no secrets
    styles.css
  Dockerfile       also used by fly.toml and docker-compose.yml
```

`npm test` runs both suites. CI runs them on every push that touches `avalon/`,
repeating the rules suite five times because the deal is random.

Real-time is Server-Sent Events rather than WebSockets: the game is turn-based,
every message goes server → client, EventSource reconnects on its own after a
tunnel or a locked screen, and it survives proxies that mangle WebSocket
upgrades. Actions go back as ordinary `POST`s.
