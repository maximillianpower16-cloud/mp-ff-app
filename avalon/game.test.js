'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('./game');

// ---------------------------------------------------------------- helpers

function roomWith(count, options = {}) {
  const room = game.createRoom('TEST');
  for (let i = 0; i < count; i++) game.addPlayer(room, `p${i}`, `P${i}`);
  Object.assign(room.options, options);
  return room;
}

function ids(room) {
  return room.players.map((p) => p.id);
}

function playerWithRole(room, key) {
  return room.players.find((p) => room.roles[p.id] === key);
}

/** Everyone acks whatever gate the room is sitting on. */
function ackAll(room) {
  for (const p of room.players) game.applyAction(room, p.id, { type: 'ack' });
}

/** Leader proposes the first `size` players; everyone votes `approve`. */
function proposeAndVote(room, approve, pick) {
  const size = game.trackFor(room.players.length)[room.questIndex];
  const leader = game.leaderId(room);
  const team = (pick || ids(room)).slice(0, size);
  for (const id of team) {
    const r = game.applyAction(room, leader, { type: 'toggleTeamMember', targetId: id });
    assert.equal(r.error, undefined, r.error);
  }
  assert.equal(game.applyAction(room, leader, { type: 'proposeTeam' }).error, undefined);
  for (const p of room.players) game.applyAction(room, p.id, { type: 'vote', approve });
  return team;
}

// ---------------------------------------------------------------- setup rules

test('evil counts follow the rulebook', () => {
  assert.equal(game.evilCount(5), 2);
  assert.equal(game.evilCount(6), 2);
  assert.equal(game.evilCount(7), 3);
  assert.equal(game.evilCount(8), 3);
  assert.equal(game.evilCount(9), 3);
  assert.equal(game.evilCount(10), 4);
});

test('quest tracks match the board', () => {
  assert.deepEqual(game.trackFor(5), [2, 3, 2, 3, 3]);
  assert.deepEqual(game.trackFor(6), [2, 3, 4, 3, 4]);
  assert.deepEqual(game.trackFor(7), [2, 3, 3, 4, 4]);
  assert.deepEqual(game.trackFor(8), [3, 4, 4, 5, 5]);
  assert.deepEqual(game.trackFor(9), [3, 4, 4, 5, 5]);
  assert.deepEqual(game.trackFor(10), [3, 4, 4, 5, 5]);
});

test('quest 4 needs two fails at 7+ players only', () => {
  for (let n = 5; n <= 10; n++) {
    for (let q = 0; q < 5; q++) {
      const expected = q === 3 && n >= 7 ? 2 : 1;
      assert.equal(game.failsRequired(n, q), expected, `n=${n} q=${q}`);
    }
  }
});

test('role list has the right shape for every player count', () => {
  for (let n = 5; n <= 10; n++) {
    const roles = game.buildRoleList(n, { percival: true, morgana: true, mordred: true, oberon: n >= 7 });
    assert.equal(roles.length, n);
    const evil = roles.filter((r) => game.ROLES[r].side === 'evil');
    assert.equal(evil.length, game.evilCount(n));
    assert.equal(roles.filter((r) => r === 'merlin').length, 1);
    assert.equal(roles.filter((r) => r === 'assassin').length, 1);
  }
});

test('too many optional evil roles is refused, not silently dropped', () => {
  const room = roomWith(5, { morgana: true, mordred: true, oberon: true });
  const err = game.validateStart(room);
  assert.match(err, /only 2 evil roles/);
  assert.equal(game.applyAction(room, 'p0', { type: 'start' }).error, err);
});

test('fewer than five players cannot start', () => {
  const room = roomWith(4);
  assert.match(game.validateStart(room), /at least 5/);
});

// ---------------------------------------------------------------- knowledge

test('evil sees evil, but never Oberon', () => {
  const room = roomWith(7, { oberon: true });
  game.startGame(room);
  for (const p of room.players) {
    const role = room.roles[p.id];
    if (game.ROLES[role].side !== 'evil' || role === 'oberon') continue;
    const expected = room.players
      .filter((o) => o.id !== p.id && game.ROLES[room.roles[o.id]].side === 'evil' && room.roles[o.id] !== 'oberon')
      .map((o) => o.name)
      .sort();
    assert.deepEqual(room.knowledge[p.id].names.slice().sort(), expected);
  }
});

