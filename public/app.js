const socket = io();

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

const name = (prompt("Dein Name:") || "User").trim().slice(0, 30) || "User";
socket.emit("register", { name });

let selfId = null;
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

function renderContacts() {
  contactsEl.innerHTML = "";
  const peers = users.filter((u) => u.id !== selfId);

  if (!peers.length) {
    contactsEl.innerHTML = "<li>Niemand online</li>";
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

function updateChatHeader() {
  const target = users.find((u) => u.id === selectedUserId);
  chatTitle.textContent = target ? `Chat mit ${target.name}` : "Kontakt wählen";

  const enabled = !!target;
  audioCallBtn.disabled = !enabled;
  videoCallBtn.disabled = !enabled;
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
  if (!selectedUserId) return;

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
  } catch (err) {
    alert("Kamera/Mikrofon nicht verfügbar.");
    resetCallState();
  }
}

socket.on("bootstrap", (payload) => {
  selfId = payload.selfId;
  users = payload.users;
  messages = payload.messages;
  statuses = payload.statuses;

  meLabel.textContent = `Du: ${name}`;
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
  } catch (err) {
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
  } catch (err) {
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

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!selectedUserId || !text) {
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
  if (!text) return;

  socket.emit("status-create", { text });
  statusInput.value = "";
});

audioCallBtn.addEventListener("click", () => startCall(false));
videoCallBtn.addEventListener("click", () => startCall(true));

hangupBtn.addEventListener("click", () => {
  if (currentPeerId) {
    socket.emit("call-end", { to: currentPeerId });
  }
  resetCallState();
});

window.addEventListener("beforeunload", () => {
  if (currentPeerId) {
    socket.emit("call-end", { to: currentPeerId });
  }
});
