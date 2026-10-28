// PremCall — server.
// Video and audio flow directly between browsers (WebRTC). This server
// introduces people in the same room, relays chat and reactions, and serves
// live match data (score, stats, play-by-play, odds) to each room.

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { MatchHub } = require('./match/hub');
const { zeroFromTap, validTap, computeLags } = require('./match/sync');
const { kalshiFor } = require('./match/kalshi');
const { AutoSync, mergeLags } = require('./match/autosync');

const PORT = process.env.PORT || 3000;
const MAX_PEERS = 6; // mesh calls work well up to ~6 people
const CHAT_HISTORY = 100; // messages kept per room for people who join late
const REACTIONS = ['⚽', '🔥', '😱', '👏', '😂', '🟥'];
const SOUNDS = ['whistle', 'fulltime', 'airhorn', 'goalhorn', 'roar', 'ooh', 'boo', 'drums'];

// Food runs: only links to known food-delivery services can be shared, so the
// room can't be sent to a look-alike payment page.
const FOOD_SERVICES = [
  ['doordash.com', 'DoorDash'], ['drd.sh', 'DoorDash'],
  ['ubereats.com', 'Uber Eats'], ['uber.com', 'Uber Eats'], ['ubr.to', 'Uber Eats'],
  ['grubhub.com', 'Grubhub'], ['seamless.com', 'Seamless'], ['postmates.com', 'Postmates'],
  ['caviar.com', 'Caviar'], ['gopuff.com', 'Gopuff'], ['instacart.com', 'Instacart'],
  ['deliveroo.co.uk', 'Deliveroo'], ['deliveroo.com', 'Deliveroo'], ['just-eat.co.uk', 'Just Eat'],
  ['wolt.com', 'Wolt'], ['skipthedishes.com', 'SkipTheDishes'],
];
const FOOD_DEADLINES = {
  kickoff: { label: 'before kick-off' },
  halftime: { label: 'by half-time' },
  15: { label: 'in 15 minutes', minutes: 15 },
  30: { label: 'in 30 minutes', minutes: 30 },
  none: { label: 'no rush' },
};
const roomFood = new Map(); // room -> { by, service, url, deadline, statuses }

function foodService(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  const match = FOOD_SERVICES.find(([domain]) => host === domain || host.endsWith(`.${domain}`));
  return match ? { url: url.toString(), service: match[1] } : null;
}
const DEFAULT_STATE = { mic: true, cam: true, screen: false };
const chatHistory = new Map(); // room -> [{ id, name, text, ts }]

