// server.js — Remember That Dude (Sports Edition)
// Rounds: Basketball → Baseball → Football, 15 Qs each
// Each question: 3 × 10s sections (synopsis → stats/teams → photo)
// After each round: Deep Cut bonus (photo only + betting)

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const axios   = require('axios');
const path    = require('path');
const fs      = require('fs');

const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer, { cors: { origin: '*' } });
const rooms      = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─────────────────────────────────────────────
//  Data loading
// ─────────────────────────────────────────────
const rawBasketball  = require('./data/round2_career');
const rawCollege     = require('./data/round3_college');

// Build college lookup from round3 data to supplement basketball players
const nbaCollegeLookup = {};
rawCollege.forEach(p => { nbaCollegeLookup[p.name] = p.college; });

function adaptBasketball(p) {
  const accolades = [];
  if (p.allStars > 0) accolades.push(`${p.allStars}× NBA All-Star`);
  if (p.rings > 0)    accolades.push(`${p.rings}× NBA Champion`);
  return {
    id: p.id, sport: 'basketball', name: p.name, position: p.position,
    teams: p.teams || [], career: p.career,
    college: nbaCollegeLookup[p.name] || null,
    wiki: p.wiki,
    synopsis: p.hint || '',
    accolades,
    stats: { ppg: p.ppg, rpg: p.rpg, apg: p.apg, spg: p.spg, bpg: p.bpg, fgPct: p.fgPct },
    funFact: p.funFact || '',
  };
}

const basketballPlayers = rawBasketball.map(adaptBasketball);

function loadSport(filename) {
  const fp = path.join(__dirname, 'data', filename);
  if (!fs.existsSync(fp)) { console.warn(`⚠️  ${filename} not found yet`); return []; }
  return require(fp);
}
const baseballPlayers = loadSport('baseball_players.js');
const footballPlayers = loadSport('football_players.js');

const ROUNDS = [
  { sport: 'basketball', label: 'Hardwood',  icon: '🏀', players: basketballPlayers },
  { sport: 'baseball',   label: 'Diamond',   icon: '⚾', players: baseballPlayers   },
  { sport: 'football',   label: 'Gridiron',  icon: '🏈', players: footballPlayers   },
];

function getPool(round) { return ROUNDS[round - 1].players; }

// ─────────────────────────────────────────────
//  Image URLs — Sports Reference sites
// ─────────────────────────────────────────────
const BBREF_VER = '202106291';

function refId(name) {
  const parts = name.trim().split(/\s+/);
  while (parts.length > 1 && /^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(parts[parts.length - 1])) parts.pop();
  const first = parts[0].toLowerCase().replace(/[^a-z]/g, '');
  const last  = parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, '');
  return last.slice(0, 5) + first.slice(0, 2) + '01';
}

function refImageUrl(name, sport) {
  const id = refId(name);
  if (sport === 'basketball') return `https://www.basketball-reference.com/req/${BBREF_VER}/images/players/${id}.jpg`;
  if (sport === 'baseball')   return `https://img.baseball-reference.com/headshots/crop/${id}.jpg`;
  if (sport === 'football')   return `https://www.pro-football-reference.com/req/${BBREF_VER}/images/players/${id}.jpg`;
  return null;
}

// Wikipedia fallback when a reference site image 404s
async function fetchWikiImage(wiki) {
  try {
    const { data } = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: { action: 'query', titles: wiki, prop: 'pageimages', format: 'json', pithumbsize: 1200, redirects: '1' },
      headers: { 'User-Agent': 'RememberThatDude/1.0' },
      timeout: 8000,
    });
    for (const p of Object.values(data.query?.pages || {})) {
      if (p.thumbnail?.source) return p.thumbnail.source;
    }
  } catch {}
  return null;
}

