import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

/**
 * Kanban Stage Bridge Extension
 *
 * Registers an `update_kanban_stage` tool the agent can call to explicitly
 * report its current phase of work. The Kanban server polls a well-known
 * JSON file (or can be wired to a localhost HTTP endpoint) to pick up the
 * stage changes.
 *
 * For the reactive-only MVP, this tool is optional — the server already
 * infers stages from the agent event stream (thinking → planning,
 * tool calls → in_progress, message_complete → in_review).
 *
 * To enable explicit reporting:
 *   1. Ensure the Kanban server exposes POST /internal/card-stage
 *   2. Or change the execute() below to write to a shared file/pipe.
 */

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "update_kanban_stage",
    label: "Update Kanban Stage",
    description:
      "Update the current card's stage in the Kanban board. " +
      "Call this when you start planning, begin implementing, finish implementation, " +
      "or when the task is done.",
    parameters: Type.Object({
      stage: Type.String({
        description:
          "The new stage. Must be one of: planning, in_progress, in_review, done",
      }),
      reason: Type.String({
        description: "A brief explanation of why the stage changed",
      }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Try to notify the Kanban server if it's running locally.
      // Fail silently if the server is not reachable.
      try {
        await fetch("http://localhost:3456/internal/card-stage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: (ctx as any).sessionId,
            stage: params.stage,
            reason: params.reason,
          }),
        });
      } catch {
        // Server may not be running or endpoint not wired yet.
      }

      return {
        content: [
          {
            type: "text",
            text: `Kanban stage updated to "${params.stage}" (${params.reason})`,
          },
        ],
        details: { stage: params.stage },
      };
    },
  });
}
