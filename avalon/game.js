'use strict';

/**
 * The Resistance: Avalon — rules engine.
 *
 * Everything secret lives in the room object on the server. Clients never get
 * the room; they get `viewFor(room, playerId)`, which is the only place allowed
 * to decide what a given player is permitted to know.
 */

const { randomInt } = require('node:crypto');

// ---------------------------------------------------------------- constants

const ROLES = {
  merlin: {
    side: 'good',
    label: 'Merlin',
    blurb: 'You see the servants of Mordred. Guide the good — but stay hidden, or the Assassin ends you.',
  },
  percival: {
    side: 'good',
    label: 'Percival',
    blurb: 'You know who Merlin is. Protect him without giving him away.',
  },
  servant: {
    side: 'good',
    label: 'Loyal Servant of Arthur',
    blurb: 'You know nothing but your own loyalty. Watch, listen, vote well.',
  },
  assassin: {
    side: 'evil',
    label: 'Assassin',
    blurb: 'If good wins three quests you get one shot at naming Merlin. Hit, and evil wins anyway.',
  },
  morgana: {
    side: 'evil',
    label: 'Morgana',
    blurb: 'You appear as Merlin to Percival. Sow doubt.',
  },
  mordred: {
    side: 'evil',
    label: 'Mordred',
    blurb: 'Merlin cannot see you. You are invisible to the enemy.',
  },
  oberon: {
    side: 'evil',
    label: 'Oberon',
    blurb: 'You are evil, but you do not know your allies — and they do not know you.',
  },
  minion: {
    side: 'evil',
    label: 'Minion of Mordred',
    blurb: 'You know your fellow servants of Mordred. Fail the quests.',
  },
};

const OPTIONAL_ROLES = ['percival', 'morgana', 'mordred', 'oberon'];
const OPTIONAL_EVIL = ['morgana', 'mordred', 'oberon'];

const QUEST_TRACK = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 10;
const MAX_REJECTS = 5;

const PHASE = {
  LOBBY: 'lobby',
  REVEAL: 'reveal',
  PROPOSAL: 'proposal',
  VOTE: 'vote',
  VOTE_REVEAL: 'voteReveal',
  QUEST: 'quest',
  QUEST_REVEAL: 'questReveal',
  ASSASSIN: 'assassin',
  END: 'end',
};

// ---------------------------------------------------------------- utilities

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function evilCount(playerCount) {
  if (playerCount <= 6) return 2;
  if (playerCount <= 9) return 3;
  return 4;
}

function trackFor(playerCount) {
  return QUEST_TRACK[playerCount] || null;
}

/** Quest 4 needs two fails at 7+ players. */
function failsRequired(playerCount, questIndex) {
  return questIndex === 3 && playerCount >= 7 ? 2 : 1;
}

function isEvil(roleKey) {
  return !!roleKey && ROLES[roleKey].side === 'evil';
}

// ---------------------------------------------------------------- room setup

function createRoom(code) {
  return {
    code,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hostId: null,
    options: { percival: false, morgana: false, mordred: false, oberon: false },
    players: [], // { id, name, connected }
    phase: PHASE.LOBBY,
    round: 0,

    roles: {}, // playerId -> role key   (SECRET)
    knowledge: {}, // playerId -> { title, names[], note }  (SECRET, per player)

    questIndex: 0,
    leaderIndex: 0,
    rejects: 0,
    team: [],
    votes: {}, // playerId -> bool       (SECRET until everyone has voted)
    actions: {}, // playerId -> bool     (SECRET forever; only counts are shown)
    acks: [], // playerId[] ready to move on
    questResults: [], // { index, passed, fails, successes, teamSize }
    voteHistory: [], // { questIndex, round, leader, team[], votes[{name,approve}], approved }
    lastVote: null,
    lastQuest: null,

    assassinTargetId: null,
    winner: null, // 'good' | 'evil'
    winReason: null,
  };
}

function findPlayer(room, id) {
  return room.players.find((p) => p.id === id) || null;
}

function nameOf(room, id) {
  const p = findPlayer(room, id);
  return p ? p.name : 'Unknown';
}

function addPlayer(room, id, name) {
  if (room.players.length >= MAX_PLAYERS) return { error: `Room is full (${MAX_PLAYERS} players).` };
  if (room.phase !== PHASE.LOBBY) return { error: 'That game has already started.' };
  const player = { id, name, connected: false };
  room.players.push(player);
  if (!room.hostId) room.hostId = id;
  touch(room);
  return { player };
}

