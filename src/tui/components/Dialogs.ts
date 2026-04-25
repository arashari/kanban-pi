import {
  Input,
  SelectList,
  Text,
  type SelectItem,
  type TUI,
  type Component,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import type { CardStage, CardEvent } from "../../types.js";

const stageItems: SelectItem[] = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "To Do" },
  { value: "planning", label: "Planning" },
  { value: "in_progress", label: "In Progress" },
  { value: "in_review", label: "In Review" },
  { value: "done", label: "Done" },
];

const selectTheme = {
  selectedPrefix: (s: string) => chalk.cyan(s),
  selectedText: (s: string) => chalk.cyan(s),
  description: (s: string) => chalk.gray(s),
  scrollInfo: (s: string) => chalk.dim(s),
  noMatch: (s: string) => chalk.yellow(s),
};

class LabeledInput implements Component {
  public input: Input;
  public label: string;

  constructor(label: string) {
    this.label = label;
    this.input = new Input();
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  render(width: number): string[] {
    return [truncateToWidth(this.label, width), ...this.input.render(width)];
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

export function askInput(
  tui: TUI,
  label: string,
  initial = ""
): Promise<string | null> {
  return new Promise((resolve) => {
    const wrapper = new LabeledInput(label);
    wrapper.input.setValue(initial);

    wrapper.input.onSubmit = (v) => {
      handle.hide();
      resolve(v);
    };
    wrapper.input.onEscape = () => {
      handle.hide();
      resolve(null);
    };

    const handle = tui.showOverlay(wrapper, {
      width: "80%",
      maxHeight: 4,
      anchor: "center",
    });
  });
}

export function askMove(
  tui: TUI,
  currentStage: CardStage
): Promise<CardStage | null> {
  return new Promise((resolve) => {
    const list = new SelectList(stageItems, 6, selectTheme);
    list.setSelectedIndex(
      stageItems.findIndex((i) => i.value === currentStage)
    );

    list.onSelect = (item) => {
      handle.hide();
      resolve(item.value as CardStage);
    };
    list.onCancel = () => {
      handle.hide();
      resolve(null);
    };

    const handle = tui.showOverlay(list, {
      width: "50%",
      maxHeight: 10,
      anchor: "center",
    });
  });
}

export function askConfirm(tui: TUI, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const text = new Text(message, 1, 1);
    let resolved = false;

    const component: Component = {
      render: (w) => {
        const lines = text.render(w);
        const hint = chalk.gray("Press [y] to confirm, [n] or [esc] to cancel");
        return [...lines, truncateToWidth(hint, w)];
      },
      invalidate: () => text.invalidate(),
      handleInput: (data) => {
        if (data === "y" || data === "Y") {
          if (!resolved) {
            resolved = true;
            handle.hide();
            resolve(true);
          }
        } else if (
          data === "n" ||
          data === "N" ||
          matchesKey(data, Key.escape)
        ) {
          if (!resolved) {
            resolved = true;
            handle.hide();
            resolve(false);
          }
        }
      },
    };

    const handle = tui.showOverlay(component, {
      width: "60%",
      maxHeight: 6,
      anchor: "center",
    });
  });
}

class HistoryViewer implements Component {
  private events: CardEvent[];
  private scrollOffset = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(events: CardEvent[]) {
    this.events = events;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.invalidate();
    } else if (matchesKey(data, Key.down)) {
      this.scrollOffset = Math.min(
        Math.max(0, this.events.length - 1),
        this.scrollOffset + 1
      );
      this.invalidate();
    } else if (matchesKey(data, Key.escape)) {
      this.onClose?.();
    }
  }

  onClose?: () => void;

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    lines.push(chalk.bold("Card History"));
    lines.push(chalk.gray("─".repeat(Math.min(width, 60))));

    const termHeight = process.stdout.rows || 24;
    const maxLines = Math.max(5, termHeight - 8);

    if (this.events.length === 0) {
      lines.push("No events yet.");
    } else {
      const visible = this.events.slice(
        this.scrollOffset,
        this.scrollOffset + maxLines
      );
      for (const ev of visible) {
        const prefix = chalk.gray(`[${ev.type}]`);
        let content = "";
        if (ev.text) content = ev.text;
        else if (ev.thinking) content = ev.thinking;
        else if (ev.error) content = chalk.red(ev.error);
        else if (ev.toolName) content = `${ev.toolName} (${ev.input ? "call" : "result"})`;
        else if (ev.stage) content = `→ ${ev.stage}`;
        else content = "";

        const line = `${prefix} ${truncateToWidth(content, width - visibleWidth(prefix) - 2)}`;
        lines.push(line);
      }
    }

    const hint = chalk.gray("[↑↓] scroll [esc] close");
    lines.push(hint);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}



export function showHistory(
  tui: TUI,
  events: CardEvent[]
): { close: () => void } {
  const viewer = new HistoryViewer(events);
  const handle = tui.showOverlay(viewer, {
    width: "80%",
    maxHeight: "80%",
    anchor: "center",
  });

  viewer.onClose = () => {
    handle.hide();
  };

  return { close: () => handle.hide() };
}
