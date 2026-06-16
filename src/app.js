import { appConfig, mediaConfig } from "./config.js";
import {
  auth,
  db,
  firestore,
  listenForAuth,
  signIn,
  signOutUser
} from "./firebase.js";

const {
  addDoc,
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc
} = firestore;

const state = {
  user: null,
  messages: [],
  commentsByMessage: new Map(),
  activeComments: new Set(),
  editingId: null,
  uploadFile: null,
  telemetry: {
    loading: true,
    events: [],
    maxMag: 0,
    risk: "Safe"
  }
};

const app = document.querySelector("#app");
const splash = document.querySelector("#splash");
const splashCanvas = document.querySelector("#splash-canvas");

if ("scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}
window.scrollTo(0, 0);

bootSplash();
render();

listenForAuth((user) => {
  state.user = user;
  render();
});

listenForMessages();
loadTelemetry();
setInterval(loadTelemetry, 1000 * 60 * 5);

setTimeout(() => {
  splash.classList.add("is-hidden");
  window.scrollTo(0, 0);
}, 1700);

function render() {
  app.innerHTML = `
    <main class="app-shell">
      ${topbarTemplate()}
      <section class="layout">
        <div class="feed-column">
          ${composerTemplate()}
          <div id="feed"></div>
        </div>
        <aside class="side-column">
          ${statusTemplate()}
          ${telemetryTemplate()}
          ${aboutTemplate()}
        </aside>
      </section>
    </main>
  `;

  bindTopbar();
  bindComposer();
  bindFeed();
  renderFeed();
}

function topbarTemplate() {
  const user = state.user;
  return `
    <header class="topbar">
      <div class="brand">
        <img src="/public/favicon.png" alt="" />
        <div>
          <h1>${appConfig.appName}</h1>
          <span>Live cosmic signal feed</span>
        </div>
      </div>
      <div class="actions">
        ${
          user
            ? `
              <div class="profile-chip">
                <img src="${safeAttr(user.photoURL || avatarDataUrl(user.displayName || "CC"))}" alt="" />
                <span>${escapeHtml(user.displayName || user.email || "Anonymous")}</span>
              </div>
              <button class="button" data-action="logout">Sign out</button>
            `
            : `<button class="button primary" data-action="login">Connect with Google</button>`
        }
      </div>
    </header>
  `;
}

function composerTemplate() {
  const disabled = state.user ? "" : "disabled";
  return `
    <section class="panel composer" aria-label="Create post">
      <div class="panel-title">
        <h2>Cosmic Feed</h2>
        <span class="status-dot" aria-hidden="true"></span>
      </div>
      ${
        state.user
          ? `
            <form id="composer-form">
              <div class="composer-row">
                <img class="avatar" src="${safeAttr(state.user.photoURL || avatarDataUrl(state.user.displayName || "CC"))}" alt="" />
                <textarea id="post-text" maxlength="${appConfig.maxPostLength}" placeholder="Transmit an update, link, signal, or field note..."></textarea>
              </div>
              <div class="composer-tools">
                <input id="image-url" type="url" placeholder="Image URL or uploaded link" />
                <input id="video-url" type="url" placeholder="YouTube link" />
                <label class="button file-input">
                  <span>Attach image</span>
                  <input id="media-file" type="file" accept="image/*" ${disabled} />
                </label>
              </div>
              <div class="composer-tools">
                <span id="composer-help" class="subtle">Upload endpoint is ${mediaConfig.uploadEndpoint ? "connected" : "waiting for config"}.</span>
                <span id="char-count" class="subtle">0 / ${appConfig.maxPostLength}</span>
                <button class="button primary" type="submit">Transmit</button>
              </div>
            </form>
          `
          : `
            <div class="empty-state">
              Connect your cosmic signature to join the feed.
            </div>
          `
      }
    </section>
  `;
}

function statusTemplate() {
  const count = state.messages.length;
  return `
    <section class="panel">
      <div class="panel-title">
        <h3>System Status</h3>
        <span class="subtle">Live</span>
      </div>
      <div class="telemetry-grid">
        <div class="metric">
          <span>Posts tracked</span>
          <strong>${count}</strong>
        </div>
        <div class="metric">
          <span>Auth</span>
          <strong>${state.user ? "Online" : "Standby"}</strong>
        </div>
        <div class="metric">
          <span>Media relay</span>
          <strong>${mediaConfig.uploadEndpoint ? "Online" : "Pending"}</strong>
        </div>
      </div>
    </section>
  `;
}

function telemetryTemplate() {
  const riskClass = state.telemetry.risk === "Critical" ? "critical" : state.telemetry.risk === "Elevated" ? "elevated" : "";
  const events = state.telemetry.events.slice(0, 5);
  return `
    <section class="panel">
      <div class="panel-title">
        <h3>72H Forecast</h3>
        <span class="risk ${riskClass}">${state.telemetry.risk}</span>
      </div>
      <div class="radar" aria-hidden="true"></div>
      <div class="telemetry-grid">
        <div class="metric">
          <span>Total Events</span>
          <strong>${state.telemetry.loading ? "Sync" : state.telemetry.events.length}</strong>
        </div>
        <div class="metric">
          <span>Max Magnitude</span>
          <strong>${state.telemetry.maxMag.toFixed(1)}</strong>
        </div>
      </div>
      <div class="quake-list">
        ${
          events.length
            ? events.map((event) => quakeTemplate(event)).join("")
            : `<div class="empty-state">No significant events detected in range</div>`
        }
      </div>
    </section>
  `;
}

function aboutTemplate() {
  return `
    <section class="panel">
      <div class="panel-title">
        <h3>Protocol</h3>
        <span class="subtle">Recovered</span>
      </div>
      <p class="subtle">
        Firebase login, Firestore messages, nested comments, image links, YouTube embeds, and live USGS telemetry are rebuilt from the compiled CosmicCompass bundle.
      </p>
    </section>
  `;
}

function renderFeed() {
  const feed = document.querySelector("#feed");
  if (!feed) return;

  if (!state.messages.length) {
    feed.innerHTML = `<div class="empty-state">NO_COSMIC_POSTS_DETECTED</div>`;
    return;
  }

  feed.innerHTML = state.messages.map((message) => postTemplate(message)).join("");
}

function postTemplate(message) {
  const ownPost = state.user && state.user.uid === message.authorUid;
  const commentsOpen = state.activeComments.has(message.id);
  const isEditing = state.editingId === message.id;
  const created = formatDate(message.createdAt);
  const imageUrl = message.imageUrl || "";
  const videoUrl = normalizeVideoUrl(message.videoUrl || "");

  return `
    <article class="post" data-message-id="${safeAttr(message.id)}">
      <div class="post-header">
        <div class="author">
          <div class="avatar" aria-hidden="true"></div>
          <div>
            <strong>${escapeHtml(message.authorName || "Anonymous")}</strong>
            <span>${ownPost ? "Origin" : "Signal"} · ${escapeHtml(created)}</span>
          </div>
        </div>
        ${ownPost ? `<button class="button icon" title="Delete post" data-action="delete-post">x</button>` : ""}
      </div>
      <div class="post-body">
        ${
          isEditing
            ? `
              <form class="edit-form">
                <textarea data-role="edit-text">${escapeHtml(message.text || "")}</textarea>
                <div class="actions">
                  <button class="button primary" type="submit" data-action="save-edit">Save</button>
                  <button class="button" type="button" data-action="cancel-edit">Cancel</button>
                </div>
              </form>
            `
            : `<p class="post-text">${escapeHtml(message.text || "")}</p>`
        }
        ${imageUrl ? `<figure class="media-frame"><img src="${safeAttr(imageUrl)}" alt="Attachment" referrerpolicy="no-referrer" /></figure>` : ""}
        ${videoUrl ? `<figure class="media-frame"><iframe src="${safeAttr(videoUrl)}" title="YouTube video player" allowfullscreen></iframe></figure>` : ""}
      </div>
      <div class="post-actions">
        <button class="button" data-action="toggle-comments">${commentsOpen ? "Hide replies" : "Replies"}</button>
        ${ownPost && !isEditing ? `<button class="button" data-action="edit-post">Edit</button>` : ""}
        ${message.imageUrl || message.videoUrl ? `<a class="button" href="${safeAttr(message.imageUrl || message.videoUrl)}" target="_blank" rel="noreferrer">Open media</a>` : ""}
      </div>
      ${commentsOpen ? commentsTemplate(message.id) : ""}
    </article>
  `;
}

function commentsTemplate(messageId) {
  const comments = state.commentsByMessage.get(messageId) || [];
  return `
    <section class="comments">
      ${
        comments.length
          ? comments.map((comment) => commentTemplate(comment)).join("")
          : `<div class="subtle">Connect signature to transmit responses.</div>`
      }
      ${
        state.user
          ? `
            <form class="comment-form">
              <input type="text" data-role="comment-input" maxlength="280" placeholder="Reply to this signal" />
              <button class="button primary" type="submit" data-action="send-comment">Reply</button>
            </form>
          `
          : ""
      }
    </section>
  `;
}

function commentTemplate(comment) {
  const ownComment = state.user && state.user.uid === comment.authorUid;
  return `
    <div class="comment" data-comment-id="${safeAttr(comment.id)}">
      <div class="comment-head">
        <strong>${escapeHtml(comment.authorName || "Anonymous")}</strong>
        <span>${escapeHtml(formatDate(comment.createdAt))}</span>
      </div>
      <p>${escapeHtml(comment.text || "")}</p>
      ${ownComment ? `<button class="button icon" title="Delete reply" data-action="delete-comment">x</button>` : ""}
    </div>
  `;
}

function quakeTemplate(event) {
  const risk = event.mag >= 6 ? "Critical" : event.mag >= 4 ? "Elevated" : "Safe";
  return `
    <a class="quake" href="${safeAttr(event.url)}" target="_blank" rel="noreferrer">
      <strong>M${event.mag.toFixed(1)} ${escapeHtml(event.place)}</strong>
      <span>${risk} · ${escapeHtml(formatTime(event.time))} · Depth ${escapeHtml(String(event.depth))}km</span>
    </a>
  `;
}

function bindTopbar() {
  document.querySelector('[data-action="login"]')?.addEventListener("click", async () => {
    try {
      await signIn();
    } catch (error) {
      showToast(`Login error: ${error.message}`);
    }
  });

  document.querySelector('[data-action="logout"]')?.addEventListener("click", async () => {
    try {
      await signOutUser();
    } catch (error) {
      showToast(`Sign out error: ${error.message}`);
    }
  });
}

function bindComposer() {
  const form = document.querySelector("#composer-form");
  if (!form) return;

  const text = document.querySelector("#post-text");
  const count = document.querySelector("#char-count");
  const file = document.querySelector("#media-file");

  text.addEventListener("input", () => {
    count.textContent = `${text.value.length} / ${appConfig.maxPostLength}`;
  });

  file.addEventListener("change", () => {
    const picked = file.files?.[0] || null;
    const helper = document.querySelector("#composer-help");
    if (picked && !picked.type.startsWith("image/")) {
      file.value = "";
      state.uploadFile = null;
      if (helper) helper.textContent = "Please choose an image file.";
      showToast("Only image files can be attached.");
      return;
    }
    state.uploadFile = picked;
    if (helper && state.uploadFile) helper.textContent = `Ready: ${state.uploadFile.name}`;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const imageUrl = document.querySelector("#image-url").value.trim();
    const videoUrl = document.querySelector("#video-url").value.trim();
    await createPost(text.value.trim(), imageUrl, videoUrl);
  });
}

function bindFeed() {
  document.querySelector("#feed")?.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    const post = event.target.closest("[data-message-id]");
    const messageId = post?.dataset.messageId;
    const comment = event.target.closest("[data-comment-id]");

    if (action === "toggle-comments") {
      toggleComments(messageId);
    }

    if (action === "delete-post") {
      await deletePost(messageId);
    }

    if (action === "edit-post") {
      state.editingId = messageId;
      render();
    }

    if (action === "cancel-edit") {
      state.editingId = null;
      render();
    }

    if (action === "delete-comment") {
      await deleteComment(comment.dataset.commentId);
    }
  });

  document.querySelector("#feed")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const post = form.closest("[data-message-id]");
    const messageId = post?.dataset.messageId;

    if (form.classList.contains("comment-form")) {
      const input = form.querySelector('[data-role="comment-input"]');
      await createComment(messageId, input.value.trim());
      input.value = "";
    }

    if (form.classList.contains("edit-form")) {
      const text = form.querySelector('[data-role="edit-text"]').value.trim();
      await saveEdit(messageId, text);
    }
  });
}

