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

const addContactForm = document.getElementById("addContactForm");
const addContactInput = document.getElementById("addContactInput");
const contactFeedback = document.getElementById("contactFeedback");
const requestList = document.getElementById("requestList");

const groupForm = document.getElementById("groupForm");
const groupNameInput = document.getElementById("groupNameInput");
const groupMembersInput = document.getElementById("groupMembersInput");
const groupFeedback = document.getElementById("groupFeedback");
const groupsList = document.getElementById("groupsList");
const groupDetailsBox = document.getElementById("groupDetailsBox");
const groupDetailsEmpty = document.getElementById("groupDetailsEmpty");
const groupDetailsContent = document.getElementById("groupDetailsContent");
const groupDetailName = document.getElementById("groupDetailName");
const groupDetailDescription = document.getElementById("groupDetailDescription");
const groupMetaSaveBtn = document.getElementById("groupMetaSaveBtn");
const groupAddMemberInput = document.getElementById("groupAddMemberInput");
const groupAddMemberBtn = document.getElementById("groupAddMemberBtn");
const groupMembersList = document.getElementById("groupMembersList");
const groupLeaveBtn = document.getElementById("groupLeaveBtn");
const toggleGroupDetailsBtn = document.getElementById("toggleGroupDetailsBtn");

const contactsEl = document.getElementById("contacts");
const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const statusForm = document.getElementById("statusForm");
const statusInput = document.getElementById("statusInput");
const statusList = document.getElementById("statusList");
const chatTitle = document.getElementById("chatTitle");
const chatHeader = document.querySelector(".chat-header");
const meLabel = document.getElementById("meLabel");
const audioCallBtn = document.getElementById("audioCallBtn");
const videoCallBtn = document.getElementById("videoCallBtn");
const hangupBtn = document.getElementById("hangupBtn");
const clearChatBtn = document.getElementById("clearChatBtn");
const deleteContactBtn = document.getElementById("deleteContactBtn");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const emojiBar = document.getElementById("emojiBar");
const mediaBox = document.getElementById("mediaBox");
const chatTabBtn = document.getElementById("chatTabBtn");
const statusTabBtn = document.getElementById("statusTabBtn");
const chatView = document.getElementById("chatView");
const statusView = document.getElementById("statusView");

let socket = null;
let selfId = null;
let selfName = null;
let users = [];
let groups = [];
let currentGroupDetails = null;
let messages = [];
let groupMessages = [];
let statuses = [];
let incomingRequests = [];
let selectedTarget = null;
let activeMainTab = "chat";
let isGroupDetailsOpen = false;

let peerConnection = null;
let localStream = null;
let currentPeerId = null;

function setMainTab(tab) {
  activeMainTab = tab === "status" ? "status" : "chat";
  const showChat = activeMainTab === "chat";
  chatHeader.classList.toggle("is-hidden", !showChat);
  chatView.classList.toggle("is-hidden", !showChat);
  statusView.classList.toggle("is-hidden", showChat);
  chatTabBtn.classList.toggle("active", showChat);
  statusTabBtn.classList.toggle("active", !showChat);
}

function setGroupDetailsOpen(open) {
  isGroupDetailsOpen = !!open;
  groupDetailsBox.classList.toggle("is-hidden", !isGroupDetailsOpen);
  toggleGroupDetailsBtn.textContent = isGroupDetailsOpen ? "Gruppendetails schliessen" : "Gruppendetails";
}

function setCallUiActive(active) {
  mediaBox.classList.toggle("is-hidden", !active);
}

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function setAuthError(message) {
  authError.textContent = message || "";
}

function setContactFeedback(message) {
  contactFeedback.textContent = message || "";
}

