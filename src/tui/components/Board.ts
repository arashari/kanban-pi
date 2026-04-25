import chalk from "chalk";
import type { Component } from "@mariozechner/pi-tui";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { KanbanCard, CardStage } from "../../types.js";
import type { BoardState } from "../state.js";

const STAGES: CardStage[] = ["backlog", "todo", "planning", "in_progress", "in_review", "done"];
const STAGE_LABELS: Record<CardStage, string> = {
  backlog: "Backlog",
  todo: "To Do",
  planning: "Planning",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};

function padToWidth(line: string, width: number): string {
  const vw = visibleWidth(line);
  if (vw < width) return line + " ".repeat(width - vw);
  return line;
}

export class Board implements Component {
  private state: BoardState;
  private selectedCol = 0;
  private selectedRow = 0;
  private onAction: (action: string, card?: KanbanCard) => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(state: BoardState, onAction: (action: string, card?: KanbanCard) => void) {
    this.state = state;
    this.onAction = onAction;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  getSelectedCard(): KanbanCard | undefined {
    const stage = STAGES[this.selectedCol];
    const cards = this.getCardsByStage(stage);
    return cards[this.selectedRow];
  }

  private getCardsByStage(stage: CardStage): KanbanCard[] {
    return this.state.cards
      .filter((c) => c.stage === stage)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private getMaxVisibleCards(): number {
    const termHeight = process.stdout.rows || 24;
    return Math.max(1, termHeight - 6); // header 3 + footer 2 + margins
  }

  handleInput(data: string): void {
    const stage = STAGES[this.selectedCol];
    const cards = this.getCardsByStage(stage);

    if (matchesKey(data, Key.up)) {
      if (this.selectedRow > 0) {
        this.selectedRow--;
        this.invalidate();
      }
    } else if (matchesKey(data, Key.down)) {
      if (this.selectedRow < cards.length - 1) {
        this.selectedRow++;
        this.invalidate();
      }
    } else if (matchesKey(data, Key.left)) {
      if (this.selectedCol > 0) {
        this.selectedCol--;
        this.selectedRow = 0;
        this.invalidate();
      }
    } else if (matchesKey(data, Key.right)) {
      if (this.selectedCol < STAGES.length - 1) {
        this.selectedCol++;
        this.selectedRow = 0;
        this.invalidate();
      }
    } else if (matchesKey(data, Key.enter)) {
      const card = this.getSelectedCard();
      if (card) this.onAction("view", card);
    } else if (data === "c" || data === "C") {
      this.onAction("create");
    } else if (data === "d" || data === "D") {
      const card = this.getSelectedCard();
      if (card) this.onAction("delete", card);
    } else if (data === "m" || data === "M") {
      const card = this.getSelectedCard();
      if (card) this.onAction("move", card);
    } else if (data === "p" || data === "P") {
      const card = this.getSelectedCard();
      if (card) this.onAction("prompt", card);
    } else if (data === "s" || data === "S") {
      const card = this.getSelectedCard();
      if (card) this.onAction("steer", card);
    } else if (data === "i" || data === "I") {
      const card = this.getSelectedCard();
      if (card) this.onAction("interrupt", card);
    } else if (data === "q" || data === "Q" || matchesKey(data, Key.ctrl("c"))) {
      this.onAction("quit");
    } else if (data === "r" || data === "R") {
      this.onAction("refresh");
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const numCols = STAGES.length;
    const baseWidth = Math.floor(width / numCols);
    const extra = width % numCols;
    const colWidths: number[] = [];
    for (let i = 0; i < numCols; i++) {
      colWidths.push(baseWidth + (i < extra ? 1 : 0));
    }

    const maxVisible = this.getMaxVisibleCards();
    const colData = STAGES.map((stage) => {
      const cards = this.getCardsByStage(stage);
      const visible = cards.slice(0, maxVisible);
      return { stage, cards: visible, total: cards.length, all: cards };
    });

    const lines: string[] = [];

    // Row 1: top border
    {
      let line = "";
      for (let i = 0; i < numCols; i++) {
        const w = colWidths[i];
        const isSelected = i === this.selectedCol;
        const top = "┌" + "─".repeat(w - 2) + "┐";
        line += isSelected ? chalk.cyan(top) : top;
      }
      lines.push(line);
    }

    // Row 2: stage name
    {
      let line = "";
      for (let i = 0; i < numCols; i++) {
        const w = colWidths[i];
        const isSelected = i === this.selectedCol;
        const label = STAGE_LABELS[colData[i].stage];
        const centered = label.padStart(Math.floor((w - 2 + label.length) / 2)).padEnd(w - 2);
        const cell = "│" + centered.substring(0, w - 2) + "│";
        line += isSelected ? chalk.cyan(cell) : cell;
      }
      lines.push(line);
    }

    // Row 3: count
    {
      let line = "";
      for (let i = 0; i < numCols; i++) {
        const w = colWidths[i];
        const isSelected = i === this.selectedCol;
        const count = `(${colData[i].total})`;
        const centered = count.padStart(Math.floor((w - 2 + count.length) / 2)).padEnd(w - 2);
        const cell = "│" + centered.substring(0, w - 2) + "│";
        line += isSelected ? chalk.cyan(cell) : cell;
      }
      lines.push(line);
    }

    // Row 4: separator
    {
      let line = "";
      for (let i = 0; i < numCols; i++) {
        const w = colWidths[i];
        const isSelected = i === this.selectedCol;
        const sep = "├" + "─".repeat(w - 2) + "┤";
        line += isSelected ? chalk.cyan(sep) : sep;
      }
      lines.push(line);
    }

    // Card rows
    const numCardRows = Math.max(1, ...colData.map((c) => c.cards.length));
    for (let r = 0; r < numCardRows; r++) {
      let line = "";
      for (let i = 0; i < numCols; i++) {
        const w = colWidths[i];
        const isSelectedCol = i === this.selectedCol;
        const card = colData[i].cards[r];
        const isSelectedCard = isSelectedCol && r === this.selectedRow;

        let inner: string;
        if (card) {
          const status = card.turnActive ? chalk.yellow("● ") : "  ";
          const title = truncateToWidth(card.title, w - 4 - visibleWidth(status));
          const text = status + title;
          const padded = text.padEnd(w - 2);
          inner = padded.substring(0, w - 2);
        } else {
          inner = " ".repeat(w - 2);
        }

        let cell = "│" + inner + "│";
        if (isSelectedCard && card) {
          cell = chalk.bgBlue.white(cell);
        } else if (isSelectedCol) {
          cell = chalk.cyan(cell);
        }
        line += cell;
      }
      lines.push(line);
    }

    // Bottom border
    {
      let line = "";
      for (let i = 0; i < numCols; i++) {
        const w = colWidths[i];
        const isSelected = i === this.selectedCol;
        const bot = "└" + "─".repeat(w - 2) + "┘";
        line += isSelected ? chalk.cyan(bot) : bot;
      }
      lines.push(line);
    }

    // Connection status
    {
      const status = this.state.connected
        ? chalk.green("● Connected")
        : chalk.red("● Disconnected");
      const selected = this.getSelectedCard();
      const info = selected
        ? `| [${truncateToWidth(selected.title, 30)}] ${chalk.gray(selected.id.slice(0, 8))}`
        : "";
      const help = chalk.gray(" [←→↑↓]nav 🐱[c]create [d]delete [m]move [p]rompt [s]teer [i]nterrupt [↵]view [q]uit");
      const footerLeft = status + info;
      const footer = footerLeft + " ".repeat(Math.max(0, width - visibleWidth(footerLeft) - visibleWidth(help))) + help;
      lines.push(truncateToWidth(footer, width));
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}