async function createPost(text, imageUrl, videoUrl) {
  if (!state.user) return showToast("Connect with Google first.");
  if (!text && !imageUrl && !videoUrl && !state.uploadFile) return showToast("Add text or media first.");

  try {
    const uploadedUrl = state.uploadFile ? await uploadMedia(state.uploadFile) : "";
    await addDoc(collection(db, "messages"), {
      text,
      authorUid: state.user.uid,
      authorName: state.user.displayName || state.user.email || "Anonymous",
      imageUrl: uploadedUrl || imageUrl || null,
      videoUrl: normalizeVideoUrl(videoUrl) || null,
      createdAt: serverTimestamp()
    });
    state.uploadFile = null;
    showToast("Post transmitted.");
  } catch (error) {
    showToast(`Create post failed: ${error.message}`);
  }
}

async function saveEdit(messageId, text) {
  if (!text) return showToast("Post cannot be empty.");
  try {
    await updateDoc(doc(db, "messages", messageId), { text });
    state.editingId = null;
    render();
    showToast("Post updated successfully.");
  } catch (error) {
    showToast(`Update failed: ${error.message}`);
  }
}

async function deletePost(messageId) {
  if (!messageId) return;
  try {
    await deleteDoc(doc(db, "messages", messageId));
    showToast("Post deleted.");
  } catch (error) {
    showToast(`Delete failed: ${error.message}`);
  }
}

