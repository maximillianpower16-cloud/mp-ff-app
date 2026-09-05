'use strict';

/* Avalon — client. Renders whatever the server says; holds no secrets of its own. */

const screenEl = document.getElementById('screen');
const hdrEl = document.getElementById('hdr');
const sheetEl = document.getElementById('sheet');
const sheetInner = document.getElementById('sheet-inner');
const toastEl = document.getElementById('toast');

let state = null; // latest personalised view from the server
let session = null; // { code, playerId, name }
let stream = null;
let revealed = false; // local-only: is the role card face-up
let assassinPick = null;
let sheet = null; // 'role' | 'history' | null
let pendingName = '';
let pendingCode = codeFromPath() || '';

// ---------------------------------------------------------------- storage

function codeFromPath() {
  const m = location.pathname.match(/^\/room\/([A-Za-z]{4})\/?$/);
  return m ? m[1].toUpperCase() : null;
}
function store(code) {
  try {
    return JSON.parse(localStorage.getItem('avalon:' + code) || 'null');
  } catch {
    return null;
  }
}
function saveStore(code, data) {
  try {
    localStorage.setItem('avalon:' + code, JSON.stringify(data));
    localStorage.setItem('avalon:lastName', data.name);
  } catch {}
}
function lastName() {
  try {
    return localStorage.getItem('avalon:lastName') || '';
  } catch {
    return '';
  }
}
function forget(code) {
  try {
    localStorage.removeItem('avalon:' + code);
  } catch {}
}

// ---------------------------------------------------------------- transport

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function connect() {
  if (stream) stream.close();
  stream = new EventSource(`/api/stream?code=${session.code}&playerId=${session.playerId}`);
  stream.addEventListener('state', (e) => {
    state = JSON.parse(e.data);
    render();
  });
  stream.onerror = () => {
    /* EventSource reconnects on its own; nothing to do but wait. */
  };
}

async function act(action) {
  try {
    await api('/api/action', { code: session.code, playerId: session.playerId, action });
  } catch (err) {
    toast(err.message);
  }
}

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 3200);
}

// ---------------------------------------------------------------- helpers

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ORD = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];

function nameOf(id) {
  const p = state.players.find((x) => x.id === id);
  return p ? p.name : '—';
}
function leaderName() {
  return state.leaderId ? nameOf(state.leaderId) : '—';
}
function roomUrl() {
  return `${location.origin}/room/${session.code}`;
}
function waitingFor(predicate) {
  return state.players.filter((p) => !predicate(p)).map((p) => p.name);
}
function waitLine(names) {
  if (!names.length) return 'Everyone is ready';
  if (names.length <= 3) return `Waiting for ${names.join(', ')}`;
  return `Waiting for ${names.length} players`;
}

// ---------------------------------------------------------------- render

function render() {
  if (!session || !state) {
    hdrEl.hidden = true;
    screenEl.innerHTML = renderHome();
    focusFirstInput();
    return;
  }
  const inGame = state.phase !== 'lobby';
  hdrEl.hidden = !inGame;
  if (inGame) hdrEl.innerHTML = renderHeader();

  const views = {
    lobby: renderLobby,
    reveal: renderReveal,
    proposal: renderProposal,
    vote: renderVote,
    voteReveal: renderVoteReveal,
    quest: renderQuest,
    questReveal: renderQuestReveal,
    assassin: renderAssassin,
    end: renderEnd,
  };
  screenEl.innerHTML = (views[state.phase] || (() => '<p class="sub">…</p>'))();

  if (sheet) {
    sheetEl.hidden = false;
    sheetInner.innerHTML = sheet === 'role' ? renderRoleSheet() : renderHistorySheet();
  } else {
    sheetEl.hidden = true;
  }
}

function focusFirstInput() {
  const input = screenEl.querySelector('input[data-autofocus]');
  if (input && document.activeElement !== input) input.focus();
}

// ---- header ---------------------------------------------------------------

