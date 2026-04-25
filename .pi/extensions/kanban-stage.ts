import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

/**
 * Kanban Stage Bridge Extension
 *
 * Registers an `update_kanban_stage` tool the agent calls to explicitly
 * report its current phase of work.  The card stage is NO LONGER inferred
 * from SDK events; the agent is the sole authority on what phase it is in.
 */

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "update_kanban_stage",
    label: "Update Kanban Stage",
    description:
      "Report your current phase of work to the Kanban board so the user can see your progress at a glance.\n\n" +
      "The user is actively watching a Kanban board. Each card moves through columns:\n" +
      "- planning   → you are analyzing the task and thinking about the approach\n" +
      "- in_progress → you are actively implementing (reading files, writing code, running commands)\n" +
      "- in_review   → you have finished and the user should review your work\n" +
      "- done       → the task is completely finished\n\n" +
      "WHEN to call this tool:\n" +
      "1. IMMEDIATELY when you start a new phase (e.g., right before you open a file or start writing code)\n" +
      "2. When you switch from thinking to doing, or from doing to reviewing\n" +
      "3. Before any significant action so the user knows what you're about to do\n" +
      "4. When you finish the task and the result is ready for the user\n\n" +
      "Always provide a brief reason explaining what you are doing.",
    parameters: Type.Object({
      stage: Type.Union([
        Type.Literal("planning", { description: "Analyzing the task and planning the approach" }),
        Type.Literal("in_progress", { description: "Actively implementing (writing code, running commands, etc.)" }),
        Type.Literal("in_review", { description: "Finished — user should review the result" }),
        Type.Literal("done", { description: "Task is completely finished" }),
      ]),
      reason: Type.String({
        description: "A brief explanation of what you are doing and why the stage changed. Keep it to one sentence.",
      }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const sessionId = (ctx as any)?.sessionManager?.getSessionId?.();
      if (!sessionId) {
        return {
          content: [{ type: "text", text: "Could not determine session ID — stage not reported." }],
          details: { error: "missing sessionId" },
        };
      }

      try {
        const resp = await fetch("http://localhost:3456/internal/card-stage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, stage: params.stage, reason: params.reason }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      } catch {
        // Server may not be running
      }

      return {
        content: [{ type: "text", text: `📋 Stage: ${params.stage} — ${params.reason}` }],
        details: { stage: params.stage },
      };
    },
  });
}
