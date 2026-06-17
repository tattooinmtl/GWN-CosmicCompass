// 1:1 video calling for CosmicCompass.
//
// Self-contained: WebRTC peer connection + Firestore signaling + an overlay UI
// that lives OUTSIDE app.js's render() cycle (appended to <body>), so the live
// <video> streams survive the app's frequent re-renders.
//
// Public API (used by app.js):
//   startCalls(me)   - begin listening for incoming calls (call on login)
//   stopCalls()      - tear down listener + any active call (call on logout)
//   placeCall(...)   - start an outgoing call to a friend (DM Call button)

import { db, firestore } from "./firebase.js";

const {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} = firestore;

const ICE_ENDPOINT = "/turn-creds.php";
const NO_ANSWER_MS = 35000;

let me = null; // { uid, displayName, photoURL }
let incomingUnsub = null;
let call = null; // active call state, or null
let timerInterval = null;

/* ----------------------------- public API ----------------------------- */

export function startCalls(user) {
  me = user;
  listenForIncoming();
}

export function stopCalls() {
  if (incomingUnsub) {
    incomingUnsub();
    incomingUnsub = null;
  }
  hideIncoming();
  if (call) endCall();
  me = null;
}

export async function placeCall(friendUid, friendName, friendPhoto, conversationId) {
  if (!me) return;
  if (call) {
    toast("You're already in a call.");
    return;
  }
  let localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch {
    toast("Camera/microphone access is needed to call.");
    return;
  }

  const iceServers = await getIceServers();
  const callRef = doc(collection(db, "calls"));
  const pc = newPeer(callRef.id, "callerCandidates", iceServers);
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  call = {
    id: callRef.id,
    role: "caller",
    pc,
    localStream,
    remoteStream: new MediaStream(),
    peerName: friendName,
    peerPhoto: friendPhoto,
    status: "ringing",
    unsubs: [],
    noAnswer: null,
    startedAt: 0
  };
  wireRemote(pc);
  buildOverlay();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  await setDoc(callRef, {
    conversationId: conversationId || null,
    callerUid: me.uid,
    callerName: me.displayName || "",
    callerPhoto: me.photoURL || "",
    calleeUid: friendUid,
    calleeName: friendName || "",
    status: "ringing",
    offer: { type: offer.type, sdp: offer.sdp },
    createdAt: serverTimestamp()
  });

  // Watch the call doc for the answer + terminal status changes.
  call.unsubs.push(
    onSnapshot(callRef, async (snap) => {
      const data = snap.data();
      if (!data) return endCall();
      if (data.answer && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        setActive();
      }
      if (["declined", "ended", "missed", "busy"].includes(data.status)) {
        endCall(data.status);
      }
    })
  );
  // Watch the callee's ICE candidates.
  call.unsubs.push(watchCandidates(callRef.id, "calleeCandidates", pc));

  // Give up if nobody answers.
  call.noAnswer = setTimeout(() => {
    if (call && call.status === "ringing") {
      updateDoc(callRef, { status: "missed" }).catch(() => {});
      endCall("missed");
    }
  }, NO_ANSWER_MS);
}

/* ----------------------------- incoming ----------------------------- */

function listenForIncoming() {
  if (incomingUnsub) incomingUnsub();
  const q = query(
    collection(db, "calls"),
    where("calleeUid", "==", me.uid),
    where("status", "==", "ringing")
  );
  incomingUnsub = onSnapshot(
    q,
    (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === "removed") {
          // Caller cancelled / call no longer ringing — close the popup.
          const inc = document.getElementById("cc-incoming");
          if (inc && inc.dataset.callId === change.doc.id) hideIncoming();
          return;
        }
        if (change.type !== "added") return;
        const data = change.doc.data();
        if (call) {
          // Already busy — politely decline.
          updateDoc(change.doc.ref, { status: "busy" }).catch(() => {});
          return;
        }
        showIncoming(change.doc.id, data);
      });
    },
    () => {}
  );
}

