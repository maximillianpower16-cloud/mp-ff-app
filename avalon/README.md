# Avalon

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

Any host that runs a Node process works: Render, Railway, Fly.io, Heroku, a
$5 VPS. There is nothing to configure.

- **Build command:** none
- **Start command:** `npm start` (the app reads `PORT` from the environment)
- **Root directory:** `avalon`

Two constraints worth knowing:

- **It needs a real server.** GitHub Pages and other static hosts can't run
  this, because role assignment and secret-filtering happen server-side by
  design (see below).
- **Rooms live in memory**, with a JSON snapshot on disk (`avalon/.data/`) so a
  restart or redeploy doesn't kill a game in progress. On a platform with an
  ephemeral filesystem that snapshot vanishes on redeploy; a game that is
  actively being played still survives an ordinary process restart. Set
  `AVALON_STATE` to a path on a mounted volume if you want it to persist
  properly. One process only — don't scale to multiple instances.

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
  game.test.js     31 tests: role dealing, knowledge filtering, every win condition
  public/
    index.html     app shell
    app.js         renders whatever the server says; holds no secrets
    styles.css
```

Real-time is Server-Sent Events rather than WebSockets: the game is turn-based,
every message goes server → client, EventSource reconnects on its own after a
tunnel or a locked screen, and it survives proxies that mangle WebSocket
upgrades. Actions go back as ordinary `POST`s.
