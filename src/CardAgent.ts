import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import type { CardStage, CardEvent } from "./types.js";

export class CardAgent {
  public cardId: string;
  public title: string;
  public description: string;
  public stage: CardStage = "backlog";
  private session?: AgentSession;
  private eventBuffer: string[] = [];
  private onEvent: (event: CardEvent) => void;
  private disposed = false;

  constructor(
    cardId: string,
    title: string,
    description: string,
    onEvent: (event: CardEvent) => void
  ) {
    this.cardId = cardId;
    this.title = title;
    this.description = description;
    this.onEvent = onEvent;
  }

  async init() {
    const { session } = await createAgentSession({
      sessionManager: SessionManager.create(process.cwd()),
    });
    this.session = session;
    session.subscribe((event) => this.handleAgentEvent(event as any));
    this.emit({
      cardId: this.cardId,
      type: "status",
      text: "Session initialized",
    });
  }

  private handleAgentEvent(event: any) {
    if (this.disposed) return;
    const type = event?.type;

    if (type === "message_update" && event.assistantMessageEvent) {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        const delta = ame.delta || "";
        this.eventBuffer.push(delta);
        this.emit({ cardId: this.cardId, type: "text_delta", text: delta });
      }
      if (ame.type === "thinking_delta") {
        this.emit({ cardId: this.cardId, type: "thinking_delta", thinking: ame.delta || "" });
      }
    }

    if (type === "tool_call") {
      this.emit({ cardId: this.cardId, type: "tool_call", toolName: event.toolName || "unknown", input: event.input });
    }

    if (type === "tool_result") {
      this.emit({ cardId: this.cardId, type: "tool_result", toolName: event.toolName || "unknown", output: event.content || event.result });
    }

    if (type === "turn_end") {
      const fullText = this.eventBuffer.join("");
      this.eventBuffer = [];
      this.emit({ cardId: this.cardId, type: "message_complete", text: fullText });
    }

    if (type === "agent_start") this.emitRunning(true);
    if (type === "agent_end") this.emitRunning(false);

    if (type === "error") {
      this.emitRunning(false);
      this.emit({ cardId: this.cardId, type: "error", error: event.message || String(event) });
    }
  }

  private transitionTo(stage: CardStage) {
    if (this.stage === stage) return;
    this.stage = stage;
    this.emit({ cardId: this.cardId, type: "stage_change", stage });
  }

  private emitRunning(active: boolean) {
    this.emit({ cardId: this.cardId, type: "status", text: active ? "running" : "idle" });
  }

  async start() {
    if (this.stage !== "backlog" && this.stage !== "todo") return;
    if (!this.session) await this.init();
    this.transitionTo("planning");

    const promptText =
      `You are working on a task. Respond naturally.\n\n` +
      `If the task requires file changes, feel free to use your available tools.\n` +
      `If the user's intent is unclear, ask for clarification before doing anything.\n\n` +
      `=== PLANNING PHASE — ASK IF UNSURE ===\n` +
      `Before you create any files, think about whether the user's intent is clear.\n` +
      `If the title or description is ambiguous (e.g. "cendol recipe" could mean\n` +
      `either a chat answer or writing a .md file), DO NOT guess. Ask the user.\n\n` +
      `Use update_kanban_stage to report your current phase.\n` +
      `Use create_kanban_card if the user wants a new implementation task.\n\n` +
      `Workspace directory: ${process.cwd()}\n\n` +
      `Task: ${this.title}\n` +
      `Description: ${this.description}`;

    this.emitRunning(true);
    await this.session!.prompt(promptText);
  }

  async prompt(message: string) {
    if (!this.session) throw new Error("Session not initialized");
    this.emitRunning(true);
    await this.session.sendUserMessage(message, { deliverAs: "steer" });
  }

  async steer(message: string) {
    if (!this.session) throw new Error("Session not initialized");
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
      sessionId: this.sessionId,
    };
  }

  private emit(event: CardEvent) {
    try { this.onEvent(event); } catch { /* ignore */ }
  }
}
