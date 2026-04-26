// Stages that humans cannot move a card INTO (agent-only)
const BLOCKED_STAGES = ['planning', 'in_progress', 'in_review', 'conflict'];

const socket = io({ withCredentials: true });
const cards = new Map();
let projects = [];
let activeProjectId = null;
let activeCardId = null;
let programmaticScroll = false;
let drawerHistory = { offset: 0, total: 0, hasMore: false, loading: false };
const loaderEl = document.getElementById("drawer-loader");

// ─── Projects ────────────────────────────────────────
const projectSelect = document.getElementById("project-select");
const manageProjectsBtn = document.getElementById("manage-projects-btn");
const projectsModal = document.getElementById("projects-modal");
const projectsList = document.getElementById("projects-list");
const projectNameInput = document.getElementById("project-name-input");
const projectPathInput = document.getElementById("project-path-input");
const projectAddBtn = document.getElementById("project-add-btn");
const projectAddError = document.getElementById("project-add-error");
const projectsCloseBtn = document.getElementById("projects-close-btn");
const modalProjectName = document.getElementById("modal-project-name");

async function fetchProjects() {
  try {
    const res = await fetch("/api/projects", { credentials: "include" });
    if (!res.ok) return;
    projects = await res.json();
    populateProjectSelect();
    // If activeProjectId is invalid, reset to default
    if (!projects.find(p => p.id === activeProjectId)) {
      activeProjectId = projects[0]?.id || null;
    }
    if (activeProjectId) {
      projectSelect.value = activeProjectId;
      await syncBoard();
    }
  } catch (_e) {
    // ignore
  }
}

function populateProjectSelect() {
  projectSelect.innerHTML = '';
  for (const p of projects) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    projectSelect.appendChild(opt);
  }
}

function getActiveProject() {
  return projects.find(p => p.id === activeProjectId);
}

projectSelect.addEventListener("change", () => {
  activeProjectId = projectSelect.value;
  // Re-render board for selected project
  document.querySelectorAll('.dropzone').forEach(z => z.innerHTML = '');
  for (const card of cards.values()) {
    if (card.projectId === activeProjectId) {
      placeCard(card);
    }
  }
  syncBoard();
});

manageProjectsBtn.addEventListener("click", () => {
  renderProjectsList();
  projectsModal.classList.remove("hidden");
});

projectsCloseBtn.addEventListener("click", () => {
  projectsModal.classList.add("hidden");
  projectNameInput.value = "";
  projectPathInput.value = "";
  projectAddError.classList.add("hidden");
  projectAddError.textContent = "";
});

function renderProjectsList() {
  projectsList.innerHTML = "";
  for (const p of projects) {
    const div = document.createElement("div");
    div.className = "project-item";
    div.innerHTML = `
      <div>
        <div class="project-item-name">${escapeHtml(p.name)}</div>
        <div class="project-item-path">${escapeHtml(p.path)}</div>
      </div>
      ${p.id !== 'default' ? `<button class="project-item-delete" data-id="${p.id}">Delete</button>` : ''}
    `;
    const delBtn = div.querySelector('.project-item-delete');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        try {
          const res = await fetch(`/api/projects/${p.id}`, { method: "DELETE", credentials: "include" });
          const data = await res.json();
          if (!res.ok) {
            alert(data.error || "Failed to delete project");
            return;
          }
          await fetchProjects();
          renderProjectsList();
        } catch (e) {
          alert(String(e));
        }
      });
    }
    projectsList.appendChild(div);
  }
}

projectAddBtn.addEventListener("click", async () => {
  const name = projectNameInput.value.trim();
  const path = projectPathInput.value.trim();
  if (!name || !path) {
    projectAddError.textContent = "Name and path are required";
    projectAddError.classList.remove("hidden");
    return;
  }
  projectAddError.classList.add("hidden");
  projectAddBtn.disabled = true;
  try {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ name, path }),
    });
    const data = await res.json();
    if (!res.ok) {
      projectAddError.textContent = data.error || "Failed to add project";
      projectAddError.classList.remove("hidden");
      projectAddBtn.disabled = false;
      return;
    }
    projectNameInput.value = "";
    projectPathInput.value = "";
    await fetchProjects();
    renderProjectsList();
  } catch (e) {
    projectAddError.textContent = String(e);
    projectAddError.classList.remove("hidden");
  } finally {
    projectAddBtn.disabled = false;
  }
});

