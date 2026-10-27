'use strict';
// PremCall — browser client.
//
// Everyone connects directly to everyone else (a "mesh"). Each connection has
// three fixed slots: 0 = mic, 1 = camera, 2 = screen share. Because the slots
// are fixed, starting/stopping a share or switching devices never needs the
// call to be renegotiated — we just swap what's in the slot.

const SLOT = { MIC: 0, CAM: 1, SCREEN: 2 };
const REACTIONS = ['⚽', '🔥', '😱', '👏', '😂', '🟥'];
const AUDIO_OPTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const VIDEO_OPTS = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } };

// STUN/TURN servers arrive from our server in the 'joined' message, so relay
// credentials only go to people who are actually in a room.
let ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const hasTurn = () => ICE_SERVERS.some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));

const $ = (s) => document.querySelector(s);
const socket = io({ autoConnect: false });

// id -> { pc, name, queue, pending, camStream, screenStream, state, volume, slotsReady }
const peers = new Map();
let localStream = null;       // mic + camera
let screenTrack = null;       // set while you're sharing
let localScreenStream = null;
let audioCtx = null;
let myName = '';
let myId = null;              // our socket id (the local tile is always 'me')
let pinnedId = null;          // who you've pinned to the telly (only you see this)
let shareOrder = [];          // who's sharing, most recent last
let unread = 0;
let activeTab = 'chat';
let speakerId = '';

const micTrack = () => localStream?.getAudioTracks()[0] || null;
const cameraTrack = () => localStream?.getVideoTracks()[0] || null;
const localState = () => ({
  mic: micTrack()?.enabled ?? false,
  cam: cameraTrack()?.enabled ?? false,
  screen: !!screenTrack,
});

// =====================================================================
// Lobby
// =====================================================================
const params = new URLSearchParams(location.search);
$('#room').value = params.get('room') || 'matchday-' + Math.random().toString(36).slice(2, 6);
try { $('#name').value = localStorage.getItem('mc-name') || ''; } catch {}

// Try camera + mic, then mic only, then camera only. If nothing works you can
// still join to watch, listen and chat. A camera already in use by another app
// (Zoom, Teams…) or a laptop without a webcam no longer stops you joining.
async function startPreview() {
  const joinBtn = $('#joinBtn');
  joinBtn.disabled = true;
  joinBtn.textContent = 'Waiting for camera and mic…';
  const attempts = [
    { video: VIDEO_OPTS, audio: AUDIO_OPTS },   // Echo cancellation + noise suppression
    { audio: AUDIO_OPTS },                      // keep TV commentary out of the call.
    { video: VIDEO_OPTS },
  ];
  let lastError = null;
  for (const constraints of attempts) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (err) {
      lastError = err;
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') break; // asking again won't help
    }
  }
  const hasMic = !!localStream?.getAudioTracks().length;
  const hasCam = !!localStream?.getVideoTracks().length;
  if (!localStream) localStream = new MediaStream(); // watch-only
  $('#preview').srcObject = hasCam ? localStream : null;
  $('#preview').closest('.preview-wrap').classList.toggle('no-camera', !hasCam);
  // Camera starts off in the waiting room; turn it on here (or later in the call).
  if (hasCam) cameraTrack().enabled = false;
  $('#previewCamBtn').hidden = !hasCam;
  renderPreviewCam();

  const note = $('#lobbyError');
  note.classList.toggle('info', hasMic || hasCam);
  if (hasMic && hasCam) note.textContent = '';
  else if (hasMic) note.textContent = 'No camera available (it may be in use by another app). You\'ll join with audio only.';
  else if (hasCam) note.textContent = 'No microphone available. You\'ll join with video only.';
  else if (lastError?.name === 'NotAllowedError') {
    note.textContent = 'Camera and mic are blocked. You can still join to watch, listen and chat, or allow access in your browser and reload.';
  } else {
    note.textContent = 'No camera or microphone found. You can still join to watch, listen and chat.';
  }
  joinBtn.disabled = false;
  joinBtn.textContent = 'Join the room';
}
startPreview();

function renderPreviewCam() {
  const on = !!cameraTrack()?.enabled;
  const btn = $('#previewCamBtn');
  btn.textContent = on ? '📷 Turn camera off' : '📷 Turn camera on';
  btn.setAttribute('aria-pressed', String(on));
  btn.classList.toggle('on', on);
  $('#preview').closest('.preview-wrap').classList.toggle('cam-off', !on);
}

$('#previewCamBtn').onclick = () => {
  const track = cameraTrack();
  if (!track) return;
  track.enabled = !track.enabled;
  renderPreviewCam();
};

