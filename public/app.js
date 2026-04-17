// app.js — Remember That Dude Sports Edition
// 3 sports rounds + Deep Cut bonus per round

const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────
let myName      = '';
let myScore     = 0;
let myStreak    = 0;
let isHost      = false;
let muted       = false;
let answered    = false;
let betLocked   = false;
let betAmount   = 0;
let currentBetPct = 0;
let questionData  = null;
let questionStartTime = 0;
let currentSection = 1;
let qTimerInterval = null;
let dcTimerInterval = null;
let lastCountdownBeep = -1;
let prefetchedImageUrl = null;  // Wikipedia image pre-fetched during sections 1+2
let usedPowersThisRound = new Set();
let usedDoubleDownGame  = false;
let activePower         = null;
let powerTargetId       = null;
let myBlockedSections      = 0;
let currentBlockedSections = 0;
let isFrozen            = false;
let doubleDownPending   = false;
let powerPanelPlayers   = [];

// ─── Audio ────────────────────────────────────────────────────────────────────
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}
function playTone(freq, dur, type, gain, delay) {
  if (muted) return;
  try {
    ensureAudio();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, audioCtx.currentTime + (delay || 0));
    g.gain.setValueAtTime(0, audioCtx.currentTime + (delay || 0));
    g.gain.linearRampToValueAtTime(gain || 0.15, audioCtx.currentTime + (delay || 0) + 0.01);
    g.gain.linearRampToValueAtTime(0, audioCtx.currentTime + (delay || 0) + dur);
    o.start(audioCtx.currentTime + (delay || 0));
    o.stop(audioCtx.currentTime + (delay || 0) + dur + 0.05);
  } catch(e) {}
}
function playCorrect() {
  playTone(523, 0.12, 'sine', 0.2, 0);
  playTone(659, 0.12, 'sine', 0.2, 0.1);
  playTone(784, 0.2,  'sine', 0.2, 0.2);
}
function playWrong() {
  playTone(220, 0.1, 'square', 0.15, 0);
  playTone(160, 0.2, 'square', 0.12, 0.12);
}
function playReveal() {
  playTone(440, 0.08, 'sine', 0.12, 0);
  playTone(550, 0.1,  'sine', 0.12, 0.09);
}
function playFanfare() {
  [523,659,784,1047,784,1047,1175,1047].forEach((f,i) => playTone(f, 0.18, 'sine', 0.2, i * 0.13));
}
document.addEventListener('click', () => {
  if (audioCtx?.state === 'suspended') audioCtx.resume();
}, { once: true });

function toggleMute() {
  muted = !muted;
  document.getElementById('btn-mute').textContent = muted ? '🔇' : '🔊';
  const dc = document.getElementById('btn-mute-dc');
  if (dc) dc.textContent = muted ? '🔇' : '🔊';
}

// ─── Screens ──────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, duration) {
  duration = duration || 2500;
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), duration);
}

// ─── HTML escape ─────────────────────────────────────────────────────────────
function esc(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Hangman blanks ──────────────────────────────────────────────────────────
function buildHangman(nameLengths, firstLetters, showFirst) {
  return (nameLengths || []).map((len, idx) => {
    const fl = firstLetters && firstLetters[idx];
    const chars = [];
    for (let i = 0; i < len; i++) {
      if (i === 0 && showFirst && fl) {
        chars.push('<span class="hm-letter revealed">' + fl + '</span>');
      } else {
        chars.push('<span class="hm-letter blank">_</span>');
      }
    }
    return '<span class="hm-word">' + chars.join('') + '</span>';
  }).join('<span class="hm-space"> </span>');
}

// ─── Stat rendering ───────────────────────────────────────────────────────────
function renderStats(stats, sport) {
  if (!stats) return '';
  const items = [];
  const chip = (val, lbl) => `<div class="stat-chip"><span class="stat-chip-val">${val}</span><span class="stat-chip-label">${lbl}</span></div>`;

  if (sport === 'basketball') {
    if (stats.ppg  != null) items.push(chip(stats.ppg,  'PPG'));
    if (stats.rpg  != null) items.push(chip(stats.rpg,  'RPG'));
    if (stats.apg  != null) items.push(chip(stats.apg,  'APG'));
    if (stats.spg  != null) items.push(chip(stats.spg,  'SPG'));
    if (stats.bpg  != null) items.push(chip(stats.bpg,  'BPG'));
    if (stats.fgPct!= null) items.push(chip(stats.fgPct + '%', 'FG%'));
  } else if (sport === 'baseball') {
    if (stats.avg  != null) items.push(chip(stats.avg,       'AVG'));
    if (stats.hr   != null) items.push(chip(stats.hr,        'HR'));
    if (stats.rbi  != null) items.push(chip(stats.rbi,       'RBI'));
    if (stats.ops  != null) items.push(chip(stats.ops,       'OPS'));
    if (stats.era  != null) items.push(chip(stats.era,       'ERA'));
    if (stats.wins != null) items.push(chip(stats.wins,      'W'));
    if (stats.strikeouts != null) items.push(chip(stats.strikeouts, 'K'));
    if (stats.saves!= null) items.push(chip(stats.saves,     'SV'));
    if (stats.whip != null) items.push(chip(stats.whip,      'WHIP'));
  } else if (sport === 'football') {
    if (stats.pass_yards   != null) items.push(chip(stats.pass_yards,   'PASS YDS'));
    if (stats.pass_tds     != null) items.push(chip(stats.pass_tds,    'PASS TD'));
    if (stats.comp_pct     != null) items.push(chip(stats.comp_pct + '%', 'CMP%'));
    if (stats.interceptions!= null) items.push(chip(stats.interceptions,'INT'));
    if (stats.rush_yards   != null) items.push(chip(stats.rush_yards,  'RUSH YDS'));
    if (stats.rush_tds     != null) items.push(chip(stats.rush_tds,   'RUSH TD'));
    if (stats.receptions   != null) items.push(chip(stats.receptions, 'REC'));
    if (stats.rec_yards    != null) items.push(chip(stats.rec_yards,  'REC YDS'));
    if (stats.rec_tds      != null) items.push(chip(stats.rec_tds,    'REC TD'));
  }
  return items.length ? '<div class="stats-grid">' + items.join('') + '</div>' : '';
}

// ─── Image helpers ────────────────────────────────────────────────────────────
function renderImage(container, imageUrl, wikiTitle, altText, large) {
  if (!imageUrl && !wikiTitle) {
    container.innerHTML = '<div class="no-image">📷<br>No image available</div>';
    return;
  }
  const img = document.createElement('img');
  img.className = large ? 'player-img player-img-large' : 'player-img';
  img.alt = altText || 'Player';
  img.src = imageUrl || '';
  img.onerror = async function() {
    this.onerror = null;
    if (wikiTitle) {
      try {
        const r = await fetch('/api/image/fallback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wiki: wikiTitle })
        });
        const d = await r.json();
        if (d.url) { this.src = d.url; return; }
      } catch(e) {}
    }
    container.innerHTML = '<div class="no-image">📷<br>No image available</div>';
  };
  container.innerHTML = '';
  container.appendChild(img);
}