// Resolve a confirmed working image URL for a player (used at game-start for deep cuts)
async function resolveImageUrl(name, sport, wiki) {
  const primary = refImageUrl(name, sport);
  try {
    const r = await axios.head(primary, {
      timeout: 4000,
      headers: { 'User-Agent': 'RememberThatDude/1.0' },
    });
    if (r.status === 200) return primary;
  } catch {}
  // BBRef 404 — try Wikipedia
  if (wiki) {
    const wikiUrl = await fetchWikiImage(wiki);
    if (wikiUrl) return wikiUrl;
  }
  return null;
}

app.post('/api/image/fallback', async (req, res) => {
  const { wiki } = req.body || {};
  if (!wiki) return res.json({ url: null });
  const url = await fetchWikiImage(wiki);
  res.json({ url: url || null });
});

// ─────────────────────────────────────────────
//  Fuzzy answer matching
// ─────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z]/g, '').replace(/(jr|sr|ii|iii|iv)$/, '');
}

function isCorrect(guess, playerName) {
  if (!guess || !playerName) return false;
  const g = norm(guess);
  if (!g) return false;
  const parts = playerName.trim().split(/\s+/);
  let last = parts[parts.length - 1];
  if (/^(jr|sr|ii|iii|iv)$/i.test(last) && parts.length > 1) last = parts[parts.length - 2];
  const lastN = norm(last);
  const fullN = norm(playerName);
  if (g === lastN || g === fullN) return true;
  const threshold = lastN.length <= 5 ? 1 : 2;
  return levenshtein(g, lastN) <= threshold || levenshtein(g, fullN) <= threshold;
}

// ─────────────────────────────────────────────
//  Scoring
// ─────────────────────────────────────────────
function calcScore(elapsedSec, streak) {
  const base = elapsedSec < 10 ? 500 : elapsedSec < 20 ? 300 : 150;
  const bonus = streak >= 10 ? 300 : streak >= 7 ? 200 : streak >= 5 ? 100 : streak >= 3 ? 50 : 0;
  return base + bonus;
}

// ─────────────────────────────────────────────
//  Player history — permanent, global across all sports
// ─────────────────────────────────────────────
const HISTORY_FILE = path.join(__dirname, 'player_history.json');

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return { used: [] }; }
}
function saveHistory(h) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(h)); } catch {}
}

app.post('/api/reset-history', (req, res) => {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify({ used: [] })); } catch {}
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
//  Nickname stripping — remove giveaway nickname references from clues
// ─────────────────────────────────────────────
function stripNicknames(text) {
  if (!text) return text;
  const qq = '(?:"[^"]*"|\'[^\']*\')';  // quoted string: "X" or 'X'
  let s = text;
  // "nicknamed 'X'" / "was nicknamed 'X'"
  s = s.replace(new RegExp('\\s*(?:was\\s+)?nicknamed\\s+' + qq, 'g'), '');
  // "known as 'X'" (only quoted — proper nickname, not "known as one of...")
  s = s.replace(new RegExp('\\s*(?:was\\s+)?known as\\s+' + qq, 'g'), '');
  // "earning/earned [him] the nickname 'X'"
  s = s.replace(new RegExp(',?\\s*earn(?:ing|ed)\\s+(?:him\\s+)?the\\s+nickname\\s+' + qq, 'g'), '');
  // Clean up artifacts: double spaces, orphaned em dashes at end
  s = s.replace(/\s{2,}/g, ' ').replace(/\s*—\s*$/, '').trim();
  return s;
}

// ─────────────────────────────────────────────
//  Synopsis truncation — keep to ~2 sentences / 220 chars
// ─────────────────────────────────────────────
function truncateSynopsis(text) {
  if (!text) return '';
  const sentences = text.match(/[^.!?]*[.!?]+/g) || [];
  if (sentences.length <= 2) return text.trim();
  return (sentences[0] + sentences[1]).trim();
}

// ─────────────────────────────────────────────
//  Question building
// ─────────────────────────────────────────────
function buildQuestions(pool, count, usedInGame, usedEverSet) {
  const fresh = pool
    .filter(p => !usedEverSet.has(p.name) && !usedInGame.has(p.name))
    .sort(() => Math.random() - 0.5);
  const selected = fresh.slice(0, count);
  if (selected.length < count) {
    // Pool exhausted — reuse least-recently-used (excluding current game picks)
    const seen = pool
      .filter(p => !usedInGame.has(p.name) && !fresh.some(f => f.name === p.name))
      .sort(() => Math.random() - 0.5);
    selected.push(...seen.slice(0, count - selected.length));
  }
  return selected.slice(0, count);
}

