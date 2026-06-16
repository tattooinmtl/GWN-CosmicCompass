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
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} = firestore;

const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const MAX_OPEN_CHATS = 10;
const GROUP_ICON = "&#9733;"; // ★ marks multi-friend chats

const state = {
  user: null,
  view: "feed", // "feed" | "profile"
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
  },
  // Private side
  profile: null, // saved profile { displayName, bio, photoURL }
  profileDraft: { displayName: "", bio: "", photoURL: "" },
  avatarBusy: false,
  friends: [], // [{ uid, displayName, photoURL }]
  friendDocs: new Map(), // uid -> live users/{uid} data (presence, avatar, name)
  incomingRequests: [], // [{ id, fromUid, fromName, fromPhoto }]
  searchTerm: "",
  searchResults: [],
  searchBusy: false,
  conversations: new Map(), // cid -> conversation data
  messagesByChat: new Map(), // cid -> [messages]
  chatDrafts: {}, // cid -> draft text
  chatVideoDrafts: {}, // cid -> pending YouTube link
  chatFiles: {}, // cid -> pending image File
  openChats: [], // [cid] (max MAX_OPEN_CHATS)
  activeChat: null, // cid
  picker: { open: false, mode: "dm", selected: new Set() },
  addToChatOpen: false
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
  const wasUid = state.user?.uid || null;
  state.user = user;
  if (user && user.uid !== wasUid) {
    bootPrivate(user);
  } else if (!user && wasUid) {
    teardownPrivate();
    state.view = "feed";
  }
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
  const showProfile = state.view === "profile" && state.user;
  // Capture focus right before we blow away the DOM, so a background re-render
  // (e.g. an incoming message) only restores focus if a field was actually active.
  const activeFocus = document.activeElement?.getAttribute?.("data-focus") || null;

  app.innerHTML = `
    <main class="app-shell">
      ${topbarTemplate()}
      ${showProfile ? profileViewTemplate() : feedViewTemplate()}
    </main>
  `;

  bindTopbar();
  if (showProfile) {
    bindProfile();
  } else {
    bindComposer();
    bindFeed();
    renderFeed();
  }
  restoreFocus(activeFocus);
}

function feedViewTemplate() {
  return `
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
  `;
}

function restoreFocus(focusId) {
  if (!focusId) return;
  const field = document.querySelector(`[data-focus="${focusId}"]`);
  if (!field) return;
  field.focus();
  if (typeof field.value === "string") {
    const end = field.value.length;
    try {
      field.setSelectionRange(end, end);
    } catch {
      /* some input types disallow setSelectionRange */
    }
  }
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
              <button class="button" data-action="${state.view === "profile" ? "go-feed" : "go-profile"}">
                ${state.view === "profile" ? "Feed" : "Profile"}
              </button>
              <div class="profile-chip">
                <img src="${safeAttr(profilePhoto() || user.photoURL || avatarDataUrl(user.displayName || "CC"))}" alt="" />
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
              <div class="comment-grid">
                <textarea data-role="comment-input" maxlength="280" placeholder="Reply to this signal"></textarea>
                <div class="comment-fields">
                  <input type="url" data-role="comment-image-url" placeholder="Image URL (optional)" />
                  <input type="url" data-role="comment-video-url" placeholder="YouTube link (optional)" />
                  <label class="button file-input">
                    <span>Attach image</span>
                    <input type="file" data-role="comment-file" accept="image/*" />
                  </label>
                </div>
              </div>
              <div class="comment-actions">
                <button class="button primary" type="submit" data-action="send-comment">Reply</button>
                <button class="button" type="button" data-action="cancel-comment">Cancel</button>
              </div>
            </form>
          `
          : ""
      }
    </section>
  `;
}