// ─── Name entry ───────────────────────────────────────────────────────────────
document.getElementById('btn-enter').addEventListener('click', enterName);
document.getElementById('input-name').addEventListener('keydown', e => { if (e.key === 'Enter') enterName(); });

function enterName() {
  const name = document.getElementById('input-name').value.trim();
  if (!name) { showToast('Enter your name first!'); return; }
  myName = name;
  showScreen('screen-lobby');
}

// ─── Lobby ────────────────────────────────────────────────────────────────────
document.getElementById('btn-create').addEventListener('click', () => {
  socket.emit('create_room', { playerName: myName });
});
document.getElementById('btn-join').addEventListener('click', joinRoom);
document.getElementById('input-room-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

function joinRoom() {
  const code = document.getElementById('input-room-code').value.trim().toUpperCase();
  if (!code) { showToast('Enter a room code!'); return; }
  socket.emit('join_room', { playerName: myName, roomCode: code });
}

socket.on('room_created', ({ roomCode }) => {
  isHost = true;
  document.getElementById('room-code-display').textContent = roomCode;
  document.getElementById('btn-start').style.display = 'block';
  document.getElementById('skip-round-row').style.display = 'flex';
  document.getElementById('waiting-msg').style.display = 'none';
  showScreen('screen-waiting');
});

socket.on('room_joined', ({ roomCode }) => {
  isHost = false;
  document.getElementById('room-code-display').textContent = roomCode;
  document.getElementById('btn-start').style.display = 'none';
  document.getElementById('skip-round-row').style.display = 'none';
  document.getElementById('waiting-msg').style.display = 'block';
  showScreen('screen-waiting');
});

socket.on('lobby_update', ({ players }) => {
  const list = document.getElementById('player-list');
  list.innerHTML = players.map(p =>
    `<div class="player-lobby-item${p.name === myName ? ' me' : ''}">
      <span class="avatar">${p.isHost ? '👑' : '🏅'}</span>
      <span class="name">${esc(p.name)}</span>
      ${p.isHost ? '<span class="host-badge">HOST</span>' : ''}
    </div>`
  ).join('');
  const me = players.find(p => p.name === myName);
  if (me) isHost = me.isHost;
  const startBtn = document.getElementById('btn-start');
  if (startBtn) startBtn.style.display = isHost ? 'block' : 'none';
  const skipRow = document.getElementById('skip-round-row');
  if (skipRow) skipRow.style.display = isHost ? 'flex' : 'none';
  const waitMsg = document.getElementById('waiting-msg');
  if (waitMsg) waitMsg.style.display = isHost ? 'none' : 'block';
});

function copyRoomCode() {
  const code = document.getElementById('room-code-display').textContent;
  navigator.clipboard.writeText(code).then(() => showToast('Room code copied!')).catch(() => showToast(code));
}

document.getElementById('btn-start').addEventListener('click', () => socket.emit('start_game'));

function startAtRound(round) { socket.emit('start_game_at_round', { round }); }

function resetHistory() {
  fetch('/api/reset-history', { method: 'POST' })
    .then(() => showToast('🔀 Player pool reset!'))
    .catch(() => showToast('Reset failed'));
}

// ─── Loading ──────────────────────────────────────────────────────────────────
socket.on('game_loading', () => showScreen('screen-loading'));

// ─── Round Intro ──────────────────────────────────────────────────────────────
socket.on('round_intro', ({ round, totalRounds, sport, label, icon }) => {
  usedPowersThisRound = new Set();
  document.getElementById('ri-icon').textContent = icon;
  document.getElementById('ri-round-label').textContent = `ROUND ${round} OF ${totalRounds}`;
  document.getElementById('ri-name').textContent = label.toUpperCase();
  const sportDescs = {
    basketball: 'Name the NBA player from clues',
    baseball:   'Name the MLB player from clues',
    football:   'Name the NFL player from clues',
  };
  document.getElementById('ri-desc').textContent = sportDescs[sport] || 'Name the player from clues';

  let sec = 4;
  const cd = document.getElementById('ri-countdown');
  cd.textContent = `Starting in ${sec}s…`;
  const t = setInterval(() => {
    sec--;
    if (sec > 0) cd.textContent = `Starting in ${sec}s…`;
    else { clearInterval(t); cd.textContent = 'GO!'; }
  }, 1000);

  showScreen('screen-round-intro');
});

// ─── Question ─────────────────────────────────────────────────────────────────
socket.on('question_start', data => {
  questionData      = data;
  answered          = false;
  currentSection    = 1;
  questionStartTime = Date.now();
  prefetchedImageUrl = null;

  // Pre-fetch Wikipedia image in background during sections 1+2 so section 3 has a face-forward photo
  if (data.wikiTitle) {
    fetch('/api/image/fallback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wiki: data.wikiTitle }),
    })
    .then(r => r.json())
    .then(d => { if (d.url) prefetchedImageUrl = d.url; })
    .catch(() => {});
  }

  const sportIcons = { basketball: '🏀', baseball: '⚾', football: '🏈' };
  document.getElementById('q-round-badge').textContent = `R${data.round} ${sportIcons[data.sport] || ''}`;
  document.getElementById('q-number').textContent = `Q${data.questionNumber}/${data.totalQuestions}`;
  document.getElementById('q-score').textContent = myScore;
  const streakEl = document.getElementById('q-streak');
  streakEl.style.display = myStreak >= 2 ? 'inline' : 'none';
  streakEl.textContent = `🔥×${myStreak}`;
  document.getElementById('btn-pause').classList.toggle('hidden', !isHost);

  // Hide power panel
  document.getElementById('power-panel').style.display = 'none';

  // Freeze / snitch / double-down UI
  document.getElementById('freeze-banner').classList.toggle('hidden', !isFrozen);
  document.getElementById('snitch-display').classList.add('hidden');
  document.getElementById('double-down-badge').classList.toggle('hidden', !doubleDownPending);

  // Apply blocks — consume and reset
  currentBlockedSections = myBlockedSections;
  myBlockedSections = 0;

  // Reset sections
  if (currentBlockedSections >= 1) {
    document.getElementById('section1-content').innerHTML = blockedClueHtml();
  } else {
    document.getElementById('section1-content').textContent = data.synopsis || '…';
  }
  document.getElementById('section1-wrap').classList.remove('hidden');
  document.getElementById('section2-wrap').classList.add('hidden');
  document.getElementById('section3-wrap').classList.add('hidden');
  document.getElementById('section2-content').innerHTML = '';
  document.getElementById('player-image-container').innerHTML = '';

  // Section markers
  ['sm-1','sm-2','sm-3'].forEach(id => document.getElementById(id).classList.remove('active','done'));
  document.getElementById('sm-1').classList.add('active');

  // Reset answer
  const input = document.getElementById('answer-input');
  input.value = '';
  input.disabled = isFrozen;
  document.getElementById('btn-submit-answer').disabled = isFrozen;
  document.getElementById('answer-result-banner').classList.add('hidden');
  document.getElementById('answered-bar').innerHTML = '';

  lastCountdownBeep = -1;
  startQuestionTimer(30);
  showScreen('screen-question');
  if (currentBlockedSections > 0) {
    const detail = currentBlockedSections >= 3 ? 'All clues blocked — good luck!'
      : currentBlockedSections === 2 ? '2 clues blocked — photo only!'
      : '1st clue blocked — wait for Clue 2!';
    showPowerOverlay('🏀', 'BLOCKED!', detail);
  }
  if (!isFrozen) setTimeout(() => input.focus(), 200);
});