function removePlayer(room, id) {
  room.players = room.players.filter((p) => p.id !== id);
  if (room.hostId === id) room.hostId = room.players.length ? room.players[0].id : null;
  touch(room);
}

function touch(room) {
  room.updatedAt = Date.now();
}

// ---------------------------------------------------------------- role deal

function validateStart(room) {
  const n = room.players.length;
  if (n < MIN_PLAYERS) return `Need at least ${MIN_PLAYERS} players — you have ${n}.`;
  if (n > MAX_PLAYERS) return `Too many players (max ${MAX_PLAYERS}).`;

  const evil = evilCount(n);
  const extras = OPTIONAL_EVIL.filter((k) => room.options[k]);
  if (1 + extras.length > evil) {
    const labels = extras.map((k) => ROLES[k].label).join(', ');
    return `With ${n} players there are only ${evil} evil roles (Assassin + ${evil - 1}). Turn off some of: ${labels}.`;
  }
  return null;
}

function buildRoleList(playerCount, options) {
  const evilN = evilCount(playerCount);
  const goodN = playerCount - evilN;

  const good = ['merlin'];
  if (options.percival) good.push('percival');
  while (good.length < goodN) good.push('servant');

  const evil = ['assassin'];
  for (const key of OPTIONAL_EVIL) if (options[key]) evil.push(key);
  while (evil.length < evilN) evil.push('minion');

  return good.slice(0, goodN).concat(evil.slice(0, evilN));
}

/**
 * Knowledge is computed once, at deal time, and stored per player so the order
 * of names stays stable across broadcasts.
 */
function buildKnowledge(room, playerId) {
  const role = room.roles[playerId];
  const others = room.players.filter((p) => p.id !== playerId);
  const roleOf = (p) => room.roles[p.id];

  if (isEvil(role) && role !== 'oberon') {
    const names = shuffle(
      others.filter((p) => isEvil(roleOf(p)) && roleOf(p) !== 'oberon').map((p) => p.name)
    );
    return {
      title: names.length ? 'Your fellow servants of Mordred' : 'You have no visible allies',
      names,
      note: room.options.oberon ? 'Oberon is also evil, but hidden from you.' : null,
    };
  }

  if (role === 'merlin') {
    const names = shuffle(
      others.filter((p) => isEvil(roleOf(p)) && roleOf(p) !== 'mordred').map((p) => p.name)
    );
    return {
      title: 'Servants of Mordred',
      names,
      note: room.options.mordred ? 'Mordred is evil too, but hidden from you.' : null,
    };
  }

  if (role === 'percival') {
    const seen = others.filter((p) => roleOf(p) === 'merlin' || roleOf(p) === 'morgana');
    const names = shuffle(seen.map((p) => p.name));
    return {
      title: names.length > 1 ? 'One of these is Merlin' : 'Merlin',
      names,
      note: names.length > 1 ? 'The other is Morgana. You cannot tell which is which.' : null,
    };
  }

  return { title: null, names: [], note: 'You know nothing but your own loyalty.' };
}

function startGame(room) {
  const error = validateStart(room);
  if (error) return { error };

  const deal = shuffle(buildRoleList(room.players.length, room.options));
  room.roles = {};
  room.players.forEach((p, i) => {
    room.roles[p.id] = deal[i];
  });
  room.knowledge = {};
  for (const p of room.players) room.knowledge[p.id] = buildKnowledge(room, p.id);

  room.phase = PHASE.REVEAL;
  room.round += 1;
  room.questIndex = 0;
  room.leaderIndex = randomInt(room.players.length);
  room.rejects = 0;
  room.team = [];
  room.votes = {};
  room.actions = {};
  room.acks = [];
  room.questResults = [];
  room.voteHistory = [];
  room.lastVote = null;
  room.lastQuest = null;
  room.assassinTargetId = null;
  room.winner = null;
  room.winReason = null;
  touch(room);
  return {};
}

function resetToLobby(room) {
  room.phase = PHASE.LOBBY;
  room.roles = {};
  room.knowledge = {};
  room.team = [];
  room.votes = {};
  room.actions = {};
  room.acks = [];
  room.questResults = [];
  room.voteHistory = [];
  room.lastVote = null;
  room.lastQuest = null;
  room.assassinTargetId = null;
  room.winner = null;
  room.winReason = null;
  room.rejects = 0;
  room.questIndex = 0;
  touch(room);
}

// ---------------------------------------------------------------- game flow

