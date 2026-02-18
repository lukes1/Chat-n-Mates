const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const ENABLE_BOTS = process.env.ENABLE_BOTS === "true";

app.use(express.static("public"));
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

const users = new Map();
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

function getVisibleStatuses() {
  const now = Date.now();
  return statuses.filter((status) => status.expiresAt > now);
}

function getUsersPayload() {
  const liveUsers = Array.from(users.values()).map((user) => ({
    id: user.id,
    name: user.name,
    online: true,
  }));

  if (!ENABLE_BOTS) {
    return liveUsers;
  }

  const bots = botUsers.map((bot) => ({
    id: bot.id,
    name: bot.name,
    online: true,
  }));

  return [...liveUsers, ...bots];
}

function buildBotReply(botName, inputText) {
  const text = inputText.toLowerCase();

  if (text.includes("hallo") || text.includes("hi")) {
    return `${botName}: Moin, ich bin online. Test läuft.`;
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

function trimMessages() {
  if (privateMessages.length > MAX_MESSAGES) {
    privateMessages.splice(0, privateMessages.length - MAX_MESSAGES);
  }
}

function broadcastUsers() {
  io.emit("users-updated", getUsersPayload());
}

function broadcastStatuses() {
  io.emit("statuses-updated", getVisibleStatuses());
}

setInterval(() => {
  const before = statuses.length;
  const now = Date.now();
  for (let i = statuses.length - 1; i >= 0; i -= 1) {
    if (statuses[i].expiresAt <= now) {
      statuses.splice(i, 1);
    }
  }
  if (statuses.length !== before) {
    broadcastStatuses();
  }
}, 60 * 1000);

if (ENABLE_BOTS) {
  setInterval(() => {
    const liveUsers = Array.from(users.values());
    if (!liveUsers.length) {
      return;
    }

    const randomUser = liveUsers[Math.floor(Math.random() * liveUsers.length)];
    const randomBot = botUsers[Math.floor(Math.random() * botUsers.length)];

    const proactiveMessage = {
      id: uuidv4(),
      from: randomBot.id,
      fromName: randomBot.name,
      to: randomUser.id,
      toName: randomUser.name,
      text: buildProactiveBotMessage(randomBot.name),
      timestamp: Date.now(),
    };

    privateMessages.push(proactiveMessage);
    trimMessages();
    io.to(randomUser.id).emit("private-message", proactiveMessage);
  }, BOT_ACTIVE_INTERVAL_MS);
}

io.on("connection", (socket) => {
  socket.on("register", ({ name }) => {
    const safeName = String(name || "User").trim().slice(0, 30) || "User";

    users.set(socket.id, {
      id: socket.id,
      name: safeName,
    });

    socket.emit("bootstrap", {
      selfId: socket.id,
      users: getUsersPayload(),
      messages: privateMessages,
      statuses: getVisibleStatuses(),
    });

    broadcastUsers();
    broadcastStatuses();
  });

  socket.on("private-message", ({ to, text }) => {
    const fromUser = users.get(socket.id);
    const targetUser = users.get(to) || (ENABLE_BOTS ? botUsersById.get(to) : null);
    const safeText = String(text || "").trim().slice(0, 2000);

    if (!fromUser || !targetUser || !safeText) {
      return;
    }

    const message = {
      id: uuidv4(),
      from: fromUser.id,
      fromName: fromUser.name,
      to: targetUser.id,
      toName: targetUser.name,
      text: safeText,
      timestamp: Date.now(),
    };

    privateMessages.push(message);
    trimMessages();

    socket.emit("private-message", message);

    if (ENABLE_BOTS && botUsersById.has(targetUser.id)) {
      setTimeout(() => {
        const reply = {
          id: uuidv4(),
          from: targetUser.id,
          fromName: targetUser.name,
          to: fromUser.id,
          toName: fromUser.name,
          text: buildBotReply(targetUser.name, safeText),
          timestamp: Date.now(),
        };
        privateMessages.push(reply);
        trimMessages();
        socket.emit("private-message", reply);
      }, 450 + Math.floor(Math.random() * 700));
      return;
    }

    io.to(targetUser.id).emit("private-message", message);
  });

  socket.on("status-create", ({ text }) => {
    const user = users.get(socket.id);
    const safeText = String(text || "").trim().slice(0, 300);

    if (!user || !safeText) {
      return;
    }

    const now = Date.now();
    const status = {
      id: uuidv4(),
      userId: user.id,
      userName: user.name,
      text: safeText,
      createdAt: now,
      expiresAt: now + STATUS_TTL_MS,
    };

    statuses.push(status);
    broadcastStatuses();
  });

  socket.on("call-offer", ({ to, offer, withVideo }) => {
    const fromUser = users.get(socket.id);
    if (!fromUser || !users.has(to)) {
      return;
    }

    io.to(to).emit("call-offer", {
      from: socket.id,
      fromName: fromUser.name,
      offer,
      withVideo: !!withVideo,
    });
  });

  socket.on("call-answer", ({ to, answer }) => {
    if (!users.has(socket.id) || !users.has(to)) {
      return;
    }

    io.to(to).emit("call-answer", {
      from: socket.id,
      answer,
    });
  });

  socket.on("ice-candidate", ({ to, candidate }) => {
    if (!users.has(socket.id) || !users.has(to)) {
      return;
    }

    io.to(to).emit("ice-candidate", {
      from: socket.id,
      candidate,
    });
  });

  socket.on("call-reject", ({ to }) => {
    const user = users.get(socket.id);
    if (!user || !users.has(to)) {
      return;
    }

    io.to(to).emit("call-reject", {
      from: socket.id,
      fromName: user.name,
    });
  });

  socket.on("call-end", ({ to }) => {
    const user = users.get(socket.id);
    if (!user || !users.has(to)) {
      return;
    }

    io.to(to).emit("call-end", {
      from: socket.id,
      fromName: user.name,
    });
  });

  socket.on("disconnect", () => {
    users.delete(socket.id);
    broadcastUsers();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`ENABLE_BOTS=${ENABLE_BOTS}`);
});
