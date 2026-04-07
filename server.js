const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const NodeCache = require('node-cache');
const path = require('path');
const fs = require('fs');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });
const imgCache = new NodeCache({ stdTTL: 86400 });
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

// Persist image URLs to disk so Bing is only scraped once per player ever
const IMAGE_CACHE_FILE = path.join(__dirname, 'image_cache.json');
function loadImageCacheDisk() {
  try { return JSON.parse(fs.readFileSync(IMAGE_CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveImageCacheDisk() {
  const dump = {};
  imgCache.keys().forEach(k => { const v = imgCache.get(k); if (v) dump[k] = v; });
  try { fs.writeFileSync(IMAGE_CACHE_FILE, JSON.stringify(dump)); } catch {}
}
// Pre-populate in-memory cache from disk on startup
Object.entries(loadImageCacheDisk()).forEach(([k, v]) => imgCache.set(k, v));
console.log(`Loaded ${imgCache.keys().length} cached image URLs from disk`);

// Load data
const hardPlayers = require('./data/round1_nba_hard');
const careerPlayers = require('./data/round2_career');
const zoomPlayers = require('./data/round3_zoomin');

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

function normalizeName(s) {
  return (s || '').toLowerCase()
    .replace(/[^a-z]/g, '') // strip everything non-letter
    .replace(/(jr|sr|ii|iii|iv)$/, '');
}

function isCorrect(guess, playerName) {
  if (!guess || !playerName) return false;
  const guessNorm = normalizeName(guess);
  if (!guessNorm) return false;

  // Get last name (skip Jr/Sr/II etc.)
  const parts = playerName.trim().split(/\s+/);
  let lastName = parts[parts.length - 1];
  if (/^(jr|sr|ii|iii|iv)$/i.test(lastName) && parts.length > 1) {
    lastName = parts[parts.length - 2];
  }
  const lastNorm = normalizeName(lastName);
  const fullNorm = normalizeName(playerName);

  // Exact match
  if (guessNorm === lastNorm || guessNorm === fullNorm) return true;

  // Fuzzy threshold: short names allow 1 edit, longer names allow 2-3
  const threshold = lastNorm.length <= 4 ? 1 : lastNorm.length <= 6 ? 2 : lastNorm.length <= 9 ? 3 : 4;
  if (levenshtein(guessNorm, lastNorm) <= threshold) return true;
  // Also check full name (no spaces)
  if (levenshtein(guessNorm, fullNorm) <= threshold + 1) return true;

  return false;
}

// ─────────────────────────────────────────────
//  Image fetching — Bing scrape (no key needed) → Wikipedia fallback
// ─────────────────────────────────────────────
const BING_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9'
};

// Known sports photo agencies — clean in-game action shots, no overlays
const SPORTS_SITES = ['gettyimages', 'alamy', 'usatsi', 'nbae', 'ap.org',
                      'si.com', 'imagn', 'shutterstock', 'wireimage', 'sports-reference'];
const SKIP_SITES   = ['wikipedia', 'wikimedia', 'imdb', 'twitter', 'facebook', 'instagram',
                      'ebay', 'ebayimg', 'beckett', 'cardboard', 'panini', 'topps',
                      'pinterest', 'pinimg', 'tumblr', 'reddit', 'comc.com', 'pwcc',
                      'goldin', 'lelands', 'sportscollect', 'dacardworld', 'blowoutcards',
                      'fleer', 'skybox', 'donruss', 'upperdeck', 'amazon', 'walmart',
                      'target.com', 'fanatics', 'nbastore', 'jerseyshoppe', 'yimg',
                      'ecrater', 'mercari', 'etsy', 'redbubble', 'teepublic'];

function isBadImage(url) {
  const lower = url.toLowerCase();
  if (SKIP_SITES.some(s => lower.includes(s))) return true;
  if (lower.includes('headshot')) return true;
  if (/ar_16.9|ar_3.2|ar_2.1/.test(lower)) return true;
  // Must be a real photo format — eliminates icons, SVGs, animated GIFs
  if (!/\.(jpg|jpeg|png)(\?|$)/i.test(url)) return true;
  // Skip obvious icon/logo/placeholder paths
  if (/\/icon|\/logo|placeholder|\/default[-_]|noimage|no[-_]photo|silhouette/i.test(url)) return true;
  return false;
}

async function fetchBingScrapedImage(player) {
  const team = player.team ? player.team.split(' ').slice(-1)[0] : '';
  // Negative keywords knock out trading cards and labeled graphics at the search level
  const query = `"${player.name}" ${team} NBA -card -"trading card" -rookie -topps -panini -fleer -skybox -donruss`.trim();
  try {
    const { data } = await axios.get('https://www.bing.com/images/search', {
      params: {
        q: query,
        form: 'HDRSC2',
        qft: '+filterui:photo-photo+filterui:aspect-tall'  // photos only, portrait orientation
      },
      headers: BING_HEADERS,
      timeout: 10000
    });

    // Bing encodes JSON with HTML entities (&quot; instead of ")
    // Use murl = original full-res image, not turl = small Bing thumbnail
    const murls = [...data.matchAll(/&quot;murl&quot;:&quot;(https?:[^&"]+)&quot;/g)]
      .map(m => m[1])
      .filter(url => !isBadImage(url));

    if (!murls.length) return null;

    // 1st choice: a sports photo agency image (skip index 0 / knowledge panel)
    const actionShot = murls.find((url, i) =>
      i > 0 && SPORTS_SITES.some(s => url.includes(s))
    );
    if (actionShot) return actionShot;

    // 2nd choice: any clean image beyond index 0
    return murls[1] || murls[0] || null;

  } catch (err) {
    console.error(`Bing scrape error for ${player.name}:`, err.message);
  }
  return null;
}

async function fetchWikipediaImages(wikis) {
  for (let i = 0; i < wikis.length; i += 50) {
    const batch = wikis.slice(i, i + 50);
    try {
      const { data } = await axios.get('https://en.wikipedia.org/w/api.php', {
        params: { action: 'query', titles: batch.join('|'), prop: 'pageimages', format: 'json', pithumbsize: 800, redirects: '1' },
        headers: { 'User-Agent': 'NameThatBaller/2.0 (basketball-trivia-game)' },
        timeout: 15000
      });
      const { pages, redirects = [] } = data.query || {};
      if (!pages) continue;
      const map = {};
      Object.values(pages).forEach(p => {
        if (p.thumbnail?.source) map[p.title.replace(/ /g, '_')] = p.thumbnail.source;
      });
      redirects.forEach(r => {
        const fk = r.from.replace(/ /g, '_'), tk = r.to.replace(/ /g, '_');
        if (map[tk]) map[fk] = map[tk];
      });
      batch.forEach(t => imgCache.set(t, map[t] || ''));
    } catch (err) {
      console.error('Wikipedia image fetch error:', err.message);
      batch.forEach(t => imgCache.set(t, ''));
    }
  }
}

async function prefetchImages(players) {
  const wikiToPlayer = {};
  players.forEach(p => { if (p.wiki) wikiToPlayer[p.wiki] = p; });

  const titles = [...new Set(players.map(p => p.wiki).filter(Boolean))];
  const uncached = titles.filter(t => imgCache.get(t) === undefined);
  if (!uncached.length) return;

  console.log(`Fetching ${uncached.length} player images via Bing…`);

  // Bing scrape in small batches with a short delay to avoid rate limiting
  const wikiNeedingWikipedia = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < uncached.length; i += CONCURRENCY) {
    await Promise.all(uncached.slice(i, i + CONCURRENCY).map(async wiki => {
      const player = wikiToPlayer[wiki];
      const url = player ? await fetchBingScrapedImage(player) : null;
      if (url) {
        imgCache.set(wiki, url);
      } else {
        wikiNeedingWikipedia.push(wiki); // fall back to Wikipedia
      }
    }));
    if (i + CONCURRENCY < uncached.length) await new Promise(r => setTimeout(r, 300));
  }

  // Wikipedia fallback for any that Bing didn't return
  if (wikiNeedingWikipedia.length) {
    console.log(`Falling back to Wikipedia for ${wikiNeedingWikipedia.length} players`);
    await fetchWikipediaImages(wikiNeedingWikipedia);
  }

  // Persist newly fetched URLs to disk
  saveImageCacheDisk();
}

app.get('/api/image', async (req, res) => {
  const { wiki } = req.query;
  if (!wiki) return res.json({ url: null });
  let url = imgCache.get(wiki);
  if (url === undefined) {
    await prefetchImages([{ wiki }]);
    url = imgCache.get(wiki) || '';
  }
  res.json({ url: url || null });
});

// ─────────────────────────────────────────────
//  Round definitions
// ─────────────────────────────────────────────
const ROUNDS = [
  { type: 'photo',  name: 'Hard Ballers',  desc: 'Name the NBA player from their photo — these aren\'t the easy ones',       icon: '📸' },
  { type: 'stats',  name: 'Career Stats',  desc: 'Name the player from career statistics only — no photo',                    icon: '📊' },
  { type: 'zoomin', name: 'Face Time',     desc: 'Face first — name the player before the uniform is revealed for fewer points', icon: '👤' }
];

function getPool(round) {
  return [hardPlayers, careerPlayers, zoomPlayers][round - 1];
}

// ─────────────────────────────────────────────
//  Player history — avoids repeats across sessions
// ─────────────────────────────────────────────
const HISTORY_FILE = path.join(__dirname, 'player_history.json');

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return { r1: [], r2: [], r3: [] }; }
}

function saveHistory(history) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); }
  catch (err) { console.error('Failed to save player history:', err.message); }
}

function buildQuestions(round, count = 15, usedNames = new Set(), recentHistory = new Set()) {
  const pool = getPool(round);
  let candidates = [...pool]
    .sort(() => Math.random() - 0.5)
    .filter(p => !usedNames.has(p.name));

  if (round !== 2) {
    candidates = candidates.filter(p => {
      const url = imgCache.get(p.wiki);
      return url && url.length > 0;
    });
  }

  // Prefer players not seen in recent sessions
  const fresh = candidates.filter(p => !recentHistory.has(p.name));
  const source = fresh.length >= count ? fresh : candidates;
  if (fresh.length < count && candidates.length >= count) {
    console.log(`Round ${round}: pool cycling — only ${fresh.length} fresh players, reusing some`);
  }
  return source.slice(0, Math.min(count, source.length));
}

function calcScore(round, elapsedSec, streak) {
  let base;
  if (round === 1) {
    // Before hint (first 10s) = bonus
    base = elapsedSec < 10 ? 700 : 500;
  } else if (round === 3) {
    // Face-only phase (first 10s) = higher points
    base = elapsedSec < 10 ? 1000 : 500;
  } else {
    // Round 2: flat
    base = 500;
  }
  let streakBonus = 0;
  if (streak >= 10) streakBonus = 500;
  else if (streak >= 7)  streakBonus = 300;
  else if (streak >= 5)  streakBonus = 200;
  else if (streak >= 3)  streakBonus = 100;
  return base + streakBonus;
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}
const AVATARS = ['🏀','⛹️','🏆','🎯','🔥','⚡','🦁','🐯','🦅','🎱','👑','💪','🎰','🎳','🃏'];
function rndAvatar() { return AVATARS[Math.floor(Math.random() * AVATARS.length)]; }

function makePlayer(socketId, name, isHost) {
  return { id: socketId, name: name.slice(0, 24), score: 0, streak: 0, roundScores: [0,0,0], isHost, avatar: rndAvatar() };
}

function makeRoom(code) {
  return {
    code, status: 'lobby',
    players: new Map(), round: 0, questionIdx: 0,
    questions: [], allQuestions: {},
    answers: new Map(), questionStart: null, phaseStart: null,
    bets: new Map(), bettingActive: false,
    timer: null,
    paused: false, pauseRemaining: 0, pausedAt: null
  };
}

function getRoom(socket) { return rooms.get(socket.data.roomCode); }

function broadcastLobby(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('lobby_update', {
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, isHost: p.isHost, avatar: p.avatar })),
    roomCode: code
  });
}