function startQuestionTimer(totalSecs) {
  clearInterval(qTimerInterval);
  updateQTimer(totalSecs, totalSecs);

  qTimerInterval = setInterval(() => {
    const elapsed = (Date.now() - questionStartTime) / 1000;
    const remaining = Math.max(0, totalSecs - elapsed);
    updateQTimer(remaining, totalSecs);

    // Once-per-second beep for last 5 seconds
    const ceilSec = Math.ceil(remaining);
    if (ceilSec <= 5 && ceilSec > 0 && ceilSec !== lastCountdownBeep) {
      lastCountdownBeep = ceilSec;
      playReveal();
    }

    if (elapsed >= 10 && currentSection < 2) {
      currentSection = 2;
      revealSection2();
    }
    if (elapsed >= 20 && currentSection < 3) {
      currentSection = 3;
      revealSection3();
    }
    if (remaining <= 0) clearInterval(qTimerInterval);
  }, 80);
}

function updateQTimer(remaining, total) {
  const secs = Math.ceil(remaining);
  document.getElementById('timer-text').textContent = secs;
  const circumference = 2 * Math.PI * 40;
  const circle = document.getElementById('timer-circle');
  if (circle) {
    circle.style.strokeDasharray = circumference;
    circle.style.strokeDashoffset = circumference * (1 - remaining / total);
    circle.style.stroke = remaining > 15 ? '#22c55e' : remaining > 8 ? '#f59e0b' : '#ef4444';
  }
}

