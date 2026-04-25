const socket = io();
const cards = new Map();
let activeCardId = null;
let programmaticScroll = false;
let drawerHistory = { offset: 0, total: 0, hasMore: false, loading: false };
const loaderEl = document.getElementById("drawer-loader");

// ─── Render ─────────────────────────────────────────
function renderCard(card) {
  const el = document.createElement("div");
  el.className = "card";
  el.id = card.id;
  el.draggable = true;
  el.dataset.stage = card.stage;

  const stageLabel = card.stage.replace("_", " ");
  const kindBadge = card.kind === "chat" ? "💬" : "🔨";

  el.innerHTML = `
    <div class="card-title">${kindBadge} ${escapeHtml(card.title)}</div>
    <div class="card-desc">${escapeHtml(card.description)}</div>
    <span class="card-stage ${card.stage}">${stageLabel}</span>
    <div class="card-indicator" id="indicator-${card.id}">
      ${card.turnActive ? '<div class="spinner"></div><span>Running…</span>' : ["planning","in_progress","in_review"].includes(card.stage) ? '<div style="width:8px;height:8px;border-radius:50%;background:#94a3b8;margin-right:6px;display:inline-block;"></div><span>Waiting…</span>' : ""}
    </div>
  `;

  el.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", card.id);
    el.classList.add("dragging");
  });

  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
  });

  el.addEventListener("click", () => openDrawer(card.id));

  return el;
}

function updateCardDom(card) {
  let el = document.getElementById(card.id);
  if (!el) {
    el = renderCard(card);
    const zone = document.getElementById("col-" + card.stage);
    if (zone) zone.appendChild(el);
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

  const indicator = document.getElementById(`indicator-${card.id}`);
  if (indicator) {
    if (card.turnActive) {
      indicator.innerHTML = '<div class="spinner"></div><span>Running…</span>';
    } else if (["planning", "in_progress", "in_review"].includes(card.stage)) {
      indicator.innerHTML = '<div style="width:8px;height:8px;border-radius:50%;background:#94a3b8;margin-right:6px;display:inline-block;"></div><span>Waiting…</span>';
    } else {
      indicator.innerHTML = "";
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
    socket.emit("move_card", { cardId, stage });
  });
});

// ─── Socket Events ─────────────────────────────────
socket.on("board_state", (boardCards) => {
  boardCards.forEach((c) => {
    const existing = cards.get(c.id);
    cards.set(c.id, c);
    if (!existing) {
      placeCard(c);
    } else if (existing.stage !== c.stage) {
      removeCardDom(c.id);
      placeCard(c);
    } else {
      updateCardDom(c);
    }
  });
});

socket.on("card_update", (card) => {
  const existing = cards.get(card.id);
  cards.set(card.id, card);
  if (!existing) {
    placeCard(card);
  } else if (existing.stage !== card.stage) {
    removeCardDom(card.id);
    placeCard(card);
  } else {
    updateCardDom(card);
  }
  // If this card is open, refresh its meta line
  if (activeCardId === card.id) {
    drawerMeta.textContent = `${card.stage.replace("_", " ").toUpperCase()}\n—\n${card.description}`;
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
  if (!title) return;

  // Disable to prevent double-clicks
  createBtn.disabled = true;

  socket.emit("create_card", { title, description }, (card) => {
    // DO NOT add the card here — card_update from the server is the
    // single source of truth for DOM insertion. Close the modal and
    // let the broadcast handler place the card.
    modal.classList.add("hidden");
    titleInput.value = "";
    descInput.value = "";
    createBtn.disabled = false;
  });
});

// ─── Drawer ─────────────────────────────────────────
const drawer = document.getElementById("drawer");
const drawerClose = document.getElementById("drawer-close");
const drawerTitle = document.getElementById("drawer-title");
const drawerMeta = document.getElementById("drawer-meta");
const drawerStream = document.getElementById("drawer-stream");
const drawerInput = document.getElementById("drawer-input");
const drawerSend = document.getElementById("drawer-send");
const drawerInterrupt = document.getElementById("drawer-interrupt");

let currentTextBlock = null;
let currentThinkingBlock = null;

function openDrawer(cardId) {
  activeCardId = cardId;
  flushBlocks();
  drawerHistory = { offset: 0, total: 0, hasMore: false, loading: false };
  const card = cards.get(cardId);
  if (!card) return;

  drawerTitle.textContent = card.title;
  drawerMeta.textContent = `${card.stage.replace("_", " ").toUpperCase()}\n—\n${card.description}`;
  drawerStream.innerHTML = "";
  drawer.classList.remove("hidden");

  socket.emit("view_card", { cardId, offset: 0, limit: 50 });
}

function closeDrawer() {
  activeCardId = null;
  flushBlocks();
  drawer.classList.add("hidden");
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
  // If the stream content doesn't overflow, the user can't scroll up.
  // Load the next older chunk automatically until content overflows
  // or we run out of history.
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

// Combine scroll handlers
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
      currentThinkingBlock = null; // close thinking block if open
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
    // Try to scroll immediately; then again after the browser has
    // painted, so scrollHeight accounts for the newly rendered nodes.
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
    // If user was near the top, keep them at top so the newly loaded
    // older history is visible. Otherwise preserve the reading position.
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

// ── Periodic sync — orchestrator is source of truth ────
async function syncBoard() {
  try {
    const res = await fetch("/api/cards");
    const serverCards = await res.json();
    serverCards.forEach((c) => {
      const existing = cards.get(c.id);
      if (!existing) {
        cards.set(c.id, c);
        placeCard(c);
      } else if (existing.stage !== c.stage) {
        cards.set(c.id, c);
        removeCardDom(c.id);
        placeCard(c);
      } else {
        cards.set(c.id, c);
        updateCardDom(c);
      }
    });
    // Remove any cards the server no longer knows about
    for (const id of cards.keys()) {
      if (!serverCards.find((c) => c.id === id)) {
        cards.delete(id);
        removeCardDom(id);
      }
    }
  } catch (_e) {
    // ignore network errors
  }
}

// First sync immediately, then every 3 seconds
syncBoard();
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