async function createComment(messageId, text) {
  if (!state.user) return showToast("Connect with Google first.");
  if (!text) return;
  try {
    await addDoc(collection(db, "comments"), {
      messageId,
      text,
      authorUid: state.user.uid,
      authorName: state.user.displayName || state.user.email || "Anonymous",
      createdAt: serverTimestamp()
    });
  } catch (error) {
    showToast(`Reply failed: ${error.message}`);
  }
}

async function deleteComment(commentId) {
  try {
    await deleteDoc(doc(db, "comments", commentId));
  } catch (error) {
    showToast(`Reply delete failed: ${error.message}`);
  }
}

function listenForMessages() {
  const messagesQuery = query(collection(db, "messages"), orderBy("createdAt", "desc"), limit(80));
  onSnapshot(
    messagesQuery,
    (snapshot) => {
      state.messages = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      render();
    },
    (error) => showToast(`Feed sync failed: ${error.message}`)
  );
}

function listenForComments(messageId) {
  const commentsQuery = query(collection(db, "comments"), orderBy("createdAt", "asc"), limit(300));
  return onSnapshot(
    commentsQuery,
    (snapshot) => {
      const comments = snapshot.docs
        .map((item) => ({ id: item.id, ...item.data() }))
        .filter((comment) => comment.messageId === messageId);
      state.commentsByMessage.set(messageId, comments);
      render();
    },
    (error) => showToast(`Reply sync failed: ${error.message}`)
  );
}

