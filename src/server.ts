import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { Orchestrator } from "./orchestrator.js";
import { getProjects, addProject, removeProject, getProjectById } from "./store.js";
import type { CreateCardPayload, MoveCardPayload, PromptCardPayload } from "./types.js";
import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Stages humans cannot move a card INTO (agent-only)
const BLOCKED_STAGES: string[] = ["planning", "in_progress", "in_review", "conflict"];

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

// ─── Projects ────────────────────────────────────────────
app.get("/api/projects", (_req, res) => {
  res.json(orchestrator.getProjects());
});

app.post("/api/projects", async (req, res) => {
  const { name, path: projectPath } = req.body;
  if (!name || !projectPath) {
    return res.status(400).json({ error: "Missing name or path" });
  }
  if (!fs.existsSync(projectPath)) {
    return res.status(400).json({ error: "Path does not exist" });
  }
  const stat = fs.statSync(projectPath);
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: "Path is not a directory" });
  }

  // Validate git repo and at least 1 commit
  try {
    await execAsync("git rev-parse --git-dir", { cwd: projectPath });
  } catch {
    return res.status(400).json({ error: "Path is not a git repository" });
  }
  try {
    await execAsync("git log --oneline -1", { cwd: projectPath });
  } catch {
    return res.status(400).json({ error: "Repository has no commits" });
  }

  const result = addProject({
    id: `proj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    path: projectPath,
    createdAt: Date.now(),
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  io.emit("projects_updated", orchestrator.getProjects());
  res.json({ success: true });
});

app.delete("/api/projects/:id", (req, res) => {
  const result = removeProject(req.params.id);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  io.emit("projects_updated", orchestrator.getProjects());
  res.json({ success: true });
});

// ─── Cards ─────────────────────────────────────────────────
app.get("/api/cards", (req, res) => {
  const projectId = req.query.projectId as string | undefined;
  if (projectId) {
    res.json(orchestrator.getCardsByProject(projectId));
  } else {
    res.json(orchestrator.getAllCards());
  }
});

app.get("/api/cards/:id/diff", async (req, res) => {
  const card = orchestrator.getCard(req.params.id);
  if (!card) return res.status(404).json({ error: "Card not found" });
  if (!card.branchName) {
    return res.status(400).json({ error: "No branch for this card — chat-only or not started" });
  }
  try {
    const project = getProjectById(card.projectId);
    const cwd = project?.path || process.cwd();
    const { stdout } = await execAsync(`git diff HEAD...${card.branchName}`, { cwd });
    res.json({ diff: stdout });
  } catch (err: any) {
    res.status(500).json({ error: err.stderr || err.message || "Diff failed" });
  }
});

app.post("/api/cards", (req, res) => {
  const payload = req.body as CreateCardPayload;
  const card = orchestrator.createCard(payload);
  res.json(card);
});

app.patch("/api/cards/:id/move", (req, res) => {
  const stage = req.body.stage;
  if (BLOCKED_STAGES.includes(stage)) {
    return res.status(400).json({ error: `Cannot move card to agent-only stage: ${stage}` });
  }
  const payload: MoveCardPayload = {
    cardId: req.params.id,
    stage,
  };
  orchestrator
    .moveCard(payload)
    .then(() => res.json({ success: true }))
    .catch((err) => res.status(400).json({ error: err.message }));
});

app.delete("/api/cards/:id", async (req, res) => {
  await orchestrator.deleteCard(req.params.id);
  res.json({ success: true });
});

// Internal endpoint for worktree commits
app.post("/internal/card-commit", (req, res) => {
  const { sessionId, hash, message, description } = req.body;
  if (!sessionId || !hash) {
    return res.status(400).json({ received: false, error: "Missing sessionId or hash" });
  }
  const ok = orchestrator.recordCommitBySession(sessionId, hash, message, description);
  res.json({ received: ok });
});

// Internal endpoint for creating cards from an agent session
app.post("/internal/cards", (req, res) => {
  const { sessionId, title, description, chatOnly } = req.body;
  if (!sessionId || !title) {
    return res.status(400).json({ received: false, error: "Missing sessionId or title" });
  }
  const projectId = orchestrator.findProjectIdBySessionId(sessionId);
  const payload: CreateCardPayload = { title, description, chatOnly, projectId };
  const card = orchestrator.createCard(payload);
  res.json({ received: true, card });
});

// ─── Socket.io ─────────────────────────────────────────────

io.on("connection", (socket) => {
  socket.emit("board_state", orchestrator.getAllCards());
  socket.emit("projects_updated", orchestrator.getProjects());

  socket.on("create_card", (payload: CreateCardPayload, ack) => {
    const card = orchestrator.createCard(payload);
    ack?.(card);
  });

  socket.on("move_card", (payload: MoveCardPayload) => {
    if (BLOCKED_STAGES.includes(payload.stage)) {
      socket.emit("card_event", {
        cardId: payload.cardId,
        type: "error",
        error: `Cannot move card to agent-only stage: ${payload.stage}`,
      });
      return;
    }
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