// ─────────────────────────────────────────────
//  Socket.io
// ─────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Connected:', socket.id);

  socket.on('create_room', ({ playerName }) => {
    let code;
    let tries = 0;
    do { code = generateCode(); tries++; } while (rooms.has(code) && tries < 30);
    const room = makeRoom(code);
    room.players.set(socket.id, makePlayer(socket.id, playerName, true));
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_created', { roomCode: code });
    broadcastLobby(code);
  });

  socket.on('join_room', ({ playerName, roomCode }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room)                  return socket.emit('error', { message: 'Room not found. Check your code!' });
    if (room.status !== 'lobby') return socket.emit('error', { message: 'Game is already in progress.' });
    if (room.players.size >= 12) return socket.emit('error', { message: 'Room is full (max 12).' });
    room.players.set(socket.id, makePlayer(socket.id, playerName, false));
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_joined', { roomCode: code });
    broadcastLobby(code);
  });

  socket.on('start_game', async () => {
    const room = getRoom(socket);
    if (!room || room.status !== 'lobby') return;
    if (!room.players.get(socket.id)?.isHost) return;
    room.status = 'loading';
    io.to(room.code).emit('game_loading', {});
    // Prefetch images for photo rounds first, then filter questions by availability
    await prefetchImages([...hardPlayers, ...zoomPlayers]).catch(() => {});
    const history = loadHistory();
    const usedNames = new Set();
    for (let r = 1; r <= 3; r++) {
      const recentHistory = new Set(history['r' + r] || []);
      room.allQuestions[r] = buildQuestions(r, 15, usedNames, recentHistory);
      room.allQuestions[r].forEach(q => {
        usedNames.add(q.name);
        history['r' + r] = (history['r' + r] || []).concat(q.name);
      });
    }
    // Trim each round's history to pool.length - 15 so there are always fresh players next game
    [hardPlayers, careerPlayers, zoomPlayers].forEach((pool, i) => {
      const key = 'r' + (i + 1);
      const keep = Math.max(0, pool.length - 15);
      history[key] = (history[key] || []).slice(-keep);
    });
    saveHistory(history);
    startRound(room.code, 1);
  });

  socket.on('submit_answer', ({ answer }) => {
    const room = getRoom(socket);
    if (!room || room.status !== 'question') return;
    if (room.answers.has(socket.id)) return; // already answered

    const q = room.questions[room.questionIdx];
    const elapsed = (Date.now() - room.questionStart) / 1000;
    const correct = isCorrect(answer, q.name);

    room.answers.set(socket.id, { answer: answer?.slice(0, 60), elapsed, correct });

    // Private immediate feedback to this player
    socket.emit('answer_feedback', { correct, answer, correctAnswer: correct ? q.name : null });

    // Public: show that someone answered (not who or what)
    io.to(room.code).emit('player_answered', {
      answeredCount: room.answers.size,
      totalPlayers: room.players.size
    });

    // If everyone answered, reveal immediately
    if (room.answers.size >= room.players.size) {
      clearTimeout(room.timer);
      doReveal(room.code);
    }
  });

  socket.on('submit_bet', ({ amount }) => {
    const room = getRoom(socket);
    if (!room || !room.bettingActive) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const bet = Math.max(0, Math.min(Number(amount) || 0, player.score));
    room.bets.set(socket.id, bet);
    socket.emit('bet_confirmed', { amount: bet });

    // When all players have bet, start Q15 early
    if (room.bets.size >= room.players.size) {
      clearTimeout(room.timer);
      room.bettingActive = false;
      room.bets.set('_done', true); // sentinel so betting doesn't re-trigger
      io.to(room.code).emit('betting_end', {});
      startQuestion(room.code);
    }
  });

  socket.on('pause_game', () => {
    const room = getRoom(socket);
    if (!room || room.paused) return;
    if (!room.players.get(socket.id)?.isHost) return;
    if (!['question', 'reveal'].includes(room.status)) return;

    clearTimeout(room.timer);
    const elapsed = Date.now() - room.phaseStart;
    room.pauseRemaining = Math.max(1000, 20000 - elapsed);
    room.paused = true;
    room.pausedAt = Date.now();

    io.to(room.code).emit('game_paused', {
      remainingSeconds: Math.ceil(room.pauseRemaining / 1000)
    });
  });

  socket.on('resume_game', () => {
    const room = getRoom(socket);
    if (!room || !room.paused) return;
    if (!room.players.get(socket.id)?.isHost) return;

    const pauseDuration = Date.now() - room.pausedAt;
    room.paused = false;
    room.pausedAt = null;

    // Shift questionStart forward so scoring doesn't count paused time
    if (room.status === 'question') room.questionStart += pauseDuration;
    room.phaseStart += pauseDuration;

    const remaining = room.pauseRemaining;
    const remainingSeconds = Math.ceil(remaining / 1000);

    if (room.status === 'question') {
      room.timer = setTimeout(() => doReveal(room.code), remaining);
    } else {
      room.timer = setTimeout(() => {
        room.questionIdx++;
        if (room.questionIdx >= room.questions.length) doRoundEnd(room.code);
        else startQuestion(room.code);
      }, remaining);
    }

    io.to(room.code).emit('game_resumed', { remainingSeconds });
  });

  socket.on('emoji_react', ({ emoji }) => {
    const room = getRoom(socket);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    io.to(room.code).emit('emoji_reaction', { emoji, playerName: p.name, id: socket.id });
  });

  socket.on('play_again', () => {
    const room = getRoom(socket);
    if (!room || room.status !== 'game_end') return;
    if (!room.players.get(socket.id)?.isHost) return;
    room.players.forEach(p => { p.score = 0; p.streak = 0; p.roundScores = [0,0,0]; });
    room.status = 'lobby';
    broadcastLobby(room.code);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) { clearTimeout(room.timer); rooms.delete(code); return; }
    if (![...room.players.values()].some(p => p.isHost))
      [...room.players.values()][0].isHost = true;
    if (room.status === 'lobby') broadcastLobby(code);
    else io.to(code).emit('player_left', { playerId: socket.id });
  });
});