function revealSection2() {
  const d = questionData;
  if (!d) return;
  playReveal();

  if (currentBlockedSections >= 2) {
    document.getElementById('section2-content').innerHTML = blockedClueHtml();
    document.getElementById('section2-wrap').classList.remove('hidden');
    document.getElementById('sm-1').classList.remove('active');
    document.getElementById('sm-1').classList.add('done');
    document.getElementById('sm-2').classList.add('active');
    return;
  }

  const content = document.getElementById('section2-content');
  let html = '';

  // Hangman name blanks
  html += `<div class="hangman-wrap" id="q-hangman">${buildHangman(d.nameLengths)}</div>`;

  // Position + career years
  const meta = [d.position, d.career].filter(Boolean).join(' · ');
  if (meta) html += `<div class="player-meta"><span class="meta-text">${esc(meta)}</span></div>`;

  // Teams
  if (d.teams && d.teams.length) {
    html += `<div class="teams-row">
      <span class="info-label">Teams</span>
      <div class="teams-chips">${d.teams.map(t => `<span class="team-chip">${esc(t)}</span>`).join('')}</div>
    </div>`;
  }

  // College
  if (d.college) {
    html += `<div class="college-row">
      <span class="info-label">College</span>
      <span class="college-name">${esc(d.college)}</span>
    </div>`;
  }

  // Accolades
  if (d.accolades && d.accolades.length) {
    html += `<div class="accolades-row">${d.accolades.map(a => `<span class="accolade-chip">🏆 ${esc(a)}</span>`).join('')}</div>`;
  }

  // Stats
  html += renderStats(d.stats, d.sport);

  content.innerHTML = html;
  document.getElementById('section2-wrap').classList.remove('hidden');

  // Update section markers
  document.getElementById('sm-1').classList.remove('active');
  document.getElementById('sm-1').classList.add('done');
  document.getElementById('sm-2').classList.add('active');
}

function revealSection3() {
  const d = questionData;
  if (!d) return;
  playReveal();

  if (currentBlockedSections >= 3) {
    document.getElementById('player-image-container').innerHTML = blockedClueHtml();
    document.getElementById('section3-wrap').classList.remove('hidden');
    document.getElementById('sm-2').classList.remove('active');
    document.getElementById('sm-2').classList.add('done');
    document.getElementById('sm-3').classList.add('active');
    return;
  }

  // Update hangman with first letters
  const hangmanEl = document.getElementById('q-hangman');
  if (hangmanEl) hangmanEl.innerHTML = buildHangman(d.nameLengths, d.nameFirstLetters, true);

  // Render photo — prefer Wikipedia (headshot, face-forward) over BBRef (action shots, jersey backs)
  const container = document.getElementById('player-image-container');
  renderImage(container, prefetchedImageUrl || d.imageUrl, d.wikiTitle, null, true);

  document.getElementById('section3-wrap').classList.remove('hidden');

  // Update section markers
  document.getElementById('sm-2').classList.remove('active');
  document.getElementById('sm-2').classList.add('done');
  document.getElementById('sm-3').classList.add('active');
}