function setGroupFeedback(message) {
  groupFeedback.textContent = message || "";
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

function getSelectedUser() {
  if (!selectedTarget || selectedTarget.type !== "user") {
    return null;
  }
  return users.find((u) => u.id === selectedTarget.id) || null;
}

function getSelectedGroup() {
  if (!selectedTarget || selectedTarget.type !== "group") {
    return null;
  }
  return groups.find((g) => g.id === selectedTarget.id) || null;
}

function updateChatHeader() {
  const user = getSelectedUser();
  const group = getSelectedGroup();

  if (user) {
    chatTitle.textContent = `Chat mit ${user.name}`;
  } else if (group) {
    chatTitle.textContent = `Gruppe: ${group.name}`;
  } else {
    chatTitle.textContent = "Kontakt oder Gruppe wählen";
  }

  const isUserChat = !!user;
  const isGroupChat = !!group;
  audioCallBtn.disabled = !isUserChat;
  videoCallBtn.disabled = !isUserChat;
  deleteContactBtn.disabled = !isUserChat;
  clearChatBtn.disabled = !(isUserChat || isGroupChat);
}

function renderContacts() {
  contactsEl.innerHTML = "";
  const peers = [...users].sort((a, b) => {
    if (a.online !== b.online) {
      return a.online ? -1 : 1;
    }
    return a.name.localeCompare(b.name, "de", { sensitivity: "base" });
  });

  if (!peers.length) {
    contactsEl.innerHTML = "<li>Keine Kontakte vorhanden</li>";
    if (selectedTarget?.type === "user") {
      selectedTarget = null;
    }
    updateChatHeader();
    return;
  }

  if (selectedTarget?.type === "user" && !peers.some((u) => u.id === selectedTarget.id)) {
    selectedTarget = null;
  }

  peers.forEach((user) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    const isActive = selectedTarget?.type === "user" && selectedTarget.id === user.id;
    btn.className = "contact-btn" + (isActive ? " active" : "");
    btn.textContent = `${user.name} (${user.online ? "online" : "offline"})`;
    btn.onclick = () => {
      selectedTarget = { type: "user", id: user.id };
      renderContacts();
      renderGroups();
      renderMessages();
      updateChatHeader();
      renderGroupDetails();
    };
    li.appendChild(btn);
    contactsEl.appendChild(li);
  });

  updateChatHeader();
}

function renderGroups() {
  groupsList.innerHTML = "";
  const sorted = [...groups].sort((a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }));

  if (!sorted.length) {
    groupsList.innerHTML = "<li>Keine Gruppen</li>";
    if (selectedTarget?.type === "group") {
      selectedTarget = null;
    }
    updateChatHeader();
    return;
  }

  if (selectedTarget?.type === "group" && !sorted.some((g) => g.id === selectedTarget.id)) {
    selectedTarget = null;
  }

  sorted.forEach((group) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    const isActive = selectedTarget?.type === "group" && selectedTarget.id === group.id;
    btn.className = "contact-btn" + (isActive ? " active" : "");
    btn.textContent = group.name;
    btn.onclick = () => {
      selectedTarget = { type: "group", id: group.id };
      setGroupDetailsOpen(true);
      renderContacts();
      renderGroups();
      renderMessages();
      updateChatHeader();
      socket?.emit("group-details-get", { groupId: group.id });
    };
    li.appendChild(btn);
    groupsList.appendChild(li);
  });

  updateChatHeader();
  renderGroupDetails();
}