async function acceptCall(callId, data) {
  if (call) return;
  hideIncoming();
  let localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch {
    toast("Camera/microphone access is needed to answer.");
    updateDoc(doc(db, "calls", callId), { status: "declined" }).catch(() => {});
    return;
  }

  const iceServers = await getIceServers();
  const pc = newPeer(callId, "calleeCandidates", iceServers);
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  call = {
    id: callId,
    role: "callee",
    pc,
    localStream,
    remoteStream: new MediaStream(),
    peerName: data.callerName,
    peerPhoto: data.callerPhoto,
    status: "active",
    unsubs: [],
    noAnswer: null,
    startedAt: 0
  };
  wireRemote(pc);

  const callRef = doc(db, "calls", callId);
  await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await updateDoc(callRef, {
    answer: { type: answer.type, sdp: answer.sdp },
    status: "active"
  });

  buildOverlay();
  setActive();

  call.unsubs.push(
    onSnapshot(callRef, (snap) => {
      const d = snap.data();
      if (!d || ["ended", "declined", "missed"].includes(d.status)) endCall(d?.status);
    })
  );
  call.unsubs.push(watchCandidates(callId, "callerCandidates", pc));
}

function declineCall(callId) {
  updateDoc(doc(db, "calls", callId), { status: "declined" }).catch(() => {});
  hideIncoming();
}

/* ----------------------------- WebRTC plumbing ----------------------------- */

async function getIceServers() {
  try {
    const res = await fetch(ICE_ENDPOINT, { cache: "no-store" });
    const data = await res.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length) return data.iceServers;
  } catch {
    /* fall through to STUN-only */
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

function newPeer(callId, mySide, iceServers) {
  const pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      addDoc(collection(db, "calls", callId, mySide), ev.candidate.toJSON()).catch(() => {});
    }
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) endCall();
  };
  return pc;
}

function wireRemote(pc) {
  pc.ontrack = (ev) => {
    ev.streams[0].getTracks().forEach((t) => call.remoteStream.addTrack(t));
    const remote = document.getElementById("cc-remote-video");
    if (remote && remote.srcObject !== call.remoteStream) remote.srcObject = call.remoteStream;
  };
}

function watchCandidates(callId, side, pc) {
  return onSnapshot(collection(db, "calls", callId, side), (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added") {
        pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(() => {});
      }
    });
  });
}

async function endCall(reason) {
  if (!call) return;
  const c = call;
  call = null; // prevent re-entry from listeners firing during teardown

  if (c.noAnswer) clearTimeout(c.noAnswer);
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  c.unsubs.forEach((u) => {
    try {
      u();
    } catch {
      /* ignore */
    }
  });
  try {
    c.pc.close();
  } catch {
    /* ignore */
  }
  c.localStream?.getTracks().forEach((t) => t.stop());
  removeOverlay();

  // Mark ended in Firestore; the caller also cleans up the docs.
  try {
    await updateDoc(doc(db, "calls", c.id), { status: "ended" }).catch(() => {});
    if (c.role === "caller") await deleteCallDoc(c.id);
  } catch {
    /* ignore */
  }

  if (reason === "declined") toast("Call declined.");
  else if (reason === "missed") toast("No answer.");
  else if (reason === "busy") toast("They're on another call.");
}

async function deleteCallDoc(id) {
  for (const side of ["callerCandidates", "calleeCandidates"]) {
    try {
      const s = await getDocs(collection(db, "calls", id, side));
      await Promise.all(s.docs.map((d) => deleteDoc(d.ref)));
    } catch {
      /* ignore */
    }
  }
  try {
    await deleteDoc(doc(db, "calls", id));
  } catch {
    /* ignore */
  }
}

/* ----------------------------- UI (overlay outside render()) ----------------------------- */

function setActive() {
  if (!call) return;
  call.status = "active";
  call.startedAt = call.startedAt || Date.now();
  const status = document.getElementById("cc-call-status");
  if (status) status.textContent = "";
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const el = document.getElementById("cc-call-timer");
    if (!el || !call) return;
    const s = Math.floor((Date.now() - call.startedAt) / 1000);
    const m = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    el.textContent = `${m}:${ss}`;
  }, 1000);
}

function video(id, muted) {
  const v = document.createElement("video");
  v.id = id;
  v.autoplay = true;
  v.playsInline = true;
  v.setAttribute("playsinline", "");
  if (muted) v.muted = true;
  return v;
}

