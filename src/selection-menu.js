/**
 * Reading-surface selection menu (Direction 2 of v1.4).
 *
 * Mounts a singleton floating menu that appears whenever the user makes a
 * non-empty text selection inside one of the registered reading roots
 * (.markdown-preview-sizer in content.js, open.html, viewer.html).
 *
 * Primary actions:
 *   - Ask AI   → expands a sub-menu of 3 chatbots; clipboard handoff.
 *   - 复制     → navigator.clipboard.writeText(selection).
 *   - 编辑     → openMarkdownInEditTab with start/end mapped to source.
 *
 * The 编辑 action maps the Selection's anchor + focus DOM points back to
 * source markdown offsets via BaselineShared.offsetForRangePoint, normalizes
 * to [min, max], and forwards them to edit.js so the textarea opens with the
 * exact selection re-highlighted (start<end). Direction 4's double-click
 * path uses the same edit-tab plumbing but with start===end.
 *
 * Exposes window.BaselineSelectionMenu = { mount, suppressNext }.
 *
 * `suppressNext()` is the hook bindReadingDblClick uses so that the
 * native word-selection following a double-click doesn't pop this menu
 * before the edit tab opens.
 */

(function (root) {
  "use strict";

  const DEBOUNCE_MS = 200;
  const VIEWPORT_PAD = 8;
  const MENU_GAP = 8;
  const SUPPRESS_TTL_MS = 400;

  // Stable chatbot URLs. If any of these change upstream, edit here only.
  const CHATBOTS = [
    { id: "qianwen",  label: "Qwen",     url: "https://www.qianwen.com/" },
    { id: "deepseek", label: "DeepSeek", url: "https://chat.deepseek.com" },
    { id: "kimi",     label: "Kimi",     url: "https://kimi.com" }
  ];

  // Mount registry: each reading column (main / split / bilingual-left)
  // registers its own root + thunks. The menu itself is a singleton.
  const mounted = [];
  let menuEl = null;
  let askWrapEl = null;
  let askSubEl = null;
  let copyBtnEl = null;
  let editBtnEl = null;
  let askBtnEl = null;
  let debounceTimer = 0;
  let suppressNextFlag = false;
  let suppressResetTimer = 0;
  // Pending action context; captured at menu open so subsequent
  // selection changes (e.g. the menu button getting focus) don't lose it.
  let pending = null;
  // Last pointer position — anchors toasts just above the cursor so the
  // user sees feedback where their attention already is, instead of at
  // the now-hidden menu's prior location.
  let lastPointerPos = null;
  let pointerTrackerBound = false;
  const TOAST_CURSOR_OFFSET = 12;

  function bindPointerTracker() {
    if (pointerTrackerBound) return;
    pointerTrackerBound = true;
    const record = (e) => {
      if (typeof e.clientX === "number" && typeof e.clientY === "number") {
        lastPointerPos = { x: e.clientX, y: e.clientY };
      }
    };
    document.addEventListener("mousemove", record, { passive: true, capture: true });
    document.addEventListener("mousedown", record, { passive: true, capture: true });
  }

  function suppressNext() {
    suppressNextFlag = true;
    if (suppressResetTimer) clearTimeout(suppressResetTimer);
    // Auto-clear so a stale flag can't silently swallow a real selection.
    suppressResetTimer = setTimeout(() => {
      suppressNextFlag = false;
      suppressResetTimer = 0;
    }, SUPPRESS_TTL_MS);
  }

  function consumeSuppress() {
    if (!suppressNextFlag) return false;
    suppressNextFlag = false;
    if (suppressResetTimer) {
      clearTimeout(suppressResetTimer);
      suppressResetTimer = 0;
    }
    return true;
  }

  function findRegistration(node) {
    if (!node) return null;
    // Drop entries whose root has been replaced (split column rebuilds
    // create a fresh sizer; the prior one is detached & GC-bound).
    for (let i = mounted.length - 1; i >= 0; i--) {
      const r = mounted[i].rootEl;
      if (!r || !document.contains(r)) mounted.splice(i, 1);
    }
    for (const reg of mounted) {
      if (reg.rootEl.contains(node)) return reg;
    }
    return null;
  }

  function getSizer(rootEl) {
    if (!rootEl) return null;
    if (rootEl.classList && rootEl.classList.contains("markdown-preview-sizer")) {
      return rootEl;
    }
    return rootEl.querySelector(".markdown-preview-sizer");
  }

  function showToast(message) {
    bindPointerTracker();
    let toast = document.getElementById("baseline-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "baseline-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    // Anchor near the cursor (slightly above) — user requested feedback
    // appear where their attention is, not at the now-hidden menu's spot.
    // Fall back to the menu, then to viewport top if neither is known.
    if (lastPointerPos) {
      toast.style.left = Math.round(lastPointerPos.x) + "px";
      const flipBelow = lastPointerPos.y < 60;
      toast.classList.toggle("is-below", flipBelow);
      toast.style.top = Math.round(
        flipBelow
          ? lastPointerPos.y + TOAST_CURSOR_OFFSET
          : lastPointerPos.y - TOAST_CURSOR_OFFSET
      ) + "px";
    } else if (menuEl && !menuEl.hidden) {
      const r = menuEl.getBoundingClientRect();
      toast.style.left = Math.round(r.left + r.width / 2) + "px";
      const flipBelow = r.top < 60;
      toast.classList.toggle("is-below", flipBelow);
      toast.style.top = Math.round(flipBelow ? r.bottom + 4 : r.top - 4) + "px";
    } else {
      toast.style.left = Math.round(window.innerWidth / 2) + "px";
      toast.classList.remove("is-below");
      toast.style.top = "80px";
    }
    toast.classList.add("is-visible");
    if (showToast._timer) clearTimeout(showToast._timer);
    showToast._timer = setTimeout(
      () => toast.classList.remove("is-visible"),
      1600
    );
  }

  // Material Symbols (filled / solid weight) — currentColor + 16px.
  function svgIcon(pathD) {
    return (
      '<svg class="bsw-selection-menu-icon" xmlns="http://www.w3.org/2000/svg"'
      + ' width="16" height="16" viewBox="0 -960 960 960" fill="currentColor"'
      + ' aria-hidden="true"><path d="' + pathD + '"/></svg>'
    );
  }
  // auto_awesome (filled) — sparkle, the "AI" affordance used everywhere
  // in Google's product surfaces.
  const ICON_ASK_AI = svgIcon(
    "M260-160 161-380 0-480l161-100 99-220 100 220 160 100-160 100-100 220Z"
    + "m460 0-50-110-110-50 110-50 50-110 50 110 110 50-110 50-50 110Z"
    + "m0-340-30-70-70-30 70-30 30-70 30 70 70 30-70 30-30 70Z"
  );
  // content_copy (filled)
  const ICON_COPY = svgIcon(
    "M360-240q-33 0-56.5-23.5T280-320v-480q0-33 23.5-56.5T360-880h360"
    + "q33 0 56.5 23.5T800-800v480q0 33-23.5 56.5T720-240H360Z"
    + "M200-80q-33 0-56.5-23.5T120-160v-560h80v560h440v80H200Z"
  );
  // edit (filled pencil — solid, no inset paper outline)
  const ICON_EDIT = svgIcon(
    "M120-120v-170l527-527q12-12 26.5-18t30.5-6q16 0 31 6t26 18l55 56"
    + "q12 11 17.5 26t5.5 30q0 16-5.5 30.5T821-647L290-120H120Z"
  );

  // labelHTML is interpolated verbatim into innerHTML — callers must hand-craft
  // safe strings. Both icon SVGs and text labels in this file are static.
  function makeButton(labelHTML, className) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className;
    b.innerHTML = labelHTML;
    return b;
  }

  function ensureMenu() {
    if (menuEl) return;
    menuEl = document.createElement("div");
    menuEl.className = "bsw-selection-menu";
    menuEl.hidden = true;
    // Block focus-stealing while still letting buttons receive clicks.
    menuEl.addEventListener("mousedown", (e) => e.preventDefault());

    askWrapEl = document.createElement("div");
    askWrapEl.className = "bsw-selection-menu-ask-wrap";

    askBtnEl = makeButton(
      ICON_ASK_AI + '<span class="bsw-selection-menu-label">Ask AI</span>'
      + '<span class="bsw-selection-menu-caret">▾</span>',
      "bsw-selection-menu-btn"
    );
    askBtnEl.title = "Send to " + CHATBOTS[0].label + " (hover for more)";
    askWrapEl.appendChild(askBtnEl);

    askSubEl = document.createElement("div");
    askSubEl.className = "bsw-selection-menu-sub";
    askSubEl.hidden = true;
    CHATBOTS.forEach((bot) => {
      const item = makeButton(bot.label, "bsw-selection-menu-sub-item");
      item.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        askAction(bot);
      });
      askSubEl.appendChild(item);
    });
    askWrapEl.appendChild(askSubEl);

    // Open submenu on hover or click; close on mouseleave with a short
    // grace period so the visual gap between button and submenu doesn't
    // race the cursor and snap-hide mid-traversal. mouseenter on either
    // the button or the submenu cancels any pending hide.
    let hideSubTimer = 0;
    const cancelHideSub = () => {
      if (hideSubTimer) { clearTimeout(hideSubTimer); hideSubTimer = 0; }
    };
    const scheduleHideSub = () => {
      cancelHideSub();
      hideSubTimer = setTimeout(() => {
        hideSubTimer = 0;
        askSubEl.hidden = true;
      }, 180);
    };
    askBtnEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      cancelHideSub();
      askSubEl.hidden = true;
      const primary = CHATBOTS[0];
      if (primary) askAction(primary);
    });
    askWrapEl.addEventListener("mouseenter", () => {
      cancelHideSub();
      askSubEl.hidden = false;
    });
    askWrapEl.addEventListener("mouseleave", scheduleHideSub);
    askSubEl.addEventListener("mouseenter", cancelHideSub);
    askSubEl.addEventListener("mouseleave", scheduleHideSub);

    copyBtnEl = makeButton(
      ICON_COPY + '<span class="bsw-selection-menu-label">Copy</span>',
      "bsw-selection-menu-btn"
    );
    copyBtnEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyAction();
    });

    editBtnEl = makeButton(
      ICON_EDIT + '<span class="bsw-selection-menu-label">Edit</span>',
      "bsw-selection-menu-btn"
    );
    editBtnEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      editAction();
    });

    menuEl.appendChild(askWrapEl);
    menuEl.appendChild(copyBtnEl);
    menuEl.appendChild(editBtnEl);
    document.body.appendChild(menuEl);
  }

  function hideMenu() {
    if (!menuEl || menuEl.hidden) return;
    menuEl.hidden = true;
    if (askSubEl) askSubEl.hidden = true;
    pending = null;
  }

  function positionMenu(rect) {
    if (!menuEl) return;
    // Measure after making visible (offscreen so flicker doesn't show).
    menuEl.style.left = "-9999px";
    menuEl.style.top = "-9999px";
    menuEl.hidden = false;
    const mw = menuEl.offsetWidth;
    const mh = menuEl.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = rect.top - mh - MENU_GAP;
    let flippedBelow = false;
    if (top < VIEWPORT_PAD) {
      top = rect.bottom + MENU_GAP;
      flippedBelow = true;
    }
    if (top + mh > vh - VIEWPORT_PAD) {
      top = Math.max(VIEWPORT_PAD, vh - mh - VIEWPORT_PAD);
    }

    let left = rect.left + rect.width / 2 - mw / 2;
    if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;
    if (left + mw > vw - VIEWPORT_PAD) left = vw - mw - VIEWPORT_PAD;

    menuEl.style.left = Math.round(left) + "px";
    menuEl.style.top = Math.round(top) + "px";
    menuEl.classList.toggle("is-below", flippedBelow);
  }

  // Snapshot the live Selection into stable values so async actions (copy
  // permission prompt, edit-tab open) don't race a selection clear.
  function snapshotSelection(reg) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return null;
    const text = sel.toString();
    if (!text || !text.trim()) return null;
    return {
      reg,
      text,
      anchorNode: sel.anchorNode,
      anchorOffset: sel.anchorOffset,
      focusNode: sel.focusNode,
      focusOffset: sel.focusOffset
    };
  }

  function onSelectionChange() {
    if (consumeSuppress()) {
      hideMenu();
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = 0;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) { hideMenu(); return; }
      const range = sel.getRangeAt(0);
      if (range.collapsed) { hideMenu(); return; }
      const reg = findRegistration(range.commonAncestorContainer);
      if (!reg) { hideMenu(); return; }
      const text = sel.toString();
      if (!text || !text.trim()) { hideMenu(); return; }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) { hideMenu(); return; }
      pending = snapshotSelection(reg);
      if (!pending) { hideMenu(); return; }
      ensureMenu();
      positionMenu(rect);
    }, DEBOUNCE_MS);
  }

  /**
   * Map the live selection (anchor/focus) back to a markdown source slice.
   * Returns the source text the user actually highlighted in the rendered
   * view — so copy/ask-AI hand over the original markdown (with **bold**,
   * fences, links, headings intact) instead of the rendered plain text.
   * Falls back to pending.text if either endpoint can't be mapped.
   */
  function sourceSliceFor(pendingCtx) {
    const fallback = pendingCtx ? pendingCtx.text : "";
    if (!pendingCtx) return fallback;
    const reg = pendingCtx.reg;
    const shared = root.BaselineShared;
    if (!reg || !shared || typeof shared.offsetForRangePoint !== "function") {
      return fallback;
    }
    const md = typeof reg.opts.getMarkdown === "function"
      ? reg.opts.getMarkdown()
      : "";
    if (!md) return fallback;
    const sizer = getSizer(reg.rootEl);
    if (!sizer) return fallback;
    const a = shared.offsetForRangePoint(
      md, sizer, pendingCtx.anchorNode, pendingCtx.anchorOffset
    );
    const f = shared.offsetForRangePoint(
      md, sizer, pendingCtx.focusNode, pendingCtx.focusOffset
    );
    if (!(a && f && a.matched && f.matched
        && Number.isFinite(a.offset) && Number.isFinite(f.offset))) {
      return fallback;
    }
    let start = a.offset, end = f.offset;
    if (start > end) { const t = start; start = end; end = t; }
    if (end <= start) return fallback;
    const slice = md.slice(start, end);
    // Trim only outer newlines/whitespace so paste lands cleanly; preserve
    // intra-selection structure (lists / code fences / indentation).
    return slice.replace(/^\s+|\s+$/g, "") || fallback;
  }

  function copyAction() {
    if (!pending) return;
    const text = sourceSliceFor(pending) || pending.text;
    const finish = () => { hideMenu(); showToast("Copied"); };
    try {
      navigator.clipboard.writeText(text).then(finish, fallback);
    } catch (_) { fallback(); }

    function fallback() {
      // Last-resort path; permission denial or older sandbox.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); finish(); }
      catch (_) { showToast("Copy failed"); hideMenu(); }
      finally { try { document.body.removeChild(ta); } catch (_) {} }
    }
  }

  function askAction(bot) {
    if (!pending || !bot) return;
    // Hand off the markdown source slice so the chatbot sees fenced code,
    // bullet structure, etc. — not the flattened rendered text.
    const text = sourceSliceFor(pending) || pending.text;

    // Hand off via chrome.storage.local — chatbot-inject.js content script on
    // the target tab will pick this up, poll for the input, and inject the
    // text. Clipboard write is kept as a backup so manual ⌘V still works
    // when the SPA selectors break.
    const stash = new Promise((resolve) => {
      try {
        if (chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set(
            {
              bswPendingChatbotInject: {
                botId: bot.id,
                text,
                ts: Date.now()
              }
            },
            () => resolve()
          );
          return;
        }
      } catch (_) {}
      resolve();
    });

    const reveal = () => {
      try { window.open(bot.url, "_blank", "noopener,noreferrer"); }
      catch (_) {}
      showToast("Sent to " + bot.label);
      hideMenu();
    };

    const clipboard = (() => {
      try { return navigator.clipboard.writeText(text); }
      catch (e) { return Promise.reject(e); }
    })();

    Promise.allSettled([stash, clipboard]).then((results) => {
      const clip = results[1];
      if (clip && clip.status === "rejected") {
        console.warn("[Baseline] clipboard write failed:", clip.reason);
      }
      reveal();
    });
  }

  function editAction() {
    if (!pending) return;
    const reg = pending.reg;
    const shared = root.BaselineShared;
    if (!shared || typeof shared.openMarkdownInEditTab !== "function") {
      console.warn("[Baseline] BaselineShared.openMarkdownInEditTab missing");
      hideMenu();
      return;
    }
    const md = typeof reg.opts.getMarkdown === "function"
      ? reg.opts.getMarkdown()
      : "";
    if (!md) { hideMenu(); return; }
    const sizer = getSizer(reg.rootEl);
    if (!sizer) { hideMenu(); return; }

    // Map both endpoints to source offsets via the generic helper.
    // Only forward selectionStart/End when BOTH endpoints actually matched —
    // otherwise we'd silently send (0, 0) and land the cursor at the top.
    let extra = undefined;
    if (typeof shared.offsetForRangePoint === "function") {
      const a = shared.offsetForRangePoint(
        md, sizer, pending.anchorNode, pending.anchorOffset
      );
      const f = shared.offsetForRangePoint(
        md, sizer, pending.focusNode, pending.focusOffset
      );
      if (a && f && a.matched && f.matched
        && Number.isFinite(a.offset) && Number.isFinite(f.offset)) {
        // anchor / focus aren't guaranteed in document order; normalize.
        let start = a.offset, end = f.offset;
        if (start > end) { const t = start; start = end; end = t; }
        extra = { selectionStart: start, selectionEnd: end };
      }
      // If mapping fails, fall through with extra=undefined — the editor
      // just opens without a pre-positioned selection. No warn needed.
    }

    const name = typeof reg.opts.getName === "function" ? reg.opts.getName() : "";
    const column = typeof reg.opts.getColumn === "function"
      ? reg.opts.getColumn()
      : "main";

    hideMenu();
    try { window.getSelection().removeAllRanges(); } catch (_) {}

    shared.openMarkdownInEditTab(md, name, column, sizer, extra).catch((err) => {
      console.warn("[Baseline] open edit tab failed:", err);
      showToast("Could not open editor");
    });
  }

  // Hide on outside mousedown / Esc / scroll. selectionchange already
  // closes when the selection collapses, but mousedown gives instant
  // feedback during drag-to-reselect.
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("mousedown", (e) => {
    if (!menuEl || menuEl.hidden) return;
    if (menuEl.contains(e.target)) return;
    hideMenu();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideMenu();
  });
  // Capture-phase scroll listener catches both window and nested
  // overflow:auto containers (Obsidian wraps the article in several).
  window.addEventListener("scroll", () => hideMenu(), true);
  window.addEventListener("resize", () => hideMenu());

  function mount(rootEl, opts) {
    if (!rootEl) return;
    // De-dupe if the same root is registered twice (e.g. surface remounts).
    for (let i = mounted.length - 1; i >= 0; i--) {
      if (mounted[i].rootEl === rootEl) mounted.splice(i, 1);
    }
    mounted.push({ rootEl, opts: opts || {} });
  }

  function unmount(rootEl) {
    for (let i = mounted.length - 1; i >= 0; i--) {
      if (mounted[i].rootEl === rootEl) mounted.splice(i, 1);
    }
  }

  root.BaselineSelectionMenu = { mount, unmount, suppressNext };
})(typeof window !== "undefined" ? window : globalThis);