socket.on("projects_updated", (updatedProjects) => {
  projects = updatedProjects;
  populateProjectSelect();
  if (!projects.find(p => p.id === activeProjectId)) {
    activeProjectId = projects[0]?.id || null;
    if (activeProjectId) projectSelect.value = activeProjectId;
    syncBoard();
  }
});

// ─── Render ─────────────────────────────────────────
function renderCard(card) {
  const el = document.createElement("div");
  el.className = "card";
  el.id = card.id;
  el.draggable = true;
  el.dataset.stage = card.stage;

  const stageLabel = card.stage.replace("_", " ");
  const project = projects.find(p => p.id === card.projectId);
  const projectTag = project ? `<div class="card-project">${escapeHtml(project.name)}</div>` : '';

  const btnLabel = card.stage === 'in_review' ? '✅ Merge' : '✅ Done';
  const showBtn = card.stage !== 'done' && card.stage !== 'conflict';

  el.innerHTML = `
    ${projectTag}
    <div class="card-title">${card.chatOnly ? '💬 ' : '🔧 '}${escapeHtml(card.title)}</div>
    <div class="card-desc">${escapeHtml(card.description)}</div>
    <span class="card-stage ${card.stage}">${stageLabel}</span>
    <div class="card-indicator" id="indicator-${card.id}">
      ${card.turnActive ? '<div class="spinner"></div><span>Running…</span>' : ""}
    </div>
    ${showBtn ? `<div class="card-actions"><button class="btn-done" data-action="done">${btnLabel}</button></div>` : ''}
  `;

  el.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", card.id);
    el.classList.add("dragging");
  });

  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
  });

  el.addEventListener("click", () => openDrawer(card.id));

  const doneBtn = el.querySelector('.btn-done');
  if (doneBtn) {
    doneBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      socket.emit('move_card', { cardId: card.id, stage: 'done' });
    });
  }

  return el;
}

function updateCardDom(card) {
  let el = document.getElementById(card.id);
  const project = projects.find(p => p.id === card.projectId);

  if (!el) {
    if (card.projectId !== activeProjectId) return;
    el = renderCard(card);
    const zone = document.getElementById("col-" + card.stage);
    if (zone) zone.appendChild(el);
    return;
  }

  // If card moved to a different project, remove it
  if (card.projectId !== activeProjectId) {
    el.remove();
    return;
  }

  const oldParent = el.parentElement;
  const newParent = document.getElementById("col-" + card.stage);
  if (newParent && oldParent !== newParent) {
    newParent.appendChild(el);
  }

  el.dataset.stage = card.stage;
  const badge = el.querySelector(".card-stage");
  badge.className = `card-stage ${card.stage}`;
  badge.textContent = card.stage.replace("_", " ");

  // Update project tag
  let projectTag = el.querySelector('.card-project');
  const newProjectTagHtml = project ? `<div class="card-project">${escapeHtml(project.name)}</div>` : '';
  if (newProjectTagHtml) {
    if (!projectTag) {
      projectTag = document.createElement('div');
      projectTag.className = 'card-project';
      el.insertBefore(projectTag, el.firstChild);
    }
    projectTag.textContent = project.name;
  } else if (projectTag) {
    projectTag.remove();
  }

  const indicator = document.getElementById(`indicator-${card.id}`);
  if (indicator) {
    if (card.turnActive) {
      indicator.innerHTML = '<div class="spinner"></div><span>Running…</span>';
    } else {
      indicator.innerHTML = "";
    }
  }

  // Update or remove the action button based on stage
  let actionsDiv = el.querySelector('.card-actions');
  const showBtn = card.stage !== 'done' && card.stage !== 'conflict';
  if (!showBtn && actionsDiv) {
    actionsDiv.remove();
  } else if (showBtn) {
    const btnLabel = card.stage === 'in_review' ? '✅ Merge' : '✅ Done';
    if (!actionsDiv) {
      actionsDiv = document.createElement('div');
      actionsDiv.className = 'card-actions';
      actionsDiv.innerHTML = `<button class="btn-done" data-action="done">${btnLabel}</button>`;
      el.appendChild(actionsDiv);
      actionsDiv.querySelector('.btn-done').addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('move_card', { cardId: card.id, stage: 'done' });
      });
    } else {
      const btn = actionsDiv.querySelector('.btn-done');
      if (btn && btn.textContent !== btnLabel) {
        btn.textContent = btnLabel;
      }
    }
  }
}