// Answer submission
document.getElementById('btn-submit-answer').addEventListener('click', submitAnswer);
document.getElementById('answer-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitAnswer(); });
document.getElementById('answer-input').addEventListener('input', e => {
  socket.emit('snitch_typing', { text: e.target.value });
});

function submitAnswer() {
  if (answered) return;
  const input = document.getElementById('answer-input');
  const answer = input.value.trim();
  if (!answer) return;
  answered = true;
  socket.emit('submit_answer', { answer });
  input.disabled = true;
  document.getElementById('btn-submit-answer').disabled = true;
}

socket.on('player_answered', ({ answeredCount, totalPlayers }) => {
  const text = `<span class="answered-count">${answeredCount}/${totalPlayers} answered</span>`;
  const bar = document.getElementById('answered-bar');
  if (bar) bar.innerHTML = text;
  const dcBar = document.getElementById('dc-answered-bar');
  if (dcBar) dcBar.innerHTML = text;
});

// ─── Answer Reveal ────────────────────────────────────────────────────────────
socket.on('answer_reveal', ({ correctAnswer, funFact, imageUrl, wikiTitle, playerResults }) => {
  clearInterval(qTimerInterval);
  isFrozen = false;
  doubleDownPending = false;
  document.getElementById('freeze-banner').classList.add('hidden');
  document.getElementById('double-down-badge').classList.add('hidden');

  const me = playerResults.find(p => p.name === myName);
  if (me) { myScore = me.totalScore; myStreak = me.streak || 0; }

  renderImage(document.getElementById('reveal-image-wrap'), imageUrl, wikiTitle, correctAnswer, true);
  document.getElementById('reveal-player-info').innerHTML =
    `<div class="reveal-player-name">${esc(correctAnswer)}</div>`;
  document.getElementById('reveal-fun-fact').innerHTML = funFact
    ? `<div class="fun-fact-text">${esc(funFact)}</div>` : '';

  const sb = document.getElementById('reveal-scoreboard');
  sb.innerHTML = playerResults.map((p, i) => {
    const medal = ['🥇','🥈','🥉'][i] || `${i+1}.`;
    const ansHtml = p.correct
      ? `<span class="ans-correct">✓${p.elapsed ? ' ' + p.elapsed.toFixed(1) + 's' : ''}</span>`
      : p.answer
        ? `<span class="ans-wrong">${esc(p.answer)}</span>`
        : '<span class="ans-none">—</span>';
    const ddTag = p.doubledDown ? ' <span class="doubled-pts">×2</span>' : '';
    const ptsHtml = p.points > 0 ? `<span class="pts-gained">+${p.points}${ddTag}</span>` : '';
    return `<div class="sb-row ${p.name === myName ? 'me' : ''}">
      <span class="sb-pos">${medal}</span>
      <span class="sb-name">${esc(p.name)}</span>
      ${ansHtml}${ptsHtml}
      <span class="sb-total">${p.totalScore}</span>
    </div>`;
  }).join('');

  startCountdown('reveal-countdown', 'reveal-timer-bar', 15);
  showScreen('screen-reveal');
});

// ─── Round End ────────────────────────────────────────────────────────────────
socket.on('round_end', ({ round, sport, label, standings, mvp }) => {
  const icons = { basketball: '🏀', baseball: '⚾', football: '🏈' };
  document.getElementById('re-round-badge').textContent =
    `${icons[sport] || ''} ${label.toUpperCase()} — ROUND ${round} COMPLETE`;

  document.getElementById('re-mvp').innerHTML = mvp
    ? `<div class="mvp-row">🌟 Round MVP: <strong>${esc(mvp)}</strong></div>` : '';

  document.getElementById('re-standings').innerHTML = standings.map((p, i) => {
    const medal = ['🥇','🥈','🥉'][i] || `${i+1}.`;
    return `<div class="standing-row ${p.name === myName ? 'me' : ''}">
      <span class="standing-rank">${medal}</span>
      <span class="standing-name">${esc(p.name)}</span>
      <span class="standing-rscore">+${p.roundScore}</span>
      <span class="standing-score">${p.score}</span>
    </div>`;
  }).join('');

  document.getElementById('re-next-label').textContent = 'Deep Cut betting coming up…';
  showScreen('screen-round-end');
});

// ─── Deep Cut Betting ─────────────────────────────────────────────────────────
socket.on('deep_cut_betting', ({ round, sport, scores }) => {
  const icons = { basketball: '🏀', baseball: '⚾', football: '🏈' };
  document.getElementById('dc-bet-sport').textContent = `${icons[sport] || ''} DEEP CUT BET`;

  const myScoreNow = scores[socket.id] || myScore;
  myScore = myScoreNow;
  document.getElementById('dc-my-score').textContent = myScoreNow;

  betLocked   = false;
  betAmount   = 0;
  currentBetPct = 0;
  document.getElementById('dc-bet-locked-msg').style.display = 'none';
  document.getElementById('btn-lock-dc-bet').disabled = false;
  document.getElementById('dc-bet-preview').textContent = 'No bet selected';
  document.querySelectorAll('.dc-bet-btn').forEach(b => b.classList.remove('selected'));

  startTimerBar('dc-bet-timer', 'dc-bet-timer-bar', 15);
  showScreen('screen-deep-cut-betting');
});

function selectDcBet(pct) {
  if (betLocked) return;
  currentBetPct = pct;
  betAmount = Math.floor(myScore * pct);
  document.querySelectorAll('.dc-bet-btn').forEach(b => {
    b.classList.toggle('selected', Number(b.dataset.pct) === pct);
  });
  document.getElementById('dc-bet-preview').textContent = pct === 0
    ? 'No bet — just playing for fun'
    : `Betting ${Math.round(pct * 100)}% = ${betAmount} pts`;
}

document.getElementById('btn-lock-dc-bet').addEventListener('click', () => {
  if (betLocked) return;
  betLocked = true;
  socket.emit('submit_bet', { pct: currentBetPct });
  document.getElementById('btn-lock-dc-bet').disabled = true;
  document.getElementById('dc-bet-locked-msg').style.display = 'block';
  clearInterval(window._dcBetCountdown);
});

socket.on('bet_confirmed', ({ amount, pct }) => {
  betAmount = amount;
  document.getElementById('dc-bet-preview').textContent = amount > 0
    ? `Bet locked: ${amount} pts (${Math.round(pct * 100)}%)`
    : 'Bet locked: passing this one';
});

socket.on('betting_end', () => clearInterval(window._dcBetCountdown));

// ─── Deep Cut Question ────────────────────────────────────────────────────────
socket.on('deep_cut_start', ({ round, sport, imageUrl, wikiTitle }) => {
  answered = false;
  questionStartTime = Date.now();

  const icons = { basketball: '🏀', baseball: '⚾', football: '🏈' };
  document.getElementById('dc-round-badge').textContent = `R${round} DEEP CUT ${icons[sport] || ''}`;
  document.getElementById('dc-score-display').textContent = myScore;

  const imgContainer = document.getElementById('dc-image-container');
  renderImage(imgContainer, imageUrl, wikiTitle, null, true);

  const betDisplay = document.getElementById('dc-bet-display');
  if (betAmount > 0) {
    betDisplay.textContent = `🎰 Your bet: ${betAmount} pts`;
    betDisplay.style.display = 'block';
  } else {
    betDisplay.style.display = 'none';
  }

  const input = document.getElementById('dc-answer-input');
  input.value = '';
  input.disabled = false;
  document.getElementById('btn-dc-submit').disabled = false;
  document.getElementById('dc-answer-result').classList.add('hidden');
  document.getElementById('dc-answered-bar').innerHTML = '';

  lastCountdownBeep = -1;
  startDcTimer(30);
  showScreen('screen-deep-cut-question');
  setTimeout(() => input.focus(), 200);
});

function startDcTimer(totalSecs) {
  clearInterval(dcTimerInterval);
  updateDcTimer(totalSecs, totalSecs);
  dcTimerInterval = setInterval(() => {
    const elapsed = (Date.now() - questionStartTime) / 1000;
    const remaining = Math.max(0, totalSecs - elapsed);
    updateDcTimer(remaining, totalSecs);
    const ceilSec = Math.ceil(remaining);
    if (ceilSec <= 5 && ceilSec > 0 && ceilSec !== lastCountdownBeep) {
      lastCountdownBeep = ceilSec;
      playReveal();
    }
    if (remaining <= 0) clearInterval(dcTimerInterval);
  }, 80);
}

function updateDcTimer(remaining, total) {
  document.getElementById('dc-timer-text').textContent = Math.ceil(remaining);
  const circumference = 2 * Math.PI * 40;
  const circle = document.getElementById('dc-timer-circle');
  if (circle) {
    circle.style.strokeDasharray = circumference;
    circle.style.strokeDashoffset = circumference * (1 - remaining / total);
    circle.style.stroke = remaining > 15 ? '#22c55e' : remaining > 8 ? '#f59e0b' : '#ef4444';
  }
}

document.getElementById('btn-dc-submit').addEventListener('click', submitDcAnswer);
document.getElementById('dc-answer-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitDcAnswer(); });

function submitDcAnswer() {
  if (answered) return;
  const input = document.getElementById('dc-answer-input');
  const answer = input.value.trim();
  if (!answer) return;
  answered = true;
  socket.emit('submit_answer', { answer });
  input.disabled = true;
  document.getElementById('btn-dc-submit').disabled = true;
}

socket.on('answer_feedback', ({ correct }) => {
  // This handles both question and deep-cut question screens
  const qScreen = document.getElementById('screen-question');
  const dcScreen = document.getElementById('screen-deep-cut-question');
  const isQuestion = qScreen.classList.contains('active');
  const isDc = dcScreen.classList.contains('active');

  if (isQuestion) {
    const elapsed = (Date.now() - questionStartTime) / 1000;
    const section = elapsed < 10 ? 1 : elapsed < 20 ? 2 : 3;
    const pts = elapsed < 10 ? 500 : elapsed < 20 ? 300 : 150;
    const banner = document.getElementById('answer-result-banner');
    if (correct) {
      banner.className = 'answer-result-banner correct';
      banner.textContent = `✅ Correct! +${pts} pts (Clue ${section})`;
      playCorrect();
    } else {
      banner.className = 'answer-result-banner incorrect';
      banner.textContent = '❌ Wrong!';
      playWrong();
    }
    banner.classList.remove('hidden');
  } else if (isDc) {
    const banner = document.getElementById('dc-answer-result');
    if (correct) {
      banner.className = 'answer-result-banner correct';
      banner.textContent = `✅ Correct! Bet coming through…`;
      playCorrect();
    } else {
      banner.className = 'answer-result-banner incorrect';
      banner.textContent = '❌ Wrong!';
      playWrong();
    }
    banner.classList.remove('hidden');
  }
});

// ─── Deep Cut Reveal ──────────────────────────────────────────────────────────
socket.on('deep_cut_reveal', ({ correctAnswer, funFact, imageUrl, wikiTitle, playerResults }) => {
  clearInterval(dcTimerInterval);
  document.getElementById('power-panel').style.display = 'none';

  const me = playerResults.find(p => p.name === myName);
  if (me) myScore = me.totalScore;

  renderImage(document.getElementById('dcr-image-wrap'), imageUrl, wikiTitle, correctAnswer, true);
  document.getElementById('dcr-player-name').textContent = correctAnswer;
  document.getElementById('dcr-fun-fact').innerHTML = funFact
    ? `<div class="fun-fact-text">${esc(funFact)}</div>` : '';

  const sb = document.getElementById('dcr-scoreboard');
  sb.innerHTML = playerResults.map((p, i) => {
    const medal = ['🥇','🥈','🥉'][i] || `${i+1}.`;
    const betHtml = p.betChange > 0
      ? `<span class="bet-win">+${p.betChange} 🎉</span>`
      : p.betChange < 0
        ? `<span class="bet-loss">${p.betChange}</span>`
        : '';
    return `<div class="sb-row ${p.name === myName ? 'me' : ''}">
      <span class="sb-pos">${medal}</span>
      <span class="sb-name">${esc(p.name)}</span>
      <span class="${p.correct ? 'ans-correct' : 'ans-wrong'}">${p.correct ? '✓' : p.answer ? esc(p.answer) : '—'}</span>
      ${betHtml}
      <span class="sb-total">${p.totalScore}</span>
    </div>`;
  }).join('');

  startCountdown('dcr-countdown', 'dcr-timer-bar', 15);
  showScreen('screen-deep-cut-reveal');
});

// ─── Game End ─────────────────────────────────────────────────────────────────
socket.on('game_end', ({ standings }) => {
  const winner = standings[0];
  document.getElementById('ge-winner').innerHTML = winner
    ? `<div class="ge-winner-name">🏆 ${esc(winner.name)}</div><div class="ge-winner-score">${winner.totalScore} pts</div>`
    : '';

  document.getElementById('ge-standings').innerHTML = standings.map((p, i) => {
    const medal = ['🥇','🥈','🥉'][i] || `${i+1}.`;
    return `<div class="standing-row ${p.name === myName ? 'me' : ''}">
      <span class="standing-rank">${medal}</span>
      <span class="standing-name">${esc(p.name)}</span>
      <span class="standing-score">${p.totalScore}</span>
    </div>`;
  }).join('');

  // Round breakdown
  if (standings[0]?.roundScores) {
    const icons = ['🏀','⚾','🏈'];
    const labels = ['Hardwood','Diamond','Gridiron'];
    let html = '<div class="ge-breakdown-title">ROUND SCORES</div><div class="ge-breakdown-cols">';
    html += labels.map((lbl, i) =>
      `<div class="ge-breakdown-item">
        <div class="ge-breakdown-label">${icons[i]} ${lbl}</div>
        ${standings.map(p => `<div class="ge-rbd-row"><span>${esc(p.name)}</span><span class="ge-breakdown-score">${(p.roundScores || [])[i] || 0}</span></div>`).join('')}
      </div>`
    ).join('');
    html += '</div>';
    document.getElementById('ge-round-breakdown').innerHTML = html;
  }

  document.getElementById('btn-play-again').style.display = isHost ? 'block' : 'none';

  if (winner && winner.name === myName) {
    setTimeout(() => confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } }), 300);
    playFanfare();
  }

  showScreen('screen-game-end');
});