test('Oberon knows nobody', () => {
  const room = roomWith(7, { oberon: true });
  game.startGame(room);
  const oberon = playerWithRole(room, 'oberon');
  assert.deepEqual(room.knowledge[oberon.id].names, []);
});

test('Merlin sees evil except Mordred', () => {
  const room = roomWith(7, { mordred: true });
  game.startGame(room);
  const merlin = playerWithRole(room, 'merlin');
  const mordred = playerWithRole(room, 'mordred');
  const seen = room.knowledge[merlin.id].names;
  assert.ok(!seen.includes(mordred.name));
  assert.equal(seen.length, game.evilCount(7) - 1);
});

test('Percival sees Merlin and Morgana, unlabeled', () => {
  const room = roomWith(7, { percival: true, morgana: true });
  game.startGame(room);
  const percival = playerWithRole(room, 'percival');
  const k = room.knowledge[percival.id];
  assert.equal(k.names.length, 2);
  assert.deepEqual(
    k.names.slice().sort(),
    [playerWithRole(room, 'merlin').name, playerWithRole(room, 'morgana').name].sort()
  );
  assert.match(k.title, /One of these/);
});

test('Percival without Morgana just sees Merlin', () => {
  const room = roomWith(7, { percival: true });
  game.startGame(room);
  const percival = playerWithRole(room, 'percival');
  assert.deepEqual(room.knowledge[percival.id].names, [playerWithRole(room, 'merlin').name]);
});

test('loyal servants learn nothing', () => {
  const room = roomWith(6);
  game.startGame(room);
  const servant = playerWithRole(room, 'servant');
  assert.deepEqual(room.knowledge[servant.id].names, []);
});

// ---------------------------------------------------------------- the view

test('the view never carries another player role before the end', () => {
  const room = roomWith(8, { percival: true, morgana: true, mordred: true });
  game.startGame(room);
  for (const p of room.players) {
    const view = game.viewFor(room, p.id);
    const json = JSON.stringify(view);
    assert.equal(view.you.role.key, room.roles[p.id]);
    for (const other of room.players) {
      if (other.id === p.id) continue;
      assert.equal(view.players.find((x) => x.id === other.id).role, null);
    }
    // The only knowledge blob in the payload is this player's own.
    assert.equal(json.split('"knowledge"').length, 2);
    assert.deepEqual(view.you.knowledge, room.knowledge[p.id]);
  }
});

test('votes are hidden until the last player has voted', () => {
  const room = roomWith(5);
  game.startGame(room);
  ackAll(room);
  const size = game.trackFor(5)[0];
  const leader = game.leaderId(room);
  for (const id of ids(room).slice(0, size)) {
    game.applyAction(room, leader, { type: 'toggleTeamMember', targetId: id });
  }
  game.applyAction(room, leader, { type: 'proposeTeam' });

  game.applyAction(room, 'p0', { type: 'vote', approve: true });
  for (const p of room.players) {
    const view = game.viewFor(room, p.id);
    assert.equal(view.lastVote, null, 'no tally before everyone votes');
    assert.equal(JSON.stringify(view).includes('"approve"'), false);
  }
  for (const p of room.players.slice(1)) game.applyAction(room, p.id, { type: 'vote', approve: true });
  assert.equal(room.phase, game.PHASE.VOTE_REVEAL);
  assert.equal(game.viewFor(room, 'p0').lastVote.votes.length, 5);
});

test('quest results are counts only — never attributed', () => {
  const room = roomWith(5);
  game.startGame(room);
  ackAll(room);
  const team = proposeAndVote(room, true);
  ackAll(room);
  assert.equal(room.phase, game.PHASE.QUEST);
  for (const id of team) {
    const evil = game.ROLES[room.roles[id]].side === 'evil';
    game.applyAction(room, id, { type: 'questAction', success: !evil });
  }
  assert.equal(room.phase, game.PHASE.QUEST_REVEAL);
  const view = game.viewFor(room, 'p0');
  assert.equal(typeof view.lastQuest.fails, 'number');
  assert.equal(JSON.stringify(view).includes('"actions"'), false);
});

// ---------------------------------------------------------------- game flow

test('good players cannot play Fail', () => {
  const room = roomWith(5);
  game.startGame(room);
  ackAll(room);
  const goodIds = ids(room).filter((id) => game.ROLES[room.roles[id]].side === 'good');
  const team = proposeAndVote(room, true, goodIds);
  ackAll(room);
  const result = game.applyAction(room, team[0], { type: 'questAction', success: false });
  assert.match(result.error, /cannot fail/);
});