// ─────────────────────────────────────────────
//  Game loop
// ─────────────────────────────────────────────
function startRound(code, round) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimeout(room.timer);
  room.round = round;
  room.questionIdx = 0;
  room.questions = room.allQuestions[round];
  room.status = 'round_intro';

  const info = ROUNDS[round - 1];
  io.to(code).emit('round_intro', { round, total: 3, ...info });
  room.timer = setTimeout(() => startQuestion(code), 6000);
}

function startQuestion(code) {
  const room = rooms.get(code);
  if (!room) return;

  // Check if this is Q15 — trigger betting first (unless already in betting flow)
  if (room.questionIdx === 14 && !room.bettingActive && !room.bets.has('_done')) {
    room.bettingActive = true;
    room.bets = new Map();

    const scores = {};
    room.players.forEach((p, id) => { scores[id] = p.score; });
    io.to(code).emit('betting_start', { scores, timeLimit: 15 });

    room.timer = setTimeout(() => {
      room.bettingActive = false;
      room.bets.set('_done', true); // sentinel to skip this branch on retry
      io.to(code).emit('betting_end', {});
      startQuestion(code);
    }, 15000);
    return;
  }

  // Clear sentinel if present
  room.bets.delete('_done');

  const q = room.questions[room.questionIdx];
  room.status = 'question';
  room.answers = new Map();
  room.questionStart = Date.now();
  room.phaseStart = Date.now();

  const roundType = ROUNDS[room.round - 1].type;
  const imageUrl = q.wiki ? (imgCache.get(q.wiki) || null) : null;

  const payload = {
    questionNumber: room.questionIdx + 1,
    totalQuestions: room.questions.length,
    round: room.round,
    roundType,
    id: q.id,
    imageUrl,
    wikiTitle: q.wiki || null,
    hint: roundType === 'photo' ? (q.hint || null) : null, // hints only in R1
    hintRevealTime: roundType === 'photo' ? 10 : 0,        // R1: hint hidden for first 10s
    faceRevealTime: roundType === 'zoomin' ? 10 : 0,       // R3: face → uniform at 10s
    isBetQuestion: room.questionIdx === 14,
    // Career stats data (round 2 only)
    statsData: roundType === 'stats' ? {
      position: q.position, height: q.height, draftYear: q.draftYear,
      career: q.career, allStars: q.allStars, rings: q.rings,
      ppg: q.ppg, rpg: q.rpg, apg: q.apg, spg: q.spg, bpg: q.bpg, fgPct: q.fgPct
    } : null
  };

  io.to(code).emit('question_start', payload);
  room.timer = setTimeout(() => doReveal(code), 20000);
}