document.getElementById('btn-play-again').addEventListener('click', () => socket.emit('play_again'));
document.getElementById('btn-back-lobby').addEventListener('click', () => location.reload());

// ─── Pause / Resume ───────────────────────────────────────────────────────────
socket.on('game_paused', () => {
  clearInterval(qTimerInterval);
  clearInterval(dcTimerInterval);
  document.getElementById('pause-msg').textContent = 'Host paused the game';
  document.getElementById('btn-resume').classList.toggle('hidden', !isHost);
  document.getElementById('pause-overlay').classList.remove('hidden');
});

socket.on('game_resumed', () => {
  document.getElementById('pause-overlay').classList.add('hidden');
  // Re-sync timer from questionStartTime (already adjusted by server-side remaining)
  if (questionData) startQuestionTimer(30);
});

function pauseGame()  { socket.emit('pause_game'); }
function resumeGame() { socket.emit('resume_game'); }

// ─── Power system ─────────────────────────────────────────────────────────────
socket.on('power_window_open', ({ leaderId, leaderName, players }) => {
  activePower = null;
  powerTargetId = null;
  powerPanelPlayers = players;
  renderPowerPanel({ leaderId, leaderName, players });
});

socket.on('power_confirmed', ({ power, targetName }) => {
  usedPowersThisRound.add(power);
  if (power === 'doubledown') { usedDoubleDownGame = true; doubleDownPending = true; }

  const labels = {
    block: '🏀 Block placed on leader!',
    freeze: `❄️ Freeze set on ${targetName || '?'}!`,
    shield: '🛡️ Shield up for next question!',
    snitch: `👁 Snitching on ${targetName || '?'}!`,
    doubledown: '×2 Double Down locked in!',
  };
  const msgs = document.getElementById('power-confirmed-msgs');
  if (msgs) {
    const div = document.createElement('div');
    div.className = 'power-confirmed-msg';
    div.textContent = '✅ ' + (labels[power] || power);
    msgs.appendChild(div);
  }
  // Disable that button and hide target picker
  const btn = document.getElementById('pbtn-' + power);
  if (btn) { btn.disabled = true; btn.classList.add('power-btn-used'); btn.classList.remove('power-btn-selected'); }
  document.getElementById('power-target-picker').style.display = 'none';
  activePower = null;
});

