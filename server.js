const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const ENABLE_BOTS = process.env.ENABLE_BOTS === "true";

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

app.use(express.json());
app.use(express.static("public"));
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

const accountsByUsername = new Map();
const accountsById = new Map();
const sessions = new Map();

const users = new Map();
const socketsByAccount = new Map();
const privateMessages = [];
const statuses = [];
const botUsers = [
  { id: "bot-lucky-luke", name: "Lucky Luke" },
  { id: "bot-bud-spencer", name: "Bud Spencer" },
  { id: "bot-terence-hill", name: "Terence Hill" },
  { id: "bot-sheriff-woody", name: "Sheriff Woody" },
];
const botUsersById = new Map(botUsers.map((bot) => [bot.id, bot]));

const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 1000;
const BOT_ACTIVE_INTERVAL_MS = 25 * 1000;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let persistTimer = null;

function normalizeUsername(username) {
  return String(username || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 30);
}

function getUsernameKey(username) {
  return normalizeUsername(username).toLowerCase();
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function loadDataFromDisk() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return;
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);

    const persistedAccounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    persistedAccounts.forEach((account) => {
      if (!account?.id || !account?.username || !account?.salt || !account?.passwordHash) {
        return;
      }
      const normalized = normalizeUsername(account.username);
      const usernameKey = getUsernameKey(normalized);
      const hydrated = {
        id: account.id,
        username: normalized,
        salt: account.salt,
        passwordHash: account.passwordHash,
        createdAt: account.createdAt || Date.now(),
      };
      accountsById.set(hydrated.id, hydrated);
      accountsByUsername.set(usernameKey, hydrated);
    });

    const persistedMessages = Array.isArray(parsed.privateMessages) ? parsed.privateMessages : [];
    persistedMessages.forEach((message) => {
      if (!message?.id || !message?.from || !message?.to || !message?.text) {
        return;
      }
      privateMessages.push({
        id: message.id,
        from: message.from,
        fromName: String(message.fromName || ""),
        to: message.to,
        toName: String(message.toName || ""),
        text: String(message.text).slice(0, 2000),
        timestamp: Number(message.timestamp) || Date.now(),
      });
    });

    const now = Date.now();
    const persistedStatuses = Array.isArray(parsed.statuses) ? parsed.statuses : [];
    persistedStatuses.forEach((status) => {
      if (!status?.id || !status?.userId || !status?.text || !status?.expiresAt) {
        return;
      }
      if (Number(status.expiresAt) <= now) {
        return;
      }
      statuses.push({
        id: status.id,
        userId: status.userId,
        userName: String(status.userName || ""),
        text: String(status.text).slice(0, 300),
        createdAt: Number(status.createdAt) || now,
        expiresAt: Number(status.expiresAt),
      });
    });
  } catch (err) {
    console.error("Failed to load persisted data:", err.message);
  }
}

function writeDataToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const payload = {
      accounts: Array.from(accountsById.values()),
      privateMessages,
      statuses,
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to persist data:", err.message);
  }
}

function schedulePersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeDataToDisk();
  }, 150);
}

