// ─────────────────────────────────────────────
//  Name That Baller — Client v2
// ─────────────────────────────────────────────

const socket = io();

// ─── State ───────────────────────────────────
let myName = '';
let myScore = 0;
let myStreak = 0;
let myBet = 0;
let currentRound = 0;
let currentRoundType = '';
let answered = false;
let muted = false;
let amHost = false;
let timerInterval = null;
let betTimerInterval = null;
let zoomRevealTimeout = null;

// Pause state
let pausedTimerRemaining = 20;
let pausedTimerCallback = null;
let currentHint = null;
let hintTimerStart = 0;
let hintTimerDelay = 0;

// ─── Audio ───────────────────────────────────
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playTone(freq, duration, type, gain, delay) {
  if (muted) return;
  type = type || 'sine'; gain = gain || 0.15; delay = delay || 0;
  try {
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime + delay);
    gainNode.gain.setValueAtTime(0, audioCtx.currentTime + delay);
    gainNode.gain.linearRampToValueAtTime(gain, audioCtx.currentTime + delay + 0.01);
    gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + delay + duration);
    osc.start(audioCtx.currentTime + delay);
    osc.stop(audioCtx.currentTime + delay + duration + 0.05);
  } catch(e) {}
}

function playCorrect() {
  playTone(523, 0.15, 'sine', 0.2, 0);
  playTone(659, 0.15, 'sine', 0.2, 0.12);
  playTone(784, 0.25, 'sine', 0.2, 0.24);
}
function playWrong() {
  playTone(220, 0.1, 'square', 0.15, 0);
  playTone(180, 0.1, 'square', 0.15, 0.1);
  playTone(140, 0.25, 'square', 0.15, 0.2);
}
function playTick() { playTone(880, 0.04, 'square', 0.06); }
function playUrgentTick() { playTone(1100, 0.05, 'square', 0.1); }
function playFanfare() {
  [523,659,784,1047,784,1047,1175,1047].forEach(function(f,i){ playTone(f, 0.18, 'sine', 0.2, i*0.13); });
}
function playCrowd() {
  if (muted) return;
  try {
    var bufSize = audioCtx.sampleRate * 0.6;
    var buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < bufSize; i++) data[i] = (Math.random()*2-1)*0.15;
    var src = audioCtx.createBufferSource();
    src.buffer = buf;
    var filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass'; filter.frequency.value = 800; filter.Q.value = 0.5;
    var g = audioCtx.createGain();
    g.gain.setValueAtTime(0.4, audioCtx.currentTime);
    g.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.6);
    src.connect(filter); filter.connect(g); g.connect(audioCtx.destination);
    src.start(); src.stop(audioCtx.currentTime + 0.65);
  } catch(e) {}
}
function playBetLock() {
  playTone(440, 0.08, 'sine', 0.15, 0);
  playTone(880, 0.15, 'sine', 0.2, 0.1);
}

function toggleMute() {
  muted = !muted;
  document.getElementById('btn-mute').textContent = muted ? '🔇' : '🔊';
}

document.addEventListener('click', function() {
  if (audioCtx.state === 'suspended') audioCtx.resume();
}, { once: true });

// ─── Screen helpers ───────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function(s){ s.classList.remove('active'); });
  document.getElementById(id).classList.add('active');
}

function showToast(msg, duration) {
  duration = duration || 3000;
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(function(){ t.classList.add('hidden'); }, duration);
}

// ─── Timer ────────────────────────────────────
function startVisualTimer(seconds, onTick) {
  clearInterval(timerInterval);
  var circle = document.getElementById('timer-circle');
  var text = document.getElementById('timer-text');
  var circumference = 2 * Math.PI * 40;
  var remaining = seconds;

  function update() {
    var pct = remaining / seconds;
    if (circle) {
      circle.style.strokeDasharray = (circumference * pct) + ' ' + circumference;
      circle.style.stroke = remaining <= 5 ? '#ff4444' : remaining <= 10 ? '#ff8800' : '#f97316';
    }
    if (text) text.textContent = remaining;
    if (onTick) onTick(remaining);
  }

  update();
  timerInterval = setInterval(function() {
    remaining--;
    update();
    if (remaining <= 0) clearInterval(timerInterval);
  }, 1000);
}

