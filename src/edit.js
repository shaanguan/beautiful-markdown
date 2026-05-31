/**
 * Full-tab markdown text editor (edit.html). Staged by the service worker;
 * Save (only when dirty) pushes changes back to the originating reading tab.
 */

(function () {
  "use strict";

  document.documentElement.classList.add("bsw-edit-root");

  function applyPageTheme(mode) {
    const body = document.body;
    if (!body) return;
    body.classList.remove("theme-light", "theme-dark");
    let resolved = mode === "dark" ? "dark" : mode === "light" ? "light" : "";
    if (!resolved) {
      resolved = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    body.classList.add(resolved === "dark" ? "theme-dark" : "theme-light");
  }

  applyPageTheme("auto");

  const params = new URLSearchParams(location.search);
  const sessionId = params.get("session") || "";
  const heading = document.getElementById("bsw-edit-heading");
  const input = document.getElementById("bsw-edit-input");
  const undoBtn = document.getElementById("bsw-edit-undo");
  const redoBtn = document.getElementById("bsw-edit-redo");
  const saveBtn = document.getElementById("bsw-edit-save");
  const mirror = document.getElementById("bsw-edit-scroll-mirror");
  const editScroller = document.querySelector(".bsw-edit-scroll");

  const HISTORY_MAX = 50;
  let baselineText = "";
  let sessionReady = false;
  let applyingHistory = false;
  let beforeInputSnapshot = null;
  const undoStack = [];
  const redoStack = [];
  let pendingScrollRatio = 0;
  let pendingScrollOffset = 0;
  let pendingScrollOffsetMatched = false;

  let toastTimer = null;

  function showToast(message) {
    let toast = document.getElementById("baseline-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "baseline-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    const anchor = saveBtn || heading;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      toast.style.left = Math.round(r.left + r.width / 2) + "px";
      const flipBelow = r.top < 60;
      toast.classList.toggle("is-below", flipBelow);
      toast.style.top = Math.round(flipBelow ? r.bottom + 4 : r.top - 4) + "px";
    }
    toast.classList.add("is-visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 1400);
  }

  function isDirty() {
    if (!input || input.disabled) return false;
    return input.value !== baselineText;
  }

  function syncSaveState() {
    if (!saveBtn || !sessionReady) return;
    saveBtn.classList.toggle("is-dirty", isDirty());
  }

  function editSnapshot() {
    if (!input) return { text: "", start: 0, end: 0 };
    return {
      text: input.value,
      start: input.selectionStart,
      end: input.selectionEnd
    };
  }

  function snapshotsEqual(a, b) {
    return a.text === b.text && a.start === b.start && a.end === b.end;
  }

  function syncHistoryButtons() {
    if (undoBtn) undoBtn.disabled = !sessionReady || undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = !sessionReady || redoStack.length === 0;
  }

  function resetHistory() {
    undoStack.length = 0;
    redoStack.length = 0;
    beforeInputSnapshot = null;
    syncHistoryButtons();
  }

  function trimHistory(stack) {
    while (stack.length > HISTORY_MAX) stack.shift();
  }

  function recordHistoryStep(prior) {
    if (!sessionReady || applyingHistory || !prior) return;
    const top = undoStack[undoStack.length - 1];
    if (top && snapshotsEqual(top, prior)) return;
    undoStack.push(prior);
    trimHistory(undoStack);
    redoStack.length = 0;
    syncHistoryButtons();
  }

  function applyHistoryState(state) {
    if (!input || !state) return;
    applyingHistory = true;
    input.value = state.text;
    const end = state.text.length;
    const start = Math.max(0, Math.min(state.start, end));
    const selEnd = Math.max(start, Math.min(state.end, end));
    try {
      input.setSelectionRange(start, selEnd);
    } catch (_) { /* ignore */ }
    applyingHistory = false;
    autoGrowTextarea();
    syncSaveState();
  }

  function undo() {
    if (!sessionReady || undoStack.length === 0) return;
    const current = editSnapshot();
    const prior = undoStack.pop();
    redoStack.push(current);
    trimHistory(redoStack);
    applyHistoryState(prior);
    syncHistoryButtons();
  }

  function redo() {
    if (!sessionReady || redoStack.length === 0) return;
    const current = editSnapshot();
    const next = redoStack.pop();
    undoStack.push(current);
    trimHistory(undoStack);
    applyHistoryState(next);
    syncHistoryButtons();
  }

  function syncMirrorStyle() {
    if (!mirror || !input) return;
    const s = getComputedStyle(input);
    mirror.style.width = input.clientWidth + "px";
    mirror.style.font = s.font;
    mirror.style.lineHeight = s.lineHeight;
    mirror.style.letterSpacing = s.letterSpacing;
    mirror.style.padding = s.padding;
    mirror.style.tabSize = s.tabSize || "2";
  }

  function autoGrowTextarea() {
    if (!input) return;
    input.style.height = "auto";
    const next = Math.max(input.scrollHeight, input.clientHeight);
    input.style.height = next + "px";
  }

  function measureOffsetTop(offset) {
    if (!mirror || !input) return 0;
    syncMirrorStyle();
    const safe = Math.max(0, Math.min(offset, input.value.length));
    mirror.textContent = input.value.slice(0, safe);
    return mirror.scrollHeight;
  }

  function getScrollContainer() {
    return editScroller || document.documentElement;
  }

  function maxPageScroll() {
    const el = getScrollContainer();
    return Math.max(0, el.scrollHeight - el.clientHeight);
  }

  function setPageScrollTop(top) {
    const el = getScrollContainer();
    el.scrollTop = Math.max(0, top);
  }

  function scrollPageToRatio(ratio) {
    autoGrowTextarea();
    const max = maxPageScroll();
    if (max <= 0) return;
    setPageScrollTop(ratio * max);
  }

  function scrollPageToOffset(offset) {
    if (!input || !editScroller) return;
    autoGrowTextarea();
    const inset = editScroller.clientHeight * 0.12;
    const pageRect = editScroller.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const top =
      editScroller.scrollTop +
      (inputRect.top - pageRect.top) +
      measureOffsetTop(offset) -
      inset;
    setPageScrollTop(top);
    const safe = Math.max(0, Math.min(offset, input.value.length));
    try { input.setSelectionRange(safe, safe); } catch (_) {}
  }

  function restoreReadingScroll() {
    if (!input) return;
    const apply = () => {
      syncMirrorStyle();
      autoGrowTextarea();
      if (pendingScrollOffsetMatched && pendingScrollOffset > 0) {
        scrollPageToOffset(pendingScrollOffset);
      } else if (pendingScrollRatio > 0) {
        scrollPageToRatio(pendingScrollRatio);
      }
    };
    apply();
    requestAnimationFrame(apply);
    requestAnimationFrame(() => requestAnimationFrame(apply));
  }

  function showError(message) {
    sessionReady = false;
    if (heading) heading.textContent = message;
    if (input) {
      input.value = "";
      input.disabled = true;
    }
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.classList.remove("is-dirty");
    }
    resetHistory();
  }

  if (!sessionId) {
    showError("无效的编辑会话");
  } else {
    chrome.runtime.sendMessage(
      { type: "getEditSession", sessionId },
      (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          showError("编辑会话已过期，请关闭后重试");
          return;
        }
        const name = resp.name ? String(resp.name) : "";
        if (heading) heading.textContent = name || "未命名文档";
        document.title = name
          ? "编辑 · " + name + " — Beautiful Markdown"
          : "编辑 Markdown — Beautiful Markdown";
        pendingScrollRatio = Number(resp.scrollRatio) || 0;
        pendingScrollOffset = Number(resp.scrollOffset) || 0;
        pendingScrollOffsetMatched = Boolean(resp.scrollOffsetMatched);
        if (input) {
          baselineText = resp.markdown == null ? "" : String(resp.markdown);
          input.value = baselineText;
          restoreReadingScroll();
          try { input.focus({ preventScroll: true }); }
          catch (_) { input.focus(); }
        }
        sessionReady = true;
        resetHistory();
        syncSaveState();
      }
    );
  }

  if (input) {
    input.addEventListener("beforeinput", () => {
      if (!sessionReady || applyingHistory || input.disabled) return;
      beforeInputSnapshot = editSnapshot();
    });
    input.addEventListener("input", () => {
      if (beforeInputSnapshot) {
        recordHistoryStep(beforeInputSnapshot);
        beforeInputSnapshot = null;
      }
      autoGrowTextarea();
      syncSaveState();
    });
  }

  if (undoBtn) undoBtn.addEventListener("click", undo);
  if (redoBtn) redoBtn.addEventListener("click", redo);

  window.addEventListener("resize", () => {
    syncMirrorStyle();
    autoGrowTextarea();
  });

  function save() {
    if (!sessionId || !input || input.disabled) return;
    saveBtn.disabled = true;
    chrome.runtime.sendMessage(
      {
        type: "applyEdit",
        sessionId,
        text: input.value
      },
      (resp) => {
        if (saveBtn) saveBtn.disabled = false;
        if (chrome.runtime.lastError) {
          console.warn("[Baseline] applyEdit failed:", chrome.runtime.lastError);
          syncSaveState();
          return;
        }
        if (!resp || !resp.ok) {
          console.warn("[Baseline] applyEdit rejected:", resp && resp.error);
          showToast((resp && resp.error) || "保存失败");
          syncSaveState();
          return;
        }
        baselineText = input.value;
        syncSaveState();
        showToast("已保存");
      }
    );
  }

  if (saveBtn) {
    saveBtn.addEventListener("click", save);
  }

  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    if ((key === "z" && e.shiftKey) || key === "y") {
      e.preventDefault();
      redo();
      return;
    }
    if (key === "enter") {
      e.preventDefault();
      save();
    }
  });
})();