let joinStarted = false;
$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (joinStarted) return;           // ignore double-clicks
  if (!localStream) {                // the camera/mic prompt is still open
    $('#lobbyError').textContent = 'Answer the camera and microphone prompt first (or block it to join without them).';
    return;
  }
  joinStarted = true;
  $('#joinBtn').disabled = true;

  myName = $('#name').value.trim() || 'Fan';
  const room = $('#room').value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 64);
  myRoom = room;
  try { localStorage.setItem('mc-name', myName); } catch {}
  history.replaceState(null, '', '?room=' + encodeURIComponent(room));

  audioCtx = new (window.AudioContext || window.webkitAudioContext)(); // needs a click to start
  audioCtx.resume?.();
  // Some browsers suspend audio again later; any click wakes it up.
  document.addEventListener('pointerdown', () => { if (audioCtx.state !== 'running') audioCtx.resume(); });
  $('#roomLabel').textContent = room;
  $('#lobby').hidden = true;
  $('#call').hidden = false;
  document.body.classList.remove('lobby');
  setMode('match');

  addTile('me', myName + ' (you)', true);
  setTileStream('me', localStream);
  applyTileState('me', localState()); // join with the camera as you left it in the lobby
  buildReactionTray();
  renderStage();

  socket.connect(); // joins the room as soon as the connection is up (see 'connect')
});

// =====================================================================
// Joining, and rejoining after the connection drops
// =====================================================================
// Socket.io reconnects by itself after a Wi-Fi blip, laptop sleep or a server
// restart, but as a brand-new connection that isn't in any room. So on every
// (re)connect we drop the old video connections, which are dead or soon will
// be, and join the room again; everyone then reconnects to us as normal.
let myRoom = '';
let joinedBefore = false;

socket.on('connect', () => {
  if (!myRoom) return;
  if (joinedBefore) {
    [...peers.keys()].forEach(closePeer);
  }
  socket.emit('join', { room: myRoom, name: myName });
});

socket.on('join-error', ({ message }) => toast(message));

// =====================================================================
// Video tiles
// =====================================================================
const tileEl = (id) => document.getElementById('tile-' + id);

// The first visible character, keeping emoji (and flags, skin tones…) whole.
function firstCharacter(name) {
  const text = (name || '?').trim() || '?';
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)[Symbol.iterator]().next().value.segment;
  }
  return Array.from(text)[0];
}
const displayName = (id) => (id === 'me' ? 'You' : peers.get(id)?.name || 'Someone');

function addTile(id, name, isLocal = false) {
  let tile = tileEl(id);
  if (tile) return tile;
  tile = document.createElement('div');
  tile.className = 'tile' + (isLocal ? ' local' : '');
  tile.id = 'tile-' + id;
  tile.dataset.id = id;
  tile.dataset.initial = firstCharacter(name).toUpperCase();
  tile.innerHTML =
    '<video autoplay playsinline></video>' +
    '<canvas class="delayed-view"></canvas>' +
    '<div class="label">' +
      '<span class="delay-badge" title="Held back so their reactions match your TV"></span>' +
      '<span class="mute-icon" title="Muted">🔇</span>' +
      '<span class="share-icon" title="Sharing their screen">🖥️</span>' +
      '<span class="name"></span>' +
    '</div>' +
    '<button class="pin-btn" title="Pin to the telly">📌</button>' +
    '<div class="float-layer"></div>';
  tile.querySelector('.name').textContent = name;
  // Video elements are always muted: you never hear your own mic, and other
  // people's audio plays through Web Audio (see attachAudio) so it can be delayed.
  tile.querySelector('video').muted = true;
  tile.querySelector('.pin-btn').onclick = (e) => { e.stopPropagation(); togglePin(id); };
  tile.ondblclick = () => togglePin(id);
  $('#tiles').appendChild(tile);
  updateCount();
  return tile;
}

function setTileStream(id, stream) {
  const tile = tileEl(id);
  if (!tile || !stream) return;
  const video = tile.querySelector('video');
  if (video.srcObject !== stream) video.srcObject = stream;
  if (id === 'me') watchSpeaking(tile, stream);
  else attachAudio(id, stream);
}

// =====================================================================
// Other people's audio: source -> (delay) -> volume -> speakers
// The delay is only switched on by the spoiler shield (sync.js).
// =====================================================================
function attachAudio(id, stream) {
  const peer = peers.get(id);
  const track = stream.getAudioTracks()[0];
  if (!peer || !track || !audioCtx) return;
  if (peer.audio?.track === track) return;
  try {
    peer.audio?.source.disconnect();
    const audio = peer.audio || { gain: audioCtx.createGain(), delay: null, seconds: 0 };
    audio.track = track;
    audio.source = audioCtx.createMediaStreamSource(new MediaStream([track]));
    audio.gain.gain.value = peer.volume;
    if (!peer.audio) audio.gain.connect(audioCtx.destination);
    if (peer.pendingDelay != null) { audio.seconds = peer.pendingDelay; peer.pendingDelay = null; }
    peer.audio = audio;
    routeAudio(peer);
    watchSpeaking(tileEl(id), null, audio.gain); // ring follows what you hear, delay included
  } catch (err) {
    console.warn('Web Audio unavailable, playing audio directly', err);
    const video = tileEl(id)?.querySelector('video');
    if (video) { video.muted = false; video.volume = peer.volume; }
  }
}