function stopVisualTimer() { clearInterval(timerInterval); }

// ─── Emoji reactions ──────────────────────────
function sendEmoji(emoji) { socket.emit('emoji_react', { emoji: emoji }); }

function spawnEmojiFloat(emoji, x, y) {
  var layer = document.getElementById('emoji-layer');
  var el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = emoji;
  el.style.left = x + '%';
  el.style.top = y + '%';
  layer.appendChild(el);
  setTimeout(function(){ el.remove(); }, 2500);
}

// ─── Room code ────────────────────────────────
function copyRoomCode() {
  var code = document.getElementById('room-code-display').textContent;
  navigator.clipboard.writeText(code).then(function(){ showToast('Room code copied!'); });
}

// ─── Betting helpers ──────────────────────────
function updateBetDisplay() {
  var slider = document.getElementById('bet-slider');
  myBet = parseInt(slider.value, 10) || 0;
  document.getElementById('bet-amount-display').textContent = myBet + ' pts';
}

function setBetPct(pct) {
  var slider = document.getElementById('bet-slider');
  slider.value = Math.round(parseInt(slider.max, 10) * pct);
  updateBetDisplay();
  if (pct === 1) playCrowd();
}

// ─── Career stats card renderer ──────────────
function renderCareerStats(statsData, container) {
  container.innerHTML = '';
  var card = document.createElement('div');
  card.className = 'career-stats-card';

  // Header
  var header = document.createElement('div');
  header.className = 'stats-header';
  header.innerHTML =
    '<div class="stats-mystery-name">??? ???</div>' +
    '<div class="career-badge-row">' +
      '<span class="career-badge">' + escHtml(statsData.position) + '</span>' +
      '<span class="career-badge">' + escHtml(statsData.height) + '</span>' +
      '<span class="career-badge">Draft ' + statsData.draftYear + '</span>' +
      '<span class="career-badge highlight">' + escHtml(statsData.career) + '</span>' +
    '</div>';
  card.appendChild(header);

  // Stats grid
  var grid = document.createElement('div');
  grid.className = 'stats-grid';
  var chips = [
    ['PPG', statsData.ppg], ['RPG', statsData.rpg], ['APG', statsData.apg],
    ['SPG', statsData.spg], ['BPG', statsData.bpg], ['FG%', statsData.fgPct + (String(statsData.fgPct).includes('%') ? '' : '%')]
  ];
  chips.forEach(function(c) {
    var chip = document.createElement('div');
    chip.className = 'stat-chip';
    chip.innerHTML = '<span class="stat-chip-val">' + c[1] + '</span><span class="stat-chip-label">' + c[0] + '</span>';
    grid.appendChild(chip);
  });
  card.appendChild(grid);

  // Meta row
  var meta = document.createElement('div');
  meta.className = 'career-meta-row';
  var rings = statsData.rings > 0 ? '🏆'.repeat(statsData.rings) : '—';
  var starsLabel = statsData.allStars === 0 ? '0' :
                   statsData.allStars === 1 ? '1×' :
                   statsData.allStars + '×';
  meta.innerHTML =
    '<div class="career-meta-item"><span class="career-meta-val">' + rings + '</span><span class="career-meta-label">Rings</span></div>' +
    '<div class="career-meta-item"><span class="career-meta-val">' + starsLabel + '</span><span class="career-meta-label">All-Stars</span></div>';
  card.appendChild(meta);

  container.appendChild(card);
}