const commentListeners = new Map();

function toggleComments(messageId) {
  if (state.activeComments.has(messageId)) {
    state.activeComments.delete(messageId);
    commentListeners.get(messageId)?.();
    commentListeners.delete(messageId);
  } else {
    state.activeComments.add(messageId);
    commentListeners.set(messageId, listenForComments(messageId));
  }
  render();
}

async function uploadMedia(file) {
  if (!mediaConfig.uploadEndpoint) {
    throw new Error("Add your uploadEndpoint in src/config.js first.");
  }

  const form = new FormData();
  form.append("file", file);
  const response = await fetch(mediaConfig.uploadEndpoint, {
    method: "POST",
    body: form
  });
  if (!response.ok) throw new Error(`Upload server returned ${response.status}`);
  const payload = await response.json();
  if (!payload.url) throw new Error("Upload response needs a url field.");
  return mediaConfig.publicBaseUrl ? new URL(payload.url, mediaConfig.publicBaseUrl).href : payload.url;
}

async function loadTelemetry() {
  try {
    const response = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson");
    if (!response.ok) throw new Error(`USGS returned ${response.status}`);
    const data = await response.json();
    const events = data.features.map((feature) => ({
      mag: Number(feature.properties.mag || 0),
      place: feature.properties.place || "Unknown origin",
      time: feature.properties.time,
      depth: Number(feature.geometry.coordinates[2] || 0).toFixed(1),
      url: feature.properties.url || "https://earthquake.usgs.gov"
    }));
    const maxMag = events.reduce((max, event) => Math.max(max, event.mag), 0);
    state.telemetry = {
      loading: false,
      events,
      maxMag,
      risk: maxMag >= 6 ? "Critical" : maxMag >= 4 ? "Elevated" : "Safe"
    };
    render();
  } catch (error) {
    state.telemetry.loading = false;
    showToast(`Telemetry sync failed: ${error.message}`);
    render();
  }
}