function routeAudio(peer) {
  const a = peer.audio;
  if (!a?.source) return;
  a.source.disconnect();
  if (a.delay) a.delay.disconnect();
  if (a.seconds > 0) {
    // A delay line only exists while needed: each one holds minutes of audio.
    if (!a.delay || a.delay._max < a.seconds) {
      const max = Math.min(179, Math.ceil(a.seconds * 1.5) + 10);
      a.delay = audioCtx.createDelay(max);
      a.delay._max = max;
    }
    a.delay.delayTime.value = a.seconds;
    a.source.connect(a.delay);
    a.delay.connect(a.gain);
  } else {
    a.delay = null;
    a.source.connect(a.gain);
  }
}

// Hold back someone's audio by this many seconds (0 = live).
function setAudioDelay(id, seconds) {
  const peer = peers.get(id);
  if (!peer?.audio) { if (peer) peer.pendingDelay = seconds; return; }
  if (Math.abs((peer.audio.seconds || 0) - seconds) < 0.05) return;
  peer.audio.seconds = seconds;
  routeAudio(peer);
}

function removeTile(id) {
  tileEl(id)?.remove();
  updateCount();
}

function updateCount() {
  const n = $('#tiles').children.length;
  $('#tiles').dataset.count = n;
  $('#countLabel').textContent = n;
}

function applyTileState(id, state) {
  const tile = tileEl(id);
  if (!tile) return;
  tile.classList.toggle('muted', !state.mic);
  tile.classList.toggle('cam-off', !state.cam);
  tile.classList.toggle('sharing', !!state.screen);
}

// Green ring around whoever is talking (or shouting at the ref).
function watchSpeaking(tile, stream, node = null) {
  const track = node || stream?.getAudioTracks()[0];
  if (!tile || !audioCtx || !track || tile._speakTrack === track) return;
  tile._speakTrack = track;
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  try { tile._speakSource?.disconnect(); } catch {}
  if (node) {
    node.connect(analyser);
    tile._speakSource = null;
  } else {
    tile._speakSource = audioCtx.createMediaStreamSource(new MediaStream([track]));
    tile._speakSource.connect(analyser);
  }
  const buf = new Uint8Array(analyser.fftSize);
  const tick = () => {
    if (!tile.isConnected || tile._speakTrack !== track) return; // tile gone or device switched
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
    tile.classList.toggle('speaking', Math.sqrt(sum / buf.length) > 0.04 && !tile.classList.contains('muted'));
    requestAnimationFrame(tick);
  };
  tick();
}

// =====================================================================
// The telly (stage): pinned person, or whoever is sharing
// =====================================================================
function screenStreamOf(id) {
  if (id === 'me') return screenTrack ? localScreenStream : null;
  const p = peers.get(id);
  return p?.state.screen && p.screenStream ? p.screenStream : null;
}
const cameraStreamOf = (id) => (id === 'me' ? localStream : peers.get(id)?.camStream || null);
const exists = (id) => id === 'me' || peers.has(id);

function stageSource() {
  if (pinnedId && exists(pinnedId)) {
    const scr = screenStreamOf(pinnedId); // pinning a sharer shows their screen
    if (scr) return { id: pinnedId, stream: scr, kind: 'screen' };
    return { id: pinnedId, stream: cameraStreamOf(pinnedId), kind: 'camera' };
  }
  const sharer = [...shareOrder].reverse().find((id) => screenStreamOf(id));
  return sharer ? { id: sharer, stream: screenStreamOf(sharer), kind: 'screen' } : null;
}

function renderStage() {
  const src = stageSource();
  const video = $('#stageVideo');
  document.body.classList.toggle('has-stage', !!src);
  $('#pitch').classList.toggle('screen', src?.kind === 'screen');
  $('#pitch').classList.toggle('mirror', src?.kind === 'camera' && src.id === 'me');
  if (!src) video.srcObject = null;
  else if (video.srcObject !== src.stream) video.srcObject = src.stream;

  $('#stageLabel').textContent = !src ? ''
    : src.kind === 'screen' ? (src.id === 'me' ? 'Your screen' : `${displayName(src.id)}'s screen`)
    : `📌 ${displayName(src.id)}`;
  $('#unpinBtn').hidden = !pinnedId;
  document.querySelectorAll('.tile').forEach((t) => t.classList.toggle('pinned', t.dataset.id === pinnedId));
  if (typeof syncStage === 'function') syncStage(src);
  renderPeople();
}