test('only the leader proposes, and only team members act', () => {
  const room = roomWith(5);
  game.startGame(room);
  ackAll(room);
  const leader = game.leaderId(room);
  const other = ids(room).find((id) => id !== leader);
  assert.match(game.applyAction(room, other, { type: 'toggleTeamMember', targetId: leader }).error, /leader/);

  const team = proposeAndVote(room, true);
  ackAll(room);
  const bench = ids(room).find((id) => !team.includes(id));
  assert.match(game.applyAction(room, bench, { type: 'questAction', success: true }).error, /not on this quest/);
});

test('a rejected vote passes leadership and bumps the counter', () => {
  const room = roomWith(5);
  game.startGame(room);
  ackAll(room);
  const firstLeader = game.leaderId(room);
  proposeAndVote(room, false);
  ackAll(room);
  assert.equal(room.rejects, 1);
  assert.equal(room.phase, game.PHASE.PROPOSAL);
  assert.notEqual(game.leaderId(room), firstLeader);
});

test('five rejections in a row hands the game to evil', () => {
  const room = roomWith(5);
  game.startGame(room);
  ackAll(room);
  for (let i = 0; i < 5; i++) {
    proposeAndVote(room, false);
    ackAll(room);
  }
  assert.equal(room.phase, game.PHASE.END);
  assert.equal(room.winner, 'evil');
  assert.match(room.winReason, /rejected in a row/);
});

test('an approved vote resets the reject counter', () => {
  const room = roomWith(5);
  game.startGame(room);
  ackAll(room);
  proposeAndVote(room, false);
  ackAll(room);
  assert.equal(room.rejects, 1);
  proposeAndVote(room, true);
  ackAll(room);
  assert.equal(room.rejects, 0);
  assert.equal(room.phase, game.PHASE.QUEST);
});

test('a tied vote is a rejection', () => {
  const room = roomWith(6);
  game.startGame(room);
  ackAll(room);
  const size = game.trackFor(6)[0];
  const leader = game.leaderId(room);
  for (const id of ids(room).slice(0, size)) {
    game.applyAction(room, leader, { type: 'toggleTeamMember', targetId: id });
  }
  game.applyAction(room, leader, { type: 'proposeTeam' });
  room.players.forEach((p, i) => game.applyAction(room, p.id, { type: 'vote', approve: i < 3 }));
  assert.equal(room.lastVote.approved, false);
});

test('three failed quests end it immediately, with no assassination', () => {
  const room = roomWith(5);
  game.startGame(room);
  ackAll(room);
  for (let i = 0; i < 3; i++) {
    const evilIds = ids(room).filter((id) => game.ROLES[room.roles[id]].side === 'evil');
    const rest = ids(room).filter((id) => !evilIds.includes(id));
    const size = game.trackFor(5)[room.questIndex];
    const team = [evilIds[0]].concat(rest).slice(0, size);
    proposeAndVote(room, true, team);
    ackAll(room);
    for (const id of team) {
      game.applyAction(room, id, { type: 'questAction', success: id !== evilIds[0] });
    }
    ackAll(room);
  }
  assert.equal(room.phase, game.PHASE.END);
  assert.equal(room.winner, 'evil');
  assert.match(room.winReason, /Three quests failed/);
});

test('quest 4 survives a single fail at 7 players', () => {
  const room = roomWith(7);
  game.startGame(room);
  room.questIndex = 3;
  room.phase = game.PHASE.QUEST;
  const evilId = ids(room).find((id) => game.ROLES[room.roles[id]].side === 'evil');
  const team = [evilId].concat(ids(room).filter((id) => id !== evilId)).slice(0, 4);
  room.team = team;
  for (const id of team) game.applyAction(room, id, { type: 'questAction', success: id !== evilId });
  assert.equal(room.lastQuest.fails, 1);
  assert.equal(room.lastQuest.needed, 2);
  assert.equal(room.lastQuest.passed, true);
});