function normalizeVideoUrl(url) {
  if (!url) return "";
  // Pull the 11-char video id out of any YouTube URL shape — watch links
  // (even with the v= param not first), youtu.be, embed, shorts, live, v —
  // on any subdomain (www, m, or none). Always rebuild as the embeddable form.
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  return match ? `https://www.youtube.com/embed/${match[1]}` : url;
}

function formatDate(timestamp) {
  if (!timestamp) return "Syncing";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeAttr(value) {
  return escapeHtml(value || "");
}

function avatarDataUrl(name) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "CC";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#15191c"/><circle cx="32" cy="32" r="30" fill="#bc13fe" opacity=".45"/><text x="50%" y="54%" text-anchor="middle" font-family="Arial" font-size="22" font-weight="700" fill="#fff">${initials}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function showToast(message) {
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

function bootSplash() {
  const ctx = splashCanvas.getContext("2d");
  const particles = Array.from({ length: 160 }, (_, index) => ({
    index,
    radius: 88 + Math.random() * 210,
    angle: Math.random() * Math.PI * 2,
    speed: 0.002 + Math.random() * 0.008,
    size: 0.8 + Math.random() * 2.4,
    warmth: Math.random()
  }));

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    splashCanvas.width = Math.floor(window.innerWidth * dpr);
    splashCanvas.height = Math.floor(window.innerHeight * dpr);
    splashCanvas.style.width = `${window.innerWidth}px`;
    splashCanvas.style.height = `${window.innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function frame() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const centerX = width / 2;
    const centerY = height / 2;
    ctx.clearRect(0, 0, width, height);

    for (const particle of particles) {
      particle.angle += particle.speed;
      const wobble = Math.sin(performance.now() * 0.001 + particle.index) * 18;
      const x = centerX + Math.cos(particle.angle) * (particle.radius + wobble);
      const y = centerY + Math.sin(particle.angle * 1.08) * (particle.radius * 0.72 + wobble);
      const color = particle.warmth > 0.5 ? "255, 116, 24" : "0, 207, 255";

      ctx.beginPath();
      ctx.arc(x, y, particle.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${color}, ${0.28 + particle.size * 0.12})`;
      ctx.shadowColor = `rgba(${color}, 0.8)`;
      ctx.shadowBlur = 18;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    ctx.beginPath();
    ctx.arc(centerX, centerY, Math.min(width, height) * 0.19, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 1;
    ctx.stroke();

    requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener("resize", resize);
  frame();
}