function togglePin(id) {
  pinnedId = pinnedId === id ? null : id;
  renderStage();
}
$('#unpinBtn').onclick = () => togglePin(pinnedId);

function noteSharing(id, on, announce = true) {
  shareOrder = shareOrder.filter((x) => x !== id);
  if (on) shareOrder.push(id);
  if (on && announce && id !== 'me') {
    toast(pinnedId ? `${displayName(id)} is sharing. Unpin to watch.` : `${displayName(id)} is sharing their screen`);
  }
  renderStage();
}

$('#fullBtn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('#pitch').requestFullscreen?.().catch(() => {});
};

// =====================================================================
// WebRTC connections
// =====================================================================
function createPeer(id, name, initiator, state = {}) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peer = {
    pc, name,
    queue: Promise.resolve(),
    pending: [],
    camStream: new MediaStream(),
    screenStream: null,
    state: { mic: true, cam: true, screen: false, ...state },
    volume: 1,
    slotsReady: false,
  };
  peers.set(id, peer);

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } });
  };

  // Which slot did this track arrive on? Mic/camera go to their tile, screen to the telly.
  pc.ontrack = (e) => {
    const slot = pc.getTransceivers().indexOf(e.transceiver);
    if (slot === SLOT.SCREEN) {
      peer.screenStream = new MediaStream([e.track]);
      renderStage();
    } else {
      peer.camStream.getTracks()
        .filter((t) => t.kind === e.track.kind)
        .forEach((t) => peer.camStream.removeTrack(t));
      peer.camStream.addTrack(e.track);
      setTileStream(id, peer.camStream);
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    const tile = tileEl(id);
    if (tile) tile.dataset.state = state;
    clearTimeout(peer.restartTimer);
    if (state === 'connected') {
      peer.restarts = 0;
      peer.gaveUp = false;
      capBitrates(pc);
    } else if (state === 'disconnected') {
      // Often a brief network blip that heals itself; if not, restart.
      peer.restartTimer = setTimeout(() => restartConnection(id), 5000);
    } else if (state === 'failed') {
      restartConnection(id);
    }
  };

  addTile(id, name);
  applyTileState(id, peer.state);
  if (peer.state.screen) noteSharing(id, true, false);

  if (initiator) {
    // The caller creates the three slots; the other side fills them when the offer arrives.
    pc.addTransceiver(micTrack() || 'audio', { direction: 'sendrecv', streams: [localStream] });
    pc.addTransceiver(cameraTrack() || 'video', { direction: 'sendrecv', streams: [localStream] });
    pc.addTransceiver(screenTrack || 'video', { direction: 'sendrecv' });
    peer.slotsReady = true;
    enqueue(peer, async () => {
      await pc.setLocalDescription(await pc.createOffer());
      socket.emit('signal', { to: id, data: { description: pc.localDescription } });
    });
  }
  return peer;
}

async function fillSlots(peer) {
  const tracks = [micTrack(), cameraTrack(), screenTrack];
  const transceivers = peer.pc.getTransceivers();
  for (let i = 0; i < 3 && i < transceivers.length; i++) {
    transceivers[i].direction = 'sendrecv';
    await transceivers[i].sender.replaceTrack(tracks[i] || null);
  }
  peer.slotsReady = true;
}

// Limit how much video we send each person. Faces don't need HD, and every
// relayed byte counts against the TURN allowance. Caps survive track swaps.
const MAX_BITRATE = { [SLOT.CAM]: 400_000, [SLOT.SCREEN]: 1_200_000 }; // bits per second

async function capBitrates(pc) {
  const transceivers = pc.getTransceivers();
  for (const [slot, maxBitrate] of Object.entries(MAX_BITRATE)) {
    const sender = transceivers[slot]?.sender;
    if (!sender) continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      if (params.encodings[0].maxBitrate === maxBitrate) continue;
      params.encodings[0].maxBitrate = maxBitrate;
      await sender.setParameters(params);
    } catch (err) {
      console.warn('Could not cap bitrate', err);
    }
  }
}

// Put a new track (or nothing) into one slot on every connection.
async function replaceSlot(slot, track) {
  await Promise.all([...peers.values()].map((peer) => {
    if (!peer.slotsReady) return null; // will pick up the current track when it connects
    const tr = peer.pc.getTransceivers()[slot];
    return tr ? tr.sender.replaceTrack(track).catch(console.error) : null;
  }));
}