// ─── Zoom-in image renderer ───────────────────
function renderZoomImage(imageUrl, container) {
  // Remove previous zoom element but keep the badge
  var old = container.querySelector('.zoom-container');
  if (old) old.remove();

  if (!imageUrl) {
    var noImg = document.createElement('div');
    noImg.className = 'img-placeholder';
    noImg.innerHTML = '<span>🏀</span>No image available';
    container.appendChild(noImg);
    return;
  }
  var wrap = document.createElement('div');
  wrap.className = 'zoom-container';
  var img = document.createElement('img');
  img.className = 'zoom-img';
  img.src = imageUrl;
  img.alt = 'Mystery player';
  img.draggable = false;
  wrap.appendChild(img);
  container.appendChild(wrap);

  clearTimeout(zoomRevealTimeout);
  zoomRevealTimeout = setTimeout(function() {
    wrap.classList.add('revealing');
    img.classList.add('revealing');
  }, 150);
}

// ─── Round 3: face → uniform reveal ──────────
function showR3Image(imageUrl, container, faceRevealTime) {
  var old = container.querySelector('.r3-wrap');
  if (old) old.remove();

  if (!imageUrl) {
    container.innerHTML += '<div class="img-placeholder"><span>🏀</span>No image</div>';
    return;
  }
  var wrap = document.createElement('div');
  wrap.className = 'r3-wrap';
  var img = document.createElement('img');
  img.className = 'r3-img';
  img.src = imageUrl;
  img.alt = 'Mystery player';
  img.draggable = false;
  wrap.appendChild(img);
  container.appendChild(wrap);

  // After faceRevealTime seconds, transition to uniform (full image)
  clearTimeout(zoomRevealTimeout);
  zoomRevealTimeout = setTimeout(function() {
    wrap.classList.add('phase2');
    img.classList.add('phase2');
    var badge = document.getElementById('zoom-pts-badge');
    if (badge) badge.textContent = '500 pts · UNIFORM';
  }, (faceRevealTime || 10) * 1000);
}

// ─── Photo image renderer ─────────────────────
function renderPhotoImage(imageUrl, container) {
  container.innerHTML = '';
  if (!imageUrl) {
    container.innerHTML = '<div class="img-placeholder"><span>🏀</span>No image available</div>';
    return;
  }
  var img = document.createElement('img');
  img.className = 'player-image';
  img.src = imageUrl;
  img.alt = 'Mystery player';
  img.draggable = false;
  container.appendChild(img);
}

// ─── Scoreboard ───────────────────────────────
function buildScoreboard(players, containerId) {
  var el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = players.map(function(p, i) {
    var score = p.totalScore !== undefined ? p.totalScore : p.score;
    var isMe = p.id === socket.id ? ' me' : '';
    var first = i === 0 ? ' first-place' : '';
    return '<div class="score-row' + isMe + first + '">' +
      '<span class="score-rank">' + (i+1) + '</span>' +
      '<span class="score-avatar">' + (p.avatar || '🏀') + '</span>' +
      '<span class="score-name">' + escHtml(p.name) + '</span>' +
      '<span class="score-pts">' + score + '</span>' +
      '</div>';
  }).join('');
}

function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─────────────────────────────────────────────
//  Name Entry
// ─────────────────────────────────────────────
document.getElementById('btn-enter').addEventListener('click', enterName);
document.getElementById('input-name').addEventListener('keydown', function(e){ if(e.key==='Enter') enterName(); });

function enterName() {
  var val = document.getElementById('input-name').value.trim();
  if (!val) { showToast('Enter your name first!'); return; }
  myName = val;
  showScreen('screen-lobby');
}

// ─────────────────────────────────────────────
//  Lobby
// ─────────────────────────────────────────────
document.getElementById('btn-create').addEventListener('click', function() {
  if (!myName) { showScreen('screen-name'); return; }
  socket.emit('create_room', { playerName: myName });
});
document.getElementById('btn-join').addEventListener('click', joinRoom);
document.getElementById('input-room-code').addEventListener('keydown', function(e){ if(e.key==='Enter') joinRoom(); });

function joinRoom() {
  var code = document.getElementById('input-room-code').value.trim().toUpperCase();
  if (!code) { showToast('Enter a room code!'); return; }
  if (!myName) { showScreen('screen-name'); return; }
  socket.emit('join_room', { playerName: myName, roomCode: code });
}

