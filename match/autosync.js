'use strict';
// Automatic TV sync. Each person's browser listens to their TV through the mic
// and sends a coarse loudness pattern (6 frequency bands, 10 times a second,
// timestamped on the shared server clock). The audio itself never leaves the
// device. Here we compare everyone's patterns: the same crowd roar or burst of
// commentary shows up in a later TV's pattern a few seconds later, and that
// shift is the gap between the TVs.

const FRAME_MS = 100;                      // 10 frames per second
const BANDS = 6;
const HISTORY = 240 * 1000 / FRAME_MS;     // keep 4 minutes per person
const WINDOW = 300;                        // compare the most recent 30 s
const MAX_LAG = 150 * 1000 / FRAME_MS;     // TVs up to 150 s apart
const MIN_SCORE = 0.3;                     // how strong a match must be
const MIN_MARGIN = 0.1;                    // ...and how clearly it beats the runner-up
const AGREE_FRAMES = 4;                    // two estimates within 0.4 s confirm a gap

class Track {
  constructor() { this.start = null; this.frames = []; }
  get end() { return this.start == null ? null : this.start + this.frames.length; } // exclusive
  add(firstIndex, frames) {
    if (this.start == null) this.start = firstIndex;
    if (firstIndex < this.start) return; // late, out-of-order data: ignore
    while (this.end < firstIndex) this.frames.push(null); // gap (e.g. tab in background)
    frames.forEach((f, i) => {
      const at = firstIndex + i - this.start;
      if (at < this.frames.length) this.frames[at] = f; else this.frames.push(f);
    });
    const extra = this.frames.length - HISTORY;
    if (extra > 0) { this.frames.splice(0, extra); this.start += extra; }
  }
  at(index) { return index < this.start || index >= this.end ? null : this.frames[index - this.start]; }
}

// Turn loudness into "what changed" (frame-to-frame differences per band) and
// standardise each band, so different TV volumes and mics don't matter.
function features(track, from, to) {
  const n = to - from;
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const cur = track.at(from + i), prev = track.at(from + i - 1);
    if (cur && prev) out[i] = cur.map((v, b) => Math.max(-15, Math.min(15, v - prev[b])));
  }
  for (let b = 0; b < BANDS; b++) {
    let s = 0, s2 = 0, c = 0;
    out.forEach((f) => { if (f) { s += f[b]; s2 += f[b] * f[b]; c++; } });
    if (c < 10) continue;
    const mean = s / c, sd = Math.sqrt(Math.max(s2 / c - mean * mean, 1e-6));
    out.forEach((f) => { if (f) f[b] = (f[b] - mean) / sd; });
  }
  return out;
}

// How far is X's TV behind Y's? Compare X's latest 30 s against Y's history.
function behindBy(x, y, now) {
  const xf = features(x, now - WINDOW, now);
  const yFrom = now - WINDOW - MAX_LAG;
  const yf = features(y, yFrom, now);
  const scores = new Float64Array(MAX_LAG + 1).fill(-1);
  for (let e = 0; e <= MAX_LAG; e++) {
    let sum = 0, used = 0;
    for (let i = 0; i < WINDOW; i++) {
      const a = xf[i];
      const bIdx = (now - WINDOW + i - e) - yFrom;
      const b = bIdx >= 0 ? yf[bIdx] : null;
      if (!a || !b) continue;
      for (let k = 0; k < BANDS; k++) sum += a[k] * b[k];
      used++;
    }
    if (used >= WINDOW * 0.7) scores[e] = sum / (used * BANDS);
  }
  let best = -1, bestE = -1;
  scores.forEach((s, e) => { if (s > best) { best = s; bestE = e; } });
  if (bestE < 0 || best <= -1) return null;
  let second = -1;
  scores.forEach((s, e) => { if (Math.abs(e - bestE) > 10 && s > second) second = s; });
  // Sub-frame accuracy: fit a parabola through the peak and its neighbours.
  let refined = bestE;
  if (bestE > 0 && bestE < MAX_LAG && scores[bestE - 1] > -1 && scores[bestE + 1] > -1) {
    const l = scores[bestE - 1], r = scores[bestE + 1];
    const denom = l - 2 * best + r;
    if (denom < 0) refined = bestE + 0.5 * (l - r) / denom;
  }
  return { frames: refined, score: best, margin: best - Math.max(second, 0) };
}

class AutoSync {
  constructor() {
    this.rooms = new Map(); // room -> { tracks: Map(id -> Track), pairs: Map(key -> estimate), lastRun }
  }

  room(room) {
    if (!this.rooms.has(room)) this.rooms.set(room, { tracks: new Map(), pairs: new Map(), lastRun: 0 });
    return this.rooms.get(room);
  }