function currentTeamSize(room) {
  const track = trackFor(room.players.length);
  return track ? track[room.questIndex] : 0;
}

function leaderId(room) {
  const p = room.players[room.leaderIndex % room.players.length];
  return p ? p.id : null;
}

function connectedPlayers(room) {
  const live = room.players.filter((p) => p.connected);
  return live.length ? live : room.players;
}

function everyoneAcked(room) {
  return connectedPlayers(room).every((p) => room.acks.includes(p.id));
}

function advanceLeader(room) {
  room.leaderIndex = (room.leaderIndex + 1) % room.players.length;
}

function endGame(room, winner, reason) {
  room.phase = PHASE.END;
  room.winner = winner;
  room.winReason = reason;
}

/** Called once every connected player has acked the vote reveal. */
function resolveVoteReveal(room) {
  const approved = room.lastVote && room.lastVote.approved;
  room.acks = [];
  room.lastVote = null;

  if (approved) {
    room.rejects = 0;
    room.actions = {};
    room.phase = PHASE.QUEST;
    return;
  }

  room.rejects += 1;
  if (room.rejects >= MAX_REJECTS) {
    endGame(room, 'evil', `${MAX_REJECTS} teams rejected in a row — the court falls into chaos.`);
    return;
  }
  advanceLeader(room);
  room.team = [];
  room.phase = PHASE.PROPOSAL;
}

/** Called once every connected player has acked the quest reveal. */
function resolveQuestReveal(room) {
  room.acks = [];
  room.lastQuest = null;

  const passed = room.questResults.filter((r) => r.passed).length;
  const failed = room.questResults.filter((r) => !r.passed).length;

  if (failed >= 3) {
    endGame(room, 'evil', 'Three quests failed.');
    return;
  }
  if (passed >= 3) {
    room.phase = PHASE.ASSASSIN;
    return;
  }

  room.questIndex += 1;
  advanceLeader(room);
  room.rejects = 0;
  room.team = [];
  room.votes = {};
  room.actions = {};
  room.phase = PHASE.PROPOSAL;
}

// ---------------------------------------------------------------- actions

/**
 * Apply a player action. Returns `{ error }` on rejection, `{}` on success.
 * Every rule is enforced here — the client UI is only a convenience.
 */