// ─────────────────────────────────────────────
//  Game controls
// ─────────────────────────────────────────────
document.getElementById('btn-start').addEventListener('click', function(){ socket.emit('start_game'); });
document.getElementById('btn-play-again').addEventListener('click', function(){ socket.emit('play_again'); });
document.getElementById('btn-back-lobby').addEventListener('click', function(){ showScreen('screen-lobby'); });

// ─────────────────────────────────────────────
//  Answer submission
// ─────────────────────────────────────────────
document.getElementById('btn-submit-answer').addEventListener('click', submitAnswer);
document.getElementById('answer-input').addEventListener('keydown', function(e){ if(e.key==='Enter') submitAnswer(); });

function submitAnswer() {
  if (answered) return;
  var val = document.getElementById('answer-input').value.trim();
  if (!val) return;
  answered = true;
  document.getElementById('answer-input').disabled = true;
  document.getElementById('btn-submit-answer').disabled = true;
  socket.emit('submit_answer', { answer: val });
}

// ─────────────────────────────────────────────
//  Bet lock
// ─────────────────────────────────────────────
document.getElementById('btn-lock-bet').addEventListener('click', function() {
  var amount = parseInt(document.getElementById('bet-slider').value, 10) || 0;
  socket.emit('submit_bet', { amount: amount });
  document.getElementById('btn-lock-bet').disabled = true;
  document.getElementById('bet-slider').disabled = true;
  document.querySelectorAll('.bet-quick .btn').forEach(function(b){ b.disabled = true; });
  document.getElementById('bet-locked-msg').style.display = 'block';
  playBetLock();
});

// ─────────────────────────────────────────────
//  Socket events
// ─────────────────────────────────────────────
socket.on('connect', function(){ console.log('Connected'); });

socket.on('error', function(data){ showToast('⚠️ ' + data.message, 4000); });

// ─── Room events ──────────────────────────────
socket.on('room_created', function(data) {
  document.getElementById('room-code-display').textContent = data.roomCode;
  showScreen('screen-waiting');
});

socket.on('room_joined', function(data) {
  document.getElementById('room-code-display').textContent = data.roomCode;
  showScreen('screen-waiting');
});

socket.on('game_loading', function() {
  // Host started — show loading state on the Start button
  var btn = document.getElementById('btn-start');
  if (btn) { btn.disabled = true; btn.textContent = 'Fetching players…'; }
});

socket.on('lobby_update', function(data) {
  var players = data.players;
  var me = players.find(function(p){ return p.id === socket.id; });
  var isHost = me && me.isHost;
  amHost = !!isHost;

  document.getElementById('btn-start').style.display = isHost ? 'block' : 'none';
  document.getElementById('waiting-msg').style.display = isHost ? 'none' : 'block';

  var list = document.getElementById('player-list');
  list.innerHTML = players.map(function(p) {
    var meClass = p.id === socket.id ? ' me' : '';
    return '<div class="player-lobby-item' + meClass + '">' +
      '<span class="avatar">' + (p.avatar || '🏀') + '</span>' +
      '<span class="name">' + escHtml(p.name) + '</span>' +
      (p.isHost ? '<span class="host-badge">HOST</span>' : '') +
      '</div>';
  }).join('');

  // If host pressed play again and we're on game end screen, go back to waiting
  if (document.getElementById('screen-game-end').classList.contains('active')) {
    myScore = 0; myStreak = 0;
    showScreen('screen-waiting');
  }
});

// ─── Round intro ──────────────────────────────
socket.on('round_intro', function(data) {
  currentRound = data.round;
  stopVisualTimer();
  clearInterval(betTimerInterval);

  document.getElementById('ri-round-label').textContent = 'ROUND ' + data.round + ' OF ' + data.total;
  document.getElementById('ri-name').textContent = data.name;
  document.getElementById('ri-desc').textContent = data.desc;
  document.getElementById('ri-icon').textContent = data.icon;

  var count = 5;
  document.getElementById('ri-countdown').textContent = 'Get Ready…';
  showScreen('screen-round-intro');

  var cd = setInterval(function() {
    count--;
    if (count > 0) {
      document.getElementById('ri-countdown').textContent = 'Starting in ' + count + '…';
      playTick();
    } else {
      clearInterval(cd);
    }
  }, 1000);
});

