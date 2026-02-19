const AUTH_TOKEN_KEY = "chatwave_token";

const authOverlay = document.getElementById("authOverlay");
const appRoot = document.getElementById("appRoot");
const authForm = document.getElementById("authForm");
const usernameInput = document.getElementById("usernameInput");
const passwordInput = document.getElementById("passwordInput");
const authError = document.getElementById("authError");
const loginBtn = document.getElementById("loginBtn");
const registerBtn = document.getElementById("registerBtn");
const logoutBtn = document.getElementById("logoutBtn");

const contactsEl = document.getElementById("contacts");
const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const statusForm = document.getElementById("statusForm");
const statusInput = document.getElementById("statusInput");
const statusList = document.getElementById("statusList");
const chatTitle = document.getElementById("chatTitle");
const meLabel = document.getElementById("meLabel");
const audioCallBtn = document.getElementById("audioCallBtn");
const videoCallBtn = document.getElementById("videoCallBtn");
const hangupBtn = document.getElementById("hangupBtn");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

let socket = null;
let selfId = null;
let selfName = null;
let users = [];
let messages = [];
let statuses = [];
let selectedUserId = null;

let peerConnection = null;
let localStream = null;
let currentPeerId = null;

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function setAuthError(message) {
  authError.textContent = message || "";
}

function getStoredToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

function setStoredToken(token) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

function clearStoredToken() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtAge(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "gerade eben";
  if (mins < 60) return `vor ${mins} min`;
  const hours = Math.floor(mins / 60);
  return `vor ${hours} h`;
}

function updateChatHeader() {
  const target = users.find((u) => u.id === selectedUserId);
  chatTitle.textContent = target ? `Chat mit ${target.name}` : "Kontakt wählen";

  const enabled = !!target;
  audioCallBtn.disabled = !enabled;
  videoCallBtn.disabled = !enabled;
}

function renderContacts() {
  contactsEl.innerHTML = "";
  const peers = users
    .filter((u) => u.id !== selfId)
    .sort((a, b) => {
      if (a.online !== b.online) {
        return a.online ? -1 : 1;
      }
      return a.name.localeCompare(b.name, "de", { sensitivity: "base" });
    });

  if (!peers.length) {
    contactsEl.innerHTML = "<li>Keine Kontakte vorhanden</li>";
    selectedUserId = null;
    updateChatHeader();
    return;
  }

  if (!selectedUserId || !peers.some((u) => u.id === selectedUserId)) {
    selectedUserId = peers[0].id;
  }

  peers.forEach((user) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "contact-btn" + (user.id === selectedUserId ? " active" : "");
    btn.textContent = `${user.name} (${user.online ? "online" : "offline"})`;
    btn.onclick = () => {
      selectedUserId = user.id;
      renderContacts();
      renderMessages();
      updateChatHeader();
    };
    li.appendChild(btn);
    contactsEl.appendChild(li);
  });

  updateChatHeader();
  renderMessages();
}

function renderMessages() {
  messagesEl.innerHTML = "";
  if (!selectedUserId) {
    return;
  }

  const conv = messages.filter(
    (m) =>
      (m.from === selfId && m.to === selectedUserId) ||
      (m.from === selectedUserId && m.to === selfId)
  );

  conv.forEach((msg) => {
    const div = document.createElement("div");
    div.className = "bubble " + (msg.from === selfId ? "out" : "in");
    div.innerHTML = `${msg.text}<small>${fmtTime(msg.timestamp)}</small>`;
    messagesEl.appendChild(div);
  });

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderStatuses() {
  statusList.innerHTML = "";

  const sorted = [...statuses].sort((a, b) => b.createdAt - a.createdAt);
  if (!sorted.length) {
    statusList.innerHTML = "<li>Keine Status-Updates</li>";
    return;
  }

  sorted.forEach((status) => {
    const li = document.createElement("li");
    li.className = "status-item";
    li.innerHTML = `<strong>${status.userName}</strong><br>${status.text}<br><small>${fmtAge(
      status.createdAt
    )}</small>`;
    statusList.appendChild(li);
  });
}

function closePeerConnection() {
  if (peerConnection) {
    peerConnection.onicecandidate = null;
    peerConnection.ontrack = null;
    peerConnection.close();
    peerConnection = null;
  }
}

function stopLocalStream() {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  localVideo.srcObject = null;
}

function resetCallState() {
  closePeerConnection();
  stopLocalStream();
  remoteVideo.srcObject = null;
  currentPeerId = null;
  hangupBtn.disabled = true;
}

async function ensureLocalStream(withVideo) {
  if (localStream) {
    return localStream;
  }

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: !!withVideo,
  });
  localVideo.srcObject = localStream;
  return localStream;
}

function createPeerConnection(targetId) {
  closePeerConnection();
  peerConnection = new RTCPeerConnection(rtcConfig);

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice-candidate", {
        to: targetId,
        candidate: event.candidate,
      });
    }
  };

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
  };

  return peerConnection;
}

async function startCall(withVideo) {
  if (!selectedUserId || !socket) {
    return;
  }

  try {
    const stream = await ensureLocalStream(withVideo);
    const pc = createPeerConnection(selectedUserId);

    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    currentPeerId = selectedUserId;
    hangupBtn.disabled = false;

    socket.emit("call-offer", {
      to: selectedUserId,
      offer,
      withVideo,
    });
  } catch (_err) {
    alert("Kamera/Mikrofon nicht verfügbar.");
    resetCallState();
  }
}