function removeCardDom(cardId) {
  const el = document.getElementById(cardId);
  if (el) el.remove();
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ─── Drag & Drop ───────────────────────────────────
document.querySelectorAll(".dropzone").forEach((zone) => {
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("dragover");
  });

  zone.addEventListener("dragleave", () => {
    zone.classList.remove("dragover");
  });

  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    const cardId = e.dataTransfer.getData("text/plain");
    const stage = zone.id.replace("col-", "");
    if (BLOCKED_STAGES.includes(stage)) {
      console.warn(`Cannot drop card into agent-only stage: ${stage}`);
      return;
    }
    socket.emit("move_card", { cardId, stage });
  });
});

// ─── Socket Events ─────────────────────────────────
socket.on("board_state", (boardCards) => {
  boardCards.forEach((c) => {
    const existing = cards.get(c.id);
    cards.set(c.id, c);
    if (!existing) {
      if (c.projectId === activeProjectId) placeCard(c);
    } else if (existing.stage !== c.stage || existing.projectId !== c.projectId) {
      removeCardDom(c.id);
      if (c.projectId === activeProjectId) placeCard(c);
    } else {
      updateCardDom(c);
    }
  });
});

socket.on("card_update", (card) => {
  const existing = cards.get(card.id);
  cards.set(card.id, card);
  if (!existing) {
    if (card.projectId === activeProjectId) placeCard(card);
  } else if (existing.stage !== card.stage || existing.projectId !== card.projectId) {
    removeCardDom(card.id);
    if (card.projectId === activeProjectId) placeCard(card);
  } else {
    updateCardDom(card);
  }
  if (activeCardId === card.id) {
    const project = projects.find(p => p.id === card.projectId);
    let meta = `${card.stage.replace("_", " ").toUpperCase()}`;
    if (project) meta += ` · 📁 ${project.name}`;
    if (card.chatOnly) meta += " · 💬 Chat only";
    if (card.branchName) meta += ` · 🌿 ${card.branchName}`;
    if (card.commits?.length) {
      const last = card.commits[card.commits.length - 1];
      meta += ` · ✅ ${last.hash.slice(0, 7)} "${last.message}"`;
    }
    if (card.mergeError) meta += `\n❌ Merge error: ${card.mergeError}`;
    meta += `\n—\n${card.description}`;
    drawerMeta.textContent = meta;
    updateInterruptButton();
  }
});

socket.on("card_deleted", ({ cardId }) => {
  cards.delete(cardId);
  removeCardDom(cardId);
  if (activeCardId === cardId) closeDrawer();
});

socket.on("card_event", (event) => {
  const card = cards.get(event.cardId);
  if (!card) return;

  if (activeCardId === event.cardId) {
    drawerHistory.total++;
    drawerHistory.offset++;
    const shouldScroll = isNearBottom();
    appendToDrawer(event);
    if (shouldScroll) scrollToBottom();
    updateJumpButton();
  }
});

function placeCard(card) {
  if (document.getElementById(card.id)) return;
  const zone = document.getElementById("col-" + card.stage);
  if (!zone) return;
  zone.appendChild(renderCard(card));
}

// ─── Modal ──────────────────────────────────────────
const modal = document.getElementById("modal");
const newBtn = document.getElementById("new-card-btn");
const cancelBtn = document.getElementById("cancel-btn");
const createBtn = document.getElementById("create-btn");
const titleInput = document.getElementById("card-title");
const descInput = document.getElementById("card-desc");

newBtn.addEventListener("click", () => {
  const project = getActiveProject();
  if (project) {
    modalProjectName.textContent = `Project: ${project.name}`;
  } else {
    modalProjectName.textContent = "";
  }
  modal.classList.remove("hidden");
  titleInput.focus();
});

cancelBtn.addEventListener("click", () => {
  modal.classList.add("hidden");
  titleInput.value = "";
  descInput.value = "";
});

createBtn.addEventListener("click", () => {
  const title = titleInput.value.trim();
  const description = descInput.value.trim();
  const chatOnly = document.getElementById("card-chat-only")?.checked || false;
  const projectId = activeProjectId;

  if (!title) return;
  if (!projectId) return;

  createBtn.disabled = true;

  socket.emit("create_card", { title, description, chatOnly, projectId }, (card) => {
    modal.classList.add("hidden");
    titleInput.value = "";
    descInput.value = "";
    document.getElementById("card-chat-only").checked = false;
    createBtn.disabled = false;
  });
});

