export type CardStage =
  | "backlog"
  | "todo"
  | "planning"
  | "in_progress"
  | "in_review"
  | "done"
  | "conflict";

export interface Project {
  id: string;
  name: string;
  path: string;
  mergeStrategy?: "local_ff" | "push_branch";
  createdAt: number;
}

export interface CommitInfo {
  hash: string;
  message: string;
  description?: string;
  date: number;
}

export interface KanbanCard {
  id: string;
  title: string;
  description: string;
  stage: CardStage;
  chatOnly?: boolean;
  projectId: string;
  worktreePath?: string;
  branchName?: string;
  commits?: CommitInfo[];
  sessionId?: string;
  turnActive?: boolean;
  mergeError?: string;
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
    | "status"
    | "commit"
    | "user_message"
    | "interrupt";
  stage?: CardStage;
  text?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  thinking?: string;
  commit?: CommitInfo;
}

export interface CreateCardPayload {
  title: string;
  description: string;
  chatOnly?: boolean;
  projectId?: string;
}

export interface MoveCardPayload {
  cardId: string;
  stage: CardStage;
}

export interface PromptCardPayload {
  cardId: string;
  message: string;
}