function createAccount(username, password) {
  const normalizedUsername = normalizeUsername(username);
  const usernameKey = getUsernameKey(username);
  const safePassword = String(password || "");

  if (!/^[a-z0-9._ -]{3,30}$/i.test(normalizedUsername)) {
    return { ok: false, error: "Username: 3-30 Zeichen, Buchstaben, Zahlen, Leerzeichen, ., _, -" };
  }
  if (safePassword.length < 6 || safePassword.length > 100) {
    return { ok: false, error: "Passwort muss 6-100 Zeichen haben" };
  }
  if (accountsByUsername.has(usernameKey)) {
    return { ok: false, error: "Username existiert bereits" };
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(safePassword, salt);
  const account = {
    id: `usr-${uuidv4()}`,
    username: normalizedUsername,
    salt,
    passwordHash,
    createdAt: Date.now(),
  };

  accountsByUsername.set(usernameKey, account);
  accountsById.set(account.id, account);
  schedulePersist();
  return { ok: true, account };
}

function issueSession(accountId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    accountId,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

function getSession(token) {
  const session = sessions.get(token);
  if (!session) {
    return null;
  }
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function getVisibleStatuses() {
  const now = Date.now();
  return statuses.filter((status) => status.expiresAt > now);
}

function getMessagesForAccount(accountId) {
  return privateMessages.filter((message) => message.from === accountId || message.to === accountId);
}

function getUsersPayload() {
  const knownAccounts = Array.from(accountsById.values())
    .sort((a, b) => a.username.localeCompare(b.username, "de", { sensitivity: "base" }))
    .map((account) => ({
      id: account.id,
      name: account.username,
      online: socketsByAccount.has(account.id),
    }));

  if (!ENABLE_BOTS) {
    return knownAccounts;
  }

  const bots = botUsers.map((bot) => ({
    id: bot.id,
    name: bot.name,
    online: true,
  }));

  return [...knownAccounts, ...bots];
}

function trimMessages() {
  if (privateMessages.length > MAX_MESSAGES) {
    privateMessages.splice(0, privateMessages.length - MAX_MESSAGES);
    schedulePersist();
  }
}

function broadcastUsers() {
  io.emit("users-updated", getUsersPayload());
}

function broadcastStatuses() {
  io.emit("statuses-updated", getVisibleStatuses());
}

function emitToAccount(accountId, eventName, payload) {
  const socketIds = socketsByAccount.get(accountId);
  if (!socketIds) {
    return;
  }
  socketIds.forEach((socketId) => {
    io.to(socketId).emit(eventName, payload);
  });
}

function buildBotReply(botName, inputText) {
  const text = inputText.toLowerCase();

  if (text.includes("hallo") || text.includes("hi")) {
    return `${botName}: Moin, ich bin online. Test laeuft.`;
  }
  if (text.includes("?")) {
    return `${botName}: Gute Frage. Der Chat funktioniert auf jeden Fall.`;
  }

  const cannedReplies = [
    `${botName}: Nachricht angekommen.`,
    `${botName}: Alles klar, ich habe dich verstanden.`,
    `${botName}: Sieht gut aus. Schreib ruhig weiter.`,
  ];
  return cannedReplies[Math.floor(Math.random() * cannedReplies.length)];
}

function buildProactiveBotMessage(botName) {
  const cannedMessages = [
    `${botName}: Wie laeuft dein Tag bisher?`,
    `${botName}: Falls du testest: Senden und Empfangen klappt.`,
    `${botName}: Soll ich dir noch eine Testnachricht schicken?`,
    `${botName}: Ich bin noch da, wenn du weiterschreiben willst.`,
    `${botName}: Kurzer Ping aus dem Test-Chat.`,
  ];
  return cannedMessages[Math.floor(Math.random() * cannedMessages.length)];
}

app.post("/auth/register", (req, res) => {
  const { username, password } = req.body || {};
  const result = createAccount(username, password);

  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  const token = issueSession(result.account.id);
  return res.status(201).json({
    token,
    user: {
      id: result.account.id,
      username: result.account.username,
    },
  });
});

app.post("/auth/login", (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const usernameKey = getUsernameKey(username);
  const password = String(req.body?.password || "");
  const account = accountsByUsername.get(usernameKey);

  if (!account) {
    return res.status(401).json({ error: "Login fehlgeschlagen" });
  }

  const expectedHash = hashPassword(password, account.salt);
  if (expectedHash !== account.passwordHash) {
    return res.status(401).json({ error: "Login fehlgeschlagen" });
  }

  const token = issueSession(account.id);
  return res.status(200).json({
    token,
    user: {
      id: account.id,
      username: account.username,
    },
  });
});

app.get("/auth/me", (req, res) => {
  const authHeader = String(req.headers.authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const session = getSession(token);

  if (!session) {
    return res.status(401).json({ error: "Nicht eingeloggt" });
  }

  const account = accountsById.get(session.accountId);
  if (!account) {
    return res.status(401).json({ error: "Nicht eingeloggt" });
  }

  return res.status(200).json({
    user: {
      id: account.id,
      username: account.username,
    },
  });
});

setInterval(() => {
  const before = statuses.length;
  const now = Date.now();
  for (let i = statuses.length - 1; i >= 0; i -= 1) {
    if (statuses[i].expiresAt <= now) {
      statuses.splice(i, 1);
    }
  }
  if (statuses.length !== before) {
    schedulePersist();
    broadcastStatuses();
  }
}, 60 * 1000);

setInterval(() => {
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
    }
  }
}, 10 * 60 * 1000);

if (ENABLE_BOTS) {
  setInterval(() => {
    const onlineAccountIds = Array.from(socketsByAccount.keys());
    if (!onlineAccountIds.length) {
      return;
    }

    const randomAccountId = onlineAccountIds[Math.floor(Math.random() * onlineAccountIds.length)];
    const randomAccount = accountsById.get(randomAccountId);
    if (!randomAccount) {
      return;
    }

    const randomBot = botUsers[Math.floor(Math.random() * botUsers.length)];
    const proactiveMessage = {
      id: uuidv4(),
      from: randomBot.id,
      fromName: randomBot.name,
      to: randomAccount.id,
      toName: randomAccount.username,
      text: buildProactiveBotMessage(randomBot.name),
      timestamp: Date.now(),
    };

    privateMessages.push(proactiveMessage);
    trimMessages();
    schedulePersist();
    emitToAccount(randomAccount.id, "private-message", proactiveMessage);
  }, BOT_ACTIVE_INTERVAL_MS);
}

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const session = getSession(token);

  if (!session) {
    next(new Error("unauthorized"));
    return;
  }

  const account = accountsById.get(session.accountId);
  if (!account) {
    next(new Error("unauthorized"));
    return;
  }

  socket.account = account;
  next();
});