// ─── Betting ──────────────────────────────────
socket.on('betting_start', function(data) {
  var scores = data.scores;
  var timeLimit = data.timeLimit || 15;
  var myScoreNow = scores[socket.id] || 0;
  myScore = myScoreNow;
  myBet = 0;

  document.getElementById('bet-my-score').textContent = myScoreNow;
  var slider = document.getElementById('bet-slider');
  slider.max = myScoreNow;
  slider.value = 0;
  slider.disabled = false;
  document.getElementById('btn-lock-bet').disabled = false;
  document.querySelectorAll('.bet-quick .btn').forEach(function(b){ b.disabled = false; });
  document.getElementById('bet-locked-msg').style.display = 'none';
  document.getElementById('bet-amount-display').textContent = '0 pts';
  document.getElementById('bet-players-status').innerHTML = '';

  var remaining = timeLimit;
  document.getElementById('bet-timer-text').textContent = remaining;

  var bar = document.getElementById('bet-timer-bar');
  bar.style.transition = 'none';
  bar.style.width = '100%';
  showScreen('screen-betting');
  setTimeout(function() {
    bar.style.transition = 'width ' + timeLimit + 's linear';
    bar.style.width = '0%';
  }, 50);

  clearInterval(betTimerInterval);
  betTimerInterval = setInterval(function() {
    remaining--;
    document.getElementById('bet-timer-text').textContent = Math.max(0, remaining);
    if (remaining <= 3) playUrgentTick(); else playTick();
    if (remaining <= 0) clearInterval(betTimerInterval);
  }, 1000);
});

socket.on('bet_confirmed', function(data){ myBet = data.amount; });
socket.on('betting_end', function(){ clearInterval(betTimerInterval); });