function doReveal(code) {
  const room = rooms.get(code);
  if (!room || room.status === 'reveal') return;
  room.status = 'reveal';
  room.phaseStart = Date.now();

  const q = room.questions[room.questionIdx];
  const isBetQuestion = room.questionIdx === 14;
  const imageUrl = q.wiki ? (imgCache.get(q.wiki) || null) : null;

  const playerResults = [];
  room.players.forEach((player, id) => {
    const ans = room.answers.get(id);
    let correct = ans ? ans.correct : false;
    let betApplied = 0;

    let points = correct ? calcScore(room.round, ans.elapsed, player.streak + 1) : 0;

    if (correct) player.streak++;
    else player.streak = 0;

    // Apply bet for Q15
    if (isBetQuestion) {
      const bet = room.bets.get(id) || 0;
      if (bet > 0) {
        betApplied = correct ? bet : -bet;
        points += betApplied;
        player.score = Math.max(0, player.score + points);
      } else {
        player.score = Math.max(0, player.score + points);
      }
    } else {
      player.score = Math.max(0, player.score + points);
    }
    player.roundScores[room.round - 1] += points;

    playerResults.push({
      id, name: player.name, avatar: player.avatar,
      answer: ans?.answer || null,
      correct, points,
      betApplied: isBetQuestion ? betApplied : null,
      totalScore: player.score,
      streak: player.streak,
      elapsed: ans ? Math.round(ans.elapsed * 10) / 10 : null
    });
  });

  playerResults.sort((a, b) => b.totalScore - a.totalScore);

  io.to(code).emit('answer_reveal', {
    correctAnswer: q.name,
    team: q.team || null,
    years: q.years || null,
    funFact: q.funFact,
    imageUrl,
    isBetQuestion,
    playerResults
  });

  room.timer = setTimeout(() => {
    room.questionIdx++;
    if (room.questionIdx >= room.questions.length) doRoundEnd(code);
    else startQuestion(code);
  }, 20000);
}