// ─────────────────────────────────────────────
//  Room helpers
// ─────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function makePlayer(id, name, isHost) {
  return { id, name, isHost, score: 0, roundScores: [0, 0, 0], streak: 0 };
}

function makeRoom(code) {
  return {
    code, status: 'lobby',
    players: new Map(),
    round: 0, questionIdx: 0,
    questions: {},   // { 1: [...15], 2: [...15], 3: [...15] }
    deepCuts: {},    // { 1: player, 2: player, 3: player }
    answers: new Map(),
    bets: new Map(),
    bettingActive: false,
    timer: null, phaseStart: 0, questionStart: 0,
    paused: false, pauseRemaining: 0,
    readyPeers: new Set(),
    // Powers
    blockingOpen: false,
    pendingBlocks: new Set(),
    pendingFreezes: new Map(),     // targetId -> attackerId
    pendingShields: new Set(),
    pendingSnitches: new Map(),    // snitcherId -> targetId
    pendingDoubleDowns: new Set(),
    frozenPlayers: new Set(),      // active during current question
    activeSnitches: new Map(),     // snitcherId -> targetId during question
    activeDoubleDowns: new Set(),  // active during current question
    usedPowersRound: new Map(),    // socketId -> Set<powerName>
    usedDoubleDownGame: new Set(), // socketId (once per game)
  };
}

function getRoom(socket) {
  return rooms.get(socket.data?.roomCode);
}

function broadcastLobby(code) {
  const room = rooms.get(code);
  if (!room) return;
  const players = [...room.players.values()].map(p => ({ id: p.id, name: p.name, isHost: p.isHost }));
  io.to(code).emit('lobby_update', { players, roomCode: code });
}

// ─────────────────────────────────────────────
//  Game flow
// ─────────────────────────────────────────────
function startRound(code, round) {
  const room = rooms.get(code);
  if (!room) return;
  room.round = round;
  room.questionIdx = 0;
  room.status = 'round_intro';
  room.blockingOpen = false;
  room.pendingBlocks = new Set();
  room.pendingFreezes = new Map();
  room.pendingShields = new Set();
  room.pendingSnitches = new Map();
  room.pendingDoubleDowns = new Set();
  room.frozenPlayers = new Set();
  room.activeSnitches = new Map();
  room.activeDoubleDowns = new Set();
  room.usedPowersRound = new Map();
  clearTimeout(room.timer);

  const { sport, label, icon } = ROUNDS[round - 1];
  io.to(code).emit('round_intro', { round, totalRounds: 3, sport, label, icon });
  room.timer = setTimeout(() => startQuestion(code), 5000);
}

function questionPayload(room) {
  const q = room.questions[room.round][room.questionIdx];
  const sport = ROUNDS[room.round - 1].sport;
  const nameParts = q.name.trim().split(/\s+/).filter(w => !/^(jr\.?|sr\.?|ii|iii|iv)$/i.test(w));
  return {
    questionNumber: room.questionIdx + 1,
    totalQuestions: 15,
    round: room.round,
    sport,
    isDeepCut: false,
    // Section 1 — visible immediately
    synopsis: truncateSynopsis(stripNicknames(q.synopsis || '')),
    // Section 2 — revealed at 10s
    nameLengths: nameParts.map(w => w.replace(/\./g, '').length),
    teams: q.teams || [],
    college: q.college || null,
    accolades: q.accolades || [],
    stats: q.stats || {},
    position: q.position || '',
    career: q.career || '',
    // Section 3 — revealed at 20s
    imageUrl: q._imageUrl || refImageUrl(q.name, sport),
    wikiTitle: q.wiki || null,
    nameFirstLetters: nameParts.map(w => w[0].toUpperCase()),
  };
}