// ─── Question ─────────────────────────────────
socket.on('question_start', function(data) {
  var questionNumber = data.questionNumber;
  var totalQuestions = data.totalQuestions;
  var round = data.round;
  var roundType = data.roundType;
  var imageUrl = data.imageUrl;
  var wikiTitle = data.wikiTitle;
  var hint = data.hint;
  var hintRevealTime = data.hintRevealTime || 0;
  var faceRevealTime = data.faceRevealTime || 10;
  var isBetQuestion = data.isBetQuestion;
  var statsData = data.statsData;

  currentRound = round;
  currentRoundType = roundType;
  answered = false;

  stopVisualTimer();

  var roundBadges = { 1: 'R1 📸', 2: 'R2 📊', 3: 'R3 🔍' };
  document.getElementById('q-round-badge').textContent = roundBadges[round] || ('R' + round);
  document.getElementById('q-number').textContent = 'Q' + questionNumber + '/' + totalQuestions;

  var betBadge = document.getElementById('q-bet-badge');
  if (isBetQuestion) betBadge.classList.remove('hidden'); else betBadge.classList.add('hidden');

  // Reset answer area
  var answerInput = document.getElementById('answer-input');
  answerInput.value = '';
  answerInput.disabled = false;
  document.getElementById('btn-submit-answer').disabled = false;
  document.getElementById('answer-input-wrap').style.display = 'flex';
  var banner = document.getElementById('answer-result-banner');
  banner.className = 'answer-result-banner hidden';
  banner.textContent = '';

  document.getElementById('answered-bar').innerHTML = '';

  // Hint — hidden initially for R1, revealed at hintRevealTime
  var hintBar = document.getElementById('hint-bar');
  hintBar.classList.add('hidden');
  clearTimeout(startVisualTimer._hintTimer);
  currentHint = hint || null;
  hintTimerStart = 0;
  hintTimerDelay = 0;
  if (hint && hintRevealTime > 0) {
    hintTimerStart = Date.now();
    hintTimerDelay = hintRevealTime * 1000;
    startVisualTimer._hintTimer = setTimeout(function() {
      hintTimerStart = 0; hintTimerDelay = 0;
      if (!answered) {
        document.getElementById('hint-text').textContent = 'Hint: ' + hint;
        hintBar.classList.remove('hidden');
        playTick();
      }
    }, hintRevealTime * 1000);
  } else if (hint && hintRevealTime === 0) {
    document.getElementById('hint-text').textContent = 'Hint: ' + hint;
    hintBar.classList.remove('hidden');
  }

  // Score / streak
  document.getElementById('q-score').textContent = myScore;
  var streakEl = document.getElementById('q-streak');
  if (myStreak >= 3) {
    streakEl.textContent = '🔥×' + myStreak;
    streakEl.style.display = 'inline';
  } else {
    streakEl.style.display = 'none';
  }

  // Content
  var imgContainer = document.getElementById('player-image-container');
  imgContainer.innerHTML = '';

  if (roundType === 'stats') {
    renderCareerStats(statsData, imgContainer);
  } else if (roundType === 'zoomin') {
    // Points badge
    var ptsBadge = document.createElement('div');
    ptsBadge.id = 'zoom-pts-badge';
    ptsBadge.className = 'zoom-pts-badge';
    ptsBadge.textContent = '1000 pts · FACE';
    imgContainer.appendChild(ptsBadge);

    if (imageUrl) {
      showR3Image(imageUrl, imgContainer, faceRevealTime);
    } else if (wikiTitle) {
      fetch('/api/image?wiki=' + encodeURIComponent(wikiTitle))
        .then(function(r){ return r.json(); })
        .then(function(body){ showR3Image(body.url || '', imgContainer, faceRevealTime); });
    } else {
      imgContainer.innerHTML += '<div class="img-placeholder"><span>🏀</span>No image</div>';
    }
  } else {
    // photo round
    if (imageUrl) {
      renderPhotoImage(imageUrl, imgContainer);
    } else if (wikiTitle) {
      fetch('/api/image?wiki=' + encodeURIComponent(wikiTitle))
        .then(function(r){ return r.json(); })
        .then(function(body){ renderPhotoImage(body.url || '', imgContainer); });
    } else {
      imgContainer.innerHTML = '<div class="img-placeholder"><span>🏀</span>No image</div>';
    }
  }

  // Show pause button for host
  var pauseBtn = document.getElementById('btn-pause');
  if (pauseBtn) pauseBtn.classList.toggle('hidden', !amHost);

  showScreen('screen-question');
  answerInput.focus();

  pausedTimerCallback = function(rem) {
    if (answered) return;
    if (rem <= 5) playUrgentTick();
    else if (rem <= 10) playTick();
  };
  startVisualTimer(20, pausedTimerCallback);
});

// ─── Answer feedback ──────────────────────────
socket.on('answer_feedback', function(data) {
  var banner = document.getElementById('answer-result-banner');
  banner.className = 'answer-result-banner';
  if (data.correct) {
    banner.textContent = '✓ Correct! ' + (data.correctAnswer || '');
    banner.classList.add('correct');
    playCorrect();
    playCrowd();
  } else {
    banner.textContent = '✗ Wrong!';
    banner.classList.add('wrong');
    playWrong();
  }
});

// ─── Player answered count ────────────────────
socket.on('player_answered', function(data) {
  var pct = Math.round((data.answeredCount / data.totalPlayers) * 100);
  document.getElementById('answered-bar').innerHTML =
    '<div class="answered-progress" style="width:' + pct + '%"></div>' +
    '<span class="answered-label">' + data.answeredCount + '/' + data.totalPlayers + ' answered</span>';
});

