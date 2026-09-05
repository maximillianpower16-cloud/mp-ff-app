/**
 * End-to-end: boots the real server, opens five Server-Sent-Event streams as
 * five phones, and plays a complete game over HTTP.
 *
 * The rules are covered by game.test.js. What this adds is the wire: that the
 * transport works, that state reaches every phone, and — the part worth
 * guarding — that no client is ever *sent* something it shouldn't know.
 *
 *   node e2e.test.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000 + Math.floor(Math.random() * 4000);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ok   ' + msg);
  } else {
    failures.push(msg);
    console.log('  FAIL ' + msg);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => wait(80);

async function post(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** POST an action and return the error message instead of throwing. */
async function refuse(phone, action) {
  try {
    await act(phone, action);
    return null;
  } catch (err) {
    return err.message;
  }
}

const act = (phone, action) =>
  post('/api/action', { code: phone.code, playerId: phone.playerId, action });

/** Open an SSE stream and keep `phone.state` in sync with it. */
async function openStream(phone) {
  const res = await fetch(`${BASE}/api/stream?code=${phone.code}&playerId=${phone.playerId}`);
  if (!res.ok) throw new Error(`stream ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  phone.reader = reader;
  phone.frames = 0;
  (async () => {
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let split;
      while ((split = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, split);
        buf = buf.slice(split + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          phone.state = JSON.parse(line.slice(6));
          phone.frames++;
        }
      }
    }
  })().catch(() => {});
  for (let i = 0; i < 150 && !phone.state; i++) await wait(20);
  if (!phone.state) throw new Error('no opening state frame');
}

// ---------------------------------------------------------------- boot

const stateFile = path.join(await mkdtemp(path.join(tmpdir(), 'avalon-e2e-')), 'rooms.json');
const server = spawn(process.execPath, [path.join(HERE, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), AVALON_STATE: stateFile },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
  server.stdout.on('data', (d) => {
    if (String(d).includes('Avalon running')) {
      clearTimeout(timer);
      resolve();
    }
  });
  server.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
});

const phones = [];
let exitCode = 0;

try {
  // -------------------------------------------------------------- lobby
  const NAMES = ['Ada', 'Brin', 'Cleo', 'Dov', 'Eze'];
  const host = { name: 'Ada', ...(await post('/api/create', { name: 'Ada' })) };
  phones.push(host);
  for (const name of NAMES.slice(1)) {
    phones.push({ name, ...(await post('/api/join', { code: host.code, name })) });
  }
  for (const phone of phones) await openStream(phone);
  await settle();

  check(phones.every((p) => p.state.players.length === 5), 'every phone sees all five players');
  check(phones.every((p) => p.state.players.every((x) => x.connected)), 'everyone shows as connected');
  check(host.state.you.isHost && !phones[1].state.you.isHost, 'the creator is the host');

  let clash = null;
  try {
    await post('/api/join', { code: host.code, name: 'Brin' });
  } catch (err) {
    clash = err.message;
  }
  check(/already connected/.test(clash || ''), 'a name in use by a live player is refused');

  check(
    /host/.test(await refuse(phones[1], { type: 'setOption', key: 'percival', value: true })),
    'a non-host cannot change the role toggles'
  );
  await act(host, { type: 'setOption', key: 'percival', value: true });
  await act(host, { type: 'setOption', key: 'morgana', value: true });
  await settle();
  check(phones[3].state.options.morgana === true, 'toggles reach every phone');

  // -------------------------------------------------------------- the deal
  await act(host, { type: 'start' });
  await settle();
  check(phones.every((p) => p.state.phase === 'reveal'), 'the game starts for everyone at once');

  const roleOf = (p) => p.state.you.role.key;
  check(phones.filter((p) => roleOf(p) === 'merlin').length === 1, 'exactly one Merlin is dealt');
  check(phones.filter((p) => roleOf(p) === 'assassin').length === 1, 'exactly one Assassin is dealt');
  check(
    phones.filter((p) => p.state.you.role.side === 'evil').length === 2,
    'five players means two evil'
  );

  for (const phone of phones) {
    check(
      phone.state.players.every((p) => p.role === null),
      `${phone.name}'s payload carries no other player's role`
    );
  }
  const merlin = phones.find((p) => roleOf(p) === 'merlin');
  const evil = phones.filter((p) => p.state.you.role.side === 'evil');
  check(
    merlin.state.you.knowledge.names.slice().sort().join() ===
      evil.map((p) => p.name).sort().join(),
    'Merlin is shown exactly the evil players'
  );
  const servant = phones.find((p) => roleOf(p) === 'servant');
  check(servant.state.you.knowledge.names.length === 0, 'a loyal servant is shown nobody');

  for (const phone of phones) await act(phone, { type: 'ack' });
  await settle();
  check(host.state.phase === 'proposal', 'the reveal gate opens once everyone is ready');

  // -------------------------------------------------------------- three quests
  for (let quest = 0; quest < 3; quest++) {
    const leader = phones.find((p) => p.playerId === host.state.leaderId);
    const size = host.state.teamSize;
    const team = phones.filter((p) => p.state.you.role.side === 'good').slice(0, size);
    check(team.length === size, `quest ${quest + 1} calls for ${size} players`);

    check(
      /leader/.test(
        await refuse(phones.find((p) => p !== leader), {
          type: 'toggleTeamMember',
          targetId: leader.playerId,
        })
      ),
      'only the leader may pick the team'
    );

    for (const t of team) await act(leader, { type: 'toggleTeamMember', targetId: t.playerId });
    await settle();
    check(phones[2].state.team.length === size, 'the forming team is visible to everyone');
    await act(leader, { type: 'proposeTeam' });
    await settle();

    // Ballots from finished rounds are public in Avalon and stay in the
    // history; what must not leak is the vote currently in progress.
    const settledRounds = phones[1].state.voteHistory.length;
    await act(host, { type: 'vote', approve: true });
    await settle();
    check(phones[1].state.lastVote === null, 'a partial vote reveals nothing');
    check(
      phones[1].state.players.find((p) => p.id === host.playerId).voted === true,
      'but "has voted" is public'
    );
    check(
      phones[1].state.voteHistory.length === settledRounds &&
        !phones[1].state.voteHistory.some((h) => h.questIndex === quest && h.attempt === 1),
      'the in-flight ballot is in nobody else\'s payload'
    );

    for (const phone of phones.slice(1)) await act(phone, { type: 'vote', approve: true });
    await settle();
    check(host.state.phase === 'voteReveal', 'the reveal fires on the last vote');
    check(host.state.lastVote.votes.length === 5, 'all five ballots reveal together');

    for (const phone of phones) await act(phone, { type: 'ack' });
    await settle();
    check(host.state.phase === 'quest', 'an approved team goes on the quest');

    const bench = phones.find((p) => !team.includes(p));
    check(
      /not on this quest/.test(await refuse(bench, { type: 'questAction', success: true })),
      'a bystander cannot play a card'
    );
    check(
      /cannot fail/.test(await refuse(team[0], { type: 'questAction', success: false })),
      'a loyal servant cannot play Fail'
    );

    for (const t of team) await act(t, { type: 'questAction', success: true });
    await settle();
    check(host.state.lastQuest.successes === size, `quest ${quest + 1} comes back all-success`);
    check(
      !JSON.stringify(host.state).includes('"actions"'),
      'quest cards are never attributed in the payload'
    );
    for (const phone of phones) await act(phone, { type: 'ack' });
    await settle();
  }

  // -------------------------------------------------------------- assassination
  check(host.state.phase === 'assassin', 'three successes hand the game to the Assassin');
  const assassin = phones.find((p) => roleOf(p) === 'assassin');
  check(assassin.state.assassin.isAssassin === true, 'the Assassin gets the private screen');
  check(
    phones.filter((p) => p !== assassin).every((p) => p.state.assassin.candidates.length === 0),
    'nobody else receives a target list'
  );
  check(
    assassin.state.assassin.candidates.every((c) => c.id !== assassin.playerId),
    'the Assassin cannot name themselves'
  );
  check(
    /Only the Assassin/.test(
      await refuse(merlin, { type: 'assassinate', targetId: assassin.playerId })
    ),
    'nobody else can take the shot'
  );

  // A phone that reloaded: same room, same stored token, same seat.
  const reconnected = await post('/api/join', {
    code: host.code,
    name: assassin.name,
    playerId: assassin.playerId,
  });
  check(reconnected.playerId === assassin.playerId, 'a reload returns to the same seat');

  await act(assassin, { type: 'assassinate', targetId: merlin.playerId });
  await settle();
  check(host.state.phase === 'end', 'naming a target ends the game');
  check(host.state.end.winner === 'evil', 'naming Merlin wins it for evil');
  check(
    phones[1].state.players.every((p) => p.role && p.role.label),
    'the final screen reveals every role'
  );
  check(host.state.voteHistory.length === 3, 'the vote history survives to the end');

  // -------------------------------------------------------------- reset
  await act(host, { type: 'reset' });
  await settle();
  check(host.state.phase === 'lobby', 'the host can deal a new round');
  check(host.state.players.length === 5, 'with the same players');
  check(phones[3].state.you.role === null, 'and no leftover roles');
  check(host.state.options.percival === true, 'role toggles carry over');

  // -------------------------------------------------------------- odds and ends
  const bogus = await fetch(`${BASE}/api/stream?code=${host.code}&playerId=deadbeef`);
  check(bogus.status === 404, 'an unknown player token cannot open a stream');
  bogus.body.cancel().catch(() => {});

  const traversal = await fetch(`${BASE}/../server.js`);
  check(traversal.status === 404, 'the static server refuses to walk out of public/');
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check(health.ok === true, 'the health endpoint answers');
} catch (err) {
  failures.push(`threw: ${err.stack}`);
  exitCode = 1;
} finally {
  for (const phone of phones) phone.reader?.cancel().catch(() => {});
  server.kill();
  await rm(path.dirname(stateFile), { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => '  - ' + f).join('\n'));
  exitCode = 1;
}
process.exit(exitCode);