function getLeader(room) {
  const sorted = [...room.players.values()].sort((a, b) => b.score - a.score);
  if (sorted.length < 2) return null;
  return sorted[0].score > sorted[1].score ? sorted[0] : null;
}

function startQuestion(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.questionIdx >= 15) { doRoundEnd(code); return; }

  room.status = 'question';
  room.answers = new Map();
  room.questionStart = Date.now();
  room.phaseStart = Date.now();
  room.blockingOpen = false;

  const leader = getLeader(room);

  // 1. Shields: cancel blocks/freezes targeting shielded players
  room.pendingShields.forEach(shieldId => {
    if (leader && leader.id === shieldId) room.pendingBlocks.clear();
    room.pendingFreezes.delete(shieldId);
    io.to(shieldId).emit('shield_activated');
  });
  room.pendingShields = new Set();

  // 2. Blocks: resolve clue suppression on leader
  const blockCount = Math.min(room.pendingBlocks.size, 3);
  if (blockCount > 0 && leader) {
    io.to(code).emit('block_reveal', { blockCount, leaderName: leader.name, leaderId: leader.id });
  }
  room.pendingBlocks = new Set();

  // 3. Freezes: notify targets
  room.frozenPlayers = new Set();
  room.pendingFreezes.forEach((attackerId, targetId) => {
    room.frozenPlayers.add(targetId);
    io.to(targetId).emit('you_are_frozen');
  });
  room.pendingFreezes = new Map();

  // 4. Snitches: activate for this question
  room.activeSnitches = new Map();
  room.pendingSnitches.forEach((targetId, snitcherId) => {
    room.activeSnitches.set(snitcherId, targetId);
  });
  room.pendingSnitches = new Map();

  // 5. Double Downs: activate for this question
  room.activeDoubleDowns = new Set(room.pendingDoubleDowns);
  room.pendingDoubleDowns = new Set();

  io.to(code).emit('question_start', questionPayload(room));
  room.timer = setTimeout(() => doReveal(code), 30000); // 3 × 10s
}

function doReveal(code) {
  const room = rooms.get(code);
  if (!room || room.status === 'reveal') return;
  room.status = 'reveal';
  room.phaseStart = Date.now();

  const q = room.questions[room.round][room.questionIdx];
  const sport = ROUNDS[room.round - 1].sport;
  const playerResults = [];

  room.players.forEach((player, id) => {
    const ans = room.answers.get(id);
    const isDoubleDown = room.activeDoubleDowns.has(id);
    let points = 0;
    if (ans?.correct) {
      player.streak++;
      points = calcScore(ans.elapsed, player.streak);
      if (isDoubleDown) points *= 2;
    } else {
      player.streak = 0;
    }
    player.score = Math.max(0, player.score + points);
    player.roundScores[room.round - 1] += points;
    playerResults.push({
      id, name: player.name,
      answer: ans?.answer || null,
      correct: ans?.correct || false,
      points, totalScore: player.score, streak: player.streak,
      elapsed: ans ? Math.round(ans.elapsed * 10) / 10 : null,
      section: ans ? (ans.elapsed < 10 ? 1 : ans.elapsed < 20 ? 2 : 3) : null,
      doubledDown: isDoubleDown && (ans?.correct || false),
    });
  });
  room.activeDoubleDowns = new Set();

  playerResults.sort((a, b) => b.totalScore - a.totalScore);

  io.to(code).emit('answer_reveal', {
    correctAnswer: q.name,
    funFact: q.funFact || '',
    imageUrl: q._imageUrl || refImageUrl(q.name, sport),
    wikiTitle: q.wiki || null,
    playerResults,
  });

  // Open power window for the next question (not after the last question)
  if (room.questionIdx < 14) {
    const powerLeader = getLeader(room);
    room.blockingOpen = true;
    room.pendingBlocks = new Set();
    room.pendingFreezes = new Map();
    room.pendingShields = new Set();
    room.pendingSnitches = new Map();
    room.pendingDoubleDowns = new Set();
    const players = [...room.players.values()].map(p => ({ id: p.id, name: p.name }));
    io.to(code).emit('power_window_open', {
      leaderId: powerLeader?.id || null,
      leaderName: powerLeader?.name || null,
      players,
    });
  }

  room.timer = setTimeout(() => {
    room.questionIdx++;
    if (room.questionIdx >= 15) doRoundEnd(code);
    else startQuestion(code);
  }, 15000);
}