// ICE restart: find a new network route without tearing the call down.
// Only one side starts it (the one with the smaller id) so the two offers can't collide.
const MAX_RESTARTS = 3;
function restartConnection(id) {
  const peer = peers.get(id);
  if (!peer || !myId || !['disconnected', 'failed'].includes(peer.pc.connectionState)) return;
  if ((peer.restarts || 0) >= MAX_RESTARTS) {
    if (peer.pc.connectionState === 'failed' && !peer.gaveUp) {
      peer.gaveUp = true;
      toast(hasTurn()
        ? `Couldn't reach ${peer.name}. Try reloading both pages.`
        : `Couldn't reach ${peer.name}. This app needs a TURN relay set up (see README).`);
    }
    return;
  }
  if (myId > id) {
    // The other side will restart; check again later in case it can't.
    peer.restartTimer = setTimeout(() => restartConnection(id), 8000);
    return;
  }
  peer.restarts = (peer.restarts || 0) + 1;
  enqueue(peer, async () => {
    if (peer.pc.signalingState !== 'stable') return;
    await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart: true }));
    socket.emit('signal', { to: id, data: { description: peer.pc.localDescription } });
  });
  peer.restartTimer = setTimeout(() => restartConnection(id), 10000); // try again if it doesn't take
}

// Process each peer's signaling messages strictly in order.
function enqueue(peer, fn) {
  peer.queue = peer.queue.then(fn).catch((err) => console.error('signaling error', err));
}

function closePeer(id) {
  const peer = peers.get(id);
  try { peer?.audio?.source?.disconnect(); peer?.audio?.delay?.disconnect(); peer?.audio?.gain.disconnect(); } catch {}
  if (typeof onPeerClosed === 'function') onPeerClosed(id);
  peer?.pc.close();
  peers.delete(id);
  removeTile(id);
  shareOrder = shareOrder.filter((x) => x !== id);
  if (pinnedId === id) pinnedId = null;
  renderStage();
}

// =====================================================================
// Signaling events
// =====================================================================
socket.on('joined', ({ id, peers: list, ice, history: past = [] }) => {
  myId = id;
  if (Array.isArray(ice) && ice.length) ICE_SERVERS = ice;
  document.body.classList.remove('offline');
  if (!joinedBefore) {
    past.forEach((m) => addChatMessage(m, { silent: true }));
    addSystemMessage('You joined the room');
    toast(list.length ? `You're in. ${list.length} already here.` : "You're first in. Share the invite link!");
  } else {
    addSystemMessage('Reconnected');
    toast('Reconnected');
  }
  joinedBefore = true;
  list.forEach((p) => createPeer(p.id, p.name, true, p.state)); // newcomer calls everyone
  sendState();
});

socket.on('peer-joined', ({ id, name, state }) => {
  if (!peers.has(id)) createPeer(id, name, false, state);
  addSystemMessage(`${name} joined`);
  toast(`${name} joined`);
  sendState(); // so they see whether we're muted/sharing
});

socket.on('signal', ({ from, name, data }) => {
  const peer = peers.get(from) || createPeer(from, name, false);
  const { pc } = peer;
  enqueue(peer, async () => {
    if (data.description) {
      await pc.setRemoteDescription(data.description);
      for (const c of peer.pending.splice(0)) await addCandidate(pc, c);
      if (data.description.type === 'offer') {
        if (!peer.slotsReady) await fillSlots(peer);
        await pc.setLocalDescription(await pc.createAnswer());
        socket.emit('signal', { to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await addCandidate(pc, data.candidate);
      else peer.pending.push(data.candidate);
    }
  });
});

// A single bad network candidate shouldn't stop the rest of the connection setup.
async function addCandidate(pc, candidate) {
  try {
    await pc.addIceCandidate(candidate);
  } catch (err) {
    console.warn('Skipped a network candidate:', err.message);
  }
}

socket.on('peer-state', ({ id, mic, cam, screen }) => {
  const peer = peers.get(id);
  if (!peer) return;
  const wasSharing = peer.state.screen;
  peer.state = { mic, cam, screen };
  applyTileState(id, peer.state);
  if (screen !== wasSharing) noteSharing(id, screen);
  else renderPeople();
});

socket.on('peer-left', ({ id }) => {
  const name = peers.get(id)?.name;
  closePeer(id);
  if (name) { toast(`${name} left`); addSystemMessage(`${name} left`); }
});

socket.on('room-full', ({ max }) => {
  toast(`That room is full (max ${max}). Try another room name.`);
  setTimeout(() => location.reload(), 2500);
});

socket.on('disconnect', (reason) => {
  if (reason === 'io client disconnect') return; // you pressed Leave
  document.body.classList.add('offline');
  toast('Connection lost. Reconnecting…');
  // If the server closed the connection on purpose, socket.io won't retry by itself.
  if (reason === 'io server disconnect') setTimeout(() => socket.connect(), 1000);
});

// =====================================================================
// Mic / camera / screen share
// =====================================================================
function sendState() {
  const state = localState();
  socket.emit('state', state);
  applyTileState('me', state);
  setBtn('#micBtn', state.mic, 'Mic on', 'Muted', micTrack() ? null : 'No mic');
  setBtn('#camBtn', state.cam, 'Camera on', 'Camera off', cameraTrack() ? null : 'No camera');
  $('#shareBtn').classList.toggle('sharing', state.screen);
  $('#shareBtn').setAttribute('aria-pressed', String(state.screen));
  $('#shareBtn').querySelector('span').textContent = state.screen ? 'Stop sharing' : 'Share screen';
  renderPeople();
}

function setBtn(sel, on, onText, offText, missingText = null) {
  const b = $(sel);
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
  b.disabled = !!missingText;
  b.querySelector('span').textContent = missingText || (on ? onText : offText);
}

function toggleTrack(kind) {
  const track = kind === 'audio' ? micTrack() : cameraTrack();
  if (!track) return;
  track.enabled = !track.enabled;
  sendState();
}
$('#micBtn').onclick = () => toggleTrack('audio');
$('#camBtn').onclick = () => toggleTrack('video');

async function startShare() {
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false, // your mic already carries your voice; shared audio would echo the TV
    });
    screenTrack = display.getVideoTracks()[0];
    screenTrack.contentHint = 'detail'; // keep text (stats, tables) sharp
    screenTrack.onended = stopShare;    // the browser's own "Stop sharing" bar
    localScreenStream = new MediaStream([screenTrack]);
    await replaceSlot(SLOT.SCREEN, screenTrack);
    noteSharing('me', true);
    sendState();
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast('Screen sharing failed: ' + err.message);
  }
}