  // A chunk of loudness frames from one person: { t0 (server ms of the first frame), frames: [[6 numbers], …] }
  add(room, id, { t0, frames }) {
    if (!Number.isFinite(t0) || !Array.isArray(frames) || frames.length > 200) return false;
    const clean = frames.map((f) => (Array.isArray(f) && f.length === BANDS && f.every(Number.isFinite) ? f.map((v) => Math.max(-140, Math.min(20, v))) : null));
    const r = this.room(room);
    if (!r.tracks.has(id)) r.tracks.set(id, new Track());
    r.tracks.get(id).add(Math.round(t0 / FRAME_MS), clean);
    return true;
  }

  remove(room, id) {
    const r = this.rooms.get(room);
    if (!r) return;
    r.tracks.delete(id);
    [...r.pairs.keys()].forEach((k) => { if (k.split('|').includes(id)) r.pairs.delete(k); });
    if (!r.tracks.size) this.rooms.delete(room);
  }

  // Re-estimate every pair (at most every 5 s). Returns true if anything changed.
  update(room, nowMs = Date.now(), force = false) {
    const r = this.rooms.get(room);
    if (!r || r.tracks.size < 2 || (!force && nowMs - r.lastRun < 5000)) return false;
    r.lastRun = nowMs;
    const ids = [...r.tracks.keys()];
    let changed = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = [ids[i], ids[j]];
        const ta = r.tracks.get(a), tb = r.tracks.get(b);
        const now = Math.min(ta.end, tb.end);
        if (now - Math.max(ta.start, tb.start) < WINDOW + 20) continue; // not enough listening yet
        const aBehind = behindBy(ta, tb, now);
        const bBehind = behindBy(tb, ta, now);
        const pick = [aBehind && { ...aBehind, sign: 1 }, bBehind && { ...bBehind, sign: -1 }]
          .filter(Boolean).sort((p, q) => q.score - p.score)[0];
        const key = `${a}|${b}`;
        const prev = r.pairs.get(key) || {};
        if (!pick || pick.score < MIN_SCORE || pick.margin < MIN_MARGIN) {
          r.pairs.set(key, { ...prev, candidate: null });
          continue;
        }
        const offset = pick.sign * pick.frames; // + means a is behind b, in frames
        // Confirm only when two estimates in a row agree.
        if (prev.candidate != null && Math.abs(prev.candidate - offset) <= AGREE_FRAMES) {
          const value = (prev.candidate + offset) / 2;
          if (prev.confirmed == null || Math.abs(prev.confirmed - value) > 1) changed = true;
          r.pairs.set(key, { candidate: offset, confirmed: value, score: pick.score, at: nowMs });
        } else {
          r.pairs.set(key, { ...prev, candidate: offset });
        }
      }
    }
    return changed;
  }

  // Each person's relative TV position in seconds (bigger = further behind), for
  // everyone linked by a confirmed match. Uses the strongest matches first.
  positions(room) {
    const r = this.rooms.get(room);
    const rel = {};
    if (!r) return rel;
    const edges = [...r.pairs.entries()]
      .filter(([, p]) => p.confirmed != null)
      .map(([k, p]) => { const [a, b] = k.split('|'); return { a, b, secs: (p.confirmed * FRAME_MS) / 1000, score: p.score }; })
      .sort((x, y) => y.score - x.score);
    if (!edges.length) return rel;
    rel[edges[0].b] = 0;
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of edges) {
        if (e.a in rel && !(e.b in rel)) { rel[e.b] = rel[e.a] - e.secs; grew = true; }
        else if (e.b in rel && !(e.a in rel)) { rel[e.a] = rel[e.b] + e.secs; grew = true; }
      }
    }
    return rel;
  }

  listening(room) {
    const r = this.rooms.get(room);
    return r ? [...r.tracks.keys()] : [];
  }
}

// Combine automatic positions with manual tap-based lags into one set of lags
// (seconds behind the furthest-ahead TV). Auto wins where it has an answer;
// someone synced only by hand is placed via anyone who has both.
function mergeLags(manual, auto, ids) {
  const out = {};
  ids.forEach((id) => { out[id] = null; });
  const autoIds = Object.keys(auto);
  if (autoIds.length >= 2) {
    autoIds.forEach((id) => { out[id] = auto[id]; });
    const bridge = autoIds.find((id) => manual[id] != null);
    if (bridge) {
      ids.forEach((id) => {
        if (out[id] == null && manual[id] != null) out[id] = auto[bridge] + (manual[id] - manual[bridge]);
      });
    }
  } else {
    ids.forEach((id) => { out[id] = manual[id] ?? null; });
  }
  const known = Object.values(out).filter((v) => v != null);
  if (!known.length) return out;
  const min = Math.min(...known);
  Object.keys(out).forEach((id) => { if (out[id] != null) out[id] = Math.round((out[id] - min) * 10) / 10; });
  return out;
}

module.exports = { AutoSync, mergeLags, FRAME_MS, BANDS, _internals: { behindBy, features, Track } };