function doRoundEnd(code) {
  const room = rooms.get(code);
  if (!room) return;
  room.status = 'round_end';

  const standings = [...room.players.values()]
    .map(p => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, roundScore: p.roundScores[room.round - 1] }))
    .sort((a, b) => b.score - a.score);

  const mvp = standings.reduce((best, p) => (!best || p.roundScore > best.roundScore) ? p : best, null);

  io.to(code).emit('round_end', {
    round: room.round, roundName: ROUNDS[room.round - 1].name, standings,
    mvp: mvp?.name, nextRound: room.round < 3 ? room.round + 1 : null
  });

  room.timer = setTimeout(() => {
    if (room.round < 3) startRound(code, room.round + 1);
    else doGameEnd(code);
  }, room.round < 3 ? 10000 : 3000);
}

function doGameEnd(code) {
  const room = rooms.get(code);
  if (!room) return;
  room.status = 'game_end';

  const standings = [...room.players.values()]
    .map(p => ({ id: p.id, name: p.name, avatar: p.avatar, totalScore: p.score, roundScores: p.roundScores }))
    .sort((a, b) => b.totalScore - a.totalScore);

  io.to(code).emit('game_end', { standings });
  room.timer = setTimeout(() => rooms.delete(code), 30 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`🏀  Name That Baller v2 running on http://localhost:${PORT}`));
