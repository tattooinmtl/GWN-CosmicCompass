# CosmicCompass — Master Plan / Roadmap

Living roadmap: what's shipped and what's next. Update as features land.

## Architecture (where things run)
- **Frontend:** static vanilla-JS SPA on **FastComet** at `m.globalwarningnetworks.com` (`index.html` + `src/`).
- **Auth + data:** **Firebase** (project `gwn-socials`) — Google sign-in + Firestore.
- **Server-side bits (PHP on FastComet):** `upload.php` (image uploads), `owm-proxy.php` (hidden OpenWeatherMap key), `turn-creds.php` (TURN credentials). Secrets in `/2026/secure/config.php`; keys in MySQL `api_keys`.
- **Media relay:** self-hosted **coturn** TURN server on the VPS (`173.212.202.219`).

## ✅ Shipped
- **Feed** — posts, comments, image uploads, YouTube embeds, USGS telemetry panel.
- **Profile** — display name, bio, avatar (via `upload.php`); shown in chats.
- **Friends** — search by email/name, invite → accept, live Online/Offline presence (heartbeat).
- **Messenger** — 1:1 DMs + group chats, up to 10 tabs, Enter-to-send, clear messages, add-friend-to-chat, image + YouTube attachments (size-limited, open/download).
- **Toolbox** (open to everyone) — Quakes (USGS), Stations (FDSN/MiniSEED), Weather (RainViewer animation + OpenWeatherMap overlays, key hidden behind PHP/MySQL proxy).
- **1:1 video calling** — WebRTC + Firestore signaling (`src/call.js`), self-hosted coturn TURN, `turn-creds.php` for short-lived credentials. Incoming popup, mute/camera/hang-up, timer, decline/missed/busy handling.

## 🔜 Next

### 1. Video quality caps (stability)
Constrain call media in `src/call.js`:
- **Target:** 720p at **24–30 FPS** (the stability sweet spot).
- **Adaptive bitrate (mobile):**
  - 480p: **500 kbps – 1.2 Mbps**
  - 720p: **1.2 – 2.5 Mbps**
- **How:** cap `getUserMedia` constraints (`width`/`height`/`frameRate`); set `RTCRtpSender.setParameters` encodings `maxBitrate` + `scaleResolutionDownBy`; pick 480p vs 720p by device/network (start conservative on mobile, allow 720p on desktop/good links).

### 2. Admin panel (owner-only)
- **Access:** only `erik.boivin@gmail.com` and `erik.boivin1980@gmail.com` (second = testing account). Enforced in **Firestore rules** via `request.auth.token.email in [...]` (not just a client check) — gate the admin-only collections/actions.
- **Monitor users:** list every user on the site (name, email, online/offline, last active).
- **Bandwidth per user (video chats):** during calls, `src/call.js` samples `RTCPeerConnection.getStats()` (bytesSent + bytesReceived) and writes running totals to Firestore (e.g. `usage/{uid}` or `callSessions`). Admin panel reads + charts it.
- **Per-user Clear button:** resets that user's usage/charts data.
- **Ban / remove user:** set a `banned` flag (rules deny banned users) and/or delete their Firestore data.
  - ⚠️ Limitation: deleting the **Firebase Auth** account itself needs the Admin SDK (server) or the Firebase console — can't be done from client JS. Plan: admin "remove" clears Firestore data + bans; final Auth-account deletion is done manually in the Firebase console (or a future PHP+Admin-REST helper).

### 3. Account deletion (legal / GDPR) — request + manual removal
- **In Profile:** a "Delete my account" section.
- **Safety guard:** the Delete button stays disabled until the user types exactly **`delete my account`** into a text box.
- **What it does:** it does **NOT** wipe internal data automatically. It files a deletion **request** (e.g. flags the account / notifies). Final data removal is handled **manually**: the user emails the request, then the owner completes removal from the **admin panel** (and Firebase console for the Auth account).
- Wording on screen should make the manual/email step clear so expectations are right.

## Notes / decisions
- Group video (3+) intentionally **out of scope** for now — would need an SFU (self-host Jitsi/LiveKit on the VPS, or a paid SaaS).
- Secrets never go in the repo (gitignored: `config.php`, `src/config.php`, `db/api_keys.sql`, `secure/`).
