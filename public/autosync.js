'use strict';
// Auto-sync: listen for your TV through the mic and send a coarse loudness
// pattern (6 frequency bands, 10 times a second) so the server can line your
// TV up with everyone else's. The audio itself never leaves this device.
//
// Measuring happens in an AudioWorklet, which keeps running when the tab is in
// the background (timers don't). Uses globals from app.js / sync.js:
// socket, audioCtx, micTrack, myId, toast, serverNow, sync, renderSyncButton,
// renderSyncStatus.

const AUTO_BANDS = [[100, 250], [250, 500], [500, 1000], [1000, 2000], [2000, 4000], [4000, 8000]];
const auto = { on: true, status: 'off', stream: null, nodes: [], chunk: null, told: false };
try { auto.on = localStorage.getItem('mc-autosync') !== 'off'; } catch {}

const WORKLET = `
class BandMeter extends AudioWorkletProcessor {
  constructor() { super(); this.acc = new Float64Array(6); this.n = 0; this.block = Math.round(sampleRate / 10); }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const len = input[0].length;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < 6; c++) { const ch = input[c]; if (ch) { const x = ch[i]; this.acc[c] += x * x; } }
      if (++this.n >= this.block) {
        const v = [];
        for (let c = 0; c < 6; c++) { v.push(Math.round(10 * Math.log10(this.acc[c] / this.n + 1e-12) * 10) / 10); this.acc[c] = 0; }
        this.n = 0;
        this.port.postMessage(v);
      }
    }
    return true;
  }
}
registerProcessor('band-meter', BandMeter);`;

async function startAuto() {
  if (!auto.on || auto.stream || auto.status === 'starting' || !audioCtx || !myId) return;
  if (!micTrack() || !audioCtx.audioWorklet) { setAutoStatus('unavailable'); return; }
  setAutoStatus('starting');
  try {
    // A separate, unprocessed copy of the mic: echo cancellation and noise
    // suppression (great for the call) would remove exactly the TV sound we need.
    const deviceId = micTrack().getSettings().deviceId;
    try {
      auto.stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      auto.stream = new MediaStream([micTrack().clone()]); // fall back to the call's mic
    }
    if (!auto.workletLoaded) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await audioCtx.audioWorklet.addModule(url);
      auto.workletLoaded = true;
    }
    if (!auto.on) { stopAuto(); return; } // switched off while starting

    const source = audioCtx.createMediaStreamSource(auto.stream);
    const merger = audioCtx.createChannelMerger(6);
    AUTO_BANDS.forEach(([lo, hi], i) => {
      const f = audioCtx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = Math.sqrt(lo * hi);
      f.Q.value = Math.sqrt(lo * hi) / (hi - lo);
      source.connect(f);
      f.connect(merger, 0, i);
      auto.nodes.push(f);
    });
    const meter = new AudioWorkletNode(audioCtx, 'band-meter', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 6, channelCountMode: 'explicit', channelInterpretation: 'discrete',
    });
    const silent = audioCtx.createGain();
    silent.gain.value = 0; // keeps the meter running without making any sound
    merger.connect(meter);
    meter.connect(silent).connect(audioCtx.destination);
    meter.port.onmessage = (e) => onFrame(e.data);
    auto.nodes.push(source, merger, meter, silent);
    setAutoStatus('listening');
    if (!auto.told) {
      auto.told = true;
      toast('Auto-sync is on: listening for your TV’s sound (audio stays on your device). Change it in ⏱.');
    }
  } catch (err) {
    console.warn('Auto-sync unavailable', err);
    stopAuto();
    setAutoStatus('unavailable');
  }
}

function stopAuto() {
  auto.nodes.forEach((n) => { try { n.disconnect(); } catch {} });
  auto.nodes = [];
  auto.stream?.getTracks().forEach((t) => t.stop());
  auto.stream = null;
  auto.chunk = null;
  if (auto.status !== 'unavailable') setAutoStatus('off');
}

// One 100 ms reading of the 6 bands. Frames are grouped into 5-second chunks,
// each stamped with the shared clock; any hiccup starts a fresh chunk.
function onFrame(bands) {
  if (!socket.connected) return;
  const t = serverNow() - 100;
  let c = auto.chunk;
  if (c && Math.abs(t - (c.t0 + c.frames.length * 100)) > 300) { sendChunk(); c = null; }
  if (!c) c = auto.chunk = { t0: t, frames: [] };
  c.frames.push(bands);
  if (c.frames.length >= 50) sendChunk();
}

function sendChunk() {
  const c = auto.chunk;
  auto.chunk = null;
  if (c && c.frames.length >= 5) socket.emit('auto-fp', { t0: Math.round(c.t0), frames: c.frames });
}

function setAutoStatus(status) {
  auto.status = status;
  renderAutoStatus();
  if (typeof renderSyncButton === 'function') renderSyncButton();
}

function autoSynced() {
  return !!(myId && sync.autoSynced?.includes(myId));
}

function renderAutoStatus() {
  const el = $('#autoStatus');
  if (!el) return;
  const toggle = $('#autoToggle');
  toggle.checked = auto.on;
  toggle.disabled = auto.status === 'unavailable';
  el.textContent =
    auto.status === 'unavailable' ? 'Not available here (needs a microphone and a recent browser).'
    : !auto.on ? 'Off. Use the tap below instead.'
    : auto.status === 'starting' ? 'Starting…'
    : autoSynced() ? '✓ Synced automatically from your TV’s sound.'
    : (sync.autoListening || []).filter((id) => id !== myId).length === 0
      ? 'Listening… waiting for a friend to turn on auto-sync too.'
      : 'Listening to your TV… this usually takes about a minute.';
}

$('#autoToggle').onchange = (e) => {
  auto.on = e.target.checked;
  try { localStorage.setItem('mc-autosync', auto.on ? 'on' : 'off'); } catch {}
  if (auto.on) startAuto();
  else { stopAuto(); socket.emit('auto-off'); }
  renderAutoStatus();
};

// Start once we're in a room (and again after a reconnect).
socket.on('joined', () => {
  auto.chunk = null;
  setTimeout(() => { if (auto.on && !auto.stream) startAuto(); }, 1500);
});
socket.on('sync-state', (state) => {
  sync.autoSynced = state.auto?.synced || [];
  sync.autoListening = state.auto?.listening || [];
  renderAutoStatus();
  if (typeof renderSyncButton === 'function') renderSyncButton();
});
socket.on('joined', ({ sync: state }) => {
  sync.autoSynced = state?.auto?.synced || [];
  sync.autoListening = state?.auto?.listening || [];
});
