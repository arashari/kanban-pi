import {
  createAgentSession,
  SessionManager,
  defineTool,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { CardStage, CardEvent } from "./types.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface CardAgentOptions {
  chatOnly?: boolean;
  worktreePath?: string;
  sandboxPath?: string;
  onEvent: (event: CardEvent) => void;
  onSubmitChanges?: (hash: string, message: string, description?: string) => Promise<void>;
}

export class CardAgent {
  public cardId: string;
  public title: string;
  public description: string;
  public stage: CardStage = "backlog";
  private session?: AgentSession;
  private eventBuffer: string[] = [];
  private onEvent: (event: CardEvent) => void;
  private onSubmitChanges?: (hash: string, message: string, description?: string) => Promise<void>;
  private chatOnly?: boolean;
  private worktreePath?: string;
  private sandboxPath?: string;
  private disposed = false;

  constructor(
    cardId: string,
    title: string,
    description: string,
    opts: CardAgentOptions
  ) {
    this.cardId = cardId;
    this.title = title;
    this.description = description;
    this.onEvent = opts.onEvent;
    this.onSubmitChanges = opts.onSubmitChanges;
    this.chatOnly = opts.chatOnly;
    this.worktreePath = opts.worktreePath;
    this.sandboxPath = opts.sandboxPath;
  }

  async init() {
    const cwd = this.chatOnly ? this.sandboxPath! : this.worktreePath!;
    const customTools = this.buildCustomTools();

    const { session } = await createAgentSession({
      cwd,
      customTools,
      sessionManager: SessionManager.create(cwd),
    });
    this.session = session;
    session.subscribe((event) => this.handleAgentEvent(event as any));
    this.emit({
      cardId: this.cardId,
      type: "status",
      text: "Session initialized",
    });
  }

  private buildCustomTools() {
    if (this.chatOnly || !this.worktreePath) return [];

    const self = this;
    const tool = defineTool({
      name: "submit_worktree_changes",
      label: "Submit Worktree Changes",
      description:
        "Commit your changes to the isolated worktree branch so they can be reviewed and merged.\n\n" +
        "Use this when:\n" +
        "- You have finished implementing the task and want to submit it for review\n" +
        "- You want to checkpoint your progress with a meaningful commit\n\n" +
        "Provide a concise commit message and optionally a longer description.",
      parameters: Type.Object({
        message: Type.String({
          description: "Short commit message (imperative mood, e.g. 'Add user auth')",
        }),
        description: Type.Optional(Type.String({
          description: "Optional longer description for the commit body",
        })),
      }),
      async execute(toolCallId, params) {
        if (!self.worktreePath) {
          return {
            content: [{ type: "text", text: "No worktree configured." }],
            details: { error: "no worktree" },
          } as any;
        }

        try {
          await execAsync(`git add -A`, { cwd: self.worktreePath });

          const commitCmd = params.description
            ? `git commit -m "${params.message}" -m "${params.description}"`
            : `git commit -m "${params.message}"`;

          try {
            await execAsync(commitCmd, { cwd: self.worktreePath });
          } catch (commitErr: any) {
            if (commitErr.stderr?.includes("nothing to commit") || commitErr.stdout?.includes("nothing to commit")) {
              return {
                content: [{ type: "text", text: "⚠️ No changes to commit." }],
                details: { empty: true },
              } as any;
            }
            throw commitErr;
          }

          const { stdout: hashStdout } = await execAsync(`git rev-parse HEAD`, { cwd: self.worktreePath });
          const hash = hashStdout.trim();

          if (self.onSubmitChanges) {
            await self.onSubmitChanges(hash, params.message, params.description);
          }

          return {
            content: [{ type: "text", text: `✅ Committed ${hash.slice(0, 7)} — ${params.message}` }],
            details: { hash, message: params.message },
          } as any;
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `❌ Commit failed: ${err.message || String(err)}` }],
            details: { error: err.message || String(err) },
          } as any;
        }
      },
    });

    return [tool];
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

    let promptText: string;

    if (this.chatOnly) {
      promptText =
        `You are in chat-only mode. Do not create or modify files unless the user explicitly requests it.\n\n` +
        `Task: ${this.title}\n` +
        `Description: ${this.description}`;
    } else {
      promptText =
        `You are working on an implementation task in an isolated environment.\n\n` +
        `=== WORKSPACE ISOLATION ===\n` +
        `You are in a git worktree at: ${this.worktreePath}\n` +
        `This is an isolated branch: card/${this.cardId}\n` +
        `Your changes will NOT affect the main codebase until reviewed and merged.\n` +
        `All file edits are safe — you cannot corrupt the main branch.\n\n` +
        `=== PROJECT ARCHITECTURE ===\n` +
        `This project has two independent clients:\n` +
        `• Web client (browser UI): public/app.js, public/index.html, public/styles.css\n` +
        `• TUI client (terminal UI): src/tui/\n\n` +
        `RULE: Edit the WEB client by default. Only edit the TUI client if the task\n` +
        `explicitly says "TUI", "terminal", "console", or "CLI". If the task is generic\n` +
        `(e.g., "add emoji to new card button"), ALWAYS edit the web client.\n\n` +
        `Use update_kanban_stage to report your current phase.\n` +
        `Use create_kanban_card if the user wants a new implementation task.\n` +
        `Use submit_worktree_changes({ message, description }) to commit your work\n` +
        `when it is ready for review. You may commit multiple times.\n\n` +
        `=== PLANNING PHASE — ASK IF UNSURE ===\n` +
        `Before you create any files, think about whether the user's intent is clear.\n` +
        `If the title or description is ambiguous, DO NOT guess. Ask the user.\n\n` +
        `Workspace directory: ${this.worktreePath}\n\n` +
        `Task: ${this.title}\n` +
        `Description: ${this.description}`;
    }

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
