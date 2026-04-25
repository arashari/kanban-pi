import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

/**
 * Create Kanban Card Extension
 *
 * Lets the agent create a new card on the Kanban board.
 * Useful when a task should be tracked separately.
 */

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "create_kanban_card",
    label: "Create Kanban Card",
    description:
      "Create a new card on the Kanban board.\n\n" +
      "Use this when:\n" +
      "- The user wants something turned into a tracked implementation task\n" +
      "- You have a large sub-task that should be tracked separately\n" +
      "- You want to hand off work to a fresh agent session\n\n" +
      "The card appears in the Backlog. The user must drag it to 'To Do' to start work.",
    parameters: Type.Object({
      title: Type.String({
        description: "Short title for the card (1–3 words)",
      }),
      description: Type.String({
        description: "What the new card should do. Be specific enough that another agent could pick it up.",
      }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const resp = await fetch("http://localhost:3456/api/cards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: params.title,
            description: params.description,
          }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const card = await resp.json();
        return {
          content: [
            {
              type: "text",
              text: `📋 Created card "${card.title}" (${card.id}). It is in the Backlog — the user must drag it to "To Do" to start work.`,
            },
          ],
          details: { card },
        };
      } catch {
        return {
          content: [
            {
              type: "text",
              text: "Could not create card — the Kanban server may not be running.",
            },
          ],
          details: { error: true },
        };
      }
    },
  });
}
