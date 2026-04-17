// webrtc.js — peer video/audio for Remember That Dude
// Mesh topology via Socket.io signaling, STUN-only (free)

const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let localStream  = null;
let micEnabled   = true;
let camEnabled   = true;
let panelVisible = false;

const peers     = new Map(); // peerId -> RTCPeerConnection
const peerNames = new Map(); // peerId -> display name

// ── Init ───────────────────────────────────────────────────────────────────────

async function initWebRTC() {
  if (localStream) return; // already running
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (_) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    } catch (_2) {
      showToast('Camera/mic unavailable — playing without video', 3500);
      return;
    }
  }
  showPanel();
  attachLocalVideo();
  socket.emit('rtc_ready');
}

function showPanel() {
  const panel = document.getElementById('video-panel');
  panel.classList.remove('hidden');
  panelVisible = true;
}

function attachLocalVideo() {
  const tile = getOrCreateTile('local', myName || 'Me');
  const vid  = tile.querySelector('video');
  vid.srcObject = localStream;
  vid.muted     = true; // prevent echo
}

// ── Tiles ──────────────────────────────────────────────────────────────────────

function getOrCreateTile(id, name) {
  const strip = document.getElementById('video-strip');
  let tile = document.getElementById('vtile-' + id);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id        = 'vtile-' + id;

    const vid      = document.createElement('video');
    vid.autoplay   = true;
    vid.playsInline = true;
    vid.className  = id === 'local' ? 'video-el local-vid' : 'video-el';

    const lbl      = document.createElement('div');
    lbl.className  = 'video-label';
    lbl.textContent = name;

    tile.appendChild(vid);
    tile.appendChild(lbl);
    strip.appendChild(tile);
  }
  return tile;
}

function removeTile(peerId) {
  const tile = document.getElementById('vtile-' + peerId);
  if (tile) tile.remove();
}

// ── Peer connections ───────────────────────────────────────────────────────────

function createPeer(peerId) {
  if (peers.has(peerId)) return peers.get(peerId);

  const pc = new RTCPeerConnection(RTC_CONFIG);
  peers.set(peerId, pc);

  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('rtc_ice', { to: peerId, candidate });
  };

  pc.ontrack = ({ streams }) => {
    const stream = streams[0];
    const name   = peerNames.get(peerId) || '...';
    const tile   = getOrCreateTile(peerId, name);
    const vid    = tile.querySelector('video');
    if (vid.srcObject !== stream) vid.srcObject = stream;
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      closePeer(peerId);
    }
  };

  return pc;
}

function closePeer(peerId) {
  const pc = peers.get(peerId);
  if (pc) { try { pc.close(); } catch (_) {} peers.delete(peerId); }
  removeTile(peerId);
}

async function sendOffer(peerId) {
  const pc    = createPeer(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('rtc_offer', { to: peerId, offer });
}

// ── Signaling ──────────────────────────────────────────────────────────────────

// Sent when we join: list of peers already in the room → we initiate to them
socket.on('rtc_existing_peers', ({ peers: list }) => {
  list.forEach(peerId => sendOffer(peerId));
});

// A new peer just joined → they will offer us, just wait
socket.on('rtc_peer_ready', ({ peerId }) => {
  peerNames.set(peerId, '...');
});

socket.on('rtc_offer', async ({ from, offer }) => {
  const pc = createPeer(from);
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('rtc_answer', { to: from, answer });
});

socket.on('rtc_answer', async ({ from, answer }) => {
  const pc = peers.get(from);
  if (pc) await pc.setRemoteDescription(answer);
});

socket.on('rtc_ice', async ({ from, candidate }) => {
  const pc = peers.get(from);
  if (pc) { try { await pc.addIceCandidate(candidate); } catch (_) {} }
});

// Hide video (not audio) during questions — show on reveals and game end
socket.on('question_start',   () => hidePanel());
socket.on('deep_cut_start',   () => hidePanel());
socket.on('answer_reveal',    () => restorePanel());
socket.on('deep_cut_reveal',  () => restorePanel());

function hidePanel() {
  const panel = document.getElementById('video-panel');
  if (panel && !panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
  }
}

function restorePanel() {
  const panel = document.getElementById('video-panel');
  if (panel && panelVisible) {
    panel.classList.remove('hidden');
  }
}

// Start WebRTC when entering the waiting room
socket.on('room_created', () => initWebRTC());
socket.on('room_joined',  () => initWebRTC());

// Sync names and clean up departed peers from lobby updates
socket.on('lobby_update', ({ players }) => {
  players.forEach(p => {
    peerNames.set(p.id, p.name);
    const tile = document.getElementById('vtile-' + p.id);
    if (tile) {
      const lbl = tile.querySelector('.video-label');
      if (lbl) lbl.textContent = p.name;
    }
  });
  // Update local tile label in case myName just resolved
  const localTile = document.getElementById('vtile-local');
  if (localTile && myName) {
    const lbl = localTile.querySelector('.video-label');
    if (lbl) lbl.textContent = myName;
  }
  // Close connections to players who left
  const ids = new Set(players.map(p => p.id));
  [...peers.keys()].forEach(id => { if (!ids.has(id)) closePeer(id); });
});

// ── Controls ───────────────────────────────────────────────────────────────────

function toggleMic() {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
  document.getElementById('btn-mic').textContent = micEnabled ? '🎤' : '🔇';
}

function toggleCam() {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => { t.enabled = camEnabled; });
  document.getElementById('btn-cam').textContent = camEnabled ? '📷' : '🚫';
  const localVid = document.querySelector('#vtile-local video');
  if (localVid) localVid.style.opacity = camEnabled ? '1' : '0.25';
}

function toggleVideoPanel() {
  const panel = document.getElementById('video-panel');
  const btn   = document.getElementById('btn-vp-toggle');
  panel.classList.toggle('collapsed');
  btn.textContent = panel.classList.contains('collapsed') ? '+' : '−';
}