// ─── Drawer ─────────────────────────────────────────
const drawer = document.getElementById("drawer");
const drawerClose = document.getElementById("drawer-close");
const drawerTitle = document.getElementById("drawer-title");
const drawerMeta = document.getElementById("drawer-meta");
const drawerStream = document.getElementById("drawer-stream");
const drawerDiff = document.getElementById("drawer-diff");
const drawerDiffBtn = document.getElementById("drawer-diff-btn");
const drawerInput = document.getElementById("drawer-input");
const drawerSend = document.getElementById("drawer-send");
const drawerInterrupt = document.getElementById("drawer-interrupt");

let currentTextBlock = null;
let currentThinkingBlock = null;

function updateInterruptButton() {
  const card = activeCardId ? cards.get(activeCardId) : null;
  if (card?.turnActive) {
    drawerInterrupt.classList.remove("hidden");
  } else {
    drawerInterrupt.classList.add("hidden");
  }
}

function openDrawer(cardId) {
  activeCardId = cardId;
  flushBlocks();
  drawerHistory = { offset: 0, total: 0, hasMore: false, loading: false };
  const card = cards.get(cardId);
  if (!card) return;
  const project = projects.find(p => p.id === card.projectId);

  drawerTitle.textContent = card.title;
  let meta = `${card.stage.replace("_", " ").toUpperCase()}`;
  if (project) meta += ` · 📁 ${project.name}`;
  if (card.chatOnly) meta += " · 💬 Chat only";
  if (card.branchName) meta += ` · 🌿 ${card.branchName}`;
  if (card.commits?.length) {
    const last = card.commits[card.commits.length - 1];
    meta += ` · ✅ ${last.hash.slice(0, 7)} "${last.message}"`;
  }
  if (card.mergeError) meta += `\n❌ Merge error: ${card.mergeError}`;
  meta += `\n—\n${card.description}`;
  drawerMeta.textContent = meta;
  drawerStream.innerHTML = "";
  drawerDiff.innerHTML = "";
  drawerDiff.classList.add("hidden");
  drawerStream.classList.remove("hidden");
  if (drawerDiffBtn) drawerDiffBtn.textContent = "View diff";
  drawer.classList.remove("hidden");
  updateInterruptButton();

  socket.emit("view_card", { cardId, offset: 0, limit: 50 });
}

function closeDrawer() {
  activeCardId = null;
  flushBlocks();
  drawer.classList.add("hidden");
  showStream();
}

function showStream() {
  drawerDiff.classList.add("hidden");
  drawerStream.classList.remove("hidden");
  if (drawerDiffBtn) drawerDiffBtn.textContent = "View diff";
}

function showDiff() {
  drawerStream.classList.add("hidden");
  drawerDiff.classList.remove("hidden");
  if (drawerDiffBtn) drawerDiffBtn.textContent = "Back to chat";
}

async function loadAndRenderDiff(cardId) {
  if (!cardId) return;
  drawerDiff.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span> Loading diff…';
  showDiff();
  try {
    const res = await fetch(`/api/cards/${cardId}/diff`, { credentials: "include" });
    const data = await res.json();
    if (!res.ok) {
      drawerDiff.innerHTML = `<div class="diff-empty">⚠️ ${escapeHtml(data.error || "Could not load diff")}</div>`;
      return;
    }
    renderDiff(data.diff);
  } catch (e) {
    drawerDiff.innerHTML = `<div class="diff-empty">❌ ${escapeHtml(String(e))}</div>`;
  }
}

function renderDiff(raw) {
  const lines = raw.split("\n");
  const container = document.createElement("div");
  for (const line of lines) {
    const p = document.createElement("div");
    p.className = "diff-line";
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      p.classList.add("header");
    } else if (line.startsWith("@@")) {
      p.classList.add("info");
    } else if (line.startsWith("+")) {
      p.classList.add("add");
    } else if (line.startsWith("-")) {
      p.classList.add("del");
    }
    p.textContent = line;
    container.appendChild(p);
  }
  drawerDiff.innerHTML = "";
  if (lines.length === 0 || (lines.length === 1 && lines[0].trim() === "")) {
    drawerDiff.innerHTML = `<div class="diff-empty">No changes yet.</div>`;
  } else {
    drawerDiff.appendChild(container);
  }
}

drawerClose.addEventListener("click", closeDrawer);

document.addEventListener("click", (e) => {
  if (drawer.classList.contains("hidden")) return;
  const isInsideDrawer = drawer.contains(e.target);
  const isCard = e.target.closest(".card");
  if (!isInsideDrawer && !isCard) {
    closeDrawer();
  }
});