async function stopShare() {
  if (!screenTrack) return;
  const t = screenTrack;
  screenTrack = null;
  localScreenStream = null;
  t.onended = null;
  t.stop();
  await replaceSlot(SLOT.SCREEN, null);
  noteSharing('me', false);
  sendState();
}

const canShare = !!navigator.mediaDevices?.getDisplayMedia;
if (!canShare) $('#shareBtn').hidden = true; // phones don't support it
$('#shareBtn').onclick = () => (screenTrack ? stopShare() : startShare());

// =====================================================================
// Chat
// =====================================================================
const panelOpen = () => !$('#panel').hidden;

function addChatMessage({ id, name, text, ts }, { silent = false } = {}) {
  const mine = id === myId;
  const li = document.createElement('li');
  li.className = 'msg' + (mine ? ' mine' : '');
  const head = document.createElement('div');
  head.className = 'msg-head';
  const who = document.createElement('strong');
  who.textContent = mine ? 'You' : name;
  const time = document.createElement('time');
  time.textContent = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  head.append(who, time);
  const body = document.createElement('div');
  body.className = 'msg-body';
  appendLinkified(body, text);
  li.append(head, body);
  appendToChat(li, mine);

  if (!silent && !mine && !(panelOpen() && activeTab === 'chat')) {
    unread++;
    updateBadge();
  }
}

function addSystemMessage(text) {
  const li = document.createElement('li');
  li.className = 'msg system';
  li.textContent = text;
  appendToChat(li, false);
}

function appendToChat(li, forceScroll) {
  const list = $('#chatList');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.appendChild(li);
  if (nearBottom || forceScroll) list.scrollTop = list.scrollHeight;
}

// Turn URLs into links without ever inserting raw HTML.
function appendLinkified(el, text) {
  text.split(/(https?:\/\/[^\s]+)/g).forEach((part, i) => {
    if (i % 2 === 1) {
      const a = document.createElement('a');
      a.href = part;
      a.textContent = part;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      el.appendChild(a);
    } else if (part) {
      el.appendChild(document.createTextNode(part));
    }
  });
}

function updateBadge() {
  const b = $('#unreadBadge');
  b.hidden = unread === 0;
  b.textContent = unread > 99 ? '99+' : unread;
}

// Spoiler shield: messages and reactions from people whose TV is ahead of yours
// arrive when your TV catches up (see sync.js).
const heldFor = (id) => (typeof spoilerDelayFor === 'function' && id !== myId ? spoilerDelayFor(id) : 0);
function afterShield(id, fn) {
  const s = heldFor(id);
  if (s > 0) setTimeout(fn, s * 1000);
  else fn();
}

socket.on('chat', (msg) => afterShield(msg.id, () => addChatMessage(msg)));

$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat', { text });
  input.value = '';
});