function applyAction(room, playerId, action) {
  const player = findPlayer(room, playerId);
  if (!player) return { error: 'You are not in this room.' };
  const isHost = room.hostId === playerId;
  const type = action && action.type;

  switch (type) {
    // ---- lobby ----------------------------------------------------------
    case 'setOption': {
      if (!isHost) return { error: 'Only the host can change roles.' };
      if (room.phase !== PHASE.LOBBY) return { error: 'Roles are locked once the game starts.' };
      if (!OPTIONAL_ROLES.includes(action.key)) return { error: 'Unknown role.' };
      room.options[action.key] = !!action.value;
      break;
    }

    case 'kick': {
      if (!isHost) return { error: 'Only the host can remove players.' };
      if (room.phase !== PHASE.LOBBY) return { error: 'Cannot remove players mid-game.' };
      if (action.targetId === playerId) return { error: 'You cannot remove yourself.' };
      if (!findPlayer(room, action.targetId)) return { error: 'No such player.' };
      removePlayer(room, action.targetId);
      break;
    }

    case 'start': {
      if (!isHost) return { error: 'Only the host can start the game.' };
      if (room.phase !== PHASE.LOBBY) return { error: 'The game has already started.' };
      const result = startGame(room);
      if (result.error) return result;
      break;
    }

    // ---- shared "everyone tap continue" gate -----------------------------
    case 'ack': {
      const gated = [PHASE.REVEAL, PHASE.VOTE_REVEAL, PHASE.QUEST_REVEAL];
      if (!gated.includes(room.phase)) return { error: 'Nothing to confirm right now.' };
      if (!room.acks.includes(playerId)) room.acks.push(playerId);
      if (everyoneAcked(room)) advancePastGate(room);
      break;
    }

    case 'forceContinue': {
      if (!isHost) return { error: 'Only the host can skip ahead.' };
      const gated = [PHASE.REVEAL, PHASE.VOTE_REVEAL, PHASE.QUEST_REVEAL];
      if (!gated.includes(room.phase)) return { error: 'Nothing to skip right now.' };
      advancePastGate(room);
      break;
    }

    // ---- team proposal ---------------------------------------------------
    case 'toggleTeamMember': {
      if (room.phase !== PHASE.PROPOSAL) return { error: 'Not the proposal phase.' };
      if (leaderId(room) !== playerId) return { error: 'Only the leader picks the team.' };
      if (!findPlayer(room, action.targetId)) return { error: 'No such player.' };
      const idx = room.team.indexOf(action.targetId);
      if (idx >= 0) room.team.splice(idx, 1);
      else if (room.team.length < currentTeamSize(room)) room.team.push(action.targetId);
      else return { error: 'The team is already full.' };
      break;
    }

    case 'proposeTeam': {
      if (room.phase !== PHASE.PROPOSAL) return { error: 'Not the proposal phase.' };
      if (leaderId(room) !== playerId) return { error: 'Only the leader proposes.' };
      if (room.team.length !== currentTeamSize(room)) {
        return { error: `Pick exactly ${currentTeamSize(room)} players.` };
      }
      room.votes = {};
      room.phase = PHASE.VOTE;
      break;
    }

    // ---- voting ----------------------------------------------------------
    case 'vote': {
      if (room.phase !== PHASE.VOTE) return { error: 'No vote in progress.' };
      if (playerId in room.votes) return { error: 'You already voted.' };
      room.votes[playerId] = !!action.approve;
      if (room.players.every((p) => p.id in room.votes)) closeVote(room);
      break;
    }

    // ---- the quest -------------------------------------------------------
    case 'questAction': {
      if (room.phase !== PHASE.QUEST) return { error: 'No quest in progress.' };
      if (!room.team.includes(playerId)) return { error: 'You are not on this quest.' };
      if (playerId in room.actions) return { error: 'You already played your card.' };
      const success = !!action.success;
      if (!success && ROLES[room.roles[playerId]].side === 'good') {
        return { error: 'Loyal servants of Arthur cannot fail a quest.' };
      }
      room.actions[playerId] = success;
      if (room.team.every((id) => id in room.actions)) closeQuest(room);
      break;
    }

    // ---- assassination ---------------------------------------------------
    case 'assassinate': {
      if (room.phase !== PHASE.ASSASSIN) return { error: 'Not the assassination phase.' };
      if (room.roles[playerId] !== 'assassin') return { error: 'Only the Assassin may strike.' };
      if (!findPlayer(room, action.targetId)) return { error: 'No such player.' };
      if (action.targetId === playerId) return { error: 'Pick someone else.' };
      room.assassinTargetId = action.targetId;
      const hit = room.roles[action.targetId] === 'merlin';
      if (hit) {
        endGame(room, 'evil', `The Assassin named ${nameOf(room, action.targetId)} — and struck Merlin dead.`);
      } else {
        endGame(room, 'good', `The Assassin named ${nameOf(room, action.targetId)}, who was not Merlin.`);
      }
      break;
    }

    // ---- host controls ---------------------------------------------------
    case 'reset': {
      if (!isHost) return { error: 'Only the host can start a new round.' };
      resetToLobby(room);
      break;
    }

    default:
      return { error: 'Unknown action.' };
  }

  touch(room);
  return {};
}

function advancePastGate(room) {
  if (room.phase === PHASE.REVEAL) {
    room.acks = [];
    room.team = [];
    room.phase = PHASE.PROPOSAL;
    return;
  }
  if (room.phase === PHASE.VOTE_REVEAL) return resolveVoteReveal(room);
  if (room.phase === PHASE.QUEST_REVEAL) return resolveQuestReveal(room);
}

function closeVote(room) {
  const approvals = room.players.filter((p) => room.votes[p.id]).length;
  const approved = approvals * 2 > room.players.length;
  const votes = room.players.map((p) => ({ id: p.id, name: p.name, approve: !!room.votes[p.id] }));

  room.lastVote = {
    approved,
    approvals,
    rejections: room.players.length - approvals,
    votes,
    leaderId: leaderId(room),
    team: room.team.slice(),
  };
  room.voteHistory.push({
    questIndex: room.questIndex,
    attempt: room.rejects + 1,
    leader: nameOf(room, leaderId(room)),
    team: room.team.map((id) => nameOf(room, id)),
    votes,
    approved,
  });
  room.acks = [];
  room.phase = PHASE.VOTE_REVEAL;
}