io.on("connection", (socket) => {
  const account = socket.account;
  users.set(socket.id, {
    socketId: socket.id,
    accountId: account.id,
    name: account.username,
  });

  if (!socketsByAccount.has(account.id)) {
    socketsByAccount.set(account.id, new Set());
  }
  socketsByAccount.get(account.id).add(socket.id);

  socket.emit("bootstrap", {
    selfId: account.id,
    users: getUsersPayload(),
    messages: getMessagesForAccount(account.id),
    statuses: getVisibleStatuses(),
  });

  broadcastUsers();
  broadcastStatuses();

  socket.on("private-message", ({ to, text }) => {
    const fromUser = users.get(socket.id);
    const targetAccount = accountsById.get(to);
    const targetUser = targetAccount
      ? { id: targetAccount.id, name: targetAccount.username }
      : ENABLE_BOTS
        ? botUsersById.get(to)
        : null;
    const safeText = String(text || "").trim().slice(0, 2000);

    if (!fromUser || !targetUser || !safeText) {
      return;
    }

    const message = {
      id: uuidv4(),
      from: fromUser.accountId,
      fromName: fromUser.name,
      to: targetUser.id,
      toName: targetUser.name,
      text: safeText,
      timestamp: Date.now(),
    };

    privateMessages.push(message);
    trimMessages();
    schedulePersist();

    emitToAccount(fromUser.accountId, "private-message", message);

    if (ENABLE_BOTS && botUsersById.has(targetUser.id)) {
      setTimeout(() => {
        const reply = {
          id: uuidv4(),
          from: targetUser.id,
          fromName: targetUser.name,
          to: fromUser.accountId,
          toName: fromUser.name,
          text: buildBotReply(targetUser.name, safeText),
          timestamp: Date.now(),
        };
        privateMessages.push(reply);
        trimMessages();
        schedulePersist();
        emitToAccount(fromUser.accountId, "private-message", reply);
      }, 450 + Math.floor(Math.random() * 700));
      return;
    }

    emitToAccount(targetUser.id, "private-message", message);
  });

  socket.on("status-create", ({ text }) => {
    const fromUser = users.get(socket.id);
    const safeText = String(text || "").trim().slice(0, 300);

    if (!fromUser || !safeText) {
      return;
    }

    const now = Date.now();
    const status = {
      id: uuidv4(),
      userId: fromUser.accountId,
      userName: fromUser.name,
      text: safeText,
      createdAt: now,
      expiresAt: now + STATUS_TTL_MS,
    };

    statuses.push(status);
    schedulePersist();
    broadcastStatuses();
  });

  socket.on("call-offer", ({ to, offer, withVideo }) => {
    const fromUser = users.get(socket.id);
    const targetAccount = accountsById.get(to);

    if (!fromUser || !targetAccount || !socketsByAccount.has(targetAccount.id)) {
      return;
    }

    emitToAccount(targetAccount.id, "call-offer", {
      from: fromUser.accountId,
      fromName: fromUser.name,
      offer,
      withVideo: !!withVideo,
    });
  });

  socket.on("call-answer", ({ to, answer }) => {
    const fromUser = users.get(socket.id);
    const targetAccount = accountsById.get(to);

    if (!fromUser || !targetAccount) {
      return;
    }

    emitToAccount(targetAccount.id, "call-answer", {
      from: fromUser.accountId,
      answer,
    });
  });

  socket.on("ice-candidate", ({ to, candidate }) => {
    const fromUser = users.get(socket.id);
    const targetAccount = accountsById.get(to);

    if (!fromUser || !targetAccount) {
      return;
    }

    emitToAccount(targetAccount.id, "ice-candidate", {
      from: fromUser.accountId,
      candidate,
    });
  });

  socket.on("call-reject", ({ to }) => {
    const fromUser = users.get(socket.id);
    const targetAccount = accountsById.get(to);

    if (!fromUser || !targetAccount) {
      return;
    }

    emitToAccount(targetAccount.id, "call-reject", {
      from: fromUser.accountId,
      fromName: fromUser.name,
    });
  });

  socket.on("call-end", ({ to }) => {
    const fromUser = users.get(socket.id);
    const targetAccount = accountsById.get(to);

    if (!fromUser || !targetAccount) {
      return;
    }

    emitToAccount(targetAccount.id, "call-end", {
      from: fromUser.accountId,
      fromName: fromUser.name,
    });
  });

  socket.on("disconnect", () => {
    const disconnectedUser = users.get(socket.id);
    users.delete(socket.id);

    if (disconnectedUser) {
      const socketSet = socketsByAccount.get(disconnectedUser.accountId);
      if (socketSet) {
        socketSet.delete(socket.id);
        if (!socketSet.size) {
          socketsByAccount.delete(disconnectedUser.accountId);
        }
      }
    }

    broadcastUsers();
  });
});

loadDataFromDisk();
trimMessages();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`ENABLE_BOTS=${ENABLE_BOTS}`);
  console.log(`Persist file: ${DATA_FILE}`);
});
