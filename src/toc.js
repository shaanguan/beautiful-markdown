/**
 * Heading enhancements: anchor-on-hover (copy permalink) + auto-generated
 * table-of-contents sidebar.
 *
 * Both features iterate the same h1-h6 list inside the markdown view, so
 * they live in one module to avoid two passes (and two ID-assignment
 * conflicts) over the same DOM.
 *
 * Architecture:
 *   buildHeadingIndex(mountEl)
 *     → assigns missing ids (slugify + dedupe), returns [{level, id, text, el}]
 *   mountHeadingAnchors(index)
 *     → injects an `.bsw-heading-anchor` <a> inside each heading; click
 *       copies window.location with the hash to clipboard
 *   mountTOC(index, opts)
 *     → builds the right-edge floating TOC. The active item is updated
 *       on click only (user spec — no scroll-spy / IntersectionObserver),
 *       collapsed state is persisted to chrome.storage.local, and the
 *       panel auto-collapses on narrow viewports (resize-aware, without
 *       overwriting the saved preference).
 *
 * The TOC is hidden when the document has fewer than 2 headings — no
 * point showing a one-item nav.
 */

(function (root) {
  "use strict";

  const TOC_COLLAPSED_KEY = "tocCollapsed";

  function slugify(text) {
    return String(text || "")
      .trim()
      .toLowerCase()
      // Keep letters/digits in CJK + Latin, replace separators with dash
      .replace(/[\s ]+/g, "-")
      .replace(/[^\p{Letter}\p{Number}\-]+/gu, "")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "section";
  }

  function buildHeadingIndex(mountEl) {
    const nodes = mountEl.querySelectorAll("h1, h2, h3, h4, h5, h6");
    const used = new Set();
    const index = [];
    for (const el of nodes) {
      let id = el.id;
      if (!id) {
        const base = slugify(el.textContent);
        id = base;
        let n = 2;
        while (used.has(id) || document.getElementById(id)) {
          id = base + "-" + n++;
        }
        el.id = id;
      }
      used.add(id);
      index.push({
        level: parseInt(el.tagName.slice(1), 10),
        id,
        text: el.textContent.trim(),
        el
      });
    }
    return index;
  }

  // ── Heading anchors ────────────────────────────────────────────────

  function mountHeadingAnchors(index) {
    for (const item of index) {
      // Skip if we've already decorated this heading (e.g. re-render).
      if (item.el.querySelector(":scope > .bsw-heading-anchor")) continue;
      const a = document.createElement("a");
      a.className = "bsw-heading-anchor";
      a.href = "#" + item.id;
      a.setAttribute("aria-label", "Copy link to this section");
      a.title = "Copy link";
      a.textContent = "#";
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const url = location.origin + location.pathname + location.search + "#" + item.id;
        copyToClipboard(url).then((ok) => {
          showToast(a, ok ? "Link copied" : "Copy failed");
        });
        // Update URL without triggering a jump (preserves scroll position).
        history.replaceState(null, "", "#" + item.id);
      });
      item.el.appendChild(a);
    }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  // Single shared toast — re-positioned on each call instead of stacking.
  // Flips below the anchor when the anchor sits too close to the top of the
  // viewport (e.g. the top-right doc tools), so the toast never lands off
  // the visible area.
  let toastTimer = null;
  function showToast(near, message) {
    let toast = document.getElementById("baseline-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "baseline-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    const r = near.getBoundingClientRect();
    toast.style.left = Math.round(r.left + r.width / 2) + "px";
    const flipBelow = r.top < 60;
    toast.classList.toggle("is-below", flipBelow);
    toast.style.top = Math.round(flipBelow ? r.bottom + 4 : r.top - 4) + "px";
    toast.classList.add("is-visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 1400);
  }

  // ── TOC sidebar ────────────────────────────────────────────────────

  function getCollapsedState() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ [TOC_COLLAPSED_KEY]: false }, (items) => {
          resolve(Boolean(items[TOC_COLLAPSED_KEY]));
        });
      } catch {
        resolve(false);
      }
    });
  }

  function setCollapsedState(collapsed) {
    try {
      chrome.storage.local.set({ [TOC_COLLAPSED_KEY]: Boolean(collapsed) });
    } catch { /* no-op */ }
  }

  async function mountTOC(index, mountEl) {
    if (!Array.isArray(index) || index.length < 2) return null;

    // .view-content gets the bsw-with-toc class which switches the layout
    // to reserve a right gutter for the (fixed-position) TOC panel.
    const contentWrap = ensureContentWrap(mountEl);
    if (!contentWrap) return null;
    const container = contentWrap.parentNode;
    // Needed by getActiveScroller() below — captured in a closure that
    // runs on every TOC item click, so this must be in scope.
    const readingView = mountEl.closest(".markdown-reading-view");
    container.classList.add("bsw-with-toc");

    // Normalize level so we never indent past 3 visual tiers even if the
    // doc starts at h2. Find min level in doc and re-base from there.
    const minLevel = Math.min(...index.map((h) => h.level));

    const root_ = document.createElement("aside");
    root_.id = "baseline-toc";
    root_.setAttribute("aria-label", "Table of contents");

    // Toggle button lives in `.bsw-doc-tools` (alongside edit/copy), not
    // inside #baseline-toc — that way it stays anchored to the article
    // edge as the TOC opens/closes, and shares spacing with sibling tools.
    const tools = ensureToolsRow(contentWrap);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "bsw-doc-tool bsw-toc-toggle";
    toggle.dataset.tooltip = "目录";
    toggle.setAttribute("aria-label", "Toggle table of contents");
    toggle.setAttribute("aria-expanded", "true");
    toggle.innerHTML = listIcon();
    // If a previous mount left a toggle, replace it rather than stack.
    const oldToggle = tools.querySelector(":scope > .bsw-toc-toggle");
    if (oldToggle) oldToggle.remove();
    tools.appendChild(toggle);

    const panel = document.createElement("div");
    panel.className = "bsw-toc-panel";

    const header = document.createElement("div");
    header.className = "bsw-toc-header";
    const title = document.createElement("div");
    title.className = "bsw-toc-title";
    title.textContent = "Contents";
    header.appendChild(title);

    const list = document.createElement("nav");
    list.className = "bsw-toc-list";

    // Resolve the right scroll container for an anchor jump. With the new
    // two-scroll-container layout, `.markdown-reading-view` scrolls inside
    // its own box in standard/wide; in full mode the window scrolls. We
    // pick by overflow rather than width-class so a future layout change
    // doesn't silently break the jump.
    const getActiveScroller = () => {
      if (readingView) {
        const cs = getComputedStyle(readingView);
        if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
          if (readingView.scrollHeight > readingView.clientHeight + 1) {
            return readingView;
          }
        }
      }
      return null; // null sentinel = use window/document scroll
    };

    // Active item is user-click-driven, NOT scroll-driven (user spec). We
    // track it only so the click handler can clear the previous selection
    // before painting the new one.
    let activeEl = null;
    const setActive = (a) => {
      if (activeEl === a) return;
      if (activeEl) activeEl.classList.remove("is-active");
      activeEl = a;
      if (a) a.classList.add("is-active");
    };

    const itemEls = new Map(); // id → <a>
    for (const h of index) {
      const a = document.createElement("a");
      a.className = "bsw-toc-item";
      a.href = "#" + h.id;
      a.dataset.level = String(Math.min(h.level - minLevel + 1, 4));
      a.textContent = h.text;
      a.title = h.text;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const scroller = getActiveScroller();
        if (scroller) {
          // Compute the heading's offset relative to the scroller, then
          // scrollTo — `scrollIntoView` walks up the ancestor chain and
          // sometimes lands on the wrong scroller (a parent flex box's
          // 1px overflow) when there are nested scroll contexts.
          const sRect = scroller.getBoundingClientRect();
          const eRect = h.el.getBoundingClientRect();
          const y = scroller.scrollTop + (eRect.top - sRect.top) - 24;
          scroller.scrollTo({ top: y, behavior: "smooth" });
        } else {
          h.el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        history.replaceState(null, "", "#" + h.id);
        setActive(a);
      });
      itemEls.set(h.id, a);
      list.appendChild(a);
    }

    panel.appendChild(header);
    panel.appendChild(list);
    root_.appendChild(panel);
    container.appendChild(root_);

    const setCollapsed = (collapsed) => {
      root_.classList.toggle("is-collapsed", collapsed);
      container.classList.toggle("bsw-toc-collapsed", collapsed);
      toggle.setAttribute(
        "aria-label",
        collapsed ? "Expand table of contents" : "Collapse table of contents"
      );
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      setCollapsedState(collapsed);
    };

    toggle.addEventListener("click", () => {
      setCollapsed(!root_.classList.contains("is-collapsed"));
    });

    // Default expanded on wide screens, collapsed on narrow viewports.
    // User's stored preference always wins on first paint.
    const stored = await getCollapsedState();
    const NARROW_BREAKPOINT = 1100;
    let wasNarrow = window.innerWidth < NARROW_BREAKPOINT;
    setCollapsed(stored || wasNarrow);

    // Resize handler: auto-collapse when the viewport shrinks below the
    // breakpoint, restore the user's stored preference when it grows back.
    // We deliberately don't persist these transitions — otherwise dragging
    // the window across the breakpoint would silently overwrite the user's
    // intent. Without this listener, opening the TOC and then narrowing the
    // window left `padding-right: 360px` in force and crushed the article.
    let resizeRaf = 0;
    const onResize = () => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(async () => {
        resizeRaf = 0;
        const isNarrow = window.innerWidth < NARROW_BREAKPOINT;
        if (isNarrow === wasNarrow) return;
        wasNarrow = isNarrow;
        if (isNarrow) {
          // Mirror setCollapsed(true) without touching storage.
          root_.classList.add("is-collapsed");
          container.classList.add("bsw-toc-collapsed");
          toggle.setAttribute("aria-label", "Expand table of contents");
          toggle.setAttribute("aria-expanded", "false");
        } else {
          // Came back to wide territory — honour the user's saved choice.
          const s = await getCollapsedState();
          root_.classList.toggle("is-collapsed", s);
          container.classList.toggle("bsw-toc-collapsed", s);
          toggle.setAttribute(
            "aria-label",
            s ? "Expand table of contents" : "Collapse table of contents"
          );
          toggle.setAttribute("aria-expanded", s ? "false" : "true");
        }
      });
    };
    window.addEventListener("resize", onResize, { passive: true });

    return {
      destroy() {
        window.removeEventListener("resize", onResize);
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        root_.remove();
        if (toggle.parentNode) toggle.parentNode.removeChild(toggle);
        container.classList.remove("bsw-with-toc", "bsw-toc-collapsed");
      }
    };
  }

  // ── Doc tools (edit / copy / toc-toggle) ───────────────────────────
  // Shared top-right row that holds optional action buttons. The TOC
  // toggle also lives here so all three buttons share spacing and travel
  // together as the TOC slides in. mountDocActions can be called either
  // before or after mountTOC — both functions look up (and create on
  // demand) the same .bsw-doc-tools container.

  function ensureContentWrap(mountEl) {
    const container = mountEl.closest(".view-content");
    if (!container) return null;
    const readingView = mountEl.closest(".markdown-reading-view");
    if (!readingView) return null;
    let contentWrap = container.querySelector(":scope > .bsw-content-wrap");
    if (!contentWrap) {
      contentWrap = document.createElement("div");
      contentWrap.className = "bsw-content-wrap";
      container.insertBefore(contentWrap, readingView);
      contentWrap.appendChild(readingView);
    }
    return contentWrap;
  }

  function ensureToolsRow(contentWrap) {
    let tools = contentWrap.querySelector(":scope > .bsw-doc-tools");
    if (!tools) {
      tools = document.createElement("div");
      tools.className = "bsw-doc-tools";
      contentWrap.appendChild(tools);
    }
    return tools;
  }

  function makeToolButton({ action, tooltip, svg, onClick }) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bsw-doc-tool";
    btn.dataset.action = action;
    btn.dataset.tooltip = tooltip;
    btn.setAttribute("aria-label", tooltip);
    btn.innerHTML = svg;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function mountDocActions(mountEl, opts) {
    const contentWrap = ensureContentWrap(mountEl);
    if (!contentWrap) return null;
    const tools = ensureToolsRow(contentWrap);

    // Re-render: drop existing edit/copy/swap buttons. Toggle is owned by
    // mountTOC and stays put.
    for (const old of tools.querySelectorAll(
      ":scope > .bsw-doc-tool[data-action='edit'], " +
      ":scope > .bsw-doc-tool[data-action='copy'], " +
      ":scope > .bsw-doc-tool[data-action='swap']"
    )) {
      old.remove();
    }

    // Insertion order: edit, copy, swap, [toggle if present]. We always
    // insertBefore the toggle so the visual order is edit | copy | swap | toc,
    // regardless of whether mountDocActions runs before or after mountTOC.
    // In 分栏视图 (split) mode the TOC is suppressed entirely and `swap`
    // ("换文件") takes the rightmost slot — same row, no extra positioning.
    const toggle = tools.querySelector(":scope > .bsw-toc-toggle");

    if (opts && typeof opts.onEdit === "function") {
      const edit = makeToolButton({
        action: "edit",
        tooltip: opts.editTooltip || "在编辑器中打开",
        svg: editIcon(),
        onClick: () => opts.onEdit()
      });
      if (toggle) tools.insertBefore(edit, toggle);
      else tools.appendChild(edit);
    }

    if (opts && typeof opts.onCopy === "function") {
      const copy = makeToolButton({
        action: "copy",
        tooltip: opts.copyTooltip || "复制全文",
        svg: copyIcon(),
        onClick: () => {
          let text;
          try { text = opts.onCopy(); } catch (_) { text = ""; }
          if (text == null) text = "";
          copyToClipboard(String(text)).then((ok) => {
            showToast(copy, ok ? (opts.copyDoneText || "全文已复制") : "复制失败");
          });
        }
      });
      if (toggle) tools.insertBefore(copy, toggle);
      else tools.appendChild(copy);
    }

    if (opts && typeof opts.onSwap === "function") {
      const swap = makeToolButton({
        action: "swap",
        tooltip: opts.swapTooltip || "换文件",
        svg: folderOpenIcon(),
        onClick: () => opts.onSwap()
      });
      if (toggle) tools.insertBefore(swap, toggle);
      else tools.appendChild(swap);
    }

    return {
      destroy() {
        for (const el of tools.querySelectorAll(
          ":scope > .bsw-doc-tool[data-action='edit'], " +
          ":scope > .bsw-doc-tool[data-action='copy'], " +
          ":scope > .bsw-doc-tool[data-action='swap']"
        )) {
          el.remove();
        }
      }
    };
  }

  // ── Reading progress bar ───────────────────────────────────────────
  // Thin progress strip at the top of the page tracking scroll position.
  // Independent of TOC so single-section docs still get it.

  function mountProgressBar() {
    // Idempotent — repeated calls (re-render, content swap) would otherwise
    // stack duplicate bars + scroll listeners.
    if (document.getElementById("baseline-progress")) return;
    const bar = document.createElement("div");
    bar.id = "baseline-progress";
    document.body.appendChild(bar);

    let rafPending = false;
    const update = () => {
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - doc.clientHeight;
      const pct = scrollable > 0
        ? Math.min(100, Math.max(0, (doc.scrollTop / scrollable) * 100))
        : 0;
      bar.style.width = pct + "%";
    };
    const onScroll = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        update();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    update();
  }

  // ── Icons ──────────────────────────────────────────────────────────

  // Material Symbols "format list bulleted" — reads instantly as a
  // table-of-contents affordance, no rotation needed since the toggle
  // shows/hides the panel rather than flipping direction.
  function listIcon() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" ' +
      'viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">' +
      '<path d="M280-600v-80h560v80H280Zm0 160v-80h560v80H280Zm0 160v-80h560v80H280Z' +
      'M160-600q-17 0-28.5-11.5T120-640q0-17 11.5-28.5T160-680q17 0 28.5 11.5T200-640' +
      'q0 17-11.5 28.5T160-600Zm0 160q-17 0-28.5-11.5T120-480q0-17 11.5-28.5T160-520' +
      'q17 0 28.5 11.5T200-480q0 17-11.5 28.5T160-440Zm0 160q-17 0-28.5-11.5T120-320' +
      'q0-17 11.5-28.5T160-360q17 0 28.5 11.5T200-320q0 17-11.5 28.5T160-280Z"/>' +
      '</svg>'
    );
  }

  // Material Symbols "content copy" (stacked rectangles).
  function copyIcon() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" ' +
      'viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">' +
      '<path d="M360-240q-33 0-56.5-23.5T280-320v-480q0-33 23.5-56.5T360-880h360' +
      'q33 0 56.5 23.5T800-800v480q0 33-23.5 56.5T720-240H360Zm0-80h360v-480H360v480Z' +
      'M200-80q-33 0-56.5-23.5T120-160v-560h80v560h440v80H200Zm160-240v-480 480Z"/>' +
      '</svg>'
    );
  }

  // Material Symbols "folder_open" — used by the 分栏视图 swap button
  // ("换文件") and the empty-state file picker. Same outline style as the
  // other tool icons so the doc-tools row stays visually homogeneous.
  function folderOpenIcon() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" ' +
      'viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">' +
      '<path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h207' +
      'q16 0 30.5 6t25.5 17l57 57h360q33 0 56.5 23.5T920-640H447l-80-80H160v480' +
      'l96-320h684L837-217q-8 26-29.5 41.5T760-160H160Zm84-80h516l72-240H316' +
      'l-72 240Zm0 0 72-240-72 240Zm-84-400v-80 80Z"/>' +
      '</svg>'
    );
  }

  // Material Symbols "edit" (pencil).
  function editIcon() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" ' +
      'viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">' +
      '<path d="M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17' +
      't30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Z' +
      'm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z"/>' +
      '</svg>'
    );
  }

  root.BaselineTOC = {
    buildHeadingIndex,
    mountHeadingAnchors,
    mountTOC,
    mountDocActions,
    mountProgressBar
  };
})(typeof window !== "undefined" ? window : globalThis);
