# CosmicCompass

Readable rebuild of the compiled CosmicCompass web app found in `C:\CosmicCompass`.

## What is rebuilt

- Firebase Google login using the `gwn-socials` project config.
- Firestore `messages` and `comments` collections.
- Twitter-like post composer with edit, delete, replies, image links, and YouTube embeds.
- Media upload hook in `src/config.js`, served by `upload.php` on FastComet.
- Canvas splash screen with particles orbiting the original favicon.
- Live USGS telemetry panel inspired by the old bundle's quake monitoring surface.
- Profile page (bio + avatar), a friends system (invite → accept, with
  Online/Offline presence), and a private messenger with multiple chat tabs
  (max 10), group chats, clear-messages, and Enter-to-send.

## Profile + private messenger

The Profile button (top bar, when signed in) opens the profile view. It holds:

- **Profile editor** — display name, bio, and a profile picture (uploaded via the
  same `upload.php`). The picture is shown in private chats.
- **Friends list** — search by email/name to send an invite; the recipient sees a
  pending request and accepts it. Friends show live Online/Offline status.
- **Messenger** — start a direct chat from the friends list, or use *New chat* to
  pick a friend (DM) or check several friends to start a group chat. Open chats
  appear as tabs (group chats marked with ★); switch by clicking a tab, close with
  ✕. Inside a chat: send with Enter, **Clear messages**, or **Add friend** (adds a
  participant to a group, or promotes a DM into a new group).

Firestore collections used: `users` (profiles + presence + `friends`
subcollection), `friendRequests`, and `conversations` (with a `messages`
subcollection). **You must publish the rules in `firestore.rules`** (Firebase
Console → Firestore Database → Rules → Publish) — they keep private chats readable
only by their participants. Firestore may prompt to create a single-field index via
a console link the first time the friend/conversation queries run.

## Run locally

```powershell
python -m http.server 4173
```

Then open `http://localhost:4173`.

## Media upload setup (FastComet)

Uploads are handled by `upload.php`, which lives in the site folder on FastComet
and saves files into an `uploads/` folder. The frontend points at it in
`src/config.js`:

```js
export const mediaConfig = {
  uploadEndpoint: "https://m.globalwarningnetworks.com/upload.php",
  publicBaseUrl: ""
};
```

`upload.php` accepts `multipart/form-data` with a `file` field and returns JSON like:

```json
{ "url": "https://m.globalwarningnetworks.com/uploads/file.png" }
```

### Deploying to FastComet

1. Upload `index.html`, `upload.php`, `src/`, and `public/` into the document
   root of the `m.globalwarningnetworks.com` subdomain.
2. Create an empty `uploads/` folder there (permissions `755`).
3. In the Firebase console, add `m.globalwarningnetworks.com` to
   **Authentication → Settings → Authorized domains**, and publish the rules from
   `firestore.rules` (Firestore Database → Rules → Publish).
