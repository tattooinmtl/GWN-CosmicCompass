# CosmicCompass

Readable rebuild of the compiled CosmicCompass web app found in `C:\CosmicCompass`.

## What is rebuilt

- Firebase Google login using the `gwn-socials` project config.
- Firestore `messages` and `comments` collections.
- Twitter-like post composer with edit, delete, replies, image links, and YouTube embeds.
- Media upload hook in `src/config.js`, served by `upload.php` on FastComet.
- Canvas splash screen with particles orbiting the original favicon.
- Live USGS telemetry panel inspired by the old bundle's quake monitoring surface.

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
   **Authentication → Settings → Authorized domains**, and publish Firestore
   security rules that allow public reads and authenticated writes.
