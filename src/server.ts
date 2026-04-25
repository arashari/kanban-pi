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
app.use(express.static("public"));

// Internal endpoint for the Kanban Stage extension
app.post("/internal/card-stage", (req, res) => {
  const { sessionId, stage, reason } = req.body;
  if (!sessionId || !stage) {
    return res.status(400).json({ received: false, error: "Missing sessionId or stage" });
  }
  const ok = orchestrator.updateCardStageBySession(sessionId, stage, reason);
  log("Extension stage report:", req.body, ok ? "(applied)" : "(ignored)");
  res.json({ received: ok });
});

const orchestrator = new Orchestrator(io);

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
  log("Client connected:", socket.id);

  // Send full board state on connect
  const board = orchestrator.getAllCards();
  log("Emit board_state:", board.map((c) => `${c.id}:${c.stage}(turnActive=${c.turnActive})`).join(", "));
  socket.emit("board_state", board);

  socket.on("create_card", (payload: CreateCardPayload, ack) => {
    const card = orchestrator.createCard(payload);
    log("Socket create_card ack:", card.id, card.stage);
    ack?.(card);
  });

  socket.on("move_card", (payload: MoveCardPayload) => {
    log("Socket move_card:", payload.cardId, "→", payload.stage);
    orchestrator.moveCard(payload).catch((err) => {
      log("move_card error:", err.message);
      console.error(err);
    });
  });

  socket.on("prompt_card", (payload: PromptCardPayload) => {
    log("Socket prompt_card:", payload.cardId);
    orchestrator.promptCard(payload).catch((err) => {
      log("prompt_card error:", err.message);
      console.error(err);
    });
  });

  socket.on("steer_card", ({ cardId, message }: { cardId: string; message: string }) => {
    log("Socket steer_card:", cardId, "msg:", message.slice(0, 40));
    orchestrator.steerCard(cardId, message).catch((err) => {
      log("steer_card error:", err.message);
      console.error(err);
    });
  });

  socket.on("interrupt_card", (cardId: string) => {
    log("Socket interrupt_card:", cardId);
    orchestrator.interruptCard(cardId).catch((err) => {
      log("interrupt_card error:", err.message);
      console.error(err);
    });
  });

  socket.on("view_card", (payload: string | { cardId: string; offset?: number; limit?: number }) => {
    const cardId = typeof payload === "string" ? payload : payload.cardId;
    const offset = typeof payload === "object" ? payload.offset || 0 : 0;
    const limit = typeof payload === "object" ? payload.limit || 50 : 50;
    log("Socket view_card:", cardId, "offset:", offset, "limit:", limit);
    const { events, total, hasMore } = orchestrator.getCardHistory(cardId, offset, limit);
    socket.emit("card_history", { cardId, events, total, hasMore, offset });
    log("Emit card_history:", cardId, "events:", events.length, "total:", total, "hasMore:", hasMore);
  });

  socket.on("disconnect", () => {
    log("Client disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3456;
httpServer.listen(PORT, () => {
  log(`🦀 Kanban Pi server running on http://localhost:${PORT}`);
});