function doRoundEnd(code) {
  const room = rooms.get(code);
  if (!room) return;
  room.status = 'round_end';

  const standings = [...room.players.values()]
    .map(p => ({ id: p.id, name: p.name, score: p.score, roundScore: p.roundScores[room.round - 1] }))
    .sort((a, b) => b.score - a.score);

  const mvp = standings.reduce((best, p) => (!best || p.roundScore > best.roundScore) ? p : best, null);

  io.to(code).emit('round_end', {
    round: room.round, sport: ROUNDS[room.round - 1].sport,
    label: ROUNDS[room.round - 1].label, standings, mvp: mvp?.name,
  });

  room.timer = setTimeout(() => startDeepCutBetting(code), 8000);
}

function startDeepCutBetting(code) {
  const room = rooms.get(code);
  if (!room) return;

  const dc = room.deepCuts[room.round];
  if (!dc) { advanceRound(code); return; }

  room.status = 'deep_cut_betting';
  room.bets = new Map();
  room.bettingActive = true;

  const scores = {};
  room.players.forEach((p, id) => { scores[id] = p.score; });

  io.to(code).emit('deep_cut_betting', {
    round: room.round,
    sport: ROUNDS[room.round - 1].sport,
    scores,
  });

  room.timer = setTimeout(() => {
    room.bettingActive = false;
    io.to(code).emit('betting_end', {});
    startDeepCutQuestion(code);
  }, 15000);
}

function startDeepCutQuestion(code) {
  const room = rooms.get(code);
  if (!room) return;

  const dc = room.deepCuts[room.round];
  const sport = ROUNDS[room.round - 1].sport;

  room.status = 'deep_cut_question';
  room.answers = new Map();
  room.questionStart = Date.now();

  io.to(code).emit('deep_cut_start', {
    round: room.round, sport,
    imageUrl: dc._imageUrl || refImageUrl(dc.name, sport),
    wikiTitle: dc.wiki || null,
  });

  room.timer = setTimeout(() => doDeepCutReveal(code), 30000);
}

function doDeepCutReveal(code) {
  const room = rooms.get(code);
  if (!room) return;
  room.status = 'deep_cut_reveal';

  const dc = room.deepCuts[room.round];
  const sport = ROUNDS[room.round - 1].sport;
  const playerResults = [];

  room.players.forEach((player, id) => {
    const ans = room.answers.get(id);
    const correct = ans?.correct || false;
    const bet = room.bets.get(id) || 0;
    const betChange = bet > 0 ? (correct ? bet : -bet) : 0;
    player.score = Math.max(0, player.score + betChange);

    playerResults.push({
      id, name: player.name,
      answer: ans?.answer || null,
      correct, betChange, totalScore: player.score,
    });
  });

  playerResults.sort((a, b) => b.totalScore - a.totalScore);

  io.to(code).emit('deep_cut_reveal', {
    correctAnswer: dc.name,
    funFact: dc.funFact || '',
    imageUrl: dc._imageUrl || refImageUrl(dc.name, sport),
    wikiTitle: dc.wiki || null,
    playerResults,
  });

  room.timer = setTimeout(() => advanceRound(code), 15000);
}

function advanceRound(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.round < 3) startRound(code, room.round + 1);
  else doGameEnd(code);
}

function doGameEnd(code) {
  const room = rooms.get(code);
  if (!room) return;
  room.status = 'game_end';

  const standings = [...room.players.values()]
    .map(p => ({ id: p.id, name: p.name, totalScore: p.score, roundScores: p.roundScores }))
    .sort((a, b) => b.totalScore - a.totalScore);

  io.to(code).emit('game_end', { standings });
  room.timer = setTimeout(() => rooms.delete(code), 30 * 60 * 1000);
}