function commentTemplate(comment) {
  const ownComment = state.user && state.user.uid === comment.authorUid;
  const imageUrl = comment.imageUrl || "";
  const videoUrl = normalizeVideoUrl(comment.videoUrl || "");
  return `
    <div class="comment" data-comment-id="${safeAttr(comment.id)}">
      <div class="comment-head">
        <strong>${escapeHtml(comment.authorName || "Anonymous")}</strong>
        <span>${escapeHtml(formatDate(comment.createdAt))}</span>
      </div>
      ${comment.text ? `<p>${escapeHtml(comment.text)}</p>` : ""}
      ${imageUrl ? `<figure class="media-frame"><img src="${safeAttr(imageUrl)}" alt="Attachment" referrerpolicy="no-referrer" /></figure>` : ""}
      ${videoUrl ? `<figure class="media-frame"><iframe src="${safeAttr(videoUrl)}" title="YouTube video player" allowfullscreen></iframe></figure>` : ""}
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

  document.querySelector('[data-action="go-profile"]')?.addEventListener("click", () => {
    state.view = "profile";
    if (state.profile) {
      state.profileDraft = { ...state.profile };
    }
    render();
  });

  document.querySelector('[data-action="go-feed"]')?.addEventListener("click", () => {
    state.view = "feed";
    render();
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

    if (action === "cancel-comment") {
      const form = event.target.closest(".comment-form");
      form?.querySelectorAll("input, textarea").forEach((field) => {
        field.value = "";
      });
    }
  });

  document.querySelector("#feed")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const post = form.closest("[data-message-id]");
    const messageId = post?.dataset.messageId;

    if (form.classList.contains("comment-form")) {
      const text = form.querySelector('[data-role="comment-input"]').value.trim();
      const imageUrl = form.querySelector('[data-role="comment-image-url"]').value.trim();
      const videoUrl = form.querySelector('[data-role="comment-video-url"]').value.trim();
      const file = form.querySelector('[data-role="comment-file"]').files?.[0] || null;
      if (file && !file.type.startsWith("image/")) {
        return showToast("Only image files can be attached.");
      }
      await createComment(messageId, { text, imageUrl, videoUrl, file });
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

async function createComment(messageId, { text, imageUrl, videoUrl, file }) {
  if (!state.user) return showToast("Connect with Google first.");
  if (!text && !imageUrl && !videoUrl && !file) return;
  try {
    const uploadedUrl = file ? await uploadMedia(file) : "";
    await addDoc(collection(db, "comments"), {
      messageId,
      text,
      imageUrl: uploadedUrl || imageUrl || null,
      videoUrl: normalizeVideoUrl(videoUrl) || null,
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

/* =========================================================================
   Private side: profile, friends, requests, and the multi-chat messenger.
   ========================================================================= */

let heartbeatTimer = null;
const privateUnsubs = [];
const friendUserUnsubs = new Map();
const chatUnsubs = new Map();

function profilePhoto() {
  return state.profile?.photoURL || "";
}
function myName() {
  return state.user?.displayName || state.user?.email || "Anonymous";
}
function myPhoto() {
  return state.profile?.photoURL || state.user?.photoURL || "";
}

async function bootPrivate(user) {
  try {
    const ref = doc(db, "users", user.uid);
    const snap = await getDoc(ref);
    const existing = snap.exists() ? snap.data() : {};
    const displayName = user.displayName || existing.displayName || user.email || "Anonymous";
    const email = user.email || existing.email || "";
    await setDoc(
      ref,
      {
        uid: user.uid,
        displayName,
        displayNameLower: displayName.toLowerCase(),
        email,
        emailLower: email.toLowerCase(),
        bio: existing.bio || "",
        photoURL: existing.photoURL || user.photoURL || "",
        lastActive: serverTimestamp()
      },
      { merge: true }
    );
    state.profile = {
      displayName,
      bio: existing.bio || "",
      photoURL: existing.photoURL || user.photoURL || ""
    };
    state.profileDraft = { ...state.profile };
  } catch (error) {
    showToast(`Profile load failed: ${error.message}`);
  }

  startHeartbeat();
  subscribeRequests();
  subscribeFriends();
  render();
}

function teardownPrivate() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  privateUnsubs.splice(0).forEach((fn) => fn());
  friendUserUnsubs.forEach((fn) => fn());
  friendUserUnsubs.clear();
  chatUnsubs.forEach((fn) => fn());
  chatUnsubs.clear();
  state.profile = null;
  state.profileDraft = { displayName: "", bio: "", photoURL: "" };
  state.friends = [];
  state.friendDocs.clear();
  state.incomingRequests = [];
  state.searchResults = [];
  state.conversations.clear();
  state.messagesByChat.clear();
  state.chatDrafts = {};
  state.chatVideoDrafts = {};
  state.chatFiles = {};
  state.openChats = [];
  state.activeChat = null;
  state.picker = { open: false, mode: "dm", selected: new Set() };
  state.addToChatOpen = false;
}

function startHeartbeat() {
  const beat = () => {
    if (!state.user) return;
    updateDoc(doc(db, "users", state.user.uid), { lastActive: serverTimestamp() }).catch(() => {});
  };
  beat();
  heartbeatTimer = setInterval(beat, 60 * 1000);
}

function subscribeRequests() {
  const q = query(collection(db, "friendRequests"), where("toUid", "==", state.user.uid));
  privateUnsubs.push(
    onSnapshot(
      q,
      (snap) => {
        state.incomingRequests = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((r) => r.status === "pending");
        render();
      },
      (error) => showToast(`Requests sync failed: ${error.message}`)
    )
  );
}

function subscribeFriends() {
  privateUnsubs.push(
    onSnapshot(
      collection(db, "users", state.user.uid, "friends"),
      (snap) => {
        state.friends = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
        syncFriendDocs();
        render();
      },
      (error) => showToast(`Friends sync failed: ${error.message}`)
    )
  );
}

// Live subscription to each friend's user doc for presence + current avatar/name.
function syncFriendDocs() {
  const ids = new Set(state.friends.map((f) => f.uid));
  friendUserUnsubs.forEach((fn, uid) => {
    if (!ids.has(uid)) {
      fn();
      friendUserUnsubs.delete(uid);
      state.friendDocs.delete(uid);
    }
  });
  ids.forEach((uid) => {
    if (friendUserUnsubs.has(uid)) return;
    friendUserUnsubs.set(
      uid,
      onSnapshot(doc(db, "users", uid), (snap) => {
        if (snap.exists()) state.friendDocs.set(uid, snap.data());
        render();
      })
    );
  });
}

function isOnline(uid) {
  const ts = state.friendDocs.get(uid)?.lastActive;
  if (!ts?.toMillis) return false;
  return Date.now() - ts.toMillis() < ONLINE_WINDOW_MS;
}
function friendName(uid) {
  if (uid === state.user?.uid) return myName();
  return (
    state.friendDocs.get(uid)?.displayName ||
    state.friends.find((f) => f.uid === uid)?.displayName ||
    "Member"
  );
}
function friendPhoto(uid) {
  if (uid === state.user?.uid) return myPhoto();
  return (
    state.friendDocs.get(uid)?.photoURL ||
    state.friends.find((f) => f.uid === uid)?.photoURL ||
    ""
  );
}
function otherParticipants(cid) {
  const conv = state.conversations.get(cid);
  return (conv?.participants || []).filter((uid) => uid !== state.user?.uid);
}
function chatLabel(cid) {
  const conv = state.conversations.get(cid);
  if (!conv) return "Chat";
  const others = otherParticipants(cid);
  if (conv.isGroup) return conv.title || others.map(friendName).join(", ") || "Group";
  return friendName(others[0]);
}
function chatAvatar(cid) {
  const others = otherParticipants(cid);
  return friendPhoto(others[0]) || avatarDataUrl(friendName(others[0]));
}

/* ---- Profile view templates ---- */

function profileViewTemplate() {
  return `
    <section class="layout profile-layout">
      <div class="profile-main">
        ${requestsTemplate()}
        ${messengerTemplate()}
      </div>
      <aside class="side-column">
        ${profileEditorTemplate()}
        ${friendsTemplate()}
      </aside>
    </section>
  `;
}

function requestsTemplate() {
  const reqs = state.incomingRequests;
  return `
    <section class="panel">
      <div class="panel-title">
        <h3>Friend Requests</h3>
        <span class="subtle">${reqs.length} pending</span>
      </div>
      ${
        reqs.length
          ? `<div class="request-list">${reqs.map(requestRow).join("")}</div>`
          : `<p class="subtle">No pending invites. Search for friends to connect.</p>`
      }
    </section>
  `;
}

function requestRow(req) {
  return `
    <div class="request-row" data-request-id="${safeAttr(req.id)}" data-from="${safeAttr(req.fromUid)}">
      <img class="avatar sm" src="${safeAttr(req.fromPhoto || avatarDataUrl(req.fromName || "CC"))}" alt="" />
      <span class="friend-name">${escapeHtml(req.fromName || "Someone")}</span>
      <div class="request-actions">
        <button class="button primary sm" data-action="accept-request">Accept</button>
        <button class="button sm" data-action="decline-request">Decline</button>
      </div>
    </div>
  `;
}

function profileEditorTemplate() {
  const d = state.profileDraft;
  return `
    <section class="panel profile-editor">
      <div class="panel-title">
        <h3>Profile</h3>
        <span class="subtle">${escapeHtml(myName())}</span>
      </div>
      <div class="profile-id">
        <label class="avatar-pick">
          <img class="avatar lg" src="${safeAttr(d.photoURL || avatarDataUrl(myName()))}" alt="" />
          <span class="avatar-pick-label">${state.avatarBusy ? "Uploading…" : "Choose picture"}</span>
          <input type="file" data-role="avatar-file" accept="image/*" />
        </label>
        <div class="profile-fields">
          <label class="field-label">Name</label>
          <input type="text" data-role="profile-name" data-focus="profile-name" value="${safeAttr(d.displayName)}" placeholder="Display name" />
          <label class="field-label">Bio</label>
          <textarea data-role="profile-bio" data-focus="profile-bio" maxlength="280" placeholder="Tell people about yourself">${escapeHtml(d.bio)}</textarea>
        </div>
      </div>
      <div class="profile-actions">
        <button class="button primary" data-action="save-profile">Save</button>
        <button class="button" data-action="reset-profile">Reset</button>
      </div>
      <p class="subtle">Your picture is shown in private chats.</p>
    </section>
  `;
}

function friendsTemplate() {
  return `
    <section class="panel friends-panel">
      <div class="panel-title">
        <h3>Friends list</h3>
        <span class="subtle">${state.friends.length}</span>
      </div>
      <div class="friend-list">
        ${
          state.friends.length
            ? state.friends.map(friendRow).join("")
            : `<p class="subtle">No friends yet. Search below to add some.</p>`
        }
      </div>
      <form class="friend-search" data-role="search-form">
        <label class="field-label">Add friend</label>
        <div class="friend-search-row">
          <input type="text" data-role="search-input" data-focus="search-input" value="${safeAttr(state.searchTerm)}" placeholder="Search email or name" />
          <button class="button" type="submit">${state.searchBusy ? "…" : "Search"}</button>
        </div>
      </form>
      ${searchResultsTemplate()}
    </section>
  `;
}

function friendRow(friend) {
  const online = isOnline(friend.uid);
  const name = friendName(friend.uid);
  const photo = friendPhoto(friend.uid) || friend.photoURL || avatarDataUrl(name);
  return `
    <div class="friend-row" data-friend="${safeAttr(friend.uid)}">
      <span class="presence-dot ${online ? "online" : "offline"}" aria-hidden="true"></span>
      <img class="avatar sm" src="${safeAttr(photo)}" alt="" />
      <span class="friend-name">${escapeHtml(name)}</span>
      <span class="friend-status ${online ? "online" : "offline"}">${online ? "Online" : "Offline"}</span>
      <button class="button sm" data-action="chat-friend" data-friend="${safeAttr(friend.uid)}">Chat</button>
    </div>
  `;
}

function searchResultsTemplate() {
  if (!state.searchResults.length) return "";
  return `
    <div class="search-results">
      ${state.searchResults
        .map((u) => {
          const already = state.friends.some((f) => f.uid === u.uid);
          return `
            <div class="search-row" data-user="${safeAttr(u.uid)}">
              <img class="avatar sm" src="${safeAttr(u.photoURL || avatarDataUrl(u.displayName || "CC"))}" alt="" />
              <span class="friend-name">${escapeHtml(u.displayName || u.email || "User")}</span>
              ${
                already
                  ? `<span class="subtle">Friend</span>`
                  : `<button class="button sm primary" data-action="add-friend" data-user="${safeAttr(u.uid)}">Invite</button>`
              }
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

/* ---- Messenger templates ---- */

function messengerTemplate() {
  return `
    <section class="panel messenger">
      <div class="panel-title">
        <h3>Messenger</h3>
        <button class="button sm" data-action="new-chat">New chat</button>
      </div>
      ${tabBarTemplate()}
      ${chatBodyTemplate()}
    </section>
  `;
}

function tabBarTemplate() {
  if (!state.openChats.length) return "";
  return `
    <div class="chat-tabs">
      ${state.openChats
        .map((cid) => {
          const conv = state.conversations.get(cid);
          const active = cid === state.activeChat ? "active" : "";
          const icon = conv?.isGroup ? `<span class="group-icon">${GROUP_ICON}</span>` : "";
          return `
            <div class="chat-tab ${active}" data-chat="${safeAttr(cid)}" data-action="select-chat">
              ${icon}<span class="tab-label">${escapeHtml(chatLabel(cid))}</span>
              <button class="tab-close" data-action="close-chat" data-chat="${safeAttr(cid)}" title="Close">✕</button>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function chatBodyTemplate() {
  if (state.picker.open || !state.activeChat) return chatPickerTemplate();
  const cid = state.activeChat;
  const conv = state.conversations.get(cid);
  const messages = state.messagesByChat.get(cid) || [];
  const draft = state.chatDrafts[cid] || "";
  return `
    <div class="chat-window" data-chat="${safeAttr(cid)}">
      <div class="chat-header">
        <div class="chat-peer">
          ${
            conv?.isGroup
              ? `<span class="group-icon">${GROUP_ICON}</span>`
              : `<img class="avatar sm" src="${safeAttr(chatAvatar(cid))}" alt="" />`
          }
          <strong>${escapeHtml(chatLabel(cid))}</strong>
        </div>
        <div class="chat-header-actions">
          <button class="button sm" data-action="add-to-chat">Add friend</button>
          <button class="button sm" data-action="clear-chat">Clear messages</button>
        </div>
      </div>
      ${addPickerTemplate()}
      <div class="chat-messages" id="chat-messages">
        ${
          messages.length
            ? messages.map(messageBubble).join("")
            : `<p class="subtle chat-empty">No messages yet. Say hello.</p>`
        }
      </div>
      <form class="chat-input" data-role="chat-form">
        <div class="chat-input-main">
          <textarea data-role="chat-text" data-focus="chat-text" placeholder="Write a message… (Enter to send)">${escapeHtml(draft)}</textarea>
          <button class="button primary" type="submit">Send</button>
        </div>
        <div class="chat-input-tools">
          <label class="button sm file-input">
            <span>${state.chatFiles[cid] ? "Image ready ✓" : "Attach image"}</span>
            <input type="file" data-role="chat-file" accept="image/*" />
          </label>
          <input type="url" class="chat-video-input" data-role="chat-video" data-focus="chat-video" value="${safeAttr(state.chatVideoDrafts[cid] || "")}" placeholder="YouTube link (optional)" />
          ${
            state.chatFiles[cid] || state.chatVideoDrafts[cid]
              ? `<button type="button" class="button sm" data-action="clear-attach">Clear</button>`
              : ""
          }
        </div>
      </form>
    </div>
  `;
}

function messageBubble(msg) {
  const own = msg.senderUid === state.user?.uid;
  const image = msg.imageUrl || "";
  const video = msg.videoUrl ? normalizeVideoUrl(msg.videoUrl) : "";
  let media = "";
  if (image) {
    media = `
      <div class="chat-media">
        <img src="${safeAttr(image)}" alt="Attachment" referrerpolicy="no-referrer" />
        <div class="media-actions">
          <a class="media-btn" href="${safeAttr(image)}" target="_blank" rel="noreferrer">Open in new window</a>
          <a class="media-btn" href="${safeAttr(image)}" download target="_blank" rel="noreferrer">Download</a>
        </div>
      </div>`;
  } else if (video) {
    media = `
      <div class="chat-media">
        <iframe src="${safeAttr(video)}" title="YouTube video player" allowfullscreen></iframe>
        <div class="media-actions">
          <a class="media-btn" href="${safeAttr(youtubeWatchUrl(video))}" target="_blank" rel="noreferrer">Open in new window</a>
        </div>
      </div>`;
  }
  return `
    <div class="bubble-row ${own ? "own" : ""}">
      ${own ? "" : `<img class="avatar xs" src="${safeAttr(friendPhoto(msg.senderUid) || msg.senderPhoto || avatarDataUrl(msg.senderName || "CC"))}" alt="" />`}
      <div class="bubble">
        ${own ? "" : `<span class="bubble-name">${escapeHtml(msg.senderName || friendName(msg.senderUid))}</span>`}
        ${msg.text ? `<span class="bubble-text">${escapeHtml(msg.text)}</span>` : ""}
        ${media}
        <span class="bubble-time">${escapeHtml(formatDate(msg.createdAt))}</span>
      </div>
    </div>
  `;
}

function youtubeWatchUrl(embedUrl) {
  const m = embedUrl.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
  return m ? `https://www.youtube.com/watch?v=${m[1]}` : embedUrl;
}

function chatPickerTemplate() {
  const mode = state.picker.mode;
  return `
    <div class="chat-picker">
      <div class="picker-modes">
        <button class="button sm ${mode === "dm" ? "primary" : ""}" data-action="picker-dm">Direct message</button>
        <button class="button sm ${mode === "group" ? "primary" : ""}" data-action="picker-group">${GROUP_ICON} Group chat</button>
      </div>
      <p class="subtle">${mode === "dm" ? "Pick a friend to start chatting." : "Check the friends to invite, then create the group."}</p>
      <div class="picker-list">
        ${
          state.friends.length
            ? state.friends.map((f) => pickerRow(f, mode)).join("")
            : `<p class="subtle">Add friends first — they appear here.</p>`
        }
      </div>
      ${
        mode === "group"
          ? `<button class="button primary" data-action="create-group" ${
              state.picker.selected.size < 1 ? "disabled" : ""
            }>Create group chat (${state.picker.selected.size})</button>`
          : ""
      }
    </div>
  `;
}

function pickerRow(friend, mode) {
  const name = friendName(friend.uid);
  const photo = friendPhoto(friend.uid) || friend.photoURL || avatarDataUrl(name);
  if (mode === "group") {
    const checked = state.picker.selected.has(friend.uid) ? "checked" : "";
    return `
      <label class="picker-row">
        <input type="checkbox" data-action="toggle-select" data-friend="${safeAttr(friend.uid)}" ${checked} />
        <img class="avatar sm" src="${safeAttr(photo)}" alt="" />
        <span class="friend-name">${escapeHtml(name)}</span>
      </label>
    `;
  }
  return `
    <div class="picker-row clickable" data-action="picker-open-dm" data-friend="${safeAttr(friend.uid)}">
      <span class="presence-dot ${isOnline(friend.uid) ? "online" : "offline"}"></span>
      <img class="avatar sm" src="${safeAttr(photo)}" alt="" />
      <span class="friend-name">${escapeHtml(name)}</span>
    </div>
  `;
}

function addPickerTemplate() {
  if (!state.addToChatOpen) return "";
  const cid = state.activeChat;
  const participants = new Set(state.conversations.get(cid)?.participants || []);
  const candidates = state.friends.filter((f) => !participants.has(f.uid));
  return `
    <div class="add-picker">
      <strong class="field-label">Add a friend to this chat</strong>
      ${
        candidates.length
          ? candidates
              .map(
                (f) => `
            <div class="picker-row">
              <img class="avatar sm" src="${safeAttr(friendPhoto(f.uid) || avatarDataUrl(friendName(f.uid)))}" alt="" />
              <span class="friend-name">${escapeHtml(friendName(f.uid))}</span>
              <button class="button sm primary" data-action="confirm-add" data-friend="${safeAttr(f.uid)}">Add</button>
            </div>`
              )
              .join("")
          : `<p class="subtle">All your friends are already in this chat.</p>`
      }
    </div>
  `;
}

/* ---- Profile + messenger event handling ---- */

function bindProfile() {
  const root = document.querySelector(".profile-layout");
  if (!root) return;
  root.addEventListener("click", onProfileClick);
  root.addEventListener("submit", onProfileSubmit);
  root.addEventListener("input", onProfileInput);
  root.addEventListener("change", onProfileChange);
  root.addEventListener("keydown", onProfileKeydown);

  const messages = document.querySelector("#chat-messages");
  if (messages) messages.scrollTop = messages.scrollHeight;
}

function onProfileInput(event) {
  const role = event.target.getAttribute?.("data-role");
  if (role === "profile-name") state.profileDraft.displayName = event.target.value;
  else if (role === "profile-bio") state.profileDraft.bio = event.target.value;
  else if (role === "search-input") state.searchTerm = event.target.value;
  else if (role === "chat-text") state.chatDrafts[state.activeChat] = event.target.value;
  else if (role === "chat-video") state.chatVideoDrafts[state.activeChat] = event.target.value;
}

function onProfileKeydown(event) {
  if (
    event.target.getAttribute?.("data-role") === "chat-text" &&
    event.key === "Enter" &&
    !event.shiftKey
  ) {
    event.preventDefault();
    submitChat();
  }
}

async function onProfileChange(event) {
  const role = event.target.getAttribute?.("data-role");
  const action = event.target.getAttribute?.("data-action");
  if (role === "avatar-file") {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return showToast("Only image files can be used.");
    await uploadAvatar(file);
  }
  if (role === "chat-file") {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      event.target.value = "";
      return showToast("Only image files can be attached.");
    }
    state.chatFiles[state.activeChat] = file;
    render();
  }
  if (action === "toggle-select") {
    const uid = event.target.getAttribute("data-friend");
    if (event.target.checked) state.picker.selected.add(uid);
    else state.picker.selected.delete(uid);
    render();
  }
}

function onProfileSubmit(event) {
  event.preventDefault();
  const form = event.target;
  if (form.matches('[data-role="search-form"]')) return runSearch();
  if (form.matches('[data-role="chat-form"]')) return submitChat();
}

async function onProfileClick(event) {
  const trigger = event.target.closest("[data-action]");
  if (!trigger) return;
  const action = trigger.getAttribute("data-action");
  const friendUid = trigger.getAttribute("data-friend");
  const userUid = trigger.getAttribute("data-user");
  const cid = trigger.getAttribute("data-chat");

  switch (action) {
    case "save-profile":
      return saveProfile();
    case "reset-profile":
      state.profileDraft = { ...(state.profile || { displayName: myName(), bio: "", photoURL: "" }) };
      return render();
    case "add-friend":
      return sendFriendRequest(userUid);
    case "accept-request": {
      const row = trigger.closest("[data-request-id]");
      return acceptRequest(row?.getAttribute("data-request-id"), row?.getAttribute("data-from"));
    }
    case "decline-request": {
      const row = trigger.closest("[data-request-id]");
      return declineRequest(row?.getAttribute("data-request-id"));
    }
    case "chat-friend":
      return openDm(friendUid);
    case "new-chat":
      state.picker.open = true;
      return render();
    case "picker-dm":
      state.picker.mode = "dm";
      state.picker.selected.clear();
      return render();
    case "picker-group":
      state.picker.mode = "group";
      return render();
    case "picker-open-dm":
      return openDm(friendUid);
    case "create-group":
      return createGroup();
    case "select-chat":
      return selectChat(cid);
    case "close-chat":
      event.stopPropagation();
      return closeChat(cid);
    case "clear-chat":
      return clearChat(state.activeChat);
    case "add-to-chat":
      state.addToChatOpen = !state.addToChatOpen;
      return render();
    case "clear-attach":
      state.chatFiles[state.activeChat] = null;
      state.chatVideoDrafts[state.activeChat] = "";
      return render();
    case "confirm-add":
      return addFriendToChat(state.activeChat, friendUid);
    default:
      return;
  }
}

/* ---- Profile actions ---- */

async function saveProfile() {
  if (!state.user) return;
  const d = state.profileDraft;
  const displayName = (d.displayName || "").trim() || myName();
  try {
    await setDoc(
      doc(db, "users", state.user.uid),
      {
        displayName,
        displayNameLower: displayName.toLowerCase(),
        bio: (d.bio || "").trim(),
        photoURL: d.photoURL || "",
        lastActive: serverTimestamp()
      },
      { merge: true }
    );
    state.profile = { displayName, bio: (d.bio || "").trim(), photoURL: d.photoURL || "" };
    showToast("Profile saved.");
    render();
  } catch (error) {
    showToast(`Save failed: ${error.message}`);
  }
}

async function uploadAvatar(file) {
  state.avatarBusy = true;
  render();
  try {
    state.profileDraft.photoURL = await uploadMedia(file);
    showToast("Picture ready — press Save.");
  } catch (error) {
    showToast(`Picture upload failed: ${error.message}`);
  } finally {
    state.avatarBusy = false;
    render();
  }
}

/* ---- Friends + requests ---- */

async function runSearch() {
  const term = (state.searchTerm || "").trim().toLowerCase();
  if (!term) return;
  state.searchBusy = true;
  render();
  try {
    const results = new Map();
    const byEmail = await getDocs(query(collection(db, "users"), where("emailLower", "==", term)));
    byEmail.forEach((d) => results.set(d.id, { uid: d.id, ...d.data() }));
    const byName = await getDocs(
      query(
        collection(db, "users"),
        where("displayNameLower", ">=", term),
        where("displayNameLower", "<=", term + ""),
        limit(10)
      )
    );
    byName.forEach((d) => results.set(d.id, { uid: d.id, ...d.data() }));
    results.delete(state.user.uid);
    state.searchResults = [...results.values()];
    if (!state.searchResults.length) showToast("No users found.");
  } catch (error) {
    showToast(`Search failed: ${error.message}`);
  } finally {
    state.searchBusy = false;
    render();
  }
}

async function sendFriendRequest(targetUid) {
  if (!targetUid || targetUid === state.user.uid) return;
  const target = state.searchResults.find((u) => u.uid === targetUid);
  const toName = target?.displayName || target?.email || "User";
  const reqId = `${state.user.uid}__${targetUid}`;
  try {
    await setDoc(doc(db, "friendRequests", reqId), {
      fromUid: state.user.uid,
      fromName: myName(),
      fromPhoto: myPhoto(),
      toUid: targetUid,
      toName,
      status: "pending",
      createdAt: serverTimestamp()
    });
    showToast(`Invite sent to ${toName}.`);
  } catch (error) {
    showToast(`Invite failed: ${error.message}`);
  }
}

async function acceptRequest(reqId, fromUid) {
  if (!reqId || !fromUid) return;
  const req = state.incomingRequests.find((r) => r.id === reqId);
  try {
    await updateDoc(doc(db, "friendRequests", reqId), { status: "accepted" });
    await setDoc(doc(db, "users", state.user.uid, "friends", fromUid), {
      uid: fromUid,
      displayName: req?.fromName || friendName(fromUid),
      photoURL: req?.fromPhoto || "",
      since: serverTimestamp()
    });
    await setDoc(doc(db, "users", fromUid, "friends", state.user.uid), {
      uid: state.user.uid,
      displayName: myName(),
      photoURL: myPhoto(),
      since: serverTimestamp()
    });
    showToast("Friend added.");
  } catch (error) {
    showToast(`Accept failed: ${error.message}`);
  }
}

async function declineRequest(reqId) {
  if (!reqId) return;
  try {
    await deleteDoc(doc(db, "friendRequests", reqId));
  } catch (error) {
    showToast(`Decline failed: ${error.message}`);
  }
}

/* ---- Chat operations ---- */

async function openDm(friendUid) {
  if (!friendUid || friendUid === state.user.uid) return;
  const cid = "dm_" + [state.user.uid, friendUid].sort().join("_");
  try {
    // Create-or-merge in one write. We can't pre-read with getDoc, because the
    // security rules deny reading a conversation that doesn't exist yet (there's
    // no resource.participants to check). merge keeps any existing lastMessage.
    await setDoc(
      doc(db, "conversations", cid),
      {
        participants: [state.user.uid, friendUid].sort(),
        isGroup: false,
        title: "",
        createdBy: state.user.uid
      },
      { merge: true }
    );
    openChat(cid);
  } catch (error) {
    showToast(`Open chat failed: ${error.message}`);
  }
}

async function createGroup() {
  const selected = [...state.picker.selected];
  if (!selected.length) return;
  try {
    const ref = await addDoc(collection(db, "conversations"), {
      participants: [state.user.uid, ...selected],
      isGroup: true,
      title: "",
      createdBy: state.user.uid,
      createdAt: serverTimestamp(),
      lastMessage: "",
      lastMessageAt: serverTimestamp(),
      lastSenderUid: ""
    });
    state.picker = { open: false, mode: "dm", selected: new Set() };
    openChat(ref.id);
  } catch (error) {
    showToast(`Group create failed: ${error.message}`);
  }
}

function openChat(cid) {
  if (!state.openChats.includes(cid)) {
    if (state.openChats.length >= MAX_OPEN_CHATS) {
      showToast(`You can have ${MAX_OPEN_CHATS} chats open at once.`);
      return;
    }
    state.openChats.push(cid);
    subscribeChat(cid);
  }
  state.activeChat = cid;
  state.picker.open = false;
  state.addToChatOpen = false;
  render();
}

function subscribeChat(cid) {
  const convUnsub = onSnapshot(doc(db, "conversations", cid), (snap) => {
    if (snap.exists()) state.conversations.set(cid, snap.data());
    render();
  });
  const msgUnsub = onSnapshot(
    query(collection(db, "conversations", cid, "messages"), orderBy("createdAt", "asc"), limit(300)),
    (snap) => {
      state.messagesByChat.set(cid, snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      render();
    },
    (error) => showToast(`Chat sync failed: ${error.message}`)
  );
  chatUnsubs.set(cid, () => {
    convUnsub();
    msgUnsub();
  });
}

function selectChat(cid) {
  state.activeChat = cid;
  state.picker.open = false;
  state.addToChatOpen = false;
  render();
}

function closeChat(cid) {
  chatUnsubs.get(cid)?.();
  chatUnsubs.delete(cid);
  state.openChats = state.openChats.filter((id) => id !== cid);
  state.messagesByChat.delete(cid);
  if (state.activeChat === cid) {
    state.activeChat = state.openChats[state.openChats.length - 1] || null;
  }
  render();
}

async function submitChat() {
  const cid = state.activeChat;
  if (!cid) return;
  const text = (state.chatDrafts[cid] || "").trim();
  const videoUrl = (state.chatVideoDrafts[cid] || "").trim();
  const file = state.chatFiles[cid] || null;
  if (!text && !videoUrl && !file) return;

  // Clear the composer immediately; restore it if the send fails.
  state.chatDrafts[cid] = "";
  state.chatVideoDrafts[cid] = "";
  state.chatFiles[cid] = null;
  render();

  try {
    const uploadedUrl = file ? await uploadMedia(file) : "";
    await addDoc(collection(db, "conversations", cid, "messages"), {
      text,
      imageUrl: uploadedUrl || null,
      videoUrl: normalizeVideoUrl(videoUrl) || null,
      senderUid: state.user.uid,
      senderName: myName(),
      senderPhoto: myPhoto(),
      createdAt: serverTimestamp()
    });
    await updateDoc(doc(db, "conversations", cid), {
      lastMessage: text || (uploadedUrl ? "Image" : "Video"),
      lastMessageAt: serverTimestamp(),
      lastSenderUid: state.user.uid
    });
  } catch (error) {
    state.chatDrafts[cid] = text;
    state.chatVideoDrafts[cid] = videoUrl;
    state.chatFiles[cid] = file;
    showToast(`Send failed: ${error.message}`);
  }
  render();
}

async function clearChat(cid) {
  if (!cid) return;
  if (!window.confirm("Clear all messages in this chat for everyone?")) return;
  try {
    const snap = await getDocs(collection(db, "conversations", cid, "messages"));
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
    await updateDoc(doc(db, "conversations", cid), { lastMessage: "", lastSenderUid: "" });
    showToast("Messages cleared.");
  } catch (error) {
    showToast(`Clear failed: ${error.message}`);
  }
}

async function addFriendToChat(cid, friendUid) {
  if (!cid || !friendUid) return;
  const conv = state.conversations.get(cid);
  try {
    if (conv?.isGroup) {
      await updateDoc(doc(db, "conversations", cid), { participants: arrayUnion(friendUid) });
      state.addToChatOpen = false;
      showToast("Friend added to group.");
      render();
    } else {
      const ref = await addDoc(collection(db, "conversations"), {
        participants: [state.user.uid, ...otherParticipants(cid), friendUid],
        isGroup: true,
        title: "",
        createdBy: state.user.uid,
        createdAt: serverTimestamp(),
        lastMessage: "",
        lastMessageAt: serverTimestamp(),
        lastSenderUid: ""
      });
      state.addToChatOpen = false;
      openChat(ref.id);
    }
  } catch (error) {
    showToast(`Add friend failed: ${error.message}`);
  }
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