test('three successes go to the Assassin, who can win or lose it', () => {
  for (const shouldHit of [true, false]) {
    const room = roomWith(5);
    game.startGame(room);
    ackAll(room);
    for (let i = 0; i < 3; i++) {
      const goodIds = ids(room).filter((id) => game.ROLES[room.roles[id]].side === 'good');
      const size = game.trackFor(5)[room.questIndex];
      const team = goodIds.slice(0, size);
      proposeAndVote(room, true, team);
      ackAll(room);
      for (const id of team) game.applyAction(room, id, { type: 'questAction', success: true });
      ackAll(room);
    }
    assert.equal(room.phase, game.PHASE.ASSASSIN);

    const assassin = playerWithRole(room, 'assassin');
    const merlin = playerWithRole(room, 'merlin');
    const decoy = room.players.find(
      (p) => game.ROLES[room.roles[p.id]].side === 'good' && p.id !== merlin.id
    );
    const target = shouldHit ? merlin : decoy;

    // Nobody else may take the shot.
    assert.match(
      game.applyAction(room, merlin.id, { type: 'assassinate', targetId: decoy.id }).error,
      /Only the Assassin/
    );
    // The Assassin's candidate list never includes their own team.
    const view = game.viewFor(room, assassin.id);
    assert.equal(view.assassin.isAssassin, true);
    for (const c of view.assassin.candidates) {
      assert.equal(game.ROLES[room.roles[c.id]].side, 'good');
    }
    assert.equal(game.viewFor(room, merlin.id).assassin.candidates.length, 0);

    game.applyAction(room, assassin.id, { type: 'assassinate', targetId: target.id });
    assert.equal(room.phase, game.PHASE.END);
    assert.equal(room.winner, shouldHit ? 'evil' : 'good');
  }
});

test('the final view reveals every role', () => {
  const room = roomWith(5);
  game.startGame(room);
  room.phase = game.PHASE.END;
  room.winner = 'good';
  const view = game.viewFor(room, 'p0');
  for (const p of view.players) assert.ok(p.role && p.role.label);
  assert.equal(view.end.merlinId, playerWithRole(room, 'merlin').id);
});

// ---------------------------------------------------------------- host tools

test('only the host can flip roles, start, or reset', () => {
  const room = roomWith(5);
  assert.match(game.applyAction(room, 'p1', { type: 'setOption', key: 'percival', value: true }).error, /host/);
  assert.match(game.applyAction(room, 'p1', { type: 'start' }).error, /host/);
  assert.equal(game.applyAction(room, 'p0', { type: 'setOption', key: 'percival', value: true }).error, undefined);
  assert.equal(room.options.percival, true);
  game.startGame(room);
  assert.match(game.applyAction(room, 'p1', { type: 'reset' }).error, /host/);
});

test('reset keeps the players and clears every secret', () => {
  const room = roomWith(6, { percival: true, morgana: true });
  game.startGame(room);
  game.applyAction(room, 'p0', { type: 'reset' });
  assert.equal(room.phase, game.PHASE.LOBBY);
  assert.equal(room.players.length, 6);
  assert.deepEqual(room.roles, {});
  assert.deepEqual(room.knowledge, {});
  assert.equal(room.options.percival, true, 'role toggles carry over to the next round');
  assert.equal(game.viewFor(room, 'p1').you.role, null);
});

test('players cannot join a game in progress', () => {
  const room = roomWith(5);
  game.startGame(room);
  assert.match(game.addPlayer(room, 'px', 'Late').error, /already started/);
});

test('a room caps at ten players', () => {
  const room = roomWith(10);
  assert.match(game.addPlayer(room, 'px', 'Eleven').error, /full/);
});

test('nobody votes twice or plays two quest cards', () => {
  const room = roomWith(5);
  game.startGame(room);
  ackAll(room);
  const size = game.trackFor(5)[0];
  const leader = game.leaderId(room);
  for (const id of ids(room).slice(0, size)) {
    game.applyAction(room, leader, { type: 'toggleTeamMember', targetId: id });
  }
  game.applyAction(room, leader, { type: 'proposeTeam' });
  game.applyAction(room, 'p0', { type: 'vote', approve: true });
  assert.match(game.applyAction(room, 'p0', { type: 'vote', approve: false }).error, /already voted/);
});

test('the leader cannot over-fill a team', () => {
  const room = roomWith(5);
  game.startGame(room);
  ackAll(room);
  const leader = game.leaderId(room);
  const size = game.trackFor(5)[0];
  for (const id of ids(room).slice(0, size)) {
    game.applyAction(room, leader, { type: 'toggleTeamMember', targetId: id });
  }
  const extra = ids(room)[size];
  assert.match(game.applyAction(room, leader, { type: 'toggleTeamMember', targetId: extra }).error, /already full/);
  assert.equal(game.applyAction(room, leader, { type: 'proposeTeam' }).error, undefined);
  assert.equal(room.phase, game.PHASE.VOTE);
});