function teardownSocket() {
  if (!socket) {
    return;
  }
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}

function resetAppState() {
  teardownSocket();
  resetCallState();
  selfId = null;
  selfName = null;
  users = [];
  messages = [];
  statuses = [];
  selectedUserId = null;
  contactsEl.innerHTML = "";
  messagesEl.innerHTML = "";
  statusList.innerHTML = "";
  meLabel.textContent = "Verbinde...";
  updateChatHeader();
}

function bindSocketEvents() {
  socket.on("bootstrap", (payload) => {
    selfId = payload.selfId;
    users = payload.users;
    messages = payload.messages;
    statuses = payload.statuses;

    meLabel.textContent = `Du: ${selfName}`;
    renderContacts();
    renderMessages();
    renderStatuses();
  });

  socket.on("users-updated", (nextUsers) => {
    users = nextUsers;
    renderContacts();
  });

  socket.on("private-message", (msg) => {
    messages.push(msg);
    renderMessages();
  });

  socket.on("statuses-updated", (nextStatuses) => {
    statuses = nextStatuses;
    renderStatuses();
  });

  socket.on("call-offer", async ({ from, fromName, offer, withVideo }) => {
    const accepted = confirm(`${fromName} ruft an (${withVideo ? "Video" : "Audio"}). Annehmen?`);
    if (!accepted) {
      socket.emit("call-reject", { to: from });
      return;
    }

    try {
      const stream = await ensureLocalStream(withVideo);
      const pc = createPeerConnection(from);
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      currentPeerId = from;
      hangupBtn.disabled = false;

      socket.emit("call-answer", {
        to: from,
        answer,
      });
    } catch (_err) {
      socket.emit("call-reject", { to: from });
      resetCallState();
    }
  });

  socket.on("call-answer", async ({ from, answer }) => {
    if (!peerConnection || currentPeerId !== from) {
      return;
    }
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on("ice-candidate", async ({ from, candidate }) => {
    if (!peerConnection || currentPeerId !== from) {
      return;
    }
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (_err) {
    }
  });

  socket.on("call-reject", ({ fromName }) => {
    alert(`${fromName} hat den Anruf abgelehnt.`);
    resetCallState();
  });

  socket.on("call-end", ({ fromName }) => {
    alert(`Anruf mit ${fromName} beendet.`);
    resetCallState();
  });

  socket.on("connect_error", () => {
    clearStoredToken();
    resetAppState();
    authOverlay.classList.remove("is-hidden");
    appRoot.classList.add("is-hidden");
    setAuthError("Session abgelaufen. Bitte erneut einloggen.");
  });
}

function connectSocket(token, user) {
  selfName = user.username;
  socket = io({
    autoConnect: false,
    auth: {
      token,
    },
  });

  bindSocketEvents();
  socket.connect();
}

async function authRequest(mode, username, password) {
  const endpoint = mode === "register" ? "/auth/register" : "/auth/login";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, password }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Fehler bei der Anmeldung");
  }

  return payload;
}

async function validateStoredToken(token) {
  const response = await fetch("/auth/me", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  return payload.user;
}

function showApp() {
  authOverlay.classList.add("is-hidden");
  appRoot.classList.remove("is-hidden");
  window.scrollTo(0, 0);
}

function showAuth() {
  appRoot.classList.add("is-hidden");
  authOverlay.classList.remove("is-hidden");
  window.scrollTo(0, 0);
}

loginBtn.addEventListener("click", () => {
  authForm.dataset.mode = "login";
});

registerBtn.addEventListener("click", () => {
  authForm.dataset.mode = "register";
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAuthError("");

  const mode = authForm.dataset.mode || "login";
  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  try {
    const payload = await authRequest(mode, username, password);
    setStoredToken(payload.token);
    resetAppState();
    showApp();
    connectSocket(payload.token, payload.user);
    passwordInput.value = "";
  } catch (err) {
    setAuthError(err.message);
  }
});

logoutBtn.addEventListener("click", () => {
  clearStoredToken();
  resetAppState();
  showAuth();
  usernameInput.focus();
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!selectedUserId || !text || !socket) {
    return;
  }

  socket.emit("private-message", {
    to: selectedUserId,
    text,
  });

  chatInput.value = "";
});

statusForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = statusInput.value.trim();
  if (!text || !socket) return;

  socket.emit("status-create", { text });
  statusInput.value = "";
});

audioCallBtn.addEventListener("click", () => startCall(false));
videoCallBtn.addEventListener("click", () => startCall(true));

hangupBtn.addEventListener("click", () => {
  if (currentPeerId && socket) {
    socket.emit("call-end", { to: currentPeerId });
  }
  resetCallState();
});

window.addEventListener("beforeunload", () => {
  if (currentPeerId && socket) {
    socket.emit("call-end", { to: currentPeerId });
  }
});

(async function bootstrapAuth() {
  authForm.dataset.mode = "login";
  const token = getStoredToken();

  if (!token) {
    showAuth();
    return;
  }

  const user = await validateStoredToken(token);
  if (!user) {
    clearStoredToken();
    showAuth();
    return;
  }

  showApp();
  connectSocket(token, user);
})();
