import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import type { CardStage, CardEvent } from "./types.js";

export type CardKind = "chat" | "coding";

export class CardAgent {
  public cardId: string;
  public title: string;
  public description: string;
  public stage: CardStage = "backlog";
  public kind: CardKind;
  private session?: AgentSession;
  private hasMadeToolCallsThisTurn = false;
  private activeToolCalls = 0;
  private eventBuffer: string[] = [];
  private onEvent: (event: CardEvent) => void;
  private disposed = false;

  constructor(
    cardId: string,
    title: string,
    description: string,
    kind: CardKind,
    onEvent: (event: CardEvent) => void
  ) {
    this.cardId = cardId;
    this.title = title;
    this.description = description;
    this.kind = kind;
    this.onEvent = onEvent;
  }

  async init() {
    const opts: any = {
      sessionManager: SessionManager.create(process.cwd()),
    };
    if (this.kind === "chat") {
      opts.noTools = "all";
    }
    const { session } = await createAgentSession(opts);
    this.session = session;

    session.subscribe((event) => this.handleAgentEvent(event as any));

    this.emit({
      cardId: this.cardId,
      type: "status",
      text: `Session initialized (${this.kind})`,
    });
  }

  private handleAgentEvent(event: any) {
    if (this.disposed) return;

    const type = event?.type;
    console.log(`[agent ${this.cardId}] raw event type="${type}" keys=`, Object.keys(event || {}).join(","));

    const assistantMessageEvent = event?.assistantMessageEvent;

    // ── Text / Thinking deltas ──────────────────────────────
    if (type === "message_update" && assistantMessageEvent) {
      const ameType = assistantMessageEvent.type;

      if (ameType === "thinking_delta") {
        this.transitionTo("planning");
        this.emit({
          cardId: this.cardId,
          type: "thinking_delta",
          thinking: assistantMessageEvent.delta || "",
        });
      }

      if (ameType === "text_delta") {
        if (!this.hasMadeToolCallsThisTurn) {
          this.transitionTo("planning");
        }
        const delta = assistantMessageEvent.delta || "";
        this.eventBuffer.push(delta);
        this.emit({
          cardId: this.cardId,
          type: "text_delta",
          text: delta,
        });
      }
    }

    // ── Tool call started ───────────────────────────────────
    if (type === "tool_call") {
      this.hasMadeToolCallsThisTurn = true;
      this.activeToolCalls++;
      this.transitionTo("in_progress");
      this.emit({
        cardId: this.cardId,
        type: "tool_call",
        toolName: event.toolName || "unknown",
        input: event.input,
      });
    }

    // ── Tool result ─────────────────────────────────────────
    if (type === "tool_result") {
      this.activeToolCalls = Math.max(0, this.activeToolCalls - 1);
      this.emit({
        cardId: this.cardId,
        type: "tool_result",
        toolName: event.toolName || "unknown",
        output: event.content || event.result,
      });
    }

    // ── Message end (assistant response complete) ──────────
    if (type === "message_end" || type === "turn_end") {
      console.log(`[agent ${this.cardId}] ${type} activeToolCalls=${this.activeToolCalls}`);
      if (this.activeToolCalls === 0) {
        this.transitionTo("in_review");
        this.emitRunning(false);
      }

      this.hasMadeToolCallsThisTurn = false;
      this.activeToolCalls = 0;

      const fullText = this.eventBuffer.join("");
      this.eventBuffer = [];

      this.emit({
        cardId: this.cardId,
        type: "message_complete",
        text: fullText,
      });
    }

    // ── Agent lifecycle ─────────────────────────────────────
    if (type === "agent_end") {
      console.log(`[agent ${this.cardId}] agent_end → emitRunning(false)`);
      this.emitRunning(false);
    }

    // ── Error ───────────────────────────────────────────────
    if (type === "error") {
      this.emitRunning(false);
      this.emit({
        cardId: this.cardId,
        type: "error",
        error: event.message || String(event),
      });
    }

    // ── Steering queued by user ─────────────────────────────
    if (type === "message_queued" || type === "queue_update") {
      // If the user steers while the agent is idle in in_review or done,
      // go back to planning so the next turn starts immediately.
      if (this.stage === "in_review" || this.stage === "done") {
        this.transitionTo("planning");
      }
    }
  }

  private transitionTo(stage: CardStage) {
    if (this.stage === stage) return;
    this.stage = stage;
    this.emit({
      cardId: this.cardId,
      type: "stage_change",
      stage,
    });
  }

  private emitRunning(active: boolean) {
    console.log(`[agent ${this.cardId}] emitRunning(${active}) stage=${this.stage}`);
    this.emit({
      cardId: this.cardId,
      type: "status",
      text: active ? "running" : "idle",
    });
  }

  async start() {
    if (this.stage !== "backlog" && this.stage !== "todo") return;
    if (!this.session) {
      await this.init();
    }
    this.transitionTo("planning");

    const promptText =
      this.kind === "chat"
        ? `You are in a chat conversation. Reply naturally.\n\n` +
          `User asks: ${this.title}\n` +
          `${this.description ? "More context: " + this.description : ""}`
        : `You are working on a coding task. ` +
          `Respond naturally. Only use tools if the task requires file changes.\n\n` +
          `Workspace directory: ${process.cwd()}\n` +
          `\n` +
          `Task: ${this.title}\n` +
          `Description: ${this.description}`;

    this.emitRunning(true);
    await this.session!.prompt(promptText);
  }

  async prompt(message: string) {
    if (!this.session) {
      throw new Error("Session not initialized");
    }
    this.emitRunning(true);
    await this.session.sendUserMessage(message, { deliverAs: "steer" });
  }

  async steer(message: string) {
    if (!this.session) {
      throw new Error("Session not initialized");
    }
    this.emitRunning(true);
    await this.session.sendUserMessage(message, { deliverAs: "steer" });
  }

  async abort() {
    if (!this.session) return;
    await this.session.abort();
    this.emitRunning(false);
  }

  async dispose() {
    this.disposed = true;
    this.emitRunning(false);
    if (this.session) {
      this.session.dispose();
      this.session = undefined;
    }
  }

  get sessionId() {
    return this.session?.sessionId;
  }

  getCurrentState() {
    return {
      cardId: this.cardId,
      title: this.title,
      description: this.description,
      stage: this.stage,
      kind: this.kind,
      sessionId: this.sessionId,
    };
  }

  private emit(event: CardEvent) {
    try {
      this.onEvent(event);
    } catch {
      // ignore emitter errors
    }
  }
}
