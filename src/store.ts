import fs from "fs";
import path from "path";
import type { KanbanCard, Project } from "./types.js";

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_PATH = path.join(DATA_DIR, "state.json");

interface PersistedState {
  projects: Project[];
  cards: KanbanCard[];
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadState(): PersistedState {
  ensureDir();
  if (!fs.existsSync(STATE_PATH)) {
    const defaultProject: Project = {
      id: "default",
      name: "kanban-pi",
      path: process.cwd(),
      createdAt: Date.now(),
    };
    const state: PersistedState = { projects: [defaultProject], cards: [] };
    saveState(state);
    return state;
  }
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as PersistedState;
    // Backward compat: ensure every card has a projectId
    if (parsed.cards) {
      for (const card of parsed.cards) {
        if (!card.projectId) card.projectId = "default";
      }
    }
    return parsed;
  } catch {
    const defaultProject: Project = {
      id: "default",
      name: "kanban-pi",
      path: process.cwd(),
      createdAt: Date.now(),
    };
    const state: PersistedState = { projects: [defaultProject], cards: [] };
    saveState(state);
    return state;
  }
}

export function saveState(state: PersistedState) {
  ensureDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function addProject(project: Project): { success: boolean; error?: string } {
  const state = loadState();
  // Validate name uniqueness
  if (state.projects.some((p) => p.name === project.name)) {
    return { success: false, error: "Project name already exists" };
  }
  state.projects.push(project);
  saveState(state);
  return { success: true };
}

export function removeProject(id: string): { success: boolean; error?: string } {
  const state = loadState();
  const hasCards = state.cards.some((c) => c.projectId === id && c.stage !== "done");
  if (hasCards) {
    return { success: false, error: "Project still has active cards" };
  }
  state.projects = state.projects.filter((p) => p.id !== id);
  // Also clean up done cards belonging to this project
  state.cards = state.cards.filter((c) => c.projectId !== id);
  saveState(state);
  return { success: true };
}

export function getProjects(): Project[] {
  return loadState().projects;
}

export function getProjectById(id: string): Project | undefined {
  return loadState().projects.find((p) => p.id === id);
}

export function saveCards(cards: KanbanCard[]) {
  const state = loadState();
  state.cards = cards;
  saveState(state);
}

export function getCards(): KanbanCard[] {
  return loadState().cards;
}