function renderHeader() {
  const track = state.track
    .map((q, i) => {
      const cls = [
        'qbox',
        q.result || '',
        i === state.questIndex && !['end', 'assassin'].includes(state.phase) ? 'now' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const mark = q.result === 'success' ? '✓' : q.result === 'fail' ? '✕' : q.size;
      return `<div class="${cls}">
        ${q.failsRequired > 1 ? '<i class="two">2 FAILS</i>' : ''}
        <b>${mark}</b><span>Q${i + 1}</span>
      </div>`;
    })
    .join('');

  const dots = Array.from({ length: state.maxRejects }, (_, i) => {
    const on = i < state.rejects;
    const last = i === state.maxRejects - 1;
    return `<div class="dot ${on ? 'on' : ''} ${last ? 'last' : ''}"></div>`;
  }).join('');

  const title =
    state.phase === 'end'
      ? 'Game over'
      : state.phase === 'assassin'
      ? 'The Assassin strikes'
      : `Quest ${state.questIndex + 1}`;
  const sub = state.phase === 'end' || state.phase === 'assassin' ? `Room ${state.code}` : `Leader · ${esc(leaderName())}`;

  return `<div class="hdr-top">
      <div class="hdr-quest">${title}<small>${sub}</small></div>
      <div class="hdr-btns">
        ${state.voteHistory.length ? '<button class="chip" data-act="sheet" data-v="history">History</button>' : ''}
        ${state.you.role ? '<button class="chip gold" data-act="sheet" data-v="role">My role</button>' : ''}
      </div>
    </div>
    <div class="track">${track}</div>
    <div class="rejrow"><em>Rejects</em><div class="dots">${dots}</div>
      <em style="margin-left:auto">${state.rejects}/${state.maxRejects}</em></div>`;
}

// ---- home -----------------------------------------------------------------

function renderHome() {
  const name = pendingName || lastName();
  const joining = !!pendingCode;
  return `<div class="center">
    <h1 class="brand"><span>The Resistance</span>Avalon</h1>
    <p class="sub">${
      joining
        ? `You've been invited to room <b>${esc(pendingCode)}</b>. Enter a name your friends will recognise.`
        : 'One phone each. No cards, no app store. 5–10 players.'
    }</p>

    <div class="field">
      <label for="nm">Your name</label>
      <input id="nm" data-autofocus maxlength="16" autocomplete="off" autocapitalize="words"
        placeholder="e.g. Sam" value="${esc(name)}">
    </div>

    ${
      joining
        ? `<button class="btn primary" data-act="join">Join room ${esc(pendingCode)}</button>
           <div class="divider">or</div>
           <button class="btn ghost small" data-act="newroom">Create a different room</button>`
        : `<button class="btn primary" data-act="create">Create a room</button>
           <div class="divider">or join one</div>
           <div class="field">
             <input id="cd" class="code" maxlength="4" autocomplete="off" autocapitalize="characters"
               placeholder="CODE" value="${esc(pendingCode)}">
           </div>
           <button class="btn" data-act="join">Join</button>`
    }
  </div>`;
}

// ---- lobby ----------------------------------------------------------------

function renderLobby() {
  const you = state.you;
  const n = state.playerCount;
  const rows = state.players
    .map(
      (p) => `<div class="prow ${p.connected ? '' : 'off'}">
        <span class="live ${p.connected ? '' : 'off'}"></span>
        <span class="nm">${esc(p.name)}${p.id === you.id ? ' <span style="color:var(--dim)">(you)</span>' : ''}</span>
        ${p.isHost ? '<span class="tag gold">Host</span>' : ''}
        ${
          you.isHost && p.id !== you.id
            ? `<button class="xbtn" data-act="kick" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button>`
            : ''
        }
      </div>`
    )
    .join('');

  const roleDefs = [
    ['percival', 'Percival', 'Good. Sees Merlin — and Morgana, if she is in play.'],
    ['morgana', 'Morgana', 'Evil. Appears as Merlin to Percival.'],
    ['mordred', 'Mordred', 'Evil. Invisible to Merlin.'],
    ['oberon', 'Oberon', 'Evil, but knows no allies and is known by none.'],
  ];
  const opts = roleDefs
    .map(
      ([key, label, desc]) => `<div class="opt">
        <div class="txt"><b>${label}</b><span>${desc}</span></div>
        <button class="sw ${state.options[key] ? 'on' : ''} ${you.isHost ? '' : 'locked'}"
          data-act="${you.isHost ? 'option' : 'noop'}" data-key="${key}" data-v="${state.options[key] ? '0' : '1'}"
          aria-label="${label}"></button>
      </div>`
    )
    .join('');

  const good = state.evilCount == null ? null : n - state.evilCount;

  return `<div class="card codebox">
      <div class="lbl">Room code</div>
      <div class="code">${esc(state.code)}</div>
      <div class="url">${esc(roomUrl())}</div>
    </div>
    <div class="btn-row">
      <button class="btn small primary" data-act="share">Share link</button>
      <button class="btn small" data-act="copy">Copy</button>
    </div>

    <div class="card">
      <h3>Players · ${n}/10${good != null ? ` &nbsp;·&nbsp; ${good} good, ${state.evilCount} evil` : ''}</h3>
      <div class="plist">${rows}</div>
    </div>

    <div class="card">
      <h3>Optional roles${you.isHost ? '' : ' · host controls these'}</h3>
      ${opts}
    </div>

    ${
      you.isHost
        ? `${state.startError ? `<div class="err">${esc(state.startError)}</div>` : ''}
           <button class="btn primary" data-act="start" ${state.startError ? 'disabled' : ''}>
             Start game${state.startError ? '' : ` · ${n} players`}
           </button>`
        : `<p class="note">${
            state.startError ? esc(state.startError) : 'Ready. Waiting for the host to start.'
          }</p>`
    }
    <button class="btn ghost small" data-act="leave">Leave room</button>`;
}

// ---- role reveal ----------------------------------------------------------

function roleCard() {
  const { role, knowledge } = state.you;
  if (!revealed) {
    return `<button class="rolecard hidden-state" data-act="toggleRole">
      <div class="eye">🛡️</div>
      <div class="rl">Your role</div>
      <div class="blurb">Make sure nobody is looking at your screen, then tap to reveal.</div>
    </button>`;
  }
  const kn = knowledge && (knowledge.names.length || knowledge.note)
    ? `<div class="knowledge">
        ${knowledge.title ? `<div class="kt">${esc(knowledge.title)}</div>` : ''}
        <div class="knames">${
          knowledge.names
            .map((nm) => `<span class="kname ${role.key === 'percival' ? 'mystery' : 'evil'}">${esc(nm)}</span>`)
            .join('')
        }</div>
        ${knowledge.note ? `<div class="knote">${esc(knowledge.note)}</div>` : ''}
      </div>`
    : '';
  return `<button class="rolecard" data-act="toggleRole">
      <div class="side ${role.side}">${role.side === 'good' ? 'Loyal to Arthur' : 'Servant of Mordred'}</div>
      <div class="rl">${esc(role.label)}</div>
      <div class="blurb">${esc(role.blurb)}</div>
      ${kn}
      <div class="knote">Tap to hide</div>
    </button>`;
}

function renderReveal() {
  const you = state.you;
  const waiting = waitingFor((p) => p.acked);
  return `${roleCard()}
    ${
      you.hasAcked
        ? `<p class="note">${esc(waitLine(waiting))} · ${state.acks.length}/${state.acksNeeded} ready</p>`
        : `<button class="btn primary" data-act="ack">Got it — I'm ready</button>
           <p class="note">${state.acks.length}/${state.acksNeeded} ready</p>`
    }
    ${you.isHost ? `<button class="btn ghost small" data-act="force">Begin the first quest</button>` : ''}`;
}

// ---- proposal -------------------------------------------------------------

function renderProposal() {
  const you = state.you;
  const size = state.teamSize;
  const needTwo = state.track[state.questIndex] && state.track[state.questIndex].failsRequired > 1;

  const rows = state.players
    .map(
      (p) => `<button class="prow ${p.onTeam ? 'sel' : ''} ${p.connected ? '' : 'off'}"
        data-act="${you.isLeader ? 'toggleTeam' : 'noop'}" data-id="${p.id}">
        <span class="nm">${esc(p.name)}</span>
        ${p.isLeader ? '<span class="tag gold">Leader</span>' : ''}
        ${p.onTeam ? '<span class="tag green">On quest</span>' : ''}
      </button>`
    )
    .join('');

  return `<div>
      <h2>${you.isLeader ? `Choose ${size} for the quest` : `${esc(leaderName())} is choosing`}</h2>
      <p class="sub">${ORD[state.questIndex]} quest · ${size} players${
    needTwo ? ' · <b style="color:var(--evil)">needs 2 fails</b>' : ''
  }</p>
    </div>
    <div class="plist">${rows}</div>
    ${
      you.isLeader
        ? `<div class="spacer"></div>
           <button class="btn primary" data-act="propose" ${state.team.length === size ? '' : 'disabled'}>
             ${state.team.length === size ? 'Put it to a vote' : `${state.team.length}/${size} chosen`}
           </button>`
        : `<p class="note">Everyone votes once the team is proposed.</p>`
    }`;
}

// ---- vote -----------------------------------------------------------------

function renderVote() {
  const you = state.you;
  const team = state.team.map((id) => esc(nameOf(id))).join(' · ');
  const waiting = waitingFor((p) => p.voted);

  if (you.hasVoted) {
    return `<div class="center">
      <div class="banner gold"><div class="big">Vote locked</div>
        <div class="small">Nobody sees it until everyone has voted.</div></div>
      <p class="note">${esc(waitLine(waiting))}</p>
      <p class="note">${state.players.length - waiting.length}/${state.players.length} voted</p>
    </div>`;
  }

  return `<div class="center">
    <div>
      <h2>${esc(leaderName())} proposes</h2>
      <p class="sub" style="font-size:19px;color:var(--text);font-weight:700;margin-top:6px">${team}</p>
    </div>
    <button class="btn good huge" data-act="vote" data-v="1">Approve</button>
    <button class="btn evil huge" data-act="vote" data-v="0">Reject</button>
    <p class="note">${state.rejects} of ${state.maxRejects} rejects used${
    state.rejects === state.maxRejects - 1 ? ' — one more and evil wins' : ''
  }</p>
  </div>`;
}

function renderVoteReveal() {
  const v = state.lastVote;
  if (!v) return '';
  const rows = v.votes
    .map(
      (x) => `<div class="prow">
        <span class="nm">${esc(x.name)}</span>
        <span class="tag ${x.approve ? 'green' : 'evil'}">${x.approve ? 'Approve' : 'Reject'}</span>
      </div>`
    )
    .join('');
  const waiting = waitingFor((p) => p.acked);
  return `<div class="banner ${v.approved ? 'ok' : 'bad'}">
      <div class="big">${v.approved ? 'Team approved' : 'Team rejected'}</div>
      <div class="small">${v.approvals} approve · ${v.rejections} reject</div>
    </div>
    <p class="note">${esc(v.team.map((id) => nameOf(id)).join(' · '))}</p>
    <div class="plist">${rows}</div>
    <div class="spacer"></div>
    ${
      !v.approved && state.rejects + 1 >= state.maxRejects
        ? '<p class="note warn">That was the fifth rejection. Evil wins.</p>'
        : ''
    }
    ${
      state.you.hasAcked
        ? `<p class="note">${esc(waitLine(waiting))} · ${state.acks.length}/${state.acksNeeded}</p>`
        : `<button class="btn primary" data-act="ack">Continue · ${state.acks.length}/${state.acksNeeded}</button>`
    }
    ${state.you.isHost ? '<button class="btn ghost small" data-act="force">Skip ahead</button>' : ''}`;
}

// ---- quest ----------------------------------------------------------------

function renderQuest() {
  const you = state.you;
  const names = state.team.map((id) => esc(nameOf(id))).join(' · ');
  const waiting = state.players.filter((p) => p.onTeam && !p.acted).map((p) => p.name);

  if (!you.onTeam) {
    return `<div class="center">
      <div>
        <h2>The quest is under way</h2>
        <p class="sub">${names}</p>
      </div>
      <div class="banner gold"><div class="big">${state.team.length - waiting.length}/${state.team.length}</div>
        <div class="small">cards played</div></div>
      <p class="note">${esc(waitLine(waiting))}</p>
    </div>`;
  }

  if (you.hasActed) {
    return `<div class="center">
      <div class="banner gold"><div class="big">Card played</div>
        <div class="small">Results are shuffled — nobody learns who played what.</div></div>
      <p class="note">${esc(waitLine(waiting))}</p>
    </div>`;
  }

  return `<div class="center">
    <div>
      <h2>You are on the quest</h2>
      <p class="sub">${names}</p>
    </div>
    <button class="btn good huge" data-act="quest" data-v="1">Success</button>
    <button class="btn evil huge" data-act="quest" data-v="0" ${you.canFail ? '' : 'disabled'}>Fail</button>
    <p class="note">${
      you.canFail
        ? 'Cards are shuffled before they are revealed.'
        : 'Loyal servants of Arthur must play Success.'
    }</p>
  </div>`;
}

function renderQuestReveal() {
  const q = state.lastQuest;
  if (!q) return '';
  const waiting = waitingFor((p) => p.acked);
  return `<div class="center">
    <div class="banner ${q.passed ? 'ok' : 'bad'}">
      <div class="big">Quest ${q.index + 1} ${q.passed ? 'succeeded' : 'failed'}</div>
      <div class="small">${q.needed > 1 ? `${q.needed} fails were required` : ''}</div>
    </div>
    <div class="tally">
      <div class="s"><b>${q.successes}</b><span>Success</span></div>
      <div class="f"><b>${q.fails}</b><span>Fail</span></div>
    </div>
    <p class="note">Cards were shuffled. Who played what stays secret.</p>
    <div class="spacer"></div>
    ${
      state.you.hasAcked
        ? `<p class="note">${esc(waitLine(waiting))} · ${state.acks.length}/${state.acksNeeded}</p>`
        : `<button class="btn primary" data-act="ack">Continue · ${state.acks.length}/${state.acksNeeded}</button>`
    }
    ${state.you.isHost ? '<button class="btn ghost small" data-act="force">Skip ahead</button>' : ''}
  </div>`;
}

// ---- assassin -------------------------------------------------------------

function renderAssassin() {
  const info = state.assassin || { isAssassin: false, candidates: [] };
  if (!info.isAssassin) {
    return `<div class="center">
      <div class="banner gold"><div class="big">Three quests succeeded</div>
        <div class="small">The Assassin is naming Merlin.</div></div>
      <p class="note">Say nothing that gives him away.</p>
    </div>`;
  }
  const rows = info.candidates
    .map(
      (c) => `<button class="prow ${assassinPick === c.id ? 'sel' : ''}" data-act="pick" data-id="${c.id}">
        <span class="nm">${esc(c.name)}</span>
      </button>`
    )
    .join('');
  return `<div>
      <h2>Name Merlin</h2>
      <p class="sub">Good has won three quests. Strike the right target and evil still takes the game.</p>
    </div>
    <div class="plist">${rows}</div>
    <div class="spacer"></div>
    <button class="btn evil" data-act="assassinate" ${assassinPick ? '' : 'disabled'}>
      ${assassinPick ? `Kill ${esc(nameOf(assassinPick))}` : 'Choose a target'}
    </button>`;
}

// ---- end ------------------------------------------------------------------

function renderEnd() {
  const e = state.end;
  const evilWon = e.winner === 'evil';
  const rows = state.players
    .map((p) => {
      const r = p.role || { label: '?', side: 'good' };
      const label = r.label === 'Loyal Servant of Arthur' ? 'Loyal Servant' : r.label;
      const marked = p.id === e.assassinTargetId ? '<span class="tag gold">Assassin’s mark</span>' : '';
      return `<div class="prow">
        <span class="nm">${esc(p.name)}</span>
        ${marked}
        <span class="tag ${r.side === 'evil' ? 'evil' : 'blue'}">${esc(label)}</span>
      </div>`;
    })
    .join('');

  return `<div class="banner ${evilWon ? 'bad' : 'ok'}">
      <div class="big">${evilWon ? 'Evil wins' : 'Good wins'}</div>
      <div class="small">${esc(e.reason || '')}</div>
    </div>
    <div class="card">
      <h3>Everyone's role</h3>
      <div class="plist">${rows}</div>
    </div>
    ${state.voteHistory.length ? '<button class="btn ghost small" data-act="sheet" data-v="history">See every vote</button>' : ''}
    <div class="spacer"></div>
    ${
      state.you.isHost
        ? '<button class="btn primary" data-act="reset">New round · same players</button>'
        : '<p class="note">Waiting for the host to deal a new round.</p>'
    }`;
}

// ---- sheets ---------------------------------------------------------------

function renderRoleSheet() {
  return `<h2>Your role</h2>${roleCard()}<button class="btn small" data-act="closeSheet">Close</button>`;
}

function renderHistorySheet() {
  const items = state.voteHistory
    .slice()
    .reverse()
    .map((h) => {
      const chips = h.votes
        .map((v) => `<span class="hv ${v.approve ? 'y' : 'n'}">${esc(v.name)}</span>`)
        .join('');
      return `<div class="hitem">
        <div class="hh"><span>Quest ${h.questIndex + 1} · proposal ${h.attempt}</span>
          <span style="color:${h.approved ? 'var(--green)' : 'var(--evil)'}">${h.approved ? 'Approved' : 'Rejected'}</span></div>
        <div class="ht">${esc(h.leader)} → ${esc(h.team.join(', '))}</div>
        <div class="hvotes">${chips}</div>
      </div>`;
    })
    .join('');
  const quests = state.track
    .map((q, i) =>
      q.result
        ? `<div class="hitem"><div class="hh"><span>Quest ${i + 1}</span>
            <span style="color:${q.result === 'success' ? 'var(--green)' : 'var(--evil)'}">${
            q.result === 'success' ? 'Succeeded' : 'Failed'
          }</span></div>
          <div class="ht">${q.size} players · ${q.fails} fail${q.fails === 1 ? '' : 's'}${
            q.failsRequired > 1 ? ` · needed ${q.failsRequired}` : ''
          }</div></div>`
        : ''
    )
    .join('');
  return `<h2>History</h2>
    ${quests ? `<div class="hist">${quests}</div>` : ''}
    <div class="hist">${items || '<p class="note">No votes yet.</p>'}</div>
    <button class="btn small" data-act="closeSheet">Close</button>`;
}

// ---------------------------------------------------------------- actions

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act_ = el.dataset.act;
  const id = el.dataset.id;
  const v = el.dataset.v;

  switch (act_) {
    case 'noop':
      return;

    case 'create':
      return doCreate();
    case 'join':
      return doJoin();
    case 'newroom':
      pendingName = nameInput();
      pendingCode = '';
      history.replaceState({}, '', '/');
      return render();

    case 'share': {
      const url = roomUrl();
      if (navigator.share) {
        try {
          await navigator.share({ title: 'Avalon', text: `Join my Avalon game — room ${session.code}`, url });
          return;
        } catch {
          return;
        }
      }
      return copy(url);
    }
    case 'copy':
      return copy(roomUrl());

    case 'option':
      return act({ type: 'setOption', key: el.dataset.key, value: v === '1' });
    case 'kick':
      return act({ type: 'kick', targetId: id });
    case 'start':
      return act({ type: 'start' });
    case 'ack':
      revealed = false;
      return act({ type: 'ack' });
    case 'force':
      return act({ type: 'forceContinue' });
    case 'toggleTeam':
      return act({ type: 'toggleTeamMember', targetId: id });
    case 'propose':
      return act({ type: 'proposeTeam' });
    case 'vote':
      return act({ type: 'vote', approve: v === '1' });
    case 'quest':
      return act({ type: 'questAction', success: v === '1' });
    case 'pick':
      assassinPick = assassinPick === id ? null : id;
      return render();
    case 'assassinate':
      if (!assassinPick) return;
      return act({ type: 'assassinate', targetId: assassinPick });
    case 'reset':
      revealed = false;
      assassinPick = null;
      return act({ type: 'reset' });

    case 'toggleRole':
      revealed = !revealed;
      return render();
    case 'sheet':
      sheet = v;
      if (v === 'role') revealed = false;
      return render();
    case 'closeSheet':
      sheet = null;
      revealed = false;
      return render();

    case 'leave':
      forget(session.code);
      if (stream) stream.close();
      session = null;
      state = null;
      pendingCode = '';
      history.replaceState({}, '', '/');
      return render();
  }
});

sheetEl.addEventListener('click', (ev) => {
  if (ev.target === sheetEl) {
    sheet = null;
    revealed = false;
    render();
  }
});

function nameInput() {
  const el = document.getElementById('nm');
  return el ? el.value.trim() : '';
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied');
  } catch {
    toast(text);
  }
}

async function doCreate() {
  const name = nameInput();
  if (!name) return toast('Enter a name first.');
  try {
    const data = await api('/api/create', { name });
    enter(data);
  } catch (err) {
    toast(err.message);
  }
}

async function doJoin() {
  const name = nameInput();
  const codeEl = document.getElementById('cd');
  const code = (pendingCode || (codeEl ? codeEl.value : '')).trim().toUpperCase();
  if (!name) return toast('Enter a name first.');
  if (!/^[A-Z]{4}$/.test(code)) return toast('Room codes are 4 letters.');
  try {
    const known = store(code);
    const data = await api('/api/join', { code, name, playerId: known ? known.playerId : undefined });
    enter(data);
  } catch (err) {
    pendingName = name;
    toast(err.message);
  }
}

function enter(data) {
  session = { code: data.code, playerId: data.playerId, name: data.name };
  saveStore(data.code, session);
  pendingCode = data.code;
  history.replaceState({}, '', `/room/${data.code}`);
  connect();
}

// ---------------------------------------------------------------- boot

async function boot() {
  const code = codeFromPath();
  if (code) {
    const known = store(code);
    if (known && known.playerId) {
      try {
        const data = await api('/api/join', { code, name: known.name, playerId: known.playerId });
        return enter(data);
      } catch {
        forget(code);
      }
    }
  }
  render();
}

// A phone that was locked mid-game comes back with a dead stream; nudge it.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session && stream && stream.readyState === 2) connect();
});

boot();
