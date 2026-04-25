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
    // Chat sessions used to disable all tools with noTools:"all",
    // but that also blocks extension tools like create_kanban_card.
    // Instead, keep extensions loaded and guide behaviour via prompt.
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

    // ── Streaming deltas for the drawer ──────────────────
    if (type === "message_update" && event.assistantMessageEvent) {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        const delta = ame.delta || "";
        this.eventBuffer.push(delta);
        this.emit({
          cardId: this.cardId,
          type: "text_delta",
          text: delta,
        });
      }
      if (ame.type === "thinking_delta") {
        this.emit({
          cardId: this.cardId,
          type: "thinking_delta",
          thinking: ame.delta || "",
        });
      }
    }

    // ── Tool call (drawer only) ─────────────────────────
    if (type === "tool_call") {
      this.emit({
        cardId: this.cardId,
        type: "tool_call",
        toolName: event.toolName || "unknown",
        input: event.input,
      });
    }

    // ── Tool result (drawer only) ───────────────────────
    if (type === "tool_result") {
      this.emit({
        cardId: this.cardId,
        type: "tool_result",
        toolName: event.toolName || "unknown",
        output: event.content || event.result,
      });
    }

    // ── Turn complete ───────────────────────────────────
    // turn_end signals the entire LLM turn (messages + tools) is done.
    if (type === "turn_end") {
      const fullText = this.eventBuffer.join("");
      this.eventBuffer = [];
      this.emit({
        cardId: this.cardId,
        type: "message_complete",
        text: fullText,
      });
    }

    // ── Agent lifecycle (for turnActive indicator) ───────
    if (type === "agent_start") {
      this.emitRunning(true);
    }
    if (type === "agent_end") {
      this.emitRunning(false);
    }

    // ── Error ────────────────────────────────────────────
    if (type === "error") {
      this.emitRunning(false);
      this.emit({
        cardId: this.cardId,
        type: "error",
        error: event.message || String(event),
      });
    }
  }

  // ── Card stage changes ───────────────────────────────
  // The ONLY source of stage changes after start() is the
  // update_kanban_stage extension tool.  Never infer stage
  // from SDK events.
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
    this.emit({
      cardId: this.cardId,
      type: "status",
      text: active ? "running" : "idle",
    });
  }

  // ── Turn lifecycle ───────────────────────────────────
  async start() {
    if (this.stage !== "backlog" && this.stage !== "todo") return;
    if (!this.session) {
      await this.init();
    }
    // Initial stage: the agent is about to begin.
    this.transitionTo("planning");

    const promptText =
      this.kind === "chat"
        ? `You are in a chat conversation. Reply naturally.

If the user's question is vague or could mean multiple things, ask a clarifying question before answering.

If the user asks for something that should later become a coding task (e.g., "now create that as a file"), use the create_kanban_card tool to make a new card instead of creating files directly.

User asks: ${this.title}
${this.description ? "More context: " + this.description : ""}`
        : `You are working on a coding task. Respond naturally. Only use tools if the task requires file changes.

=== PLANNING PHASE — ASK IF UNSURE ===
Before you create any files or make any changes, think about whether the user's intent is 100% clear.
If the task title or description is ambiguous — for example, it sounds like a chat question instead of a coding task, or you are not sure what files to modify — DO NOT create files.
Instead, stay in the planning stage and ask the user a clarifying question. Wait for their answer.

Examples where you SHOULD ask for clarification:
- "cendol recipe" → this could be a chat answer or creating a .md file; ask which one.
- "fix the bug" → ask which bug, which file, or what the expected behavior is.
- "add feature" → ask which feature and where it should go.

=== WORKFLOW ===
1. Use update_kanban_stage to report your current phase (planning → in_progress → in_review → done).
2. Use create_kanban_card if the user wants a new task spun off as a separate card.

Workspace directory: ${process.cwd()}

Task: ${this.title}
Description: ${this.description}`;

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
