export type CardKind = "chat" | "coding";

export type CardStage =
  | "backlog"
  | "todo"
  | "planning"
  | "in_progress"
  | "in_review"
  | "done";

export interface KanbanCard {
  id: string;
  title: string;
  description: string;
  stage: CardStage;
  kind: CardKind;
  sessionId?: string;
  turnActive?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CardEvent {
  cardId: string;
  type:
    | "stage_change"
    | "text_delta"
    | "thinking_delta"
    | "tool_call"
    | "tool_result"
    | "message_complete"
    | "error"
    | "status";
  stage?: CardStage;
  text?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  thinking?: string;
}

export interface CreateCardPayload {
  title: string;
  description: string;
  kind?: CardKind;
}

export interface MoveCardPayload {
  cardId: string;
  stage: CardStage;
}

export interface PromptCardPayload {
  cardId: string;
  message: string;
}