// =====================================================================
// Side panel (chat + people)
// =====================================================================
function openPanel(tab) {
  $('#panel').hidden = false;
  document.body.classList.add('panel-open');
  setTab(tab);
}
function closePanel() {
  $('#panel').hidden = true;
  document.body.classList.remove('panel-open');
  if (typeof placeMatchCentre === 'function') placeMatchCentre();
}
function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#chatPane').hidden = tab !== 'chat';
  $('#matchPane').hidden = tab !== 'match';
  $('#foodPane').hidden = tab !== 'food';
  if (tab === 'food' && typeof onFoodTabOpened === 'function') onFoodTabOpened();
  $('#peoplePane').hidden = tab !== 'people';
  if (typeof placeMatchCentre === 'function') placeMatchCentre();
  if (tab === 'chat') {
    unread = 0;
    updateBadge();
    const list = $('#chatList');
    list.scrollTop = list.scrollHeight;
    if (window.matchMedia('(pointer: fine)').matches) $('#chatInput').focus();
  } else if (tab === 'people') {
    renderPeople();
  }
}
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => setTab(t.dataset.tab); });
$('#closePanel').onclick = closePanel;
$('#chatBtn').onclick = () => (panelOpen() && activeTab === 'chat' ? closePanel() : openPanel('chat'));
$('#countBtn').onclick = () => (panelOpen() && activeTab === 'people' ? closePanel() : openPanel('people'));

function renderPeople() {
  const list = $('#peopleList');
  if (!list || !panelOpen() || activeTab !== 'people') return;
  if (list.contains(document.activeElement) && document.activeElement.type === 'range') return; // don't interrupt a drag
  list.replaceChildren();

  const rows = [['me', myName + ' (you)', localState()]];
  peers.forEach((p, id) => rows.push([id, p.name, p.state]));

  rows.forEach(([id, name, state]) => {
    const li = document.createElement('li');
    li.className = 'person';

    const top = document.createElement('div');
    top.className = 'person-top';
    const n = document.createElement('span');
    n.className = 'person-name';
    n.textContent = name;
    const icons = document.createElement('span');
    icons.className = 'person-icons';
    icons.textContent = [
      state.mic ? '🎙️' : '🔇',
      state.cam ? '📷' : '🚫',
      state.screen ? '🖥️' : '',
    ].join(' ');
    const pin = document.createElement('button');
    pin.className = 'small-btn';
    pin.textContent = pinnedId === id ? 'Unpin' : 'Pin';
    pin.onclick = () => togglePin(id);
    top.append(n, icons, pin);
    li.appendChild(top);
    if (typeof syncLabelFor === 'function') {
      const lag = syncLabelFor(id);
      if (lag) li.appendChild(Object.assign(document.createElement('div'), { className: 'person-sync', textContent: lag }));
    }

    if (id !== 'me') {
      const vol = document.createElement('label');
      vol.className = 'person-vol';
      vol.textContent = '🔊';
      const range = document.createElement('input');
      range.type = 'range';
      range.min = 0;
      range.max = 100;
      range.value = Math.round((peers.get(id)?.volume ?? 1) * 100);
      range.setAttribute('aria-label', `Volume for ${name}`);
      range.oninput = () => setVolume(id, range.value / 100);
      vol.appendChild(range);
      li.appendChild(vol);
    }
    list.appendChild(li);
  });
}

function setVolume(id, v) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.volume = v;
  if (peer.audio) peer.audio.gain.gain.value = v;
  const video = tileEl(id)?.querySelector('video');
  if (video && !video.muted) video.volume = v; // only if Web Audio wasn't available
}

// =====================================================================
// Reactions
// =====================================================================
function buildReactionTray() {
  const tray = $('#reactionTray');
  const row = tray.querySelector('.tray-emojis') || tray;
  if (row.children.length) return;
  REACTIONS.forEach((emoji, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = emoji;
    b.title = `React (${i + 1})`;
    b.onclick = () => { sendReaction(emoji); tray.hidden = true; };
    row.appendChild(b);
  });
}
function sendReaction(emoji) { socket.emit('reaction', { emoji }); }

$('#reactBtn').onclick = (e) => { e.stopPropagation(); $('#reactionTray').hidden = !$('#reactionTray').hidden; };
document.addEventListener('click', (e) => {
  if (!$('#reactionTray').contains(e.target)) $('#reactionTray').hidden = true;
});

socket.on('reaction', ({ id, emoji }) => afterShield(id, () => showReaction(id, emoji)));

function showReaction(id, emoji) {
  const tileId = id === myId ? 'me' : id;
  floatEmoji(tileEl(tileId)?.querySelector('.float-layer'), emoji);
  if (document.body.classList.contains('has-stage')) floatEmoji($('#stageFloat'), emoji, true);
}

