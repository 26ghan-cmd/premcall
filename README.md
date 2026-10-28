# PremCall

Video calls for watching Premier League matches with friends. Each person watches
the match on their own TV or stream; this app is the "second screen" where you see
and hear each other.

## Using it

PremCall is hosted on Render, so there's nothing to install:

1. Open your Render link (e.g. `https://your-app.onrender.com`).
2. Allow camera and mic, enter your name and join a room.
3. Click **Invite** to copy the room link and send it to your friends.

Every push to this repository's `main` branch redeploys the app automatically.
Settings such as API keys live in Render under **Environment** (see
[Match data setup](#match-data-setup) and [Calling friends in other places](#calling-friends-in-other-places)).

**Try a call on your own:** open the same room link in a second browser tab.
You'll see yourself twice. Wear headphones or mute one tab to avoid feedback.

## Running it on your own computer

Only needed to try changes before putting them live. You need
[Node.js](https://nodejs.org) 18 or newer and a fresh copy of this repository:

```bash
git clone https://github.com/26ghan-cmd/premcall.git
cd premcall
npm install
npm start
```

Open http://localhost:3000. Without the environment variables you use on Render,
the match centre offers the demo match only and calls work best on the same network.

## What's in it

- **Rooms by link:** share `?room=your-room-name` and up to 6 people can join.
- **Camera off by default:** the waiting room starts with your camera off; turn
  it on there before joining, or any time in the call.
- **Joins with whatever works:** no webcam, or a camera busy in another app? You
  join with audio only. No devices or permission blocked? You can still watch,
  listen and chat.
- **Recovers from dropouts:** after a Wi-Fi blip, laptop sleep or server restart
  the app rejoins the room by itself (and re-sends your TV sync). Video links that
  drop are restarted automatically.
- **Match centre:** the room picks a Premier League match (or the demo match) and
  everyone sees the live score, stats, written play-by-play with analysis, live
  odds and lineups. The Stats tab opens with a **win-probability chart**:
  how the chances of a home win, draw and away win have moved through the match
  (from the live odds, bookmaker margin removed), with goals and red cards marked,
  a hover tooltip and a table view. It fills the telly when nothing is shared or pinned, and is
  always available from the scorebug in the top bar or the **Match** tab.
- **The telly:** the big area at the top shows the match centre, a shared screen,
  or whoever you've pinned. Full-screen button included.
- **Match mode:** a compact strip of faces under the telly.
- **Halftime mode:** a big grid of faces, or telly on the left and faces on the
  right when something is on the telly.
- **Screen sharing** (desktop browsers): your screen goes on everyone's telly and
  your camera stays visible in your tile. If several people share, the most recent
  one shows; pin someone to choose. Not available on phones.
- **Pinning:** 📌 on any tile (or double-click it) puts that person on your telly.
  Only you see your pins.
- **Chat:** side panel with history for late joiners, clickable links and an
  unread badge. History is forgotten when everyone leaves.
- **People list:** everyone's mic/camera/sharing status, pin buttons, and a
  volume slider per person.
- **Reactions:** ⚽ 🔥 😱 👏 😂 🟥 float over your tile and the telly.
- **Soundboard** (in the React tray): whistle, full-time whistle, air horn, goal
  horn, crowd roar, "ooh!", boos and drums, played for everyone. All made in code
  with Web Audio (no recordings). Held back by the spoiler shield like reactions;
  each person has their own volume and can switch sounds off.
- **Food runs:** start a group order in DoorDash, Uber Eats, Grubhub etc., paste its
  share link in the **Food** tab, and pick a deadline. Everyone gets a card to add
  their own food and mark "I'm in" / "Ordered ✓". Only links to known delivery
  apps are accepted. (Delivery apps don't let other apps place orders, but group
  orders do the job.)
- **Kalshi tab** in the match centre: live prediction-market prices for the match
  (home / draw / away, as a % chance) from Kalshi's public market data, plus
  other Premier League games, and a link to trade on Kalshi. Read-only: no Kalshi
  account or key is stored here. Prices follow your spoiler delay.
- **Settings:** choose microphone, camera and speakers (speaker choice works in
  Chrome and Edge).
- **Talking ring:** a green outline around whoever is speaking.
- **Auto-sync (no tapping):** once you join, the app listens for your TV through
  your mic and lines everyone's TVs up by itself, usually within a minute. It
  compares the rhythm of the crowd noise and commentary: the same roar reaches a
  delayed TV a few seconds later, and that shift is the gap. Only a rough
  loudness pattern (6 numbers, 10 times a second) is sent; the sound itself
  never leaves your device. Needs the TV to be audible to the mic, so headphones
  plugged into the TV won't work; tap-to-sync is still there as a fallback, and
  people synced either way are combined. Can be switched off in the sync window.
- **Sync with your TV + spoiler shield:** everyone taps ⏱ **Sync TV** when their
  TV's match clock ticks over to a new minute (or at kick-off). The app works out
  how far behind each TV is and, for friends whose TV is ahead of yours, holds back
  their video, voice, chat and reactions by the difference, so a cheer never
  arrives before you've seen the goal. The people list shows everyone's lag. A
  sync that's more than 2½ minutes off from everyone else's is ignored and that
  person is asked to check it. The shield can be switched off in the sync window.
- **Line up the TVs:** whoever's TV is ahead gets a prompt in the sync window to
  pause it for the exact gap ("Your TV is 30s ahead of Sam's"). They tap when they
  pause, a countdown says when to press play, and the app measures the pause and
  updates their sync. Every TV then shows the same moment, nothing is held back,
  and conversation is live.
  Screen shares aren't held back.
- **Spoiler delay for match data:** in Settings, hold back the match centre by
  10–90 seconds so the score never changes before your TV shows the goal.
- Keyboard shortcuts: **M** mic, **V** camera, **S** share, **C** chat,
  **G** match centre, **H** layout, **1–6** reactions, **Esc** close panel.
- Echo cancellation and noise suppression are on, to keep TV commentary out of the call.

## How it works

```
server.js        Introduces people in the same room and relays connection details.
                 It never touches video.
                 Also relays chat (keeping recent history per room) and reactions.
match/hub.js     Follows each match a room is watching. Data is fetched once per
                 match and shared by every room, so usage doesn't grow with users.
match/api-football.js  Live Premier League data and odds from API-Football.
match/demo.js    The demo match: fictional clubs, simulated play, modelled odds.
match/feed.js    Turns data changes into play-by-play lines and stats-based analysis.
match/ai.js      Optional AI-written analysis (Claude).
match/sync.js    TV sync maths: from each person's clock taps, how far behind their TV is.
match/autosync.js  Auto-sync: matches everyone's TV loudness patterns (cross-correlation)
                 to find the gaps, confirmed by two agreeing estimates.
public/autosync.js  Measures the TV's loudness in 6 bands (an AudioWorklet, so it keeps
                 working in a background tab) and sends it every 5 seconds.
match/kalshi.js  Kalshi prices for Premier League games, matched to our fixtures.
match/teams.js   Recognising clubs under different names (Man Utd = Manchester United).
public/app.js    WebRTC: every browser connects directly to every other (a "mesh").
                 Each connection has three fixed slots (mic, camera, screen), so
                 sharing or switching devices never interrupts the call.
public/match.js  The match centre interface and the spoiler delay.
public/sounds.js Soundboard (synthesized sounds).
public/food.js   Food runs.
public/sync.js   Sync dialog, shared clock, and the spoiler shield: delayed audio
                 (Web Audio), delayed video (a rolling buffer of small snapshots),
                 and held-back chat and reactions.
public/*.html/css  The interface.
```

## Replay a past match

In the match picker, **Replay a past match** plays a finished Premier League game
(2022/23 to 2024/25) through the match centre as if it were live: real goals,
cards, subs, VAR and lineups at the right minutes, at fast (about 7 minutes) or
real-time speed. Counting stats build up evenly to the real full-time numbers
and the odds are modelled, because old matches only keep final stats and no
odds. Each replay uses about two API-Football requests, so it works on the free
plan, which doesn't include the current season.

## Match data setup

Without any keys, the match centre offers the **demo match** only. Add these
environment variables on your host (Render: your service → Environment):

| Variable | What it does |
|---|---|
| `API_FOOTBALL_KEY` | Live Premier League fixtures, scores, stats, events, lineups and odds from [API-Football](https://www.api-football.com/pricing). |
| (Kalshi) | Nothing to set up: Kalshi's market data is public. `KALSHI_API_BASE` overrides the API address (for testing). |

Optional tuning:

| Variable | Default | |
|---|---|---|
| `LIVE_POLL_SECONDS` | 15 | How often live match data is refreshed |
| `ODDS_POLL_SECONDS` | 30 | How often live odds are refreshed |
| `PL_SEASON` | automatic | Season year, e.g. 2026 for 2026/27 |
| `DEMO_SECONDS_PER_MINUTE` | 4 | Demo match speed (4 → a full match takes about 7 minutes) |

Each live match uses about 700 API-Football requests (2 hours of updates), however
many rooms are watching it. The server slows down automatically if the daily
allowance runs low. The play-by-play is written from the data feed (goals, cards,
subs, VAR, shots, saves, corners), so it describes what the data shows rather
than every pass.

## Calling friends in other places

`localhost` only works on your own machine. To invite friends:

1. **Quick test:** run a tunnel such as `npx localtunnel --port 3000` or
   `ngrok http 3000`, and share the https link it gives you.
   Browsers only allow camera access on https (or localhost).
2. **Proper hosting:** deploy to any Node host with websockets (Render, Railway,
   Fly.io). They provide https automatically.
3. **TURN relay (needed for most real calls):** many home, office and mobile
   networks block direct connections, so both people see "Couldn't reach…".
   A TURN server relays the video instead. Set **one** of these as environment
   variables on your host (Render: your service → Environment). Never put the
   keys in the code. The server hands browsers short-lived credentials at `/ice`.

   | Provider | Variables | Cost |
   |---|---|---|
   | [Metered](https://www.metered.ca/stun-turn) | `METERED_APP_NAME`, `METERED_API_KEY` | Free 500 MB/month: fine for testing, not a full match |
   | [Cloudflare](https://developers.cloudflare.com/calls/turn/) | `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` | $0.05/GB, a few cents per match |
   | Any other / self-hosted coturn | `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Varies |

   On startup the server log says which relay it's using, e.g. `TURN relay: Cloudflare`.
   You can also open `https://your-app/ice`, which shows `{"relay":"Cloudflare",…}`.
   Relay credentials are only sent to people who join a room; Cloudflare ones
   expire after 6 hours, and joins are limited to 30 per address per 10 minutes.

## Limits and next steps

- A mesh works well for about 6 people. For bigger "pub" rooms, move video to an
  SFU such as LiveKit; the interface can stay the same.
- Auto-sync needs at least two people with it on, and the TVs must be showing the
  same broadcast (two different channels' commentary won't match; tap instead).
