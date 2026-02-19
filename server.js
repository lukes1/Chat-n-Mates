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
const MAX_GROUP_MESSAGES = 2000;
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
    CREATE TABLE IF NOT EXISTS contacts (
      account_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (account_id, contact_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_requests (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS contact_requests_to_status_idx
    ON contact_requests (to_id, status, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS contact_requests_from_to_status_idx
    ON contact_requests (from_id, to_id, status);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT ''`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      joined_at BIGINT NOT NULL,
      PRIMARY KEY (group_id, account_id)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS group_members_account_idx
    ON group_members (account_id, joined_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_messages (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      from_name TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS group_messages_group_idx
    ON group_messages (group_id, timestamp DESC);
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

async function isContact(accountId, targetAccountId) {
  const result = await pool.query(
    `SELECT 1 FROM contacts WHERE account_id = $1 AND contact_id = $2 LIMIT 1`,
    [accountId, targetAccountId]
  );
  return result.rowCount > 0;
}

async function getContactIds(accountId) {
  const result = await pool.query(`SELECT contact_id FROM contacts WHERE account_id = $1`, [accountId]);
  return result.rows.map((row) => row.contact_id);
}

async function createMutualContact(accountA, accountB) {
  const now = Date.now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO contacts (account_id, contact_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [accountA, accountB, now]
    );
    await client.query(
      `INSERT INTO contacts (account_id, contact_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [accountB, accountA, now]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function deleteMutualContact(accountA, accountB) {
  await pool.query(`DELETE FROM contacts WHERE account_id = $1 AND contact_id = $2`, [accountA, accountB]);
  await pool.query(`DELETE FROM contacts WHERE account_id = $1 AND contact_id = $2`, [accountB, accountA]);
  await pool.query(
    `
    UPDATE contact_requests
    SET status = 'rejected', updated_at = $3
    WHERE ((from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1))
    AND status = 'pending'
    `,
    [accountA, accountB, Date.now()]
  );
}

async function clearDirectChat(accountA, accountB) {
  await pool.query(
    `
    DELETE FROM private_messages
    WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)
    `,
    [accountA, accountB]
  );
}

async function getIncomingContactRequests(accountId) {
  const result = await pool.query(
    `
    SELECT cr.id, cr.from_id, a.username AS from_name, cr.created_at
    FROM contact_requests cr
    JOIN accounts a ON a.id = cr.from_id
    WHERE cr.to_id = $1 AND cr.status = 'pending'
    ORDER BY cr.created_at DESC
    `,
    [accountId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    fromId: row.from_id,
    fromName: row.from_name,
    createdAt: Number(row.created_at),
  }));
}

async function createContactRequest(fromId, toId) {
  const now = Date.now();

  const reversePending = await pool.query(
    `
    SELECT id
    FROM contact_requests
    WHERE from_id = $1 AND to_id = $2 AND status = 'pending'
    LIMIT 1
    `,
    [toId, fromId]
  );

  if (reversePending.rowCount) {
    const requestId = reversePending.rows[0].id;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE contact_requests SET status = 'accepted', updated_at = $2 WHERE id = $1`,
        [requestId, now]
      );
      await client.query(
        `INSERT INTO contacts (account_id, contact_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [fromId, toId, now]
      );
      await client.query(
        `INSERT INTO contacts (account_id, contact_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [toId, fromId, now]
      );
      await client.query("COMMIT");
      return { ok: true, autoAccepted: true };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  const existing = await pool.query(
    `
    SELECT 1
    FROM contact_requests
    WHERE from_id = $1 AND to_id = $2 AND status = 'pending'
    LIMIT 1
    `,
    [fromId, toId]
  );
  if (existing.rowCount) {
    return { ok: false, error: "Anfrage wurde bereits gesendet" };
  }

  await pool.query(
    `
    INSERT INTO contact_requests (id, from_id, to_id, status, created_at, updated_at)
    VALUES ($1, $2, $3, 'pending', $4, $4)
    `,
    [uuidv4(), fromId, toId, now]
  );

  return { ok: true, autoAccepted: false };
}

async function acceptContactRequest(requestId, accountId) {
  const now = Date.now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const reqResult = await client.query(
      `
      SELECT id, from_id, to_id
      FROM contact_requests
      WHERE id = $1 AND to_id = $2 AND status = 'pending'
      LIMIT 1
      `,
      [requestId, accountId]
    );

    if (!reqResult.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Anfrage nicht gefunden" };
    }

    const request = reqResult.rows[0];

    await client.query(
      `UPDATE contact_requests SET status = 'accepted', updated_at = $2 WHERE id = $1`,
      [request.id, now]
    );

    await client.query(
      `INSERT INTO contacts (account_id, contact_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [request.from_id, request.to_id, now]
    );
    await client.query(
      `INSERT INTO contacts (account_id, contact_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [request.to_id, request.from_id, now]
    );

    await client.query("COMMIT");
    return { ok: true, fromId: request.from_id, toId: request.to_id };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function rejectContactRequest(requestId, accountId) {
  const now = Date.now();
  const result = await pool.query(
    `
    UPDATE contact_requests
    SET status = 'rejected', updated_at = $3
    WHERE id = $1 AND to_id = $2 AND status = 'pending'
    `,
    [requestId, accountId, now]
  );

  if (!result.rowCount) {
    return { ok: false, error: "Anfrage nicht gefunden" };
  }
  return { ok: true };
}

async function getGroupsForAccount(accountId) {
  const result = await pool.query(
    `
    SELECT g.id, g.name, g.description, g.image_url, g.owner_id, g.created_at
    FROM group_members gm
    JOIN groups g ON g.id = gm.group_id
    WHERE gm.account_id = $1
    ORDER BY lower(g.name) ASC
    `,
    [accountId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description || "",
    imageUrl: row.image_url || "",
    ownerId: row.owner_id,
    createdAt: Number(row.created_at),
  }));
}

async function getGroupById(groupId) {
  const result = await pool.query(
    `SELECT id, name, description, image_url, owner_id, created_at FROM groups WHERE id = $1 LIMIT 1`,
    [groupId]
  );
  if (!result.rowCount) {
    return null;
  }
  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    imageUrl: row.image_url || "",
    ownerId: row.owner_id,
    createdAt: Number(row.created_at),
  };
}

async function isGroupMember(groupId, accountId) {
  const result = await pool.query(
    `SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = $2 LIMIT 1`,
    [groupId, accountId]
  );
  return result.rowCount > 0;
}

async function getGroupMemberIds(groupId) {
  const result = await pool.query(`SELECT account_id FROM group_members WHERE group_id = $1`, [groupId]);
  return result.rows.map((row) => row.account_id);
}

async function createGroup(ownerId, name, memberUsernames) {
  const cleanName = String(name || "").trim().slice(0, 40);
  if (cleanName.length < 2) {
    return { ok: false, error: "Gruppenname muss mindestens 2 Zeichen haben" };
  }

  const uniqueNames = Array.from(
    new Set(
      (Array.isArray(memberUsernames) ? memberUsernames : [])
        .map((entry) => normalizeUsername(entry))
        .filter(Boolean)
    )
  );

  const memberIds = new Set([ownerId]);
  for (const username of uniqueNames) {
    const account = await getAccountByUsername(username);
    if (!account) {
      return { ok: false, error: `User nicht gefunden: ${username}` };
    }
    if (account.id === ownerId) {
      continue;
    }
    const allowed = await isContact(ownerId, account.id);
    if (!allowed) {
      return { ok: false, error: `${account.username} ist nicht in deinen Kontakten` };
    }
    memberIds.add(account.id);
  }

  if (memberIds.size < 2) {
    return { ok: false, error: "Fuege mindestens 1 Kontakt zur Gruppe hinzu" };
  }

  const groupId = `grp-${uuidv4()}`;
  const now = Date.now();
  await pool.query(
    `INSERT INTO groups (id, name, description, image_url, owner_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      groupId,
      cleanName,
      "",
      "",
      ownerId,
      now,
    ]
  );

  for (const memberId of memberIds) {
    await pool.query(
      `INSERT INTO group_members (group_id, account_id, joined_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [groupId, memberId, now]
    );
  }

  return { ok: true, groupId, memberIds: Array.from(memberIds) };
}

async function getGroupDetailsForAccount(accountId, groupId) {
  const member = await isGroupMember(groupId, accountId);
  if (!member) {
    return null;
  }

  const group = await getGroupById(groupId);
  if (!group) {
    return null;
  }

  const membersResult = await pool.query(
    `
    SELECT a.id, a.username
    FROM group_members gm
    JOIN accounts a ON a.id = gm.account_id
    WHERE gm.group_id = $1
    ORDER BY lower(a.username) ASC
    `,
    [groupId]
  );

  return {
    ...group,
    members: membersResult.rows.map((row) => ({
      id: row.id,
      name: row.username,
      online: socketsByAccount.has(row.id),
    })),
  };
}

async function updateGroupMeta(ownerId, groupId, patch) {
  const group = await getGroupById(groupId);
  if (!group) {
    return { ok: false, error: "Gruppe nicht gefunden" };
  }
  if (group.ownerId !== ownerId) {
    return { ok: false, error: "Nur der Owner darf die Gruppe bearbeiten" };
  }

  const nextName = String(patch.name ?? group.name).trim().slice(0, 40);
  const nextDescription = String(patch.description ?? group.description).trim().slice(0, 300);
  const nextImageUrl = String(patch.imageUrl ?? group.imageUrl).trim().slice(0, 500);

  if (nextName.length < 2) {
    return { ok: false, error: "Gruppenname muss mindestens 2 Zeichen haben" };
  }

  await pool.query(
    `UPDATE groups SET name = $2, description = $3, image_url = $4 WHERE id = $1`,
    [groupId, nextName, nextDescription, nextImageUrl]
  );
  return { ok: true };
}

async function addGroupMemberByUsername(ownerId, groupId, username) {
  const group = await getGroupById(groupId);
  if (!group) {
    return { ok: false, error: "Gruppe nicht gefunden" };
  }
  if (group.ownerId !== ownerId) {
    return { ok: false, error: "Nur der Owner darf Mitglieder hinzufuegen" };
  }

  const account = await getAccountByUsername(username);
  if (!account) {
    return { ok: false, error: "User nicht gefunden" };
  }
  if (account.id !== ownerId) {
    const allowed = await isContact(ownerId, account.id);
    if (!allowed) {
      return { ok: false, error: `${account.username} ist nicht in deinen Kontakten` };
    }
  }

  await pool.query(
    `INSERT INTO group_members (group_id, account_id, joined_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [groupId, account.id, Date.now()]
  );
  return { ok: true, memberId: account.id };
}

async function removeGroupMember(ownerId, groupId, memberId) {
  const group = await getGroupById(groupId);
  if (!group) {
    return { ok: false, error: "Gruppe nicht gefunden" };
  }
  if (group.ownerId !== ownerId) {
    return { ok: false, error: "Nur der Owner darf Mitglieder entfernen" };
  }
  if (memberId === ownerId) {
    return { ok: false, error: "Owner kann sich nicht selbst entfernen" };
  }

  await pool.query(`DELETE FROM group_members WHERE group_id = $1 AND account_id = $2`, [groupId, memberId]);
  return { ok: true };
}

async function saveGroupMessage(message) {
  await pool.query(
    `
    INSERT INTO group_messages (id, group_id, from_id, from_name, text, timestamp)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [message.id, message.groupId, message.from, message.fromName, message.text, message.timestamp]
  );

  await pool.query(
    `
    DELETE FROM group_messages
    WHERE id IN (
      SELECT id
      FROM group_messages
      ORDER BY timestamp DESC
      OFFSET $1
    )
    `,
    [MAX_GROUP_MESSAGES]
  );
}

async function getGroupMessagesForAccount(accountId) {
  const result = await pool.query(
    `
    SELECT gm.id, gm.group_id, gm.from_id, gm.from_name, gm.text, gm.timestamp
    FROM group_messages gm
    JOIN group_members m ON m.group_id = gm.group_id
    WHERE m.account_id = $1
    ORDER BY gm.timestamp DESC
    LIMIT $2
    `,
    [accountId, MAX_GROUP_MESSAGES]
  );

  return result.rows
    .map((row) => ({
      id: row.id,
      groupId: row.group_id,
      from: row.from_id,
      fromName: row.from_name,
      text: row.text,
      timestamp: Number(row.timestamp),
    }))
    .reverse();
}

async function clearGroupChat(groupId) {
  await pool.query(`DELETE FROM group_messages WHERE group_id = $1`, [groupId]);
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

async function getUsersPayloadForAccount(accountId) {
  const result = await pool.query(
    `
    SELECT a.id, a.username
    FROM contacts c
    JOIN accounts a ON a.id = c.contact_id
    WHERE c.account_id = $1
    ORDER BY lower(a.username) ASC
    `,
    [accountId]
  );

  const contacts = result.rows.map((row) => ({
    id: row.id,
    name: row.username,
    online: socketsByAccount.has(row.id),
  }));

  if (!ENABLE_BOTS) {
    return contacts;
  }

  const bots = botUsers.map((bot) => ({
    id: bot.id,
    name: bot.name,
    online: true,
  }));

  return [...contacts, ...bots];
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

async function emitUsersForAccount(accountId) {
  emitToAccount(accountId, "users-updated", await getUsersPayloadForAccount(accountId));
}

async function emitGroupsForAccount(accountId) {
  emitToAccount(accountId, "groups-updated", await getGroupsForAccount(accountId));
}

async function emitGroupDetailsForAccount(accountId, groupId) {
  const details = await getGroupDetailsForAccount(accountId, groupId);
  if (details) {
    emitToAccount(accountId, "group-details", details);
  }
}

async function emitContactRequestsForAccount(accountId) {
  emitToAccount(accountId, "contact-requests-updated", await getIncomingContactRequests(accountId));
}

async function notifyPresenceChange(accountId) {
  const related = new Set([accountId]);
  const contacts = await getContactIds(accountId);
  contacts.forEach((id) => related.add(id));

  await Promise.all(Array.from(related).map((id) => emitUsersForAccount(id)));
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
      io.emit("statuses-updated", await getVisibleStatuses());
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
        users: await getUsersPayloadForAccount(account.id),
        groups: await getGroupsForAccount(account.id),
        messages: await getMessagesForAccount(account.id),
        groupMessages: await getGroupMessagesForAccount(account.id),
        statuses: await getVisibleStatuses(),
        contactRequests: await getIncomingContactRequests(account.id),
      });

      await notifyPresenceChange(account.id);
      await emitGroupsForAccount(account.id);
    } catch (_err) {
    }
  })();

  socket.on("contact-request-send", async ({ username }) => {
    try {
      const fromUser = users.get(socket.id);
      if (!fromUser) {
        return;
      }

      const target = await getAccountByUsername(username);
      if (!target) {
        emitToAccount(fromUser.accountId, "contact-request-result", {
          ok: false,
          message: "User nicht gefunden",
        });
        return;
      }

      if (target.id === fromUser.accountId) {
        emitToAccount(fromUser.accountId, "contact-request-result", {
          ok: false,
          message: "Du kannst dich nicht selbst hinzufügen",
        });
        return;
      }

      if (await isContact(fromUser.accountId, target.id)) {
        emitToAccount(fromUser.accountId, "contact-request-result", {
          ok: false,
          message: "Kontakt existiert bereits",
        });
        return;
      }

      const result = await createContactRequest(fromUser.accountId, target.id);
      if (!result.ok) {
        emitToAccount(fromUser.accountId, "contact-request-result", {
          ok: false,
          message: result.error,
        });
        return;
      }

      if (result.autoAccepted) {
        emitToAccount(fromUser.accountId, "contact-request-result", {
          ok: true,
          message: `Kontakt mit ${target.username} wurde bestaetigt`,
        });
        await Promise.all([
          emitUsersForAccount(fromUser.accountId),
          emitUsersForAccount(target.id),
          emitContactRequestsForAccount(fromUser.accountId),
          emitContactRequestsForAccount(target.id),
        ]);
        return;
      }

      emitToAccount(fromUser.accountId, "contact-request-result", {
        ok: true,
        message: `Anfrage an ${target.username} gesendet`,
      });
      await emitContactRequestsForAccount(target.id);
    } catch (_err) {
      emitToAccount(socket.account.id, "contact-request-result", {
        ok: false,
        message: "Anfrage fehlgeschlagen",
      });
    }
  });

  socket.on("contact-request-accept", async ({ requestId }) => {
    try {
      const currentUser = users.get(socket.id);
      if (!currentUser) {
        return;
      }

      const result = await acceptContactRequest(String(requestId || ""), currentUser.accountId);
      if (!result.ok) {
        emitToAccount(currentUser.accountId, "contact-request-result", {
          ok: false,
          message: result.error,
        });
        return;
      }

      await Promise.all([
        emitUsersForAccount(result.fromId),
        emitUsersForAccount(result.toId),
        emitContactRequestsForAccount(result.fromId),
        emitContactRequestsForAccount(result.toId),
      ]);
    } catch (_err) {
    }
  });

  socket.on("contact-request-reject", async ({ requestId }) => {
    try {
      const currentUser = users.get(socket.id);
      if (!currentUser) {
        return;
      }

      const result = await rejectContactRequest(String(requestId || ""), currentUser.accountId);
      if (!result.ok) {
        emitToAccount(currentUser.accountId, "contact-request-result", {
          ok: false,
          message: result.error,
        });
        return;
      }

      await emitContactRequestsForAccount(currentUser.accountId);
    } catch (_err) {
    }
  });

  socket.on("contact-delete", async ({ contactId }) => {
    try {
      const currentUser = users.get(socket.id);
      const contact = await getAccountById(contactId);
      if (!currentUser || !contact) {
        return;
      }

      const linked = await isContact(currentUser.accountId, contact.id);
      if (!linked) {
        emitToAccount(currentUser.accountId, "contact-request-result", {
          ok: false,
          message: "Kontakt nicht gefunden",
        });
        return;
      }

      await deleteMutualContact(currentUser.accountId, contact.id);
      await Promise.all([
        emitUsersForAccount(currentUser.accountId),
        emitUsersForAccount(contact.id),
        emitContactRequestsForAccount(currentUser.accountId),
        emitContactRequestsForAccount(contact.id),
      ]);

      emitToAccount(currentUser.accountId, "contact-request-result", {
        ok: true,
        message: `${contact.username} wurde entfernt`,
      });
    } catch (_err) {
    }
  });

  socket.on("group-create", async ({ name, members }) => {
    try {
      const currentUser = users.get(socket.id);
      if (!currentUser) {
        return;
      }

      const result = await createGroup(currentUser.accountId, name, members);
      if (!result.ok) {
        emitToAccount(currentUser.accountId, "group-create-result", {
          ok: false,
          message: result.error,
        });
        return;
      }

      emitToAccount(currentUser.accountId, "group-create-result", {
        ok: true,
        message: "Gruppe erstellt",
      });

      await Promise.all(result.memberIds.map((accountId) => emitGroupsForAccount(accountId)));
    } catch (_err) {
      emitToAccount(socket.account.id, "group-create-result", {
        ok: false,
        message: "Gruppe konnte nicht erstellt werden",
      });
    }
  });

  socket.on("group-details-get", async ({ groupId }) => {
    try {
      const currentUser = users.get(socket.id);
      if (!currentUser || !groupId) {
        return;
      }
      await emitGroupDetailsForAccount(currentUser.accountId, groupId);
    } catch (_err) {
    }
  });

  socket.on("group-meta-update", async ({ groupId, name, description, imageUrl }) => {
    try {
      const currentUser = users.get(socket.id);
      if (!currentUser || !groupId) {
        return;
      }

      const result = await updateGroupMeta(currentUser.accountId, groupId, { name, description, imageUrl });
      if (!result.ok) {
        emitToAccount(currentUser.accountId, "group-create-result", {
          ok: false,
          message: result.error,
        });
        return;
      }

      const memberIds = await getGroupMemberIds(groupId);
      await Promise.all(memberIds.map((accountId) => emitGroupsForAccount(accountId)));
      await Promise.all(memberIds.map((accountId) => emitGroupDetailsForAccount(accountId, groupId)));
      emitToAccount(currentUser.accountId, "group-create-result", {
        ok: true,
        message: "Gruppendaten aktualisiert",
      });
    } catch (_err) {
    }
  });

  socket.on("group-member-add", async ({ groupId, username }) => {
    try {
      const currentUser = users.get(socket.id);
      if (!currentUser || !groupId || !username) {
        return;
      }

      const result = await addGroupMemberByUsername(currentUser.accountId, groupId, username);
      if (!result.ok) {
        emitToAccount(currentUser.accountId, "group-create-result", {
          ok: false,
          message: result.error,
        });
        return;
      }

      const memberIds = await getGroupMemberIds(groupId);
      await Promise.all(memberIds.map((accountId) => emitGroupsForAccount(accountId)));
      await Promise.all(memberIds.map((accountId) => emitGroupDetailsForAccount(accountId, groupId)));
      emitToAccount(currentUser.accountId, "group-create-result", {
        ok: true,
        message: "Mitglied hinzugefuegt",
      });
    } catch (_err) {
    }
  });

  socket.on("group-member-remove", async ({ groupId, memberId }) => {
    try {
      const currentUser = users.get(socket.id);
      if (!currentUser || !groupId || !memberId) {
        return;
      }

      const beforeMembers = await getGroupMemberIds(groupId);
      const result = await removeGroupMember(currentUser.accountId, groupId, memberId);
      if (!result.ok) {
        emitToAccount(currentUser.accountId, "group-create-result", {
          ok: false,
          message: result.error,
        });
        return;
      }

      const afterMembers = await getGroupMemberIds(groupId);
      const allAffected = new Set([...beforeMembers, ...afterMembers]);
      await Promise.all(Array.from(allAffected).map((accountId) => emitGroupsForAccount(accountId)));
      await Promise.all(afterMembers.map((accountId) => emitGroupDetailsForAccount(accountId, groupId)));
      emitToAccount(currentUser.accountId, "group-create-result", {
        ok: true,
        message: "Mitglied entfernt",
      });
    } catch (_err) {
    }
  });

  socket.on("private-message", async ({ to, text }) => {
    try {
      const fromUser = users.get(socket.id);
      const safeText = String(text || "").trim().slice(0, 2000);
      if (!fromUser || !safeText) {
        return;
      }

      const targetAccount = await getAccountById(to);
      const targetUser = targetAccount
        ? { id: targetAccount.id, name: targetAccount.username }
        : ENABLE_BOTS
          ? botUsersById.get(to)
          : null;

      if (!targetUser) {
        return;
      }

      if (!botUsersById.has(targetUser.id)) {
        const contactAllowed = await isContact(fromUser.accountId, targetUser.id);
        if (!contactAllowed) {
          return;
        }
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

  socket.on("group-message", async ({ groupId, text }) => {
    try {
      const fromUser = users.get(socket.id);
      const safeText = String(text || "").trim().slice(0, 2000);
      if (!fromUser || !safeText || !groupId) {
        return;
      }

      const member = await isGroupMember(groupId, fromUser.accountId);
      if (!member) {
        return;
      }

      const message = {
        id: uuidv4(),
        groupId,
        from: fromUser.accountId,
        fromName: fromUser.name,
        text: safeText,
        timestamp: Date.now(),
      };

      await saveGroupMessage(message);
      const memberIds = await getGroupMemberIds(groupId);
      memberIds.forEach((accountId) => emitToAccount(accountId, "group-message", message));
    } catch (_err) {
    }
  });

  socket.on("chat-clear", async ({ targetType, targetId }) => {
    try {
      const currentUser = users.get(socket.id);
      if (!currentUser || !targetId) {
        return;
      }

      if (targetType === "user") {
        const target = await getAccountById(targetId);
        if (!target) {
          return;
        }
        const linked = await isContact(currentUser.accountId, target.id);
        if (!linked) {
          return;
        }

        await clearDirectChat(currentUser.accountId, target.id);
        emitToAccount(currentUser.accountId, "direct-chat-cleared", { targetId: target.id });
        emitToAccount(target.id, "direct-chat-cleared", { targetId: currentUser.accountId });
        return;
      }

      if (targetType === "group") {
        const member = await isGroupMember(targetId, currentUser.accountId);
        if (!member) {
          return;
        }
        await clearGroupChat(targetId);
        const memberIds = await getGroupMemberIds(targetId);
        memberIds.forEach((accountId) => emitToAccount(accountId, "group-chat-cleared", { groupId: targetId }));
      }
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
      io.emit("statuses-updated", await getVisibleStatuses());
    } catch (_err) {
    }
  });

  socket.on("call-offer", async ({ to, offer, withVideo }) => {
    const fromUser = users.get(socket.id);
    if (!fromUser || !socketsByAccount.has(to)) {
      return;
    }

    const contactAllowed = await isContact(fromUser.accountId, to);
    if (!contactAllowed) {
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

      try {
        await notifyPresenceChange(disconnectedUser.accountId);
      } catch (_err) {
      }
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