// ─── Answer reveal ────────────────────────────
socket.on('answer_reveal', function(data) {
  stopVisualTimer();

  var myResult = data.playerResults.find(function(p){ return p.id === socket.id; });
  if (myResult) { myScore = myResult.totalScore; myStreak = myResult.streak; }

  // Image
  var imgWrap = document.getElementById('reveal-image-wrap');
  imgWrap.innerHTML = '';
  if (data.imageUrl) {
    var rImg = document.createElement('img');
    rImg.src = data.imageUrl;
    rImg.alt = data.correctAnswer;
    imgWrap.appendChild(rImg);
  }

  // Player info
  var info = document.getElementById('reveal-player-info');
  var teamLine = '';
  if (data.team) teamLine = '<div class="reveal-player-meta">' + escHtml(data.team) + (data.years ? ' · ' + escHtml(data.years) : '') + '</div>';
  info.innerHTML = '<div class="reveal-player-name">' + escHtml(data.correctAnswer) + '</div>' + teamLine;

  // Fun fact — CSS already adds 💡 via ::before, so just set text
  var factEl = document.getElementById('reveal-fun-fact');
  if (data.funFact) {
    factEl.textContent = data.funFact;
    factEl.style.display = 'block';
  } else {
    factEl.style.display = 'none';
  }

  buildScoreboard(data.playerResults, 'reveal-scoreboard');

  if (myResult && myResult.correct) {
    confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 }, colors: ['#f97316','#ffffff','#1a1a2e'] });
  }

  // Countdown bar
  var revealBar = document.getElementById('reveal-timer-bar');
  revealBar.style.transition = 'none';
  revealBar.style.width = '100%';
  var revealSec = 20;
  document.getElementById('reveal-countdown').textContent = revealSec;
  setTimeout(function() {
    revealBar.style.transition = 'width 20s linear';
    revealBar.style.width = '0%';
  }, 50);
  var rt = setInterval(function() {
    revealSec--;
    document.getElementById('reveal-countdown').textContent = Math.max(0, revealSec);
    if (revealSec <= 0) clearInterval(rt);
  }, 1000);

  showScreen('screen-reveal');
});

// ─── Round end ────────────────────────────────
socket.on('round_end', function(data) {
  stopVisualTimer();
  playFanfare();

  document.getElementById('re-round-badge').textContent =
    'ROUND ' + data.round + ' COMPLETE — ' + data.roundName.toUpperCase();

  var mvpEl = document.getElementById('re-mvp');
  if (data.mvp) {
    mvpEl.innerHTML = '<div style="font-size:11px;letter-spacing:2px;opacity:.7">🏅 ROUND MVP</div>' +
      '<div style="font-size:20px;font-weight:800;margin-top:4px">' + escHtml(data.mvp) + '</div>';
    mvpEl.style.display = 'block';
  } else { mvpEl.style.display = 'none'; }

  var list = document.getElementById('re-standings');
  list.innerHTML = data.standings.map(function(p, i) {
    var meClass = p.id === socket.id ? ' me' : '';
    return '<div class="standing-row' + meClass + '">' +
      '<span class="standing-rank">' + (i+1) + '</span>' +
      '<span class="standing-avatar">' + (p.avatar||'🏀') + '</span>' +
      '<span class="standing-name">' + escHtml(p.name) + '</span>' +
      '<span class="standing-score">' + p.score + '</span>' +
      '<span class="standing-rscore">+' + p.roundScore + '</span>' +
      '</div>';
  }).join('');

  document.getElementById('re-next-label').textContent = data.nextRound
    ? 'Round ' + data.nextRound + ' starts in a moment…'
    : 'Final standings coming up…';

  showScreen('screen-round-end');
});

