const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 5000,
  pingTimeout: 5000,
});

const ENABLE_BOTS = process.env.ENABLE_BOTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required. Configure PostgreSQL before starting the server.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : false,
});

app.use(express.json());
app.use(express.static("public"));
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

const sessions = new Map();
const users = new Map();
const socketsByAccount = new Map();

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

function normalizeUsername(username) {
  return String(username || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 30);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
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

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_ci_idx
    ON accounts ((lower(username)));
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS private_messages (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      from_name TEXT NOT NULL,
      to_id TEXT NOT NULL,
      to_name TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS private_messages_to_idx ON private_messages (to_id, timestamp DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS private_messages_from_idx ON private_messages (from_id, timestamp DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS statuses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS statuses_expires_idx ON statuses (expires_at);
  `);
}

async function createAccount(username, password) {
  const normalizedUsername = normalizeUsername(username);
  const safePassword = String(password || "");

  if (!/^[a-z0-9._ -]{3,30}$/i.test(normalizedUsername)) {
    return { ok: false, error: "Username: 3-30 Zeichen, Buchstaben, Zahlen, Leerzeichen, ., _, -" };
  }
  if (safePassword.length < 6 || safePassword.length > 100) {
    return { ok: false, error: "Passwort muss 6-100 Zeichen haben" };
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

  try {
    await pool.query(
      `INSERT INTO accounts (id, username, salt, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [account.id, account.username, account.salt, account.passwordHash, account.createdAt]
    );
    return { ok: true, account };
  } catch (err) {
    if (err.code === "23505") {
      return { ok: false, error: "Username existiert bereits" };
    }
    throw err;
  }
}

async function getAccountByUsername(username) {
  const normalizedUsername = normalizeUsername(username);
  const result = await pool.query(
    `SELECT id, username, salt, password_hash, created_at
     FROM accounts
     WHERE lower(username) = lower($1)
     LIMIT 1`,
    [normalizedUsername]
  );
  if (!result.rowCount) {
    return null;
  }
  const row = result.rows[0];
  return {
    id: row.id,
    username: row.username,
    salt: row.salt,
    passwordHash: row.password_hash,
    createdAt: Number(row.created_at),
  };
}

async function getAccountById(accountId) {
  const result = await pool.query(
    `SELECT id, username, salt, password_hash, created_at FROM accounts WHERE id = $1 LIMIT 1`,
    [accountId]
  );
  if (!result.rowCount) {
    return null;
  }
  const row = result.rows[0];
  return {
    id: row.id,
    username: row.username,
    salt: row.salt,
    passwordHash: row.password_hash,
    createdAt: Number(row.created_at),
  };
}

async function listAccounts() {
  const result = await pool.query(`SELECT id, username FROM accounts ORDER BY lower(username) ASC`);
  return result.rows.map((row) => ({ id: row.id, username: row.username }));
}

async function saveMessage(message) {
  await pool.query(
    `
    INSERT INTO private_messages (id, from_id, from_name, to_id, to_name, text, timestamp)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      message.id,
      message.from,
      message.fromName,
      message.to,
      message.toName,
      message.text,
      message.timestamp,
    ]
  );

  await pool.query(
    `
    DELETE FROM private_messages
    WHERE id IN (
      SELECT id
      FROM private_messages
      ORDER BY timestamp DESC
      OFFSET $1
    )
    `,
    [MAX_MESSAGES]
  );
}

async function getMessagesForAccount(accountId) {
  const result = await pool.query(
    `
    SELECT id, from_id, from_name, to_id, to_name, text, timestamp
    FROM private_messages
    WHERE from_id = $1 OR to_id = $1
    ORDER BY timestamp DESC
    LIMIT $2
    `,
    [accountId, MAX_MESSAGES]
  );

  return result.rows
    .map((row) => ({
      id: row.id,
      from: row.from_id,
      fromName: row.from_name,
      to: row.to_id,
      toName: row.to_name,
      text: row.text,
      timestamp: Number(row.timestamp),
    }))
    .reverse();
}

async function insertStatus(status) {
  await pool.query(
    `
    INSERT INTO statuses (id, user_id, user_name, text, created_at, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [status.id, status.userId, status.userName, status.text, status.createdAt, status.expiresAt]
  );
}

async function getVisibleStatuses() {
  const now = Date.now();
  const result = await pool.query(
    `
    SELECT id, user_id, user_name, text, created_at, expires_at
    FROM statuses
    WHERE expires_at > $1
    ORDER BY created_at DESC
    `,
    [now]
  );

  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    text: row.text,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  }));
}

async function deleteExpiredStatuses() {
  const now = Date.now();
  const result = await pool.query(`DELETE FROM statuses WHERE expires_at <= $1`, [now]);
  return result.rowCount;
}