function renderMessages() {
  messagesEl.innerHTML = "";

  if (!selectedTarget) {
    return;
  }

  if (selectedTarget.type === "user") {
    const targetId = selectedTarget.id;
    const conv = messages.filter(
      (m) => (m.from === selfId && m.to === targetId) || (m.from === targetId && m.to === selfId)
    );

    conv.forEach((msg) => {
      const div = document.createElement("div");
      div.className = "bubble " + (msg.from === selfId ? "out" : "in");
      div.innerHTML = `${msg.text}<small>${fmtTime(msg.timestamp)}</small>`;
      messagesEl.appendChild(div);
    });
  }

  if (selectedTarget.type === "group") {
    const groupId = selectedTarget.id;
    const conv = groupMessages.filter((m) => m.groupId === groupId);

    conv.forEach((msg) => {
      const div = document.createElement("div");
      div.className = "bubble " + (msg.from === selfId ? "out" : "in");
      const sender = msg.from === selfId ? "Du" : msg.fromName;
      div.innerHTML = `<strong>${sender}</strong><br>${msg.text}<small>${fmtTime(msg.timestamp)}</small>`;
      messagesEl.appendChild(div);
    });
  }

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

function renderRequests() {
  requestList.innerHTML = "";
  if (!incomingRequests.length) {
    requestList.innerHTML = "<li>Keine offenen Anfragen</li>";
    return;
  }

  incomingRequests.forEach((req) => {
    const li = document.createElement("li");
    li.className = "request-item";
    li.innerHTML = `<strong>${req.fromName}</strong>`;

    const actions = document.createElement("div");
    actions.className = "request-actions";

    const acceptBtn = document.createElement("button");
    acceptBtn.textContent = "Annehmen";
    acceptBtn.onclick = () => socket?.emit("contact-request-accept", { requestId: req.id });

    const rejectBtn = document.createElement("button");
    rejectBtn.textContent = "Ablehnen";
    rejectBtn.onclick = () => socket?.emit("contact-request-reject", { requestId: req.id });

    actions.appendChild(acceptBtn);
    actions.appendChild(rejectBtn);
    li.appendChild(actions);
    requestList.appendChild(li);
  });
}

function renderGroupDetails() {
  const selectedGroup = getSelectedGroup();
  if (!selectedGroup || !currentGroupDetails || currentGroupDetails.id !== selectedGroup.id) {
    groupDetailsEmpty.classList.remove("is-hidden");
    groupDetailsContent.classList.add("is-hidden");
    groupMembersList.innerHTML = "";
    return;
  }

  groupDetailsEmpty.classList.add("is-hidden");
  groupDetailsContent.classList.remove("is-hidden");

  groupDetailName.value = currentGroupDetails.name || "";
  groupDetailDescription.value = currentGroupDetails.description || "";

  const isOwner = currentGroupDetails.ownerId === selfId;
  groupDetailName.disabled = !isOwner;
  groupDetailDescription.disabled = !isOwner;
  groupMetaSaveBtn.disabled = !isOwner;
  groupAddMemberInput.disabled = !isOwner;
  groupAddMemberBtn.disabled = !isOwner;
  groupLeaveBtn.disabled = false;

  groupMembersList.innerHTML = "";
  const members = Array.isArray(currentGroupDetails.members) ? currentGroupDetails.members : [];
  if (!members.length) {
    groupMembersList.innerHTML = "<li>Keine Mitglieder</li>";
    return;
  }

  members.forEach((member) => {
    const li = document.createElement("li");
    li.className = "group-member-item";

    const label = document.createElement("span");
    label.textContent = `${member.name} (${member.online ? "online" : "offline"})`;
    li.appendChild(label);

    if (isOwner && member.id !== selfId) {
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "Entfernen";
      removeBtn.onclick = () => {
        socket?.emit("group-member-remove", { groupId: currentGroupDetails.id, memberId: member.id });
      };
      li.appendChild(removeBtn);
    }

    groupMembersList.appendChild(li);
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
  setCallUiActive(false);
}

async function ensureLocalStream(withVideo) {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!withVideo });
  localVideo.srcObject = localStream;
  return localStream;
}

function createPeerConnection(targetId) {
  closePeerConnection();
  peerConnection = new RTCPeerConnection(rtcConfig);

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice-candidate", { to: targetId, candidate: event.candidate });
    }
  };

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
  };

  return peerConnection;
}

