import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { Orchestrator } from "./orchestrator.js";
import type { CreateCardPayload, MoveCardPayload, PromptCardPayload } from "./types.js";
import fs from "fs";

// ── Logger ─────────────────────────────────────────────
const LOG_PATH = process.env.LOG_FILE || "server.log";
const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
function log(...args: unknown[]) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}`;
  console.log(line);
  logStream.write(line + "\n");
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(express.json());

// ── Basic Auth ───────────────────────────────────────
const AUTH_USER = process.env.KANBAN_USERNAME;
const AUTH_PASS = process.env.KANBAN_PASSWORD;
const AUTH_ENABLED = !!(AUTH_USER && AUTH_PASS);

if (AUTH_ENABLED) {
  log("🔒 Basic auth enabled");
} else {
  log("⚠️  Warning: KANBAN_USERNAME and KANBAN_PASSWORD not set — server is open");
}

function checkBasicAuth(authHeader?: string): boolean {
  if (!AUTH_ENABLED) return true;
  if (!authHeader) return false;
  const [scheme, encoded] = authHeader.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf-8");
  const [user, pass] = decoded.split(":");
  return user === AUTH_USER && pass === AUTH_PASS;
}

app.use((req, res, next) => {
  if (checkBasicAuth(req.headers.authorization)) {
    next();
  } else {
    res.setHeader("WWW-Authenticate", 'Basic realm="Kanban Pi"');
    res.status(401).send("Authentication required");
  }
});

app.use(express.static("public"));

// Internal endpoint for the Kanban Stage extension
app.post("/internal/card-stage", (req, res) => {
  const { sessionId, stage, reason } = req.body;
  if (!sessionId || !stage) {
    return res.status(400).json({ received: false, error: "Missing sessionId or stage" });
  }
  const ok = orchestrator.updateCardStageBySession(sessionId, stage, reason);
  res.json({ received: ok });
});

const orchestrator = new Orchestrator(io);

// ── Socket.io Auth ───────────────────────────────────
io.use((socket, next) => {
  if (checkBasicAuth(socket.handshake.headers.authorization)) {
    next();
  } else {
    next(new Error("Authentication required"));
  }
});

// ─── REST API ──────────────────────────────────────────────

app.get("/api/hello", (_req, res) => {
  res.json({ message: "Hello from Kanban Pi! 👋" });
});

app.get("/api/cards", (_req, res) => {
  res.json(orchestrator.getAllCards());
});

app.post("/api/cards", (req, res) => {
  const payload = req.body as CreateCardPayload;
  const card = orchestrator.createCard(payload);
  res.json(card);
});

app.patch("/api/cards/:id/move", (req, res) => {
  const payload: MoveCardPayload = {
    cardId: req.params.id,
    stage: req.body.stage,
  };
  orchestrator
    .moveCard(payload)
    .then(() => res.json({ success: true }))
    .catch((err) => res.status(400).json({ error: err.message }));
});

app.delete("/api/cards/:id", (req, res) => {
  orchestrator.deleteCard(req.params.id);
  res.json({ success: true });
});

// ─── Socket.io ─────────────────────────────────────────────

io.on("connection", (socket) => {
  socket.emit("board_state", orchestrator.getAllCards());

  socket.on("create_card", (payload: CreateCardPayload, ack) => {
    const card = orchestrator.createCard(payload);
    ack?.(card);
  });

  socket.on("move_card", (payload: MoveCardPayload) => {
    orchestrator.moveCard(payload).catch(log);
  });

  socket.on("prompt_card", (payload: PromptCardPayload) => {
    orchestrator.promptCard(payload).catch(log);
  });

  socket.on("steer_card", ({ cardId, message }: { cardId: string; message: string }) => {
    orchestrator.steerCard(cardId, message).catch(log);
  });

  socket.on("interrupt_card", (cardId: string) => {
    orchestrator.interruptCard(cardId).catch(log);
  });

  socket.on("view_card", (payload: string | { cardId: string; offset?: number; limit?: number }) => {
    const cardId = typeof payload === "string" ? payload : payload.cardId;
    const offset = typeof payload === "object" ? payload.offset || 0 : 0;
    const limit = typeof payload === "object" ? payload.limit || 50 : 50;
    const { events, total, hasMore } = orchestrator.getCardHistory(cardId, offset, limit);
    socket.emit("card_history", { cardId, events, total, hasMore, offset });
  });
});

const PORT = process.env.PORT || 3456;
httpServer.listen(PORT, () => {
  log(`🦀 Kanban Pi server running on http://localhost:${PORT}`);
});