socket.on('you_are_frozen', () => {
  isFrozen = true;
  showToast('❄️ You are FROZEN next question — no answers!', 4000);
});

socket.on('shield_activated', () => {
  showToast('🛡️ Your Shield blocked an incoming attack!', 3500);
});

socket.on('snitch_update', ({ targetName, text }) => {
  const el = document.getElementById('snitch-display');
  if (!el) return;
  el.classList.remove('hidden');
  el.textContent = `👁 ${targetName}: ${text || '(typing…)'}`;
});

socket.on('block_reveal', ({ blockCount, leaderName, leaderId }) => {
  if (socket.id === leaderId) {
    myBlockedSections = blockCount;
    const detail = blockCount >= 3 ? 'All clues blocked — good luck!' : blockCount === 2 ? '2 clues blocked — photo only!' : '1st clue blocked — wait for Clue 2!';
    showPowerOverlay('🏀', 'BLOCKED!', detail);
  } else {
    const blasts = ['🏀','🏀🏀','🏀🏀🏀'][blockCount - 1] || '🏀';
    const msg = blockCount >= 3 ? `${blasts} ${leaderName} is FULLY BLOCKED!` : `${blasts} ${blockCount} block${blockCount > 1 ? 's' : ''} on ${leaderName}!`;
    showToast(msg, 3500);
  }
});