async function startCall(withVideo) {
  const user = getSelectedUser();
  if (!user || !socket) return;

  try {
    const stream = await ensureLocalStream(withVideo);
    const pc = createPeerConnection(user.id);
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    currentPeerId = user.id;
    hangupBtn.disabled = false;
    setCallUiActive(true);

    socket.emit("call-offer", { to: user.id, offer, withVideo });
  } catch (_err) {
    alert("Kamera/Mikrofon nicht verfügbar.");
    resetCallState();
  }
}

function teardownSocket() {
  if (!socket) return;
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
  groups = [];
  messages = [];
  groupMessages = [];
  currentGroupDetails = null;
  statuses = [];
  incomingRequests = [];
  selectedTarget = null;
  contactsEl.innerHTML = "";
  groupsList.innerHTML = "";
  requestList.innerHTML = "";
  messagesEl.innerHTML = "";
  statusList.innerHTML = "";
  meLabel.textContent = "Verbinde...";
  setContactFeedback("");
  setGroupFeedback("");
  updateChatHeader();
  setMainTab("chat");
  setGroupDetailsOpen(false);
  setCallUiActive(false);
  renderGroupDetails();
}

function bindSocketEvents() {
  socket.on("bootstrap", (payload) => {
    selfId = payload.selfId;
    users = payload.users || [];
    groups = payload.groups || [];
    messages = payload.messages || [];
    groupMessages = payload.groupMessages || [];
    statuses = payload.statuses || [];
    incomingRequests = payload.contactRequests || [];

    meLabel.textContent = `Du: ${selfName}`;
    renderContacts();
    renderGroups();
    renderMessages();
    renderStatuses();
    renderRequests();
    if (selectedTarget?.type === "group") {
      socket.emit("group-details-get", { groupId: selectedTarget.id });
    } else {
      renderGroupDetails();
    }
  });

  socket.on("users-updated", (nextUsers) => {
    users = nextUsers || [];
    renderContacts();
    renderMessages();
  });

  socket.on("groups-updated", (nextGroups) => {
    groups = nextGroups || [];
    renderGroups();
    renderMessages();
    if (selectedTarget?.type === "group") {
      socket.emit("group-details-get", { groupId: selectedTarget.id });
    }
  });

  socket.on("group-details", (details) => {
    currentGroupDetails = details || null;
    renderGroupDetails();
  });

  socket.on("private-message", (msg) => {
    messages.push(msg);
    renderMessages();
  });

  socket.on("group-message", (msg) => {
    groupMessages.push(msg);
    renderMessages();
  });

  socket.on("direct-chat-cleared", ({ targetId }) => {
    messages = messages.filter(
      (m) => !((m.from === selfId && m.to === targetId) || (m.from === targetId && m.to === selfId))
    );
    renderMessages();
  });

  socket.on("group-chat-cleared", ({ groupId }) => {
    groupMessages = groupMessages.filter((m) => m.groupId !== groupId);
    renderMessages();
  });

  socket.on("statuses-updated", (nextStatuses) => {
    statuses = nextStatuses || [];
    renderStatuses();
  });

  socket.on("contact-requests-updated", (nextRequests) => {
    incomingRequests = nextRequests || [];
    renderRequests();
  });

  socket.on("contact-request-result", ({ message }) => {
    setContactFeedback(message || "");
  });

  socket.on("group-create-result", ({ ok, message }) => {
    setGroupFeedback(message || (ok ? "Gruppe erstellt" : "Gruppenerstellung fehlgeschlagen"));
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
      setCallUiActive(true);

      socket.emit("call-answer", { to: from, answer });
    } catch (_err) {
      socket.emit("call-reject", { to: from });
      resetCallState();
    }
  });

  socket.on("call-answer", async ({ from, answer }) => {
    if (!peerConnection || currentPeerId !== from) return;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on("ice-candidate", async ({ from, candidate }) => {
    if (!peerConnection || currentPeerId !== from) return;
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
  socket = io({ autoConnect: false, auth: { token } });
  bindSocketEvents();
  socket.connect();
}

async function authRequest(mode, username, password) {
  const endpoint = mode === "register" ? "/auth/register" : "/auth/login";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
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

addContactForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const username = addContactInput.value.trim();
  if (!username || !socket) return;
  setContactFeedback("");
  socket.emit("contact-request-send", { username });
  addContactInput.value = "";
});

groupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = groupNameInput.value.trim();
  const members = groupMembersInput.value
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  if (!name || !socket) {
    return;
  }

  setGroupFeedback("");
  socket.emit("group-create", { name, members });
  groupNameInput.value = "";
  groupMembersInput.value = "";
});