function ctrlButton(label, title, onClick) {
  const b = document.createElement("button");
  b.className = "cc-call-btn";
  b.title = title;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function buildOverlay() {
  removeOverlay();
  const root = document.createElement("div");
  root.id = "cc-call";
  root.className = "cc-call";

  const stage = document.createElement("div");
  stage.className = "cc-call-stage";

  const remote = video("cc-remote-video", false);
  remote.className = "cc-remote";
  const local = video("cc-local-video", true);
  local.className = "cc-local";
  local.srcObject = call.localStream;
  remote.srcObject = call.remoteStream;
  stage.appendChild(remote);
  stage.appendChild(local);

  const bar = document.createElement("div");
  bar.className = "cc-call-bar";
  const name = document.createElement("strong");
  name.textContent = call.peerName || "Call";
  const status = document.createElement("span");
  status.id = "cc-call-status";
  status.className = "cc-call-sub";
  status.textContent = call.role === "caller" ? "Ringing…" : "Connecting…";
  const timer = document.createElement("span");
  timer.id = "cc-call-timer";
  timer.className = "cc-call-timer";
  bar.appendChild(name);
  bar.appendChild(status);
  bar.appendChild(timer);

  const controls = document.createElement("div");
  controls.className = "cc-call-controls";
  let micOn = true;
  let camOn = true;
  const micBtn = ctrlButton("🎙️", "Mute mic", () => {
    micOn = !micOn;
    call?.localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
    micBtn.classList.toggle("off", !micOn);
    micBtn.textContent = micOn ? "🎙️" : "🔇";
  });
  const camBtn = ctrlButton("📷", "Turn camera off", () => {
    camOn = !camOn;
    call?.localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
    camBtn.classList.toggle("off", !camOn);
  });
  const hangBtn = ctrlButton("📴", "Hang up", () => endCall("ended"));
  hangBtn.classList.add("cc-hang");
  controls.appendChild(micBtn);
  controls.appendChild(camBtn);
  controls.appendChild(hangBtn);

  root.appendChild(bar);
  root.appendChild(stage);
  root.appendChild(controls);
  document.body.appendChild(root);
}

function removeOverlay() {
  document.getElementById("cc-call")?.remove();
}

function showIncoming(callId, data) {
  hideIncoming();
  const root = document.createElement("div");
  root.id = "cc-incoming";
  root.className = "cc-incoming";
  root.innerHTML = `
    <div class="cc-incoming-card">
      <img class="cc-incoming-avatar" src="${esc(data.callerPhoto || avatar(data.callerName))}" alt="" />
      <div class="cc-incoming-name">${esc(data.callerName || "Someone")}</div>
      <div class="cc-incoming-sub">Incoming video call…</div>
      <div class="cc-incoming-actions">
        <button class="cc-call-btn cc-accept" id="cc-accept" title="Accept">📹</button>
        <button class="cc-call-btn cc-hang" id="cc-decline" title="Decline">📴</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);
  root.querySelector("#cc-accept").addEventListener("click", () => acceptCall(callId, data));
  root.querySelector("#cc-decline").addEventListener("click", () => declineCall(callId));
  // Auto-dismiss if the caller gives up.
  root.dataset.callId = callId;
}

function hideIncoming() {
  document.getElementById("cc-incoming")?.remove();
}

/* ----------------------------- minimal local helpers ----------------------------- */

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function avatar(name) {
  const initials =
    String(name || "CC")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "CC";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="#15191c"/><circle cx="48" cy="48" r="46" fill="#bc13fe" opacity=".45"/><text x="50%" y="56%" text-anchor="middle" font-family="Arial" font-size="34" font-weight="700" fill="#fff">${initials}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function toast(message) {
  document.querySelector(".cc-call-toast")?.remove();
  const t = document.createElement("div");
  t.className = "cc-call-toast";
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// Best-effort: end an active call if the tab is closed.
window.addEventListener("beforeunload", () => {
  if (call) {
    navigator.sendBeacon?.(ICE_ENDPOINT); // keep-alive hint; non-critical
    try {
      updateDoc(doc(db, "calls", call.id), { status: "ended" });
    } catch {
      /* ignore */
    }
  }
});
