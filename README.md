# 🦀 Kanban Pi

A Kanban board where every card is a persistent **Pi agent session**. Drag a card from **Backlog → To Do** and an agent starts working on it automatically. The agent decides whether to reply conversationally, research, or implement — only using tools when the task actually requires file changes.

Watch it think, respond, and pause for your review — all in real time.

## Architecture

```
Browser (Kanban Board)
    │ Socket.io
    ▼
Node.js Backend  ──►  Pi Agent Session per card
Express + ws           (createAgentSession)
    │                     │
    ▼                     ▼
Orchestrator         SessionManager
(cards map)          ~/.pi/agent/sessions/
```

**Stages:**

| Stage | Trigger |
|---|---|
| `backlog` | Card created |
| `todo` | Human drags here → agent session created, starts planning |
| `planning` | Agent is streaming thinking / analysis |
| `in_progress` | Agent is executing tools (bash, write, edit) |
| `in_review` | Agent finished its turn, waiting for human feedback |
| `done` | Human approved, session archived |

## Quick Start

```bash
cd kanban-pi
npm install     # already done if you see node_modules
npm run dev     # starts server on http://localhost:3456
```

Open your browser to **http://localhost:3456**.

### Prerequisites

- Node.js ≥ 20
- A Pi-compatible API key or subscription configured (e.g., `ANTHROPIC_API_KEY`)

## How It Works

### Reactive Stage Detection

The backend listens to every `AgentSessionEvent` and maps it to a column:

| Pi Event | Column |
|---|---|
| `thinking_delta` | **Planning** |
| `tool_call` | **In Progress** |
| `message_complete` + had tools | **In Review** |
| `message_queued` (steer) | back to **Planning** |

### Creating a Card

1. Click **+ New Card**
2. Enter a title and description (e.g., *"How do I use React hooks?"* or *"Add auth middleware"*)
3. Card appears in **Backlog**
4. Drag to **To Do** — Pi session starts automatically

The agent decides what to do:
- **Q&A card** (e.g., "explain closures") → the agent just replies in text, no files touched
- **Coding card** (e.g., "add auth middleware") → the agent reads files, plans, writes code, runs tests
- **Research card** (e.g., "evaluate three JS bundlers") → the agent reads existing files and gathers info

### Steering an Agent

Click any running card to open the detail drawer. Type a message and hit **Send** to steer the agent mid-flight.

```
→ IN PROGRESS
  ⚡ write("src/auth.ts")
  ✓ write done
← IN REVIEW

You: "Also add rate limiting"
→ PLANNING
```

## Project Structure

```
kanban-pi/
├── src/
│   ├── server.ts       # Express + Socket.io entry
│   ├── orchestrator.ts  # Card lifecycle + stage transitions
│   ├── CardAgent.ts     # Wraps one Pi AgentSession
│   └── types.ts         # Shared types
├── public/
│   ├── index.html       # Kanban UI
│   ├── styles.css       # Dark theme
│   └── app.js           # Socket.io client + drag & drop
├── .pi/
│   └── extensions/
│       └── kanban-stage.ts  # Optional Pi extension for explicit stage reporting
├── package.json
└── tsconfig.json
```

## Extending

### Add Explicit Stage Tool

The reactive detection is usually accurate, but you can wire the `update_kanban_stage` tool for 100 % precision.

1. The extension is already in `.pi/extensions/kanban-stage.ts`
2. Pi auto-discovers it because the server runs from `kanban-pi/` and Pi walks up
3. Complete the `POST /internal/card-stage` route in `server.ts` to map sessionId → cardId

### Multiple Concurrent Agents

Each card runs its own `AgentSession`. They execute independently in Node.js. Your limits are:

- Provider API rate limits
- Your API spend budget
- `ulimit` / system process limits (rarely hit)

### Future Ideas

| Feature | How |
|---|---|
| Fork a card into two branches | Clone the session JSONL, create two cards |
| Export card history as HTML | Pi's built-in `exportHtml()` |
| Team collaboration | Same backend, broadcast events via Socket.io rooms |
| Auto-archive done cards | Cron + `session.exportHtml()` to `archive/` |
| Custom skills per column | Load different `.pi/skills/` based on stage |

## License

MIT