function floatEmoji(layer, emoji, big = false) {
  if (!layer) return;
  const s = document.createElement('span');
  s.className = 'float' + (big ? ' big' : '');
  s.textContent = emoji;
  s.style.left = 10 + Math.random() * 70 + '%';
  layer.appendChild(s);
  setTimeout(() => s.remove(), 2200);
}

// =====================================================================
// Settings: pick mic, camera, speakers
// =====================================================================
// Audio plays through Web Audio, so the speaker choice is set on the AudioContext.
const canPickSpeaker = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;

async function openSettings() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  fillSelect('#micSelect', devices.filter((d) => d.kind === 'audioinput'), micTrack()?.getSettings().deviceId);
  fillSelect('#camSelect', devices.filter((d) => d.kind === 'videoinput'), cameraTrack()?.getSettings().deviceId);
  $('#speakerRow').hidden = !canPickSpeaker;
  if (canPickSpeaker) {
    fillSelect('#speakerSelect', devices.filter((d) => d.kind === 'audiooutput'), speakerId || 'default');
  }
  $('#settings').showModal();
}

function fillSelect(sel, list, current) {
  const el = $(sel);
  el.replaceChildren(...list.map((d, i) => {
    const o = new Option(d.label || `Device ${i + 1}`, d.deviceId);
    o.selected = d.deviceId === current;
    return o;
  }));
  el.disabled = list.length < 2;
}

async function switchDevice(kind, deviceId) {
  try {
    const fresh = await navigator.mediaDevices.getUserMedia(kind === 'audio'
      ? { audio: { ...AUDIO_OPTS, deviceId: { exact: deviceId } } }
      : { video: { ...VIDEO_OPTS, deviceId: { exact: deviceId } } });
    const newTrack = kind === 'audio' ? fresh.getAudioTracks()[0] : fresh.getVideoTracks()[0];
    const old = kind === 'audio' ? micTrack() : cameraTrack();
    if (old) {
      newTrack.enabled = old.enabled; // keep muted/camera-off as it was
      localStream.removeTrack(old);
      old.stop();
    }
    localStream.addTrack(newTrack);
    await replaceSlot(kind === 'audio' ? SLOT.MIC : SLOT.CAM, newTrack);

    // Refresh the places that show your own camera.
    const meVideo = tileEl('me')?.querySelector('video');
    if (meVideo) { meVideo.srcObject = null; meVideo.srcObject = localStream; }
    watchSpeaking(tileEl('me'), localStream);
    $('#stageVideo').srcObject = null;
    renderStage();
    toast(kind === 'audio' ? 'Microphone switched' : 'Camera switched');
  } catch (err) {
    toast("Couldn't switch device: " + err.message);
  }
}


$('#settingsBtn').onclick = () => openSettings().catch((err) => toast('Settings unavailable: ' + err.message));
$('#micSelect').onchange = (e) => switchDevice('audio', e.target.value);
$('#camSelect').onchange = (e) => switchDevice('video', e.target.value);
$('#speakerSelect').onchange = (e) => {
  speakerId = e.target.value;
  audioCtx?.setSinkId(speakerId === 'default' ? '' : speakerId)
    .then(() => toast('Speakers switched'))
    .catch((err) => toast("Couldn't switch speakers: " + err.message));
};

// =====================================================================
// Layout, invite, leave, shortcuts
// =====================================================================
// Match = compact strip of faces, eyes on the TV. Halftime = big faces, time to chat.
function setMode(mode) {
  document.body.classList.toggle('match', mode === 'match');
  document.body.classList.toggle('halftime', mode === 'halftime');
  document.querySelectorAll('.mode-switch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  });
}
document.querySelectorAll('.mode-switch button').forEach((btn) => {
  btn.onclick = () => setMode(btn.dataset.mode);
});

$('#inviteBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Invite link copied');
  } catch {
    prompt('Copy this invite link:', location.href);
  }
};

$('#leaveBtn').onclick = () => {
  socket.disconnect();
  [...peers.keys()].forEach(closePeer);
  screenTrack?.stop();
  localStream.getTracks().forEach((t) => t.stop());
  location.reload();
};

document.addEventListener('keydown', (e) => {
  if ($('#call').hidden || $('#settings').open) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'm') toggleTrack('audio');
  else if (k === 'v') toggleTrack('video');
  else if (k === 's' && canShare) screenTrack ? stopShare() : startShare();
  else if (k === 'h') setMode(document.body.classList.contains('match') ? 'halftime' : 'match');
  else if (k === 'c') { e.preventDefault(); openPanel('chat'); }
  else if (k === 'g' && typeof showMatchCentre === 'function') showMatchCentre();
  else if (k === 'escape') closePanel();
  else if (/^[1-6]$/.test(k)) sendReaction(REACTIONS[Number(k) - 1]);
});

// =====================================================================
// Toast
// =====================================================================
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
