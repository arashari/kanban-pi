import { io, Socket } from "socket.io-client";
import type { KanbanCard, CardStage, CardEvent } from "../types.js";

type Listener = () => void;

export class BoardState {
  cards: KanbanCard[] = [];
  events = new Map<string, CardEvent[]>();
  socket: Socket;
  connected = false;
  private listeners: Listener[] = [];
  private serverUrl: string;

  constructor(serverUrl = "http://localhost:3456") {
    this.serverUrl = serverUrl;
    this.socket = io(serverUrl);

    this.socket.on("connect", () => {
      this.connected = true;
      this.notify();
    });

    this.socket.on("disconnect", () => {
      this.connected = false;
      this.notify();
    });

    this.socket.on("board_state", (cards: KanbanCard[]) => {
      this.cards = cards;
      this.notify();
    });

    this.socket.on("card_update", (card: KanbanCard) => {
      const idx = this.cards.findIndex((c) => c.id === card.id);
      if (idx >= 0) {
        this.cards[idx] = card;
      } else {
        this.cards.push(card);
      }
      this.notify();
    });

    this.socket.on("card_deleted", ({ cardId }: { cardId: string }) => {
      this.cards = this.cards.filter((c) => c.id !== cardId);
      this.events.delete(cardId);
      this.notify();
    });

    this.socket.on("card_event", (event: CardEvent) => {
      const history = this.events.get(event.cardId) || [];
      history.push(event);
      this.events.set(event.cardId, history);
      this.notify();
    });
  }

  onChange(fn: Listener) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  createCard(title: string, description: string) {
    this.socket.emit("create_card", { title, description });
  }

  moveCard(cardId: string, stage: CardStage) {
    this.socket.emit("move_card", { cardId, stage });
  }

  deleteCard(cardId: string) {
    this.socket.emit("delete_card", cardId);
  }

  promptCard(cardId: string, message: string) {
    this.socket.emit("prompt_card", { cardId, message });
  }

  steerCard(cardId: string, message: string) {
    this.socket.emit("steer_card", { cardId, message });
  }

  interruptCard(cardId: string) {
    this.socket.emit("interrupt_card", cardId);
  }

  viewCard(cardId: string, offset = 0, limit = 50) {
    return new Promise<{ cardId: string; events: CardEvent[]; total: number; hasMore: boolean; offset: number }>((resolve) => {
      this.socket.emit("view_card", { cardId, offset, limit });
      const handler = (data: any) => {
        if (data.cardId === cardId) {
          this.socket.off("card_history", handler);
          resolve(data);
        }
      };
      this.socket.on("card_history", handler);
    });
  }
}