// ─── Game end ─────────────────────────────────
socket.on('game_end', function(data) {
  var standings = data.standings;
  stopVisualTimer();
  playFanfare();
  setTimeout(function() {
    confetti({ particleCount: 200, spread: 120, origin: { y: 0.5 }, colors: ['#f97316','#ffd700','#ffffff','#1a1a2e'] });
  }, 300);

  var winner = standings[0];
  var winnerEl = document.getElementById('ge-winner');
  if (winner) {
    var isMe = winner.id === socket.id;
    winnerEl.innerHTML =
      '<div class="ge-winner-avatar">' + (winner.avatar || '🏆') + '</div>' +
      '<div class="ge-winner-name">' + escHtml(winner.name) + (isMe ? ' 🎉' : '') + '</div>' +
      '<div class="ge-winner-score">' + winner.totalScore + ' pts</div>';
  }

  var geList = document.getElementById('ge-standings');
  geList.innerHTML = standings.map(function(p, i) {
    var meClass = p.id === socket.id ? ' me' : '';
    return '<div class="standing-row' + meClass + '">' +
      '<span class="standing-rank">' + (i+1) + '</span>' +
      '<span class="standing-avatar">' + (p.avatar||'🏀') + '</span>' +
      '<span class="standing-name">' + escHtml(p.name) + '</span>' +
      '<span class="standing-score">' + p.totalScore + '</span>' +
      '</div>';
  }).join('');

  // Round breakdown for local player
  var me = standings.find(function(p){ return p.id === socket.id; });
  var breakdown = document.getElementById('ge-round-breakdown');
  if (me && me.roundScores) {
    var labels = ['Hard Ballers','Career Stats','Zoom In'];
    breakdown.innerHTML = '<div class="ge-breakdown-title">Your Round Breakdown</div>' +
      '<div class="ge-breakdown-cols">' +
      me.roundScores.map(function(s,i){
        return '<div class="ge-breakdown-item">' +
          '<div class="ge-breakdown-label">' + labels[i] + '</div>' +
          '<div class="ge-breakdown-score">' + s + '</div>' +
          '</div>';
      }).join('') +
      '</div>';
    breakdown.style.display = 'block';
  } else {
    breakdown.style.display = 'none';
  }

  document.getElementById('btn-play-again').style.display = 'block';
  showScreen('screen-game-end');
});

// ─── Pause / Resume ──────────────────────────
function pauseGame() { socket.emit('pause_game'); }
function resumeGame() { socket.emit('resume_game'); }

socket.on('game_paused', function(data) {
  pausedTimerRemaining = data.remainingSeconds;
  stopVisualTimer();

  // Freeze hint timer — record remaining ms
  if (hintTimerStart > 0) {
    clearTimeout(startVisualTimer._hintTimer);
    var hintElapsed = Date.now() - hintTimerStart;
    hintTimerDelay = Math.max(0, hintTimerDelay - hintElapsed);
    hintTimerStart = 0;
  }

  document.getElementById('pause-overlay').classList.remove('hidden');
  var resumeBtn = document.getElementById('btn-resume');
  if (resumeBtn) resumeBtn.classList.toggle('hidden', !amHost);
  var pauseBtn = document.getElementById('btn-pause');
  if (pauseBtn) pauseBtn.classList.add('hidden');
});

socket.on('game_resumed', function(data) {
  document.getElementById('pause-overlay').classList.add('hidden');
  var pauseBtn = document.getElementById('btn-pause');
  if (pauseBtn) pauseBtn.classList.toggle('hidden', !amHost);

  // Restart visual timer with server-authoritative remaining time
  startVisualTimer(data.remainingSeconds, pausedTimerCallback);

  // Restart hint timer if it hadn't fired yet
  if (hintTimerDelay > 0 && currentHint && !answered) {
    hintTimerStart = Date.now();
    var hintDelaySnapshot = hintTimerDelay;
    var hintSnapshot = currentHint;
    startVisualTimer._hintTimer = setTimeout(function() {
      hintTimerStart = 0; hintTimerDelay = 0;
      if (!answered) {
        document.getElementById('hint-text').textContent = 'Hint: ' + hintSnapshot;
        document.getElementById('hint-bar').classList.remove('hidden');
        playTick();
      }
    }, hintDelaySnapshot);
  }
});

// ─── Emoji reactions (incoming) ──────────────
socket.on('emoji_reaction', function(data) {
  spawnEmojiFloat(data.emoji, 10 + Math.random()*80, 20 + Math.random()*60);
});