function scrollToBottom() {
  drawerStream.scrollTop = drawerStream.scrollHeight - drawerStream.clientHeight;
}

const SCROLL_THRESHOLD = 50;
const SCROLL_TOP_THRESHOLD = 80;

function isNearBottom() {
  return drawerStream.scrollHeight - drawerStream.scrollTop - drawerStream.clientHeight < SCROLL_THRESHOLD;
}

function checkAutoLoad() {
  if (!activeCardId || !drawerHistory.hasMore || drawerHistory.loading) return;
  if (drawerStream.scrollTop < SCROLL_TOP_THRESHOLD) {
    drawerHistory.loading = true;
    loaderEl?.classList.remove("hidden");
    socket.emit("view_card", { cardId: activeCardId, offset: drawerHistory.offset, limit: 50 });
  }
}

function checkFill() {
  if (!activeCardId || !drawerHistory.hasMore || drawerHistory.loading) return;
  if (drawerStream.scrollHeight <= drawerStream.clientHeight + 2) {
    drawerHistory.loading = true;
    loaderEl?.classList.remove("hidden");
    socket.emit("view_card", { cardId: activeCardId, offset: drawerHistory.offset, limit: 50 });
  }
}

function updateJumpButton() {
  const btn = document.getElementById("jump-to-latest");
  if (!btn) return;
  if (isNearBottom()) {
    btn.classList.add("hidden");
  } else {
    btn.classList.remove("hidden");
  }
}

function onDrawerScroll() {
  updateJumpButton();
  if (programmaticScroll) return;
  checkAutoLoad();
}

function flushBlocks() {
  currentTextBlock = null;
  currentThinkingBlock = null;
}

// ── Core renderer ─────────────────────────────────────
function appendToDrawer(event, container = drawerStream) {
  switch (event.type) {
    case "text_delta": {
      currentThinkingBlock = null;
      if (!currentTextBlock) {
        currentTextBlock = document.createElement("p");
        container.appendChild(currentTextBlock);
      }
      currentTextBlock.textContent += event.text || "";
      break;
    }

    case "thinking_delta": {
      currentTextBlock = null;
      if (!currentThinkingBlock) {
        currentThinkingBlock = document.createElement("div");
        currentThinkingBlock.className = "thinking";
        container.appendChild(currentThinkingBlock);
      }
      currentThinkingBlock.textContent = (currentThinkingBlock.textContent || "💭 ") + (event.thinking || "");
      break;
    }

    case "tool_call": {
      flushBlocks();
      const el = document.createElement("div");
      el.className = "tool-call";
      el.textContent = `⚡ ${event.toolName}: ${JSON.stringify(event.input, null, 2).slice(0, 200)}`;
      container.appendChild(el);
      break;
    }

    case "tool_result": {
      flushBlocks();
      const el = document.createElement("div");
      el.className = "tool-result";
      el.textContent = `✓ ${event.toolName} done`;
      container.appendChild(el);
      break;
    }

    case "message_complete": {
      flushBlocks();
      const count = event.text?.length || 0;
      const el = document.createElement("div");
      el.className = "message-complete";
      el.innerHTML = `<span>✓ turn complete (${count} chars)</span>`;
      container.appendChild(el);
      break;
    }

    case "error": {
      flushBlocks();
      const el = document.createElement("div");
      el.className = "error";
      el.textContent = `❌ ${event.error}`;
      container.appendChild(el);
      break;
    }

    case "stage_change": {
      flushBlocks();
      const el = document.createElement("div");
      el.className = "stage-change";
      el.textContent = `→ ${(event.stage || "").replace("_", " ").toUpperCase()}`;
      container.appendChild(el);
      break;
    }

    case "commit": {
      flushBlocks();
      const el = document.createElement("div");
      el.className = "commit";
      const c = event.commit;
      el.textContent = `✅ Committed ${c.hash.slice(0, 7)}: ${c.message}`;
      container.appendChild(el);
      break;
    }

    case "status": {
      flushBlocks();
      const el = document.createElement("div");
      el.className = "system-status";
      el.textContent = `ℹ️ ${event.text}`;
      container.appendChild(el);
      break;
    }

    default: {
      flushBlocks();
      const el = document.createElement("div");
      el.textContent = JSON.stringify(event);
      container.appendChild(el);
    }
  }
}

function renderHistory(events, container = drawerStream) {
  flushBlocks();
  for (const ev of events) {
    appendToDrawer(ev, container);
  }
  flushBlocks();
}

