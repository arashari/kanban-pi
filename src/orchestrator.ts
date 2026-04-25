import { Server as SocketServer } from "socket.io";
import { CardAgent } from "./CardAgent.js";
import type {
  KanbanCard,
  CardStage,
  CreateCardPayload,
  MoveCardPayload,
  PromptCardPayload,
  CardEvent,
} from "./types.js";

export class Orchestrator {
  private cards = new Map<string, KanbanCard>();
  private agents = new Map<string, CardAgent>();
  private eventHistory = new Map<string, CardEvent[]>();
  private io: SocketServer;

  constructor(io: SocketServer) {
    this.io = io;
  }

  createCard(payload: CreateCardPayload): KanbanCard {
    const id = `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const card: KanbanCard = {
      id,
      title: payload.title,
      description: payload.description,
      stage: "backlog",
      kind: payload.kind || "coding",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.cards.set(id, card);
    console.log(`[orchestrator] Card ${id} created: "${card.title}" → backlog`);
    this.broadcastCardUpdate(card);
    return card;
  }

  async moveCard(payload: MoveCardPayload) {
    const card = this.cards.get(payload.cardId);
    if (!card) throw new Error("Card not found");

    const oldStage = card.stage;
    card.stage = payload.stage;
    card.updatedAt = Date.now();

    console.log(`[orchestrator] Card ${card.id} moved: ${oldStage} → ${card.stage} (user)`);
    // Stage machine transitions
    if (payload.stage === "todo" && oldStage === "backlog") {
      // Create agent session when moved to todo
      const agent = new CardAgent(
        card.id,
        card.title,
        card.description,
        card.kind,
        (event) => this.handleAgentEvent(card.id, event)
      );
      this.agents.set(card.id, agent);
      await agent.init();
      card.sessionId = agent.sessionId;
      this.broadcastCardUpdate(card);
      await agent.start();
    }

    if (payload.stage === "done") {
      // Dispose agent, keep history
      const agent = this.agents.get(card.id);
      if (agent) {
        await agent.dispose();
        this.agents.delete(card.id);
      }
    }

    if (payload.stage === "backlog" && oldStage !== "backlog") {
      // Pause / abort current work
      const agent = this.agents.get(card.id);
      if (agent) {
        await agent.abort();
      }
    }

    this.broadcastCardUpdate(card);
  }

  async promptCard(payload: PromptCardPayload) {
    const card = this.cards.get(payload.cardId);
    if (!card) throw new Error("Card not found");

    const agent = this.agents.get(payload.cardId);
    if (!agent) {
      // Auto-promote to todo and create session if user prompts from backlog
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

  deleteCard(cardId: string) {
    const agent = this.agents.get(cardId);
    if (agent) {
      agent.dispose();
      this.agents.delete(cardId);
    }
    this.cards.delete(cardId);
    this.eventHistory.delete(cardId);
    this.io.emit("card_deleted", { cardId });
  }

  private findCardIdBySessionId(sessionId: string): string | undefined {
    for (const [cardId, agent] of this.agents) {
      if (agent.sessionId === sessionId) {
        return cardId;
      }
    }
    return undefined;
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

    this.broadcastCardUpdate(card);
    this.io.emit("card_event", event);
    return true;
  }

  getCardsByStage(stage: CardStage): KanbanCard[] {
    return Array.from(this.cards.values())
      .filter((c) => c.stage === stage)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getAllCards(): KanbanCard[] {
    return Array.from(this.cards.values()).sort((a, b) => b.createdAt - a.createdAt);
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

    // Track running/idle state separately from history stream
    if (event.type === "status" && (event.text === "running" || event.text === "idle")) {
      card.turnActive = event.text === "running";
      this.broadcastCardUpdate(card);
      return; // synthetic state event — skip history and drawer
    }
    // Store in history for reload replay
    const history = this.eventHistory.get(cardId) || [];
    history.push(event);
    this.eventHistory.set(cardId, history);

    if (event.type === "stage_change" && event.stage) {
      const prev = card.stage;
      card.stage = event.stage;
      card.updatedAt = Date.now();
      console.log(`[orchestrator] Card ${cardId} moved: ${prev} → ${event.stage} (agent)`);
      this.broadcastCardUpdate(card);
    }

    // Forward all events to the frontend
    this.io.emit("card_event", event);
  }

  private broadcastCardUpdate(card: KanbanCard) {
    this.io.emit("card_update", card);
  }
}
