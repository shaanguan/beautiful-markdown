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

  // Edit tab mirrors the reading tab's Dark/Light: any reading surface
  // writes its resolved mode to chrome.storage.local.bswEditFollowMode on
  // every applyMode() (see baseline-surface.js). We seed from that key,
  // then track live changes so toggling theme in reading mode flips here
  // immediately. Fall back to system prefs if the key isn't set yet.
  applyPageTheme("auto");
  try {
    chrome.storage.local.get({ bswEditFollowMode: null }, (items) => {
      const m = items && items.bswEditFollowMode;
      if (m === "dark" || m === "light") applyPageTheme(m);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes || !changes.bswEditFollowMode) return;
      const m = changes.bswEditFollowMode.newValue;
      if (m === "dark" || m === "light") applyPageTheme(m);
    });
  } catch (_) { /* not in extension context */ }

  const params = new URLSearchParams(location.search);
  const sessionId = params.get("session") || "";
  const heading = document.getElementById("bsw-edit-heading");
  const input = document.getElementById("bsw-edit-input");
  const undoBtn = document.getElementById("bsw-edit-undo");
  const redoBtn = document.getElementById("bsw-edit-redo");
  const saveBtn = document.getElementById("bsw-edit-save");
  const mirror = document.getElementById("bsw-edit-scroll-mirror");
  const caretOverlay = document.getElementById("bsw-edit-caret");
  const editMain = document.querySelector(".bsw-edit-main");
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
  let pendingSelectionStart = null;
  let pendingSelectionEnd = null;

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
    scheduleCaretSync();
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

  // Fat block caret with inverted glyph. The browser's caret-shape:block
  // would paint a solid block but doesn't auto-invert the character beneath
  // it, so the glyph becomes unreadable. We hide the native caret
  // (caret-color: transparent) and render our own overlay div that paints
  // both the block AND the underlying glyph in inverted color.
  //
  // Position is computed via the existing hidden mirror: we rebuild the
  // mirror with a marker <span> at the caret offset, read its bounding
  // rect, and translate into .bsw-edit-main-relative coordinates.
  function syncCaretOverlay() {
    if (!caretOverlay || !input || !mirror || !editMain) return;
    if (
      !sessionReady || input.disabled ||
      document.activeElement !== input ||
      input.selectionStart !== input.selectionEnd
    ) {
      caretOverlay.classList.remove("is-visible");
      return;
    }
    const start = input.selectionStart;
    const text = input.value;
    const ch = text[start];
    // glyph: what the overlay paints in inverted color.
    // markerText: what we insert in the mirror to measure the caret's pixel
    //   position. nbsp keeps end-of-line / end-of-text measurable without
    //   triggering an extra wrap (nbsp doesn't break).
    // afterText: rest of the mirror content (preserves line layout below).
    let glyph, markerText, afterText;
    if (start >= text.length) {
      glyph = " ";
      markerText = " ";
      afterText = "";
    } else if (ch === "\n" || ch === "\r") {
      glyph = " ";
      markerText = " ";
      // Keep the newline so subsequent lines remain on their own rows.
      afterText = text.slice(start);
    } else if (ch === "\t") {
      glyph = " ";
      markerText = " ";
      afterText = text.slice(start + 1);
    } else {
      glyph = ch;
      markerText = ch;
      afterText = text.slice(start + 1);
    }

    syncMirrorStyle();
    while (mirror.firstChild) mirror.removeChild(mirror.firstChild);
    mirror.appendChild(document.createTextNode(text.slice(0, start)));
    const marker = document.createElement("span");
    marker.textContent = markerText;
    mirror.appendChild(marker);
    if (afterText) mirror.appendChild(document.createTextNode(afterText));

    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const mainRect = editMain.getBoundingClientRect();

    // Mirror and input share padding, so the marker's offset inside the
    // mirror equals the caret's offset inside the input. Translate by the
    // input↔mirror box delta to land in input coords, then convert into
    // .bsw-edit-main-relative coords for the absolutely-positioned overlay.
    const dy = inputRect.top - mirrorRect.top;
    const dx = inputRect.left - mirrorRect.left;
    const top = markerRect.top - mainRect.top + dy;
    const left = markerRect.left - mainRect.left + dx;

    const cs = getComputedStyle(input);
    // Set font longhands explicitly. The `font` shorthand often fails to
    // serialize for getComputedStyle output, silently dropping the family
    // back to the body's sans-serif — which shifted the glyph half a
    // line below the textarea's monospace baseline last time we tried.
    caretOverlay.style.fontFamily = cs.fontFamily;
    caretOverlay.style.fontSize = cs.fontSize;
    caretOverlay.style.fontStyle = cs.fontStyle;
    caretOverlay.style.fontWeight = cs.fontWeight;
    caretOverlay.style.fontVariant = cs.fontVariant;
    caretOverlay.style.lineHeight = cs.lineHeight;
    caretOverlay.style.letterSpacing = cs.letterSpacing;
    caretOverlay.style.tabSize = cs.tabSize;

    caretOverlay.style.top = top + "px";
    caretOverlay.style.left = left + "px";
    // Minimum 0.6em width so end-of-line / end-of-text shows a visible block
    // even when the measured marker is just a nbsp.
    const minWidth = parseFloat(cs.fontSize) * 0.6;
    caretOverlay.style.width = Math.max(markerRect.width, minWidth) + "px";
    caretOverlay.style.height = markerRect.height + "px";
    caretOverlay.textContent = glyph;
    caretOverlay.classList.add("is-visible");
  }

  function scheduleCaretSync() {
    requestAnimationFrame(syncCaretOverlay);
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
    // Top inset: keep the caret in the upper third — but a flat 12% pushed
    // the surrounding context off-screen vs the reading view's anchor.
    // Add ~5 line-heights of headroom so the target line sits ~5 lines down
    // from the top of the viewport, matching how the reading mode renders
    // the same offset (more context above the cursor → less re-orientation).
    const cs = getComputedStyle(input);
    const lineHeight = parseFloat(cs.lineHeight) ||
      (parseFloat(cs.fontSize) || 16) * 1.85;
    const inset = editScroller.clientHeight * 0.12 + lineHeight * 5;
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
    const hasSelection = pendingSelectionStart != null;
    const apply = () => {
      syncMirrorStyle();
      autoGrowTextarea();
      // Caller-supplied selection (双击进编辑 / 划词进编辑) wins over
      // generic scroll restoration: the selection itself implies where
      // the user wants the viewport.
      if (hasSelection) {
        const len = input.value.length;
        const start = Math.max(0, Math.min(pendingSelectionStart, len));
        const end = Math.max(
          start,
          Math.min(pendingSelectionEnd == null ? start : pendingSelectionEnd, len)
        );
        try { input.setSelectionRange(start, end); } catch (_) {}
        scrollPageToOffset(start);
        // setSelectionRange after scrollPageToOffset re-collapses the
        // caret; re-assert the range so user sees the highlight too.
        if (end > start) {
          try { input.setSelectionRange(start, end); } catch (_) {}
        }
        return;
      }
      if (pendingScrollOffsetMatched && pendingScrollOffset > 0) {
        scrollPageToOffset(pendingScrollOffset);
      } else if (pendingScrollRatio > 0) {
        scrollPageToRatio(pendingScrollRatio);
      }
    };
    apply();
    requestAnimationFrame(apply);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      apply();
      scheduleCaretSync();
    }));
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

  // Repeat-edit dedup: when the source page fires another edit at the same
  // (tab, column), the service worker reuses this window and pushes the new
  // caret / scroll target here. If the source's markdown still matches what
  // we loaded, we keep input.value as-is so unsaved typing survives. If it
  // changed (user navigated to a different file), the worker includes the
  // fresh markdown + name and we replace the editor contents.
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== "baselineEditReposition") return;
      if (!sessionId || msg.sessionId !== sessionId) return;
      pendingScrollRatio = Number(msg.scrollRatio) || 0;
      pendingScrollOffset = Number(msg.scrollOffset) || 0;
      pendingScrollOffsetMatched = Boolean(msg.scrollOffsetMatched);
      pendingSelectionStart = Number.isFinite(msg.selectionStart)
        ? msg.selectionStart
        : null;
      pendingSelectionEnd = Number.isFinite(msg.selectionEnd)
        ? msg.selectionEnd
        : null;
      let documentChanged = Object.prototype.hasOwnProperty.call(msg, "markdown");
      if (documentChanged && isDirty()) {
        // Source page wants us to switch documents, but the user has
        // uncommitted typing here. Native confirm — if they cancel we keep
        // the editor on the old file (source page already moved on; that
        // state mismatch is acceptable, user can re-trigger edit later).
        const ok = window.confirm(
          "You have unsaved edits in this editor.\n\n" +
          "Switching to a different document will discard them. " +
          "Save first (then use the Download button on the reading tab) " +
          "if you want to keep your changes.\n\n" +
          "Click OK to discard and switch, or Cancel to keep editing."
        );
        if (!ok) documentChanged = false;
      }
      if (documentChanged) {
        const nextText = msg.markdown == null ? "" : String(msg.markdown);
        const nextName = msg.name == null ? "" : String(msg.name);
        if (heading) heading.textContent = nextName || "Untitled document";
        document.title = "";
        if (input) {
          baselineText = nextText;
          input.value = nextText;
          // Wipe the auto-grown height from the previous document so the
          // next measurement reads scrollHeight against the new content,
          // not stale layout. Also park the scroller at the top so
          // scrollPageToOffset's getBoundingClientRect math starts from a
          // known frame instead of an out-of-bounds scrollTop from before.
          input.style.height = "auto";
          if (editScroller) editScroller.scrollTop = 0;
        }
        resetHistory();
        syncSaveState();
      }
      if (!input || input.disabled) return;
      if (documentChanged) {
        // Force a sync layout flush so the new value/height/scrollTop reset
        // takes effect, then wait one rAF for scrollbar appearance to settle
        // (scrollbar toggling is async on overflow:auto and changes the
        // textarea's clientWidth, which mirror measurements depend on).
        // Only then focus + restore. Focusing before measurement was racing
        // with the browser's auto scroll-into-view on the textarea.
        void input.offsetHeight;
        requestAnimationFrame(() => {
          try { input.focus({ preventScroll: true }); }
          catch (_) { input.focus(); }
          restoreReadingScroll();
        });
      } else {
        try { input.focus({ preventScroll: true }); }
        catch (_) { input.focus(); }
        restoreReadingScroll();
      }
    });
  } catch (_) { /* not in extension context */ }

  if (!sessionId) {
    showError("Invalid edit session");
  } else {
    chrome.runtime.sendMessage(
      { type: "getEditSession", sessionId },
      (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          showError("Edit session expired. Close this window and retry.");
          return;
        }
        const name = resp.name ? String(resp.name) : "";
        // In-page header shows the file name; OS title bar stays empty
        // because chromeless popup mode hides it visually anyway.
        if (heading) heading.textContent = name || "Untitled document";
        document.title = "";
        pendingScrollRatio = Number(resp.scrollRatio) || 0;
        pendingScrollOffset = Number(resp.scrollOffset) || 0;
        pendingScrollOffsetMatched = Boolean(resp.scrollOffsetMatched);
        pendingSelectionStart = Number.isFinite(resp.selectionStart)
          ? resp.selectionStart
          : null;
        pendingSelectionEnd = Number.isFinite(resp.selectionEnd)
          ? resp.selectionEnd
          : null;
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
        scheduleCaretSync();
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
      scheduleCaretSync();
    });
  }

  if (undoBtn) undoBtn.addEventListener("click", undo);
  if (redoBtn) redoBtn.addEventListener("click", redo);

  // Selection changes don't fire `input`; listen explicitly so the
  // block caret overlay tracks the caret.
  if (input) {
    input.addEventListener("select", scheduleCaretSync);
    input.addEventListener("keyup", scheduleCaretSync);
    input.addEventListener("mouseup", scheduleCaretSync);
    input.addEventListener("focus", scheduleCaretSync);
    input.addEventListener("blur", () => {
      if (caretOverlay) caretOverlay.classList.remove("is-visible");
    });
  }
  // selectionchange fires for arrow keys + programmatic moves that the
  // above events miss.
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === input) scheduleCaretSync();
  });
  if (editScroller) {
    editScroller.addEventListener("scroll", scheduleCaretSync, { passive: true });
  }

  window.addEventListener("resize", () => {
    syncMirrorStyle();
    autoGrowTextarea();
    scheduleCaretSync();
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
          showToast((resp && resp.error) || "Save failed");
          syncSaveState();
          return;
        }
        baselineText = input.value;
        syncSaveState();
        showToast("Saved");
      }
    );
  }

  if (saveBtn) {
    saveBtn.addEventListener("click", save);
  }

  // Browser-native confirm when the chromeless popup is closed (OS X, ⌘W)
  // while the editor has uncommitted typing. Custom button text isn't
  // possible on beforeunload; user gets the platform's "Leave site?" prompt.
  window.addEventListener("beforeunload", (e) => {
    if (!isDirty()) return;
    e.preventDefault();
    e.returnValue = "";
  });

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