function closeQuest(room) {
  const cards = room.team.map((id) => room.actions[id]);
  const fails = cards.filter((c) => c === false).length;
  const successes = cards.length - fails;
  const needed = failsRequired(room.players.length, room.questIndex);
  const passed = fails < needed;

  room.questResults.push({
    index: room.questIndex,
    passed,
    fails,
    successes,
    teamSize: cards.length,
    team: room.team.map((id) => nameOf(room, id)),
  });
  room.lastQuest = { passed, fails, successes, needed, index: room.questIndex };
  room.actions = {};
  room.acks = [];
  room.phase = PHASE.QUEST_REVEAL;
}

// ---------------------------------------------------------------- the view

/**
 * The single trust boundary. Anything not returned from here never reaches a
 * browser. Other players' roles are included only once the game has ended.
 */
function viewFor(room, playerId) {
  const n = room.players.length;
  const track = trackFor(n);
  const lid = leaderId(room);
  const ended = room.phase === PHASE.END;
  const myRole = room.roles[playerId] || null;

  const players = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    connected: p.connected,
    isHost: p.id === room.hostId,
    isLeader: p.id === lid && room.phase !== PHASE.LOBBY && room.phase !== PHASE.END,
    onTeam: room.team.includes(p.id),
    voted: room.phase === PHASE.VOTE ? p.id in room.votes : false,
    acted: room.phase === PHASE.QUEST ? p.id in room.actions : false,
    acked: room.acks.includes(p.id),
    // Roles are revealed to everyone only at the end of the game.
    role: ended && room.roles[p.id] ? publicRole(room.roles[p.id]) : null,
  }));

  const view = {
    code: room.code,
    phase: room.phase,
    round: room.round,
    playerCount: n,
    players,
    hostId: room.hostId,
    leaderId: room.phase === PHASE.LOBBY ? null : lid,
    rejects: room.rejects,
    maxRejects: MAX_REJECTS,
    questIndex: room.questIndex,
    teamSize: track ? track[room.questIndex] : 0,
    team: room.team.slice(),
    options: { ...room.options },
    evilCount: n >= MIN_PLAYERS && n <= MAX_PLAYERS ? evilCount(n) : null,
    startError: room.phase === PHASE.LOBBY ? validateStart(room) : null,
    track: track
      ? track.map((size, i) => ({
          size,
          failsRequired: failsRequired(n, i),
          result: room.questResults[i] ? (room.questResults[i].passed ? 'success' : 'fail') : null,
          fails: room.questResults[i] ? room.questResults[i].fails : null,
        }))
      : [],
    acks: room.acks.slice(),
    acksNeeded: connectedPlayers(room).length,
    voteHistory: room.voteHistory,
    you: {
      id: playerId,
      name: nameOf(room, playerId),
      isHost: room.hostId === playerId,
      isLeader: lid === playerId,
      onTeam: room.team.includes(playerId),
      hasVoted: playerId in room.votes,
      hasActed: playerId in room.actions,
      hasAcked: room.acks.includes(playerId),
      role: myRole ? publicRole(myRole) : null,
      knowledge: room.knowledge[playerId] || null,
      canFail: myRole ? ROLES[myRole].side === 'evil' : false,
    },
    lastVote: room.phase === PHASE.VOTE_REVEAL ? room.lastVote : null,
    lastQuest: room.phase === PHASE.QUEST_REVEAL ? room.lastQuest : null,
  };

  if (room.phase === PHASE.ASSASSIN) {
    const amAssassin = myRole === 'assassin';
    view.assassin = {
      isAssassin: amAssassin,
      assassinName: null,
      // The Assassin already knows their evil allies, so hiding them leaks nothing.
      candidates: amAssassin
        ? room.players
            .filter((p) => p.id !== playerId && !isEvil(room.roles[p.id]))
            .map((p) => ({ id: p.id, name: p.name }))
        : [],
    };
  }

  if (ended) {
    view.end = {
      winner: room.winner,
      reason: room.winReason,
      assassinTargetId: room.assassinTargetId,
      merlinId: room.players.find((p) => room.roles[p.id] === 'merlin')?.id || null,
    };
  }

  return view;
}

function publicRole(key) {
  return { key, label: ROLES[key].label, side: ROLES[key].side, blurb: ROLES[key].blurb };
}

module.exports = {
  ROLES,
  OPTIONAL_ROLES,
  OPTIONAL_EVIL,
  QUEST_TRACK,
  PHASE,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MAX_REJECTS,
  shuffle,
  evilCount,
  trackFor,
  failsRequired,
  createRoom,
  addPlayer,
  removePlayer,
  findPlayer,
  buildRoleList,
  validateStart,
  startGame,
  resetToLobby,
  applyAction,
  viewFor,
  leaderId,
  touch,
};