async function getUsersPayload() {
  const accounts = await listAccounts();
  const knownAccounts = accounts.map((account) => ({
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

async function broadcastUsers() {
  const payload = await getUsersPayload();
  io.emit("users-updated", payload);
}

async function broadcastStatuses() {
  const payload = await getVisibleStatuses();
  io.emit("statuses-updated", payload);
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

app.post("/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const result = await createAccount(username, password);

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
  } catch (_err) {
    return res.status(500).json({ error: "Interner Fehler" });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const username = req.body?.username;
    const password = String(req.body?.password || "");
    const account = await getAccountByUsername(username);

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
  } catch (_err) {
    return res.status(500).json({ error: "Interner Fehler" });
  }
});

app.get("/auth/me", async (req, res) => {
  try {
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const session = getSession(token);

    if (!session) {
      return res.status(401).json({ error: "Nicht eingeloggt" });
    }

    const account = await getAccountById(session.accountId);
    if (!account) {
      return res.status(401).json({ error: "Nicht eingeloggt" });
    }

    return res.status(200).json({
      user: {
        id: account.id,
        username: account.username,
      },
    });
  } catch (_err) {
    return res.status(500).json({ error: "Interner Fehler" });
  }
});

setInterval(async () => {
  try {
    const removedCount = await deleteExpiredStatuses();
    if (removedCount > 0) {
      await broadcastStatuses();
    }
  } catch (_err) {
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
  setInterval(async () => {
    try {
      const onlineAccountIds = Array.from(socketsByAccount.keys());
      if (!onlineAccountIds.length) {
        return;
      }

      const randomAccountId = onlineAccountIds[Math.floor(Math.random() * onlineAccountIds.length)];
      const randomAccount = await getAccountById(randomAccountId);
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

      await saveMessage(proactiveMessage);
      emitToAccount(randomAccount.id, "private-message", proactiveMessage);
    } catch (_err) {
    }
  }, BOT_ACTIVE_INTERVAL_MS);
}

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const session = getSession(token);

    if (!session) {
      next(new Error("unauthorized"));
      return;
    }

    const account = await getAccountById(session.accountId);
    if (!account) {
      next(new Error("unauthorized"));
      return;
    }

    socket.account = account;
    next();
  } catch (_err) {
    next(new Error("unauthorized"));
  }
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

  (async () => {
    try {
      socket.emit("bootstrap", {
        selfId: account.id,
        users: await getUsersPayload(),
        messages: await getMessagesForAccount(account.id),
        statuses: await getVisibleStatuses(),
      });

      await broadcastUsers();
      await broadcastStatuses();
    } catch (_err) {
    }
  })();

  socket.on("private-message", async ({ to, text }) => {
    try {
      const fromUser = users.get(socket.id);
      const targetAccount = await getAccountById(to);
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

      await saveMessage(message);
      emitToAccount(fromUser.accountId, "private-message", message);

      if (ENABLE_BOTS && botUsersById.has(targetUser.id)) {
        setTimeout(async () => {
          const reply = {
            id: uuidv4(),
            from: targetUser.id,
            fromName: targetUser.name,
            to: fromUser.accountId,
            toName: fromUser.name,
            text: buildBotReply(targetUser.name, safeText),
            timestamp: Date.now(),
          };
          await saveMessage(reply);
          emitToAccount(fromUser.accountId, "private-message", reply);
        }, 450 + Math.floor(Math.random() * 700));
        return;
      }

      emitToAccount(targetUser.id, "private-message", message);
    } catch (_err) {
    }
  });

  socket.on("status-create", async ({ text }) => {
    try {
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

      await insertStatus(status);
      await broadcastStatuses();
    } catch (_err) {
    }
  });

  socket.on("call-offer", ({ to, offer, withVideo }) => {
    const fromUser = users.get(socket.id);
    if (!fromUser || !socketsByAccount.has(to)) {
      return;
    }

    emitToAccount(to, "call-offer", {
      from: fromUser.accountId,
      fromName: fromUser.name,
      offer,
      withVideo: !!withVideo,
    });
  });

  socket.on("call-answer", ({ to, answer }) => {
    const fromUser = users.get(socket.id);
    if (!fromUser) {
      return;
    }

    emitToAccount(to, "call-answer", {
      from: fromUser.accountId,
      answer,
    });
  });

  socket.on("ice-candidate", ({ to, candidate }) => {
    const fromUser = users.get(socket.id);
    if (!fromUser) {
      return;
    }

    emitToAccount(to, "ice-candidate", {
      from: fromUser.accountId,
      candidate,
    });
  });

  socket.on("call-reject", ({ to }) => {
    const fromUser = users.get(socket.id);
    if (!fromUser) {
      return;
    }

    emitToAccount(to, "call-reject", {
      from: fromUser.accountId,
      fromName: fromUser.name,
    });
  });

  socket.on("call-end", ({ to }) => {
    const fromUser = users.get(socket.id);
    if (!fromUser) {
      return;
    }

    emitToAccount(to, "call-end", {
      from: fromUser.accountId,
      fromName: fromUser.name,
    });
  });

  socket.on("disconnect", async () => {
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

    try {
      await broadcastUsers();
    } catch (_err) {
    }
  });
});

async function main() {
  await initDb();

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`ENABLE_BOTS=${ENABLE_BOTS}`);
    console.log("PostgreSQL persistence enabled");
  });
}

main().catch((err) => {
  console.error("Startup failed:", err.message);
  process.exit(1);
});