// ── Socket: history response ──────────────────────────
socket.on("card_history", ({ cardId, events, total, hasMore, offset }) => {
  if (activeCardId !== cardId) return;

  drawerHistory.total = total;
  drawerHistory.hasMore = hasMore;

  if (offset === 0) {
    drawerStream.innerHTML = "";
    flushBlocks();
    renderHistory(events);
    scrollToBottom();
    requestAnimationFrame(() => {
      scrollToBottom();
      setTimeout(() => {
        scrollToBottom();
        updateJumpButton();
        drawerHistory.loading = false;
        loaderEl?.classList.add("hidden");
        checkFill();
      }, 0);
    });
  } else {
    const prevScrollTop = drawerStream.scrollTop;
    const prevHeight = drawerStream.scrollHeight;
    const temp = document.createElement("div");
    renderHistory(events, temp);
    drawerStream.insertBefore(temp, drawerStream.firstChild);

    programmaticScroll = true;
    if (prevScrollTop < SCROLL_TOP_THRESHOLD) {
      drawerStream.scrollTop = 0;
    } else {
      drawerStream.scrollTop = prevScrollTop + (drawerStream.scrollHeight - prevHeight);
    }

    drawerHistory.loading = false;
    setTimeout(() => {
      programmaticScroll = false;
      loaderEl?.classList.add("hidden");
      checkFill();
    }, 0);
  }

  drawerHistory.offset = offset + events.length;
});

// ── Periodic sync ────────────────────────────────────
async function syncBoard() {
  try {
    const url = activeProjectId ? `/api/cards?projectId=${activeProjectId}` : '/api/cards';
    const res = await fetch(url, { credentials: "include" });
    const serverCards = await res.json();
    serverCards.forEach((c) => {
      const existing = cards.get(c.id);
      if (!existing) {
        cards.set(c.id, c);
        if (c.projectId === activeProjectId) placeCard(c);
      } else if (existing.stage !== c.stage || existing.projectId !== c.projectId) {
        cards.set(c.id, c);
        removeCardDom(c.id);
        if (c.projectId === activeProjectId) placeCard(c);
      } else {
        cards.set(c.id, c);
        updateCardDom(c);
      }
    });
    // Remove any cards the server no longer knows about or that moved to another project
    for (const id of cards.keys()) {
      const serverCard = serverCards.find((c) => c.id === id);
      if (!serverCard) {
        cards.delete(id);
        removeCardDom(id);
      } else if (serverCard.projectId !== activeProjectId) {
        removeCardDom(id);
      }
    }
    if (activeCardId) {
      updateInterruptButton();
    }
  } catch (_e) {
    // ignore network errors
  }
}

// First sync after projects load
fetchProjects();
setInterval(syncBoard, 3000);

// ── Interrupt agent ──────────────────────────────────
drawerInterrupt.addEventListener("click", () => {
  if (!activeCardId) return;
  socket.emit("interrupt_card", activeCardId);

  const shouldScroll = isNearBottom();
  flushBlocks();
  const el = document.createElement("div");
  el.className = "system-status";
  el.textContent = "⏹ Interrupted by user";
  drawerStream.appendChild(el);
  if (shouldScroll) scrollToBottom();
  updateJumpButton();
});

// ── View diff ────────────────────────────────────────
if (drawerDiffBtn) {
  drawerDiffBtn.addEventListener("click", () => {
    if (!activeCardId) return;
    const isDiffVisible = !drawerDiff.classList.contains("hidden");
    if (isDiffVisible) {
      showStream();
    } else {
      loadAndRenderDiff(activeCardId);
    }
  });
}

// ── Sending messages ──────────────────────────────────
drawerSend.addEventListener("click", () => {
  if (!activeCardId) return;
  const msg = drawerInput.value.trim();
  if (!msg) return;

  socket.emit("steer_card", { cardId: activeCardId, message: msg });
  drawerInput.value = "";

  const shouldScroll = isNearBottom();
  flushBlocks();
  const el = document.createElement("div");
  el.className = "user-message";
  el.textContent = `👤 ${msg}`;
  drawerStream.appendChild(el);
  if (shouldScroll) scrollToBottom();
  updateJumpButton();
});

drawerInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") drawerSend.click();
});

drawerStream.addEventListener("scroll", onDrawerScroll);

document.getElementById("jump-to-latest")?.addEventListener("click", () => {
  scrollToBottom();
  updateJumpButton();
});
