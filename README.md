# CosmicCompass

Readable rebuild of the compiled CosmicCompass web app found in `C:\CosmicCompass`.

## What is rebuilt

- Firebase Google login using the `gwn-socials` project config.
- Firestore `messages` and `comments` collections.
- Twitter-like post composer with edit, delete, replies, image links, and YouTube embeds.
- Railway-ready media upload hook in `src/config.js`.
- Canvas splash screen with particles orbiting the original favicon.
- Live USGS telemetry panel inspired by the old bundle's quake monitoring surface.

## Run locally

```powershell
python -m http.server 4173
```

Then open `http://localhost:4173`.

## Railway media setup

When the upload service is ready, set:

```js
export const mediaConfig = {
  uploadEndpoint: "https://your-railway-app.up.railway.app/upload",
  publicBaseUrl: ""
};
```

The endpoint should accept `multipart/form-data` with a `file` field and return JSON like:

```json
{ "url": "https://your-cdn-or-railway-url/file.png" }
```
