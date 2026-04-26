#!/usr/bin/env node
import { TUI, ProcessTerminal, Text } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { BoardState } from "./state.js";
import { Board } from "./components/Board.js";
import { askInput, askMove, askConfirm, showHistory } from "./components/Dialogs.js";

const serverUrl = process.env.KANBAN_SERVER || "http://localhost:3456";
const state = new BoardState(serverUrl);

const tui = new TUI(new ProcessTerminal());

// Connection status indicator above board
const statusText = new Text("", 0, 0);

function updateStatus() {
  if (state.connected) {
    statusText.setText("");
  } else {
    statusText.setText(
      chalk.bgRed.white(` ⚠  Disconnected from ${serverUrl} `)
    );
  }
}

state.onChange(() => {
  updateStatus();
  board.invalidate();
  tui.requestRender();
});

const board = new Board(state, async (action, card) => {
  switch (action) {
    case "quit": {
      tui.stop();
      process.exit(0);
      break;
    }
    case "create": {
      const title = await askInput(tui, "Title: ");
      if (!title) return;
      const description = (await askInput(tui, "Description: ")) || "";
      state.createCard(title, description);
      break;
    }
    case "delete": {
      if (!card) return;
      const ok = await askConfirm(tui, `Delete "${card.title}"?`);
      if (ok) state.deleteCard(card.id);
      break;
    }
    case "move": {
      if (!card) return;
      const stage = await askMove(tui, card.stage);
      if (stage) state.moveCard(card.id, stage);
      break;
    }
    case "done": {
      if (!card) return;
      state.moveCard(card.id, "done");
      break;
    }
    case "prompt": {
      if (!card) return;
      const message = await askInput(tui, `Prompt "${card.title}": `);
      if (message) state.promptCard(card.id, message);
      break;
    }
    case "steer": {
      if (!card) return;
      const message = await askInput(tui, `Steer "${card.title}": `);
      if (message) state.steerCard(card.id, message);
      break;
    }
    case "interrupt": {
      if (!card) return;
      state.interruptCard(card.id);
      break;
    }
    case "view": {
      if (!card) return;
      const history = await state.viewCard(card.id);
      const events = history.events.length > 0
        ? history.events
        : [
            {
              cardId: card.id,
              type: "status" as const,
              text: `Title: ${card.title} | Stage: ${card.stage} | ID: ${card.id}`,
            },
          ];
      showHistory(tui, events);
      break;
    }
    case "refresh": {
      state.socket.emit("board_state");
      break;
    }
  }
});

tui.addChild(statusText);
tui.addChild(board);

tui.start();

// Graceful shutdown
process.on("SIGINT", () => {
  tui.stop();
  process.exit(0);
});
