import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { Orchestrator } from "./orchestrator.js";
import type { CreateCardPayload, MoveCardPayload, PromptCardPayload } from "./types.js";

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
  console.log("Extension stage report:", req.body, ok ? "(applied)" : "(ignored)");
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
  console.log("Client connected:", socket.id);

  // Send full board state on connect
  socket.emit("board_state", orchestrator.getAllCards());

  socket.on("create_card", (payload: CreateCardPayload, ack) => {
    const card = orchestrator.createCard(payload);
    ack?.(card);
  });

  socket.on("move_card", (payload: MoveCardPayload) => {
    orchestrator.moveCard(payload).catch(console.error);
  });

  socket.on("prompt_card", (payload: PromptCardPayload) => {
    orchestrator.promptCard(payload).catch(console.error);
  });

  socket.on("steer_card", ({ cardId, message }: { cardId: string; message: string }) => {
    orchestrator.steerCard(cardId, message).catch(console.error);
  });

  socket.on("interrupt_card", (cardId: string) => {
    orchestrator.interruptCard(cardId).catch(console.error);
  });

  socket.on("view_card", (payload: string | { cardId: string; offset?: number; limit?: number }) => {
    const cardId = typeof payload === "string" ? payload : payload.cardId;
    const offset = typeof payload === "object" ? payload.offset || 0 : 0;
    const limit = typeof payload === "object" ? payload.limit || 50 : 50;
    const { events, total, hasMore } = orchestrator.getCardHistory(cardId, offset, limit);
    socket.emit("card_history", { cardId, events, total, hasMore, offset });
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3456;
httpServer.listen(PORT, () => {
  console.log(`🦀 Kanban Pi server running on http://localhost:${PORT}`);
});
