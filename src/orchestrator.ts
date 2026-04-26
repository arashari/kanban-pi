import { Server as SocketServer } from "socket.io";
import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { CardAgent } from "./CardAgent.js";
import type {
  KanbanCard,
  CardStage,
  CreateCardPayload,
  MoveCardPayload,
  PromptCardPayload,
  CardEvent,
  CommitInfo,
  Project,
} from "./types.js";
import { loadState, saveState, getProjectById, getProjects } from "./store.js";

const execAsync = promisify(exec);
const WORKTREE_BASE = ".kanban-worktrees";

export class Orchestrator {
  private cards = new Map<string, KanbanCard>();
  private agents = new Map<string, CardAgent>();
  private eventHistory = new Map<string, CardEvent[]>();
  private io: SocketServer;

  constructor(io: SocketServer) {
    this.io = io;
    // Restore persisted cards
    const state = loadState();
    for (const card of state.cards) {
      this.cards.set(card.id, card);
      this.eventHistory.set(card.id, []);
    }
  }

  getProjects(): Project[] {
    return getProjects();
  }

  createCard(payload: CreateCardPayload): KanbanCard {
    const id = `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const projectId = payload.projectId && getProjectById(payload.projectId)
      ? payload.projectId
      : "default";
    const card: KanbanCard = {
      id,
      title: payload.title,
      description: payload.description,
      stage: "backlog",
      chatOnly: payload.chatOnly,
      projectId,
      turnActive: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.cards.set(id, card);
    this.persistCards();
    this.broadcastCardUpdate(card);
    return card;
  }

  async moveCard(payload: MoveCardPayload) {
    const card = this.cards.get(payload.cardId);
    if (!card) throw new Error("Card not found");

    const oldStage = card.stage;
    card.stage = payload.stage;
    card.updatedAt = Date.now();

    if (payload.stage === "todo" && oldStage === "backlog") {
      let agentCwd = process.cwd();
      let worktreePath: string | undefined;

      if (!card.chatOnly) {
        const project = getProjectById(card.projectId);
        if (!project) throw new Error("Project not found for card");
        worktreePath = await this.createWorktree(card.id, project);
        card.worktreePath = worktreePath;
        card.branchName = `card/${card.id}`;
        agentCwd = worktreePath;
      } else {
        const project = getProjectById(card.projectId);
        agentCwd = project?.path || `/tmp/.kanban-chat-${card.id}`;
        if (!project) {
          await fs.promises.mkdir(agentCwd, { recursive: true });
        }
      }

      const project = getProjectById(card.projectId);

      const agent = new CardAgent(
        card.id,
        card.title,
        card.description,
        {
          chatOnly: card.chatOnly,
          worktreePath,
          sandboxPath: agentCwd,
          repoPath: project?.path,
          projectName: project?.name,
          onEvent: (event) => this.handleAgentEvent(card.id, event),
          onSubmitChanges: !card.chatOnly
            ? (hash, message, description) => this.handleCommit(card.id, hash, message, description)
            : undefined,
        }
      );
      this.agents.set(card.id, agent);
      await agent.init();
      card.sessionId = agent.sessionId;
      this.persistCards();
      this.broadcastCardUpdate(card);
      await agent.start();
    }

    if (payload.stage === "done") {
      const agent = this.agents.get(card.id);
      if (agent) {
        await agent.dispose();
        this.agents.delete(card.id);
      }
      card.turnActive = false;

      if (!card.chatOnly && card.branchName && card.commits && card.commits.length > 0) {
        const project = getProjectById(card.projectId);
        const mergeResult = await this.mergeBranch(card, project);
        if (mergeResult.error) {
          card.mergeError = mergeResult.error;
          card.stage = "conflict";
          console.log(`[orchestrator] Card ${card.id} merge failed — moved to conflict`);
          const event: CardEvent = {
            cardId: card.id,
            type: "error",
            error: `Merge failed: ${mergeResult.error}`,
          };
          const history = this.eventHistory.get(card.id) || [];
          history.push(event);
          this.eventHistory.set(card.id, history);
          this.io.emit("card_event", event);
        } else {
          card.mergeError = undefined;
          if (card.worktreePath) {
            try { await execAsync(`git worktree remove --force "${card.worktreePath}"`); } catch {}
            card.worktreePath = undefined;
          }
          try { await execAsync(`git branch -D ${card.branchName}`, { cwd: project?.path }); } catch {}
          card.branchName = undefined;

          const event: CardEvent = {
            cardId: card.id,
            type: "status",
            text: `Merged into main: ${mergeResult.stdout || "success"}`,
          };
          const history = this.eventHistory.get(card.id) || [];
          history.push(event);
          this.eventHistory.set(card.id, history);
          this.io.emit("card_event", event);
        }
      }
    }

    if (payload.stage === "backlog" && oldStage !== "backlog") {
      card.turnActive = false;
      const agent = this.agents.get(card.id);
      if (agent) {
        await agent.abort();
      }
    }

    this.persistCards();
    this.broadcastCardUpdate(card);
  }

  async promptCard(payload: PromptCardPayload) {
    const card = this.cards.get(payload.cardId);
    if (!card) throw new Error("Card not found");

    const agent = this.agents.get(payload.cardId);
    if (!agent) {
      if (card.stage === "backlog") {
        await this.moveCard({ cardId: payload.cardId, stage: "todo" });
      }
      const newAgent = this.agents.get(payload.cardId);
      if (newAgent) {
        await newAgent.prompt(payload.message);
      }
      return;
    }

    await agent.prompt(payload.message);
  }

  async steerCard(cardId: string, message: string) {
    const agent = this.agents.get(cardId);
    if (!agent) throw new Error("No active session for this card");
    await agent.steer(message);
  }

  async interruptCard(cardId: string) {
    const agent = this.agents.get(cardId);
    if (!agent) throw new Error("No active session for this card");
    await agent.abort();
  }

  async deleteCard(cardId: string) {
    const card = this.cards.get(cardId);

    if (card?.worktreePath) {
      try {
        await execAsync(`git worktree remove --force "${card.worktreePath}"`);
      } catch (e) {
        console.error(`[orchestrator] Failed to remove worktree for ${cardId}:`, e);
      }
      try {
        if (card.branchName) {
          const project = getProjectById(card.projectId);
          await execAsync(`git branch -D ${card.branchName}`, { cwd: project?.path });
        }
      } catch {
        // Branch may already be gone
      }
    }

    if (card?.chatOnly) {
      try {
        await fs.promises.rm(`/tmp/.kanban-chat-${cardId}`, { recursive: true, force: true });
      } catch {}
    }

    const agent = this.agents.get(cardId);
    if (agent) {
      await agent.dispose();
      this.agents.delete(cardId);
    }
    this.cards.delete(cardId);
    this.eventHistory.delete(cardId);
    this.persistCards();
    this.io.emit("card_deleted", { cardId });
  }

  private async createWorktree(cardId: string, project: Project): Promise<string> {
    const worktreeDir = path.join(project.path, WORKTREE_BASE);
    await fs.promises.mkdir(worktreeDir, { recursive: true });

    // Ensure worktree dir is gitignored in the project repo
    await this.ensureGitignored(project.path, WORKTREE_BASE);

    const worktreePath = path.join(worktreeDir, cardId);
    const branchName = `card/${cardId}`;

    // Clean up any stale worktree or leftover directory
    try { await execAsync(`git worktree remove --force "${worktreePath}"`, { cwd: project.path }); } catch { /* ignore */ }
    try { await fs.promises.rm(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { await execAsync(`git branch -D ${branchName}`, { cwd: project.path }); } catch { /* ignore */ }

    await execAsync(`git worktree add -b "${branchName}" "${worktreePath}" HEAD`, { cwd: project.path });

    return worktreePath;
  }

  private async ensureGitignored(repoPath: string, pattern: string) {
    const gitignorePath = path.join(repoPath, ".gitignore");
    let content = "";
    try {
      content = await fs.promises.readFile(gitignorePath, "utf-8");
    } catch {
      // .gitignore may not exist
    }
    const lines = content.split("\n");
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(`^${escaped}/?$`);
    if (lines.some((l) => rx.test(l.trim()))) return;
    const newLine = content.endsWith("\n") || content === "" ? `${pattern}/` : `\n${pattern}/`;
    await fs.promises.writeFile(gitignorePath, content + newLine, "utf-8");
  }

  private async mergeBranch(card: KanbanCard, project?: Project): Promise<{ error?: string; stdout?: string }> {
    if (!card.branchName) return { error: "No branch to merge" };
    const cwd = project?.path || process.cwd();
    try {
      // Rebase the branch onto main in the worktree so history is linear
      if (card.worktreePath) {
        await execAsync(`git rebase main`, { cwd: card.worktreePath });
      }
      const { stdout, stderr } = await execAsync(`git merge --ff-only "${card.branchName}"`, { cwd });
      return { stdout: stdout || stderr };
    } catch (err: any) {
      // Attempt to abort the failed rebase so the branch isn't left in a dirty state
      if (card.worktreePath) {
        try { await execAsync(`git rebase --abort`, { cwd: card.worktreePath }); } catch {}
      }
      // Attempt to abort any failed merge
      try { await execAsync(`git merge --abort`, { cwd }); } catch {}
      return { error: err.stderr || err.stdout || err.message || "Merge failed" };
    }
  }

  private async handleCommit(cardId: string, hash: string, message: string, description?: string) {
    const card = this.cards.get(cardId);
    if (!card) return;
    if (!card.commits) card.commits = [];
    const commit: CommitInfo = { hash, message, description, date: Date.now() };
    card.commits.push(commit);
    card.updatedAt = Date.now();
    this.persistCards();
    this.broadcastCardUpdate(card);

    const event: CardEvent = {
      cardId,
      type: "commit",
      commit,
      text: `Committed ${hash.slice(0, 7)}: ${message}`,
    };
    const history = this.eventHistory.get(cardId) || [];
    history.push(event);
    this.eventHistory.set(cardId, history);
    this.io.emit("card_event", event);
  }

  recordCommitBySession(sessionId: string, hash: string, message: string, description?: string): boolean {
    const cardId = this.findCardIdBySessionId(sessionId);
    if (!cardId) return false;
    this.handleCommit(cardId, hash, message, description);
    return true;
  }

  private findCardIdBySessionId(sessionId: string): string | undefined {
    for (const [cardId, agent] of this.agents) {
      if (agent.sessionId === sessionId) {
        return cardId;
      }
    }
    return undefined;
  }

  findProjectIdBySessionId(sessionId: string): string | undefined {
    const cardId = this.findCardIdBySessionId(sessionId);
    if (!cardId) return undefined;
    const card = this.cards.get(cardId);
    return card?.projectId;
  }

  updateCardStageBySession(sessionId: string, stage: CardStage, reason?: string): boolean {
    const cardId = this.findCardIdBySessionId(sessionId);
    if (!cardId) return false;

    const card = this.cards.get(cardId);
    if (!card) return false;

    const prev = card.stage;
    card.stage = stage;
    card.updatedAt = Date.now();

    console.log(`[orchestrator] Card ${cardId} moved: ${prev} → ${stage} (extension${reason ? ", " + reason : ""})`);

    const event: CardEvent = {
      cardId,
      type: "stage_change",
      stage,
      text: reason,
    };

    const history = this.eventHistory.get(cardId) || [];
    history.push(event);
    this.eventHistory.set(cardId, history);

    this.persistCards();
    this.broadcastCardUpdate(card);
    this.io.emit("card_event", event);
    return true;
  }

  getCardsByStage(stage: CardStage): KanbanCard[] {
    return Array.from(this.cards.values())
      .filter((c) => c.stage === stage)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getCard(cardId: string): KanbanCard | undefined {
    return this.cards.get(cardId);
  }

  getAllCards(): KanbanCard[] {
    return Array.from(this.cards.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  getCardsByProject(projectId: string): KanbanCard[] {
    return Array.from(this.cards.values())
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getCardHistory(cardId: string, offset = 0, limit = 50): { events: CardEvent[]; total: number; hasMore: boolean } {
    const all = this.eventHistory.get(cardId) || [];
    const total = all.length;
    const end = Math.max(0, total - offset);
    const start = Math.max(0, end - limit);
    const events = all.slice(start, end);
    return { events, total, hasMore: start > 0 };
  }

  private handleAgentEvent(cardId: string, event: CardEvent) {
    const card = this.cards.get(cardId);
    if (!card) return;

    if (event.type === "status" && (event.text === "running" || event.text === "idle")) {
      card.turnActive = event.text === "running";
      this.broadcastCardUpdate(card);
      return;
    }

    const history = this.eventHistory.get(cardId) || [];
    history.push(event);
    this.eventHistory.set(cardId, history);

    if (event.type === "stage_change" && event.stage) {
      const prev = card.stage;
      card.stage = event.stage;
      card.updatedAt = Date.now();
      console.log(`[orchestrator] Card ${cardId} moved: ${prev} → ${event.stage} (agent)`);
      this.persistCards();
      this.broadcastCardUpdate(card);
    }

    this.io.emit("card_event", event);
  }

  private broadcastCardUpdate(card: KanbanCard) {
    this.io.emit("card_update", card);
  }

  private persistCards() {
    saveState({ projects: getProjects(), cards: this.getAllCards() });
  }
}