groupMetaSaveBtn.addEventListener("click", () => {
  const group = getSelectedGroup();
  if (!group || !socket) {
    return;
  }
  socket.emit("group-meta-update", {
    groupId: group.id,
    name: groupDetailName.value.trim(),
    description: groupDetailDescription.value.trim(),
  });
});

groupLeaveBtn.addEventListener("click", () => {
  const group = getSelectedGroup();
  if (!group || !socket) {
    return;
  }
  const ok = confirm(`Gruppe ${group.name} wirklich verlassen?`);
  if (!ok) {
    return;
  }
  socket.emit("group-leave", { groupId: group.id });
  selectedTarget = null;
  currentGroupDetails = null;
  renderGroups();
  renderMessages();
  renderGroupDetails();
  updateChatHeader();
});

groupAddMemberBtn.addEventListener("click", () => {
  const group = getSelectedGroup();
  const username = groupAddMemberInput.value.trim();
  if (!group || !username || !socket) {
    return;
  }
  socket.emit("group-member-add", {
    groupId: group.id,
    username,
  });
  groupAddMemberInput.value = "";
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!selectedTarget || !text || !socket) {
    return;
  }

  if (selectedTarget.type === "user") {
    socket.emit("private-message", { to: selectedTarget.id, text });
  }
  if (selectedTarget.type === "group") {
    socket.emit("group-message", { groupId: selectedTarget.id, text });
  }

  chatInput.value = "";
});

statusForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = statusInput.value.trim();
  if (!text || !socket) return;
  socket.emit("status-create", { text });
  statusInput.value = "";
});

deleteContactBtn.addEventListener("click", () => {
  const user = getSelectedUser();
  if (!user || !socket) {
    return;
  }
  const ok = confirm(`Kontakt ${user.name} wirklich löschen?`);
  if (!ok) {
    return;
  }
  socket.emit("contact-delete", { contactId: user.id });
  selectedTarget = null;
  renderContacts();
  renderMessages();
  updateChatHeader();
});

clearChatBtn.addEventListener("click", () => {
  if (!selectedTarget || !socket) {
    return;
  }
  const ok = confirm("Chatverlauf wirklich leeren?");
  if (!ok) {
    return;
  }
  socket.emit("chat-clear", {
    targetType: selectedTarget.type,
    targetId: selectedTarget.id,
  });
});

audioCallBtn.addEventListener("click", () => startCall(false));
videoCallBtn.addEventListener("click", () => startCall(true));

hangupBtn.addEventListener("click", () => {
  if (currentPeerId && socket) {
    socket.emit("call-end", { to: currentPeerId });
  }
  resetCallState();
});

emojiBar.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-emoji]");
  if (!button) {
    return;
  }
  const emoji = button.getAttribute("data-emoji");
  if (!emoji) {
    return;
  }
  chatInput.value += emoji;
  chatInput.focus();
});

chatTabBtn.addEventListener("click", () => setMainTab("chat"));
statusTabBtn.addEventListener("click", () => setMainTab("status"));
toggleGroupDetailsBtn.addEventListener("click", () => setGroupDetailsOpen(!isGroupDetailsOpen));

function disconnectPresence() {
  if (!socket) return;
  if (currentPeerId) {
    socket.emit("call-end", { to: currentPeerId });
  }
  socket.disconnect();
}

window.addEventListener("beforeunload", disconnectPresence);
window.addEventListener("pagehide", disconnectPresence);

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