// Simple per-person rate limit so nobody can flood the room.
function tooSoon(socket, key, ms) {
  const now = Date.now();
  const last = socket.data['last_' + key] || 0;
  socket.data['last_' + key] = now;
  return now - last < ms;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Match data ----------
// Each room follows at most one match; the hub fetches each match once and we
// send every update to all the rooms following it.
const hub = new MatchHub();
const roomMatch = new Map(); // room -> fixture id

hub.on('update', (fixtureId, payload) => {
  if (!payload) return;
  hub.watchersOf(fixtureId).forEach((room) => io.to(room).emit('match', payload));
});

// Kalshi prices for a match (public market data, cached for everyone).
app.get('/api/kalshi', async (req, res) => {
  const id = String(req.query?.fixture || new URL(req.url, 'http://x').searchParams.get('fixture') || '');
  const f = id ? hub.payload(id)?.fixture : null;
  const isDemo = f?.source === 'demo' || f?.source === 'replay';
  const data = await kalshiFor(isDemo ? null : f?.home.name, isDemo ? null : f?.away.name);
  res.set('Cache-Control', 'no-store').json({ ...data, demo: isDemo });
});

// Past matches that can be replayed (one season at a time).
app.get('/api/replays', async (req, res) => {
  const season = Number(req.query?.season || new URL(req.url, 'http://x').searchParams.get('season') || 2024);
  res.set('Cache-Control', 'no-store').json(await hub.replayList(season));
});

hub.on('replay-error', (fixtureId, message) => {
  hub.watchersOf(fixtureId).forEach((room) => io.to(room).emit('match-error', { message: `Couldn't load that replay (${message}).` }));
});

app.get('/api/fixtures', async (req, res) => {
  res.set('Cache-Control', 'no-store').json(await hub.listFixtures());
});

// ---------- TV sync ----------
// room -> Map(socketId -> { h1, h2 }): when each person's TV showed the clock at
// zero for each half (server time). See match/sync.js.
const roomSync = new Map();

const autoSync = new AutoSync();

function syncState(room) {
  const cals = roomSync.get(room) || new Map();
  const manual = computeLags(cals);
  const members = io.sockets.adapter.rooms.get(room) || new Set();
  // Automatic (TV audio) positions take priority; hand taps fill the gaps.
  const auto = autoSync.positions(room);
  const lags = mergeLags(manual.lags, auto, [...members]);
  const flagged = manual.flagged.filter((id) => !(id in auto));
  return {
    lags,
    flagged,
    auto: { listening: autoSync.listening(room), synced: Object.keys(auto) },
    synced: [...cals.entries()].map(([id, c]) => ({ id, halves: [c.h1 != null && 1, c.h2 != null && 2].filter(Boolean) })),
    members: members.size,
  };
}
const broadcastSync = (room) => io.to(room).emit('sync-state', syncState(room));

function followMatch(room, fixtureId) {
  const previous = roomMatch.get(room);
  if (previous) hub.unwatch(previous, room);
  if (!fixtureId) { roomMatch.delete(room); return null; }
  const id = hub.watch(fixtureId, room);
  roomMatch.set(room, id);
  return id;
}

// ---------- ICE servers (STUN + TURN relay) ----------
// TURN relays video when two people's networks block a direct connection.
// Configure ONE provider with environment variables (e.g. on Render):
//   Cloudflare: CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN  (recommended)
//   Metered:    METERED_APP_NAME, METERED_API_KEY
//   Any other:  TURN_URLS (comma-separated), TURN_USERNAME, TURN_CREDENTIAL
//
// Every browser in a call needs the relay username/password, so they can't be
// fully secret. To limit misuse we only hand them to people who have joined a
// room (in the 'joined' message, never over plain HTTP), Cloudflare credentials
// expire after a few hours, and joins are rate limited per address.
const FALLBACK_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const CREDENTIAL_TTL_S = 6 * 3600;   // long enough for a match plus extra time
const CREDENTIAL_REUSE_MS = 20 * 60e3; // so every credential handed out has 5h+ left
let iceCache = { servers: null, expires: 0 };

const relayProvider = () => {
  const env = process.env;
  if (env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN) return 'Cloudflare';
  if (env.METERED_APP_NAME && env.METERED_API_KEY) return 'Metered';
  if (env.TURN_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL) return 'custom TURN';
  return null;
};

async function fetchIceServers() {
  const env = process.env;
  const provider = relayProvider();

  if (provider === 'Cloudflare') {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: CREDENTIAL_TTL_S }),
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) throw new Error(`Cloudflare TURN returned ${res.status}`);
    const { iceServers } = await res.json();
    // Port 53 URLs tend to time out in browsers; drop them.
    const list = (Array.isArray(iceServers) ? iceServers : [iceServers]).map((s) => ({
      ...s,
      urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)),
    }));
    return { servers: list, ttlMs: CREDENTIAL_REUSE_MS };
  }

  if (provider === 'Metered') {
    const res = await fetch(
      `https://${env.METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`Metered TURN returned ${res.status}`);
    return { servers: await res.json(), ttlMs: CREDENTIAL_REUSE_MS };
  }

  if (provider === 'custom TURN') {
    return {
      servers: [
        ...FALLBACK_ICE,
        {
          urls: env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean),
          username: env.TURN_USERNAME,
          credential: env.TURN_CREDENTIAL,
        },
      ],
      ttlMs: 24 * 3600e3,
    };
  }

  return { servers: FALLBACK_ICE, ttlMs: 24 * 3600e3 };
}

async function iceServersForJoin() {
  try {
    if (!iceCache.servers || Date.now() > iceCache.expires) {
      const { servers, ttlMs } = await fetchIceServers();
      iceCache = { servers, expires: Date.now() + ttlMs };
    }
    return iceCache.servers;
  } catch (err) {
    console.error('TURN setup failed:', err.message);
    return FALLBACK_ICE; // the call still works for people on friendly networks
  }
}

// Status only (no credentials), handy for checking the relay is configured.
app.get('/ice', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ relay: relayProvider(), credentials: 'sent to people who join a room' });
});

// At most JOIN_LIMIT joins per address per 10 minutes (covers reconnects comfortably).
const JOIN_LIMIT = 30;
const joinLog = new Map(); // address -> [timestamps]
function joinAllowed(socket) {
  const fwd = socket.handshake?.headers?.['x-forwarded-for'];
  const addr = (fwd ? String(fwd).split(',')[0].trim() : socket.handshake?.address) || 'unknown';
  const now = Date.now();
  const recent = (joinLog.get(addr) || []).filter((t) => now - t < 10 * 60e3);
  if (recent.length >= JOIN_LIMIT) return false;
  recent.push(now);
  joinLog.set(addr, recent);
  return true;
}
setInterval(() => {
  const now = Date.now();
  joinLog.forEach((list, addr) => {
    const recent = list.filter((t) => now - t < 10 * 60e3);
    if (recent.length) joinLog.set(addr, recent); else joinLog.delete(addr);
  });
}, 10 * 60e3).unref();

io.on('connection', (socket) => {
  socket.on('join', async ({ room, name } = {}) => {
    room = String(room || '').trim().slice(0, 64);
    name = String(name || 'Fan').trim().slice(0, 32) || 'Fan';
    if (!room || socket.data.room || socket.data.joining) return;
    if (!joinAllowed(socket)) {
      socket.emit('join-error', { message: 'Too many joins from your connection. Wait a few minutes and try again.' });
      return;
    }
    socket.data.joining = true;
    const ice = await iceServersForJoin();
    socket.data.joining = false;
    if (!socket.connected) return;

    const members = io.sockets.adapter.rooms.get(room);
    if (members && members.size >= MAX_PEERS) {
      socket.emit('room-full', { max: MAX_PEERS });
      return;
    }

    const peers = members
      ? [...members].map((id) => {
          const s = io.sockets.sockets.get(id);
          return { id, name: s?.data.name || 'Fan', state: s?.data.state || DEFAULT_STATE };
        })
      : [];

    socket.data.room = room;
    socket.data.name = name;
    socket.data.state = { ...DEFAULT_STATE };
    socket.join(room);
    const matchId = roomMatch.get(room) || null;
    socket.emit('joined', {
      id: socket.id, peers, ice, history: chatHistory.get(room) || [],
      match: matchId ? { fixtureId: matchId, data: hub.payload(matchId) } : null,
      sync: syncState(room),
      food: roomFood.get(room) || null,
    });
    socket.to(room).emit('peer-joined', { id: socket.id, name, state: socket.data.state });
  });

  // Text chat. The server keeps the last messages so late joiners can catch up;
  // history is forgotten once the room empties.
  socket.on('chat', ({ text } = {}) => {
    const room = socket.data.room;
    if (!room) return;
    text = String(text || '').trim().slice(0, 500);
    if (!text || tooSoon(socket, 'chat', 300)) return;
    const msg = { id: socket.id, name: socket.data.name, text, ts: Date.now() };
    const list = chatHistory.get(room) || [];
    list.push(msg);
    if (list.length > CHAT_HISTORY) list.shift();
    chatHistory.set(room, list);
    io.to(room).emit('chat', msg);
  });

  // Anyone in the room can choose which match the room is following.
  socket.on('select-match', async ({ fixtureId } = {}) => {
    const room = socket.data.room;
    if (!room || tooSoon(socket, 'select', 1500)) return;
    let id = fixtureId == null ? null : String(fixtureId).slice(0, 32);
    if (id && id.startsWith('replay:')) {
      const [, fixtureId, speed] = id.split(':');
      if (!/^\d+$/.test(fixtureId || '') || !['fast', 'real'].includes(speed) || !hub.isReplayable(fixtureId)) {
        socket.emit('match-error', { message: "Couldn't find that past match." });
        return;
      }
    } else if (id && id !== 'demo') {
      await hub.listFixtures(); // make sure the fixture list is loaded
      if (!socket.connected || socket.data.room !== room) return;
      if (!hub.isKnownFixture(id)) {
        socket.emit('match-error', { message: "Couldn't find that match." });
        return;
      }
    }
    const changed = id !== roomMatch.get(room) || id === 'demo';
    id = followMatch(room, id);
    if (changed && roomSync.has(room)) { // a different match: old TV syncs no longer apply
      roomSync.delete(room);
      broadcastSync(room);
    }
    io.to(room).emit('match-selected', { fixtureId: id, by: socket.data.name, data: id ? hub.payload(id) : null });
  });

  // A shared clock: clients work out the difference between their clock and
  // ours, so taps from different devices can be compared accurately.
  socket.on('time-ping', ({ t0 } = {}) => {
    socket.emit('time-pong', { t0, server: Date.now() });
  });

  // "My TV's match clock just showed this time."
  socket.on('sync', (tap = {}) => {
    const room = socket.data.room;
    if (!room || tooSoon(socket, 'sync', 500)) return;
    const t = { half: Number(tap.half), clockSec: Number(tap.clockSec), tapAt: Number(tap.tapAt) };
    if (!validTap(t)) {
      socket.emit('sync-error', { message: "That sync didn't look right. Please try again." });
      return;
    }
    if (!roomSync.has(room)) roomSync.set(room, new Map());
    const cals = roomSync.get(room);
    const mine = cals.get(socket.id) || {};
    mine[t.half === 2 ? 'h2' : 'h1'] = zeroFromTap(t);
    mine.at = Date.now();
    cals.set(socket.id, mine);
    broadcastSync(room);
  });

  // Auto-sync: a few seconds of TV loudness pattern (never audio).
  socket.on('auto-fp', (chunk = {}) => {
    const room = socket.data.room;
    if (!room || tooSoon(socket, 'auto', 1000)) return;
    const wasListening = autoSync.listening(room).includes(socket.id);
    if (!autoSync.add(room, socket.id, chunk)) return;
    const changed = autoSync.update(room);
    if (changed || !wasListening) broadcastSync(room);
  });

  socket.on('auto-off', () => {
    const room = socket.data.room;
    if (!room) return;
    autoSync.remove(room, socket.id);
    broadcastSync(room);
  });

  socket.on('sync-clear', () => {
    const room = socket.data.room;
    if (!room || !roomSync.get(room)?.delete(socket.id)) return;
    broadcastSync(room);
  });

  // Soundboard: play a sound for everyone in the room.
  socket.on('sound', ({ sound } = {}) => {
    const room = socket.data.room;
    if (!room || !SOUNDS.includes(sound) || tooSoon(socket, 'sound', 1200)) return;
    io.to(room).emit('sound', { id: socket.id, name: socket.data.name, sound });
  });

  // Food runs: one shared group-order link per room.
  socket.on('food-start', ({ url, deadline } = {}) => {
    const room = socket.data.room;
    if (!room) return;
    const found = foodService(url);
    if (!found) {
      socket.emit('food-error', { message: 'Paste a group-order link from DoorDash, Uber Eats, Grubhub or another delivery app.' });
      return;
    }
    if (tooSoon(socket, 'food', 1000)) return; // only valid links count towards the limit
    const d = FOOD_DEADLINES[deadline] || FOOD_DEADLINES.none;
    const run = {
      by: socket.data.name,
      byId: socket.id,
      service: found.service,
      url: found.url,
      deadline: { key: String(deadline || 'none'), label: d.label, at: d.minutes ? Date.now() + d.minutes * 60e3 : null },
      startedAt: Date.now(),
      statuses: { [socket.id]: { name: socket.data.name, status: 'in' } },
    };
    roomFood.set(room, run);
    io.to(room).emit('food-state', { run, event: 'started', by: socket.data.name });
  });

  socket.on('food-status', ({ status } = {}) => {
    const room = socket.data.room;
    const run = room && roomFood.get(room);
    if (!run || !['in', 'ordered', 'out'].includes(status) || tooSoon(socket, 'food-status', 300)) return;
    run.statuses[socket.id] = { name: socket.data.name, status };
    io.to(room).emit('food-state', { run, event: 'status' });
  });

  socket.on('food-end', () => {
    const room = socket.data.room;
    if (!room || !roomFood.has(room)) return;
    roomFood.delete(room);
    io.to(room).emit('food-state', { run: null, event: 'ended', by: socket.data.name });
  });

  // Quick emoji reactions.
  socket.on('reaction', ({ emoji } = {}) => {
    const room = socket.data.room;
    if (!room || !REACTIONS.includes(emoji) || tooSoon(socket, 'reaction', 250)) return;
    io.to(room).emit('reaction', { id: socket.id, emoji });
  });

  // Relay WebRTC offers/answers/ICE candidates between two people in the same room.
  socket.on('signal', ({ to, data } = {}) => {
    const target = io.sockets.sockets.get(to);
    if (!target || !socket.data.room || target.data.room !== socket.data.room) return;
    target.emit('signal', { from: socket.id, name: socket.data.name, data });
  });

  // Mic/camera/screen-share status, so others can show icons and size tiles.
  socket.on('state', ({ mic, cam, screen } = {}) => {
    if (!socket.data.room) return;
    socket.data.state = { mic: !!mic, cam: !!cam, screen: !!screen };
    socket.to(socket.data.room).emit('peer-state', { id: socket.id, ...socket.data.state });
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (!room) return;
    socket.to(room).emit('peer-left', { id: socket.id });
    if (!io.sockets.adapter.rooms.get(room)) {
      chatHistory.delete(room);
      roomSync.delete(room);
      roomFood.delete(room);
      autoSync.remove(room, socket.id);
      followMatch(room, null); // stop fetching data nobody is watching
    } else {
      const hadSync = roomSync.get(room)?.delete(socket.id);
      const hadAuto = autoSync.listening(room).includes(socket.id);
      autoSync.remove(room, socket.id);
      if (hadSync || hadAuto) broadcastSync(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`PremCall running at http://localhost:${PORT}`);
  const env = process.env;
  const provider = relayProvider();
  console.log(provider
    ? `TURN relay: ${provider}`
    : 'TURN relay: not configured (some friends may fail to connect; see README)');
  console.log(env.API_FOOTBALL_KEY
    ? 'Match data: API-Football'
    : 'Match data: demo only (set API_FOOTBALL_KEY for live Premier League data)');
  console.log(env.ANTHROPIC_API_KEY
    ? 'Match analysis: Claude'
    : 'Match analysis: stats-based (set ANTHROPIC_API_KEY for AI-written analysis)');
});
