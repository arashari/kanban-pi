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
  private pendingSteering = false;
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
        toolName: event.toolCall?.toolName || "unknown",
        output: event.result,
      });
    }

    // ── Message complete ──────────────────────────────────────
    if (type === "message_complete") {
      if (this.activeToolCalls === 0 && !this.pendingSteering) {
        this.transitionTo("in_review");
      }

      this.hasMadeToolCallsThisTurn = false;
      this.activeToolCalls = 0;
      this.pendingSteering = false;

      const fullText = this.eventBuffer.join("");
      this.eventBuffer = [];

      this.emit({
        cardId: this.cardId,
        type: "message_complete",
        text: fullText,
      });
    }

    // ── Error ───────────────────────────────────────────────
    if (type === "error") {
      this.emit({
        cardId: this.cardId,
        type: "error",
        error: event.message || String(event),
      });
    }

    // ── Steering queued by user ─────────────────────────────
    if (type === "message_queued") {
      this.pendingSteering = true;
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

  async start() {
    if (this.stage !== "backlog" && this.stage !== "todo") return;
    if (!this.session) {
      await this.init();
    }
    this.transitionTo("planning");

    if (this.kind === "chat") {
      // Chat-only: no tools, just a straight prompt
      await this.session!.prompt(
        `You are in a chat conversation. Reply naturally.\n\n` +
          `User asks: ${this.title}\n` +
          `${this.description ? "More context: " + this.description : ""}`
      );
    } else {
      await this.session!.prompt(
        `You are working on a coding task. ` +
          `Respond naturally. Only use tools if the task requires file changes.\n\n` +
          `Workspace directory: ${process.cwd()}\n` +
          `\n` +
          `Task: ${this.title}\n` +
          `Description: ${this.description}`
      );
    }
  }

  async prompt(message: string) {
    if (!this.session) {
      throw new Error("Session not initialized");
    }
    await this.session.sendUserMessage(message, { deliverAs: "steer" });
  }

  async steer(message: string) {
    if (!this.session) {
      throw new Error("Session not initialized");
    }
    await this.session.sendUserMessage(message, { deliverAs: "steer" });
  }

  async abort() {
    if (!this.session) return;
    await this.session.abort();
  }

  async dispose() {
    this.disposed = true;
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