function renderPowerPanel({ leaderId, leaderName, players }) {
  const panel = document.getElementById('power-panel');
  if (!panel) return;

  const myId = socket.id;
  const isLeader = (myId === leaderId);
  const hasLeader = !!leaderId;
  const others = players.filter(p => p.id !== myId);

  const powers = [
    { id: 'block',      icon: '🏀', label: 'Block',       desc: leaderName ? `Block ${leaderName}` : 'No leader',
      disabled: isLeader || !hasLeader || usedPowersThisRound.has('block'),
      usedMsg: isLeader ? 'You are the leader' : !hasLeader ? 'No clear leader' : 'Used this round', needsTarget: false },
    { id: 'freeze',     icon: '❄️', label: 'Freeze',      desc: 'Freeze a player',
      disabled: usedPowersThisRound.has('freeze') || others.length === 0,
      usedMsg: 'Used this round', needsTarget: true },
    { id: 'shield',     icon: '🛡️', label: 'Shield',     desc: 'Protect yourself',
      disabled: usedPowersThisRound.has('shield'),
      usedMsg: 'Used this round', needsTarget: false },
    { id: 'snitch',     icon: '👁', label: 'Snitch',      desc: "Watch someone's typing",
      disabled: usedPowersThisRound.has('snitch') || others.length === 0,
      usedMsg: 'Used this round', needsTarget: true },
    { id: 'doubledown', icon: '×2', label: 'Double Down', desc: '2× points if correct',
      disabled: usedDoubleDownGame,
      usedMsg: 'Used this game', needsTarget: false },
  ];

  const grid = document.getElementById('power-grid');
  grid.innerHTML = powers.map(pw => `
    <button class="power-btn${pw.disabled ? ' power-btn-used' : ''}" id="pbtn-${pw.id}"
      onclick="${pw.disabled ? '' : pw.needsTarget ? `selectPower('${pw.id}')` : `usePowerDirect('${pw.id}')`}"
      ${pw.disabled ? 'disabled' : ''} title="${pw.disabled ? pw.usedMsg : pw.desc}">
      <span class="power-icon">${pw.icon}</span>
      <span class="power-label">${pw.label}</span>
      <span class="power-desc">${pw.disabled ? pw.usedMsg : pw.desc}</span>
    </button>
  `).join('');

  document.getElementById('power-target-picker').style.display = 'none';
  document.getElementById('power-confirmed-msgs').innerHTML = '';
  panel.style.display = 'block';
}

function selectPower(powerName) {
  activePower = powerName;
  document.querySelectorAll('.power-btn').forEach(b => b.classList.remove('power-btn-selected'));
  const btn = document.getElementById('pbtn-' + powerName);
  if (btn) btn.classList.add('power-btn-selected');

  const others = powerPanelPlayers.filter(p => p.id !== socket.id);
  const chips = document.getElementById('power-target-chips');
  chips.innerHTML = others.map(p =>
    `<button class="power-target-chip" onclick="confirmPowerTarget('${p.id}','${esc(p.name)}')">${esc(p.name)}</button>`
  ).join('');
  document.getElementById('power-target-picker').style.display = 'block';
}

function usePowerDirect(powerName) {
  socket.emit('use_power', { power: powerName, targetId: null });
  const btn = document.getElementById('pbtn-' + powerName);
  if (btn) { btn.disabled = true; btn.classList.add('power-btn-used'); }
}

function confirmPowerTarget(targetId, targetName) {
  if (!activePower) return;
  socket.emit('use_power', { power: activePower, targetId });
  const btn = document.getElementById('pbtn-' + activePower);
  if (btn) { btn.disabled = true; btn.classList.add('power-btn-used'); btn.classList.remove('power-btn-selected'); }
  document.getElementById('power-target-picker').style.display = 'none';
  activePower = null;
}

function blockedClueHtml() {
  return '<div class="blocked-clue"><span class="blocked-ball">🏀</span><span class="blocked-text">BLOCKED</span></div>';
}

function showPowerOverlay(icon, title, detail) {
  document.getElementById('block-overlay-icon').textContent = icon;
  document.getElementById('block-overlay-title').textContent = title;
  document.getElementById('block-overlay-detail').textContent = detail;
  const overlay = document.getElementById('block-overlay');
  overlay.classList.remove('hidden');
  setTimeout(() => overlay.classList.add('hidden'), 2400);
}

// ─── Errors ───────────────────────────────────────────────────────────────────
socket.on('error', ({ message }) => showToast(message, 3500));

// ─── Utility: countdown timer ────────────────────────────────────────────────
function startCountdown(countdownId, barId, secs) {
  let s = secs;
  document.getElementById(countdownId).textContent = s;
  const bar = document.getElementById(barId);
  if (bar) bar.style.width = '100%';
  const t = setInterval(() => {
    s--;
    const el = document.getElementById(countdownId);
    if (el) el.textContent = s;
    if (bar) bar.style.width = `${(s / secs) * 100}%`;
    if (s <= 0) clearInterval(t);
  }, 1000);
  return t;
}

// ─── Utility: simple timer bar ───────────────────────────────────────────────
function startTimerBar(textId, barId, secs) {
  let s = secs;
  document.getElementById(textId).textContent = s;
  const bar = document.getElementById(barId);
  if (bar) bar.style.width = '100%';
  clearInterval(window._dcBetCountdown);
  window._dcBetCountdown = setInterval(() => {
    s--;
    const el = document.getElementById(textId);
    if (el) el.textContent = s;
    if (bar) bar.style.width = `${(s / secs) * 100}%`;
    if (s <= 0) clearInterval(window._dcBetCountdown);
  }, 1000);
}