// ─────────────────────────────────────────────
//  Socket handlers
// ─────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('create_room', ({ playerName }) => {
    if (!playerName?.trim()) return;
    let code;
    do { code = generateCode(); } while (rooms.has(code));
    const room = makeRoom(code);
    room.players.set(socket.id, makePlayer(socket.id, playerName.trim(), true));
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_created', { roomCode: code });
    broadcastLobby(code);
  });

  socket.on('join_room', ({ playerName, roomCode }) => {
    const code = (roomCode || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit('error', { message: 'Room not found. Check your code!' });
    if (room.status !== 'lobby') return socket.emit('error', { message: 'Game is already in progress.' });
    if (room.players.size >= 12) return socket.emit('error', { message: 'Room is full (max 12).' });
    room.players.set(socket.id, makePlayer(socket.id, playerName.trim(), false));
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_joined', { roomCode: code });
    broadcastLobby(code);
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket);
    if (!room) return;
    room.readyPeers.delete(socket.id);
    room.pendingBlocks.delete(socket.id);
    room.pendingShields.delete(socket.id);
    room.pendingDoubleDowns.delete(socket.id);
    room.frozenPlayers.delete(socket.id);
    room.activeDoubleDowns.delete(socket.id);
    room.usedPowersRound.delete(socket.id);
    room.usedDoubleDownGame.delete(socket.id);
    room.pendingFreezes.delete(socket.id);
    room.pendingFreezes.forEach((attackerId, targetId) => { if (attackerId === socket.id) room.pendingFreezes.delete(targetId); });
    room.activeSnitches.delete(socket.id);
    room.pendingSnitches.delete(socket.id);
    room.pendingSnitches.forEach((targetId, snitcherId) => { if (targetId === socket.id) room.pendingSnitches.delete(snitcherId); });
    room.players.delete(socket.id);
    if (room.players.size === 0) {
      clearTimeout(room.timer);
      rooms.delete(room.code);
      return;
    }
    // Pass host if host left
    if (!room.players.has(room.hostId || '')) {
      const next = room.players.values().next().value;
      if (next) { next.isHost = true; room.hostId = next.id; }
    }
    broadcastLobby(room.code);
  });

  async function handleStartGame(socket, startAtRound = 1) {
    const room = getRoom(socket);
    if (!room || room.status !== 'lobby') return;
    if (!room.players.get(socket.id)?.isHost) return;

    room.status = 'loading';
    io.to(room.code).emit('game_loading', {});

    const history = loadHistory();
    const usedEverSet = new Set(history.used || []);
    const usedInGame = new Set();

    for (let r = 1; r <= 3; r++) {
      const pool = getPool(r);
      const questions = buildQuestions(pool, 15, usedInGame, usedEverSet);
      room.questions[r] = questions;
      questions.forEach(q => usedInGame.add(q.name));

      // Pre-resolve question images in parallel so clients get working URLs
      const sport = ROUNDS[r - 1].sport;
      await Promise.allSettled(questions.map(async q => {
        const url = await resolveImageUrl(q.name, sport, q.wiki);
        if (url) q._imageUrl = url;
      }));

      // Deep cut: prefer deepCut:true players, verify image works before committing
      const remaining = pool.filter(p => !usedInGame.has(p.name)).sort(() => Math.random() - 0.5);
      const deepCutPool = remaining.filter(p => p.deepCut === true);
      const candidates = (deepCutPool.length > 0 ? deepCutPool : remaining).slice(0, 5);
      let chosen = null;
      for (const candidate of candidates) {
        const imgUrl = await resolveImageUrl(candidate.name, sport, candidate.wiki);
        if (imgUrl) {
          chosen = { ...candidate, _imageUrl: imgUrl };
          break;
        }
      }
      // Last resort: pick first candidate even if image unresolved
      room.deepCuts[r] = chosen || candidates[0] || null;
      if (room.deepCuts[r]) usedInGame.add(room.deepCuts[r].name);
    }

    history.used = [...new Set([...usedEverSet, ...usedInGame])];
    saveHistory(history);

    startRound(room.code, Math.max(1, Math.min(3, startAtRound)));
  }

  socket.on('start_game',          () => handleStartGame(socket, 1));
  socket.on('start_game_at_round', ({ round }) => handleStartGame(socket, round));

  socket.on('submit_answer', ({ answer }) => {
    const room = getRoom(socket);
    if (!room) return;
    const isDeepCut = room.status === 'deep_cut_question';
    if (!['question', 'deep_cut_question'].includes(room.status)) return;
    if (room.answers.has(socket.id)) return;
    if (room.frozenPlayers.has(socket.id)) return;

    const q = isDeepCut
      ? room.deepCuts[room.round]
      : room.questions[room.round][room.questionIdx];
    if (!q) return;

    const elapsed = (Date.now() - room.questionStart) / 1000;
    const correct = isCorrect(answer, q.name);

    room.answers.set(socket.id, { answer: answer?.slice(0, 60), elapsed, correct });
    socket.emit('answer_feedback', { correct, correctAnswer: correct ? q.name : null });
    io.to(room.code).emit('player_answered', {
      answeredCount: room.answers.size,
      totalPlayers: room.players.size,
    });

    if (room.answers.size >= room.players.size) {
      clearTimeout(room.timer);
      if (isDeepCut) doDeepCutReveal(room.code);
      else doReveal(room.code);
    }
  });

  socket.on('submit_bet', ({ pct }) => {
    const room = getRoom(socket);
    if (!room || !room.bettingActive) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    const validPcts = [0.05, 0.10, 0.15, 0.20, 0.25];
    const safePct = validPcts.includes(Number(pct)) ? Number(pct) : 0;
    const bet = Math.floor(player.score * safePct);
    room.bets.set(socket.id, bet);
    socket.emit('bet_confirmed', { amount: bet, pct: safePct });

    if (room.bets.size >= room.players.size) {
      clearTimeout(room.timer);
      room.bettingActive = false;
      io.to(room.code).emit('betting_end', {});
      startDeepCutQuestion(room.code);
    }
  });

  socket.on('pause_game', () => {
    const room = getRoom(socket);
    if (!room || room.paused) return;
    if (!room.players.get(socket.id)?.isHost) return;
    if (!['question', 'reveal', 'deep_cut_question'].includes(room.status)) return;

    clearTimeout(room.timer);
    const duration = room.status === 'reveal' ? 15000 : 30000;
    const elapsed = Date.now() - room.phaseStart;
    room.pauseRemaining = Math.max(1000, duration - elapsed);
    room.paused = true;

    io.to(room.code).emit('game_paused', { remainingSeconds: Math.ceil(room.pauseRemaining / 1000) });
  });

  socket.on('resume_game', () => {
    const room = getRoom(socket);
    if (!room || !room.paused) return;
    if (!room.players.get(socket.id)?.isHost) return;
    room.paused = false;
    room.phaseStart = Date.now();

    io.to(room.code).emit('game_resumed', {});

    const remaining = room.pauseRemaining;
    if (room.status === 'reveal') {
      room.timer = setTimeout(() => {
        room.questionIdx++;
        if (room.questionIdx >= 15) doRoundEnd(room.code);
        else startQuestion(room.code);
      }, remaining);
    } else {
      room.timer = setTimeout(() => {
        if (room.status === 'deep_cut_question') doDeepCutReveal(room.code);
        else doReveal(room.code);
      }, remaining);
    }
  });

  // ── Power system ──────────────────────────────────────────────────────────
  socket.on('use_power', ({ power, targetId }) => {
    const room = getRoom(socket);
    if (!room || !room.blockingOpen) return;

    const used = room.usedPowersRound.get(socket.id) || new Set();
    if (power === 'doubledown') {
      if (room.usedDoubleDownGame.has(socket.id)) return;
    } else {
      if (used.has(power)) return;
    }

    const leader = getLeader(room);
    let targetName = null;

    switch (power) {
      case 'block':
        if (!leader || socket.id === leader.id) return;
        room.pendingBlocks.add(socket.id);
        break;
      case 'freeze':
        if (!targetId || socket.id === targetId || !room.players.has(targetId)) return;
        if (room.pendingFreezes.has(targetId)) return;
        room.pendingFreezes.set(targetId, socket.id);
        targetName = room.players.get(targetId).name;
        break;
      case 'shield':
        room.pendingShields.add(socket.id);
        break;
      case 'snitch':
        if (!targetId || socket.id === targetId || !room.players.has(targetId)) return;
        room.pendingSnitches.set(socket.id, targetId);
        targetName = room.players.get(targetId).name;
        break;
      case 'doubledown':
        room.pendingDoubleDowns.add(socket.id);
        room.usedDoubleDownGame.add(socket.id);
        break;
      default:
        return;
    }

    used.add(power);
    room.usedPowersRound.set(socket.id, used);
    socket.emit('power_confirmed', { power, targetName });
  });

  socket.on('snitch_typing', ({ text }) => {
    const room = getRoom(socket);
    if (!room || room.status !== 'question') return;
    room.activeSnitches.forEach((targetId, snitcherId) => {
      if (targetId === socket.id) {
        const player = room.players.get(socket.id);
        io.to(snitcherId).emit('snitch_update', {
          targetName: player?.name || '?',
          text: (text || '').slice(0, 60),
        });
      }
    });
  });

  // ── WebRTC signaling relay ─────────────────────────────────────────────────
  socket.on('rtc_ready', () => {
    const room = getRoom(socket);
    if (!room) return;
    const existing = [...room.readyPeers];
    socket.emit('rtc_existing_peers', { peers: existing });
    socket.to(room.code).emit('rtc_peer_ready', { peerId: socket.id });
    room.readyPeers.add(socket.id);
  });

  socket.on('rtc_offer', ({ to, offer }) => {
    io.to(to).emit('rtc_offer', { from: socket.id, offer });
  });

  socket.on('rtc_answer', ({ to, answer }) => {
    io.to(to).emit('rtc_answer', { from: socket.id, answer });
  });

  socket.on('rtc_ice', ({ to, candidate }) => {
    io.to(to).emit('rtc_ice', { from: socket.id, candidate });
  });

  socket.on('emoji_react', ({ emoji }) => {
    const room = getRoom(socket);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    io.to(room.code).emit('emoji_reaction', { emoji, name: player.name });
  });

  socket.on('play_again', () => {
    const room = getRoom(socket);
    if (!room || room.status !== 'game_end') return;
    if (!room.players.get(socket.id)?.isHost) return;
    room.players.forEach(p => {
      p.score = 0; p.roundScores = [0, 0, 0]; p.streak = 0;
    });
    room.questions = {}; room.deepCuts = {};
    room.blockingOpen = false;
    room.pendingBlocks = new Set();
    room.pendingFreezes = new Map();
    room.pendingShields = new Set();
    room.pendingSnitches = new Map();
    room.pendingDoubleDowns = new Set();
    room.frozenPlayers = new Set();
    room.activeSnitches = new Map();
    room.activeDoubleDowns = new Set();
    room.usedPowersRound = new Map();
    room.usedDoubleDownGame = new Set();
    room.status = 'lobby';
    broadcastLobby(room.code);
  });
});

// ─────────────────────────────────────────────
//  Debug endpoint
// ─────────────────────────────────────────────
app.get('/api/debug/pools', (req, res) => {
  res.json({
    basketball: basketballPlayers.length,
    baseball: baseballPlayers.length,
    football: footballPlayers.length,
    history: (loadHistory().used || []).length,
  });
});

// ─────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🏀⚾🏈  Remember That Dude running on http://localhost:${PORT}`);
  ROUNDS.forEach(r => console.log(`  ${r.icon} ${r.label}: ${r.players.length} players`));
});
