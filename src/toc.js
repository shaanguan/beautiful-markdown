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
 *     → builds a two-state right-edge entry. Collapsed (default) shows
 *       only a vertical tick ruler (one short bar per heading, length
 *       tracks level) under the doc-tools, right-edge aligned. Click a
 *       tick to expand: the 360px panel slides in AND the article
 *       reflows narrower (padding-right) — the panel shares the page
 *       surface with the article (no border/shadow), no overlay. The
 *       panel header has an × button to collapse back. Scroll-spy via
 *       IntersectionObserver keeps the active tick + panel item in sync
 *       regardless of which state is showing.
 *
 * The TOC is hidden when the document has fewer than 2 headings — no
 * point showing a one-item nav.
 */

(function (root) {
  "use strict";

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

  // Strip the trailing `<a class="bsw-heading-anchor">#</a>` (and any other
  // chrome) before reading the heading text, so re-indexes after the anchor
  // is mounted don't leak a literal "#" into the TOC entry.
  function headingTextContent(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(".bsw-heading-anchor").forEach((n) => n.remove());
    return clone.textContent;
  }

  function buildHeadingIndex(mountEl) {
    const nodes = mountEl.querySelectorAll("h1, h2, h3, h4, h5, h6");
    const used = new Set();
    const index = [];
    for (const el of nodes) {
      const cleanText = headingTextContent(el);
      let id = el.id;
      if (!id) {
        const base = slugify(cleanText);
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
        text: cleanText.trim(),
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
    // `near` is either a DOM element (anchor at its bounding box) or a
    // {x, y} viewport-coords object (anchor at that point — used for the
    // Download toast so it lands by the cursor instead of the button).
    let centerX, anchorTop, anchorBottom;
    if (near && typeof near.x === "number" && typeof near.y === "number") {
      centerX = near.x;
      anchorTop = near.y;
      anchorBottom = near.y;
    } else {
      const r = near.getBoundingClientRect();
      centerX = r.left + r.width / 2;
      anchorTop = r.top;
      anchorBottom = r.bottom;
    }
    toast.style.left = Math.round(centerX) + "px";
    const flipBelow = anchorTop < 60;
    toast.classList.toggle("is-below", flipBelow);
    toast.style.top = Math.round(flipBelow ? anchorBottom + 4 : anchorTop - 4) + "px";
    toast.classList.add("is-visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 1400);
  }

  // ── TOC sidebar ────────────────────────────────────────────────────

  // Resolve the right scroll container for anchor jumps and scroll-spy.
  // With the two-scroll-container layout, `.markdown-reading-view` scrolls
  // inside its own box in standard/wide; in full mode the window scrolls.
  // Pick by overflow rather than width-class so a future layout change
  // doesn't silently break the jump.
  function makeScrollerResolver(mountEl) {
    const readingView = mountEl.closest(".markdown-reading-view");
    const isScrollableOverflow = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.overflowY !== "auto" && cs.overflowY !== "scroll") return false;
      return el.scrollHeight > el.clientHeight + 1;
    };
    return () => {
      const viewContent = mountEl.closest(".view-content");
      if (viewContent && document.body.classList.contains("bsw-twopane-active")) {
        return viewContent;
      }
      if (isScrollableOverflow(readingView)) return readingView;
      if (!document.body.classList.contains("bsw-twopane-active")) {
        const app = document.querySelector(".app-container");
        if (isScrollableOverflow(app)) return app;
      }
      return null;
    };
  }

  function buildPanel(index, minLevel, getScroller, spyRef) {
    const panel = document.createElement("div");
    panel.className = "bsw-toc-panel";

    const header = document.createElement("div");
    header.className = "bsw-toc-header";
    const title = document.createElement("div");
    title.className = "bsw-toc-title";
    title.textContent = "Contents";
    header.appendChild(title);
    // Collapse-back button. Click handler is wired by the caller via
    // closeBtn — we don't know the container/state at panel-build time.
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "bsw-toc-close";
    closeBtn.setAttribute("aria-label", "Collapse contents");
    closeBtn.setAttribute("title", "Collapse contents");
    closeBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
      '<path d="M3 3 L11 11 M11 3 L3 11"/></svg>';
    header.appendChild(closeBtn);

    const list = document.createElement("nav");
    list.className = "bsw-toc-list";

    // Active item is click-driven (not scroll-spy). Once a click sets the
    // highlight, a scroll listener watches whether the user has scrolled
    // away from the landing position by more than ~3 line-heights; if so,
    // the highlight clears. A short cooldown lets the smooth scroll itself
    // settle without immediately clearing the just-set state.
    let activeEl = null;
    let activeHeadingEl = null;
    let activeScrollTarget = null;   // element with the scroll listener
    let driftWatching = false;       // false during smooth-scroll cooldown
    let driftHomingTimer = 0;
    let driftRaf = 0;

    const COOLDOWN_MS = 900;
    const DRIFT_LINES = 3;
    const LANDING_OFFSET_PX = 24;    // matches the click handler's -24 inset

    const detachDriftScroll = () => {
      if (activeScrollTarget) {
        activeScrollTarget.removeEventListener("scroll", onDriftScroll);
        activeScrollTarget = null;
      }
    };

    const checkDriftNow = () => {
      if (!activeEl || !driftWatching) return;
      if (!activeHeadingEl || !activeHeadingEl.isConnected) {
        setActive(null);
        return;
      }
      const scroller = getScroller();
      const sTop = scroller ? scroller.getBoundingClientRect().top : 0;
      const hTop = activeHeadingEl.getBoundingClientRect().top;
      const cs = getComputedStyle(activeHeadingEl);
      const lineHeight = parseFloat(cs.lineHeight)
        || (parseFloat(cs.fontSize) || 16) * 1.4;
      if (Math.abs((hTop - sTop) - LANDING_OFFSET_PX) > lineHeight * DRIFT_LINES) {
        setActive(null);
      }
    };

    const onDriftScroll = () => {
      if (driftRaf) return;
      driftRaf = requestAnimationFrame(() => {
        driftRaf = 0;
        checkDriftNow();
      });
    };

    const setActive = (a, headingEl) => {
      if (activeEl === a) return;
      if (activeEl) activeEl.classList.remove("is-active");
      activeEl = a;
      activeHeadingEl = a ? headingEl || null : null;
      driftWatching = false;
      if (driftHomingTimer) {
        clearTimeout(driftHomingTimer);
        driftHomingTimer = 0;
      }
      detachDriftScroll();
      if (!a) return;
      a.classList.add("is-active");
      // Wait out the smooth scroll, then start watching for drift. We also
      // re-check on the timer fire in case the scroll already settled but
      // no further scroll events will come (so onDriftScroll wouldn't run).
      const scroller = getScroller();
      activeScrollTarget = scroller || window;
      activeScrollTarget.addEventListener("scroll", onDriftScroll, { passive: true });
      driftHomingTimer = setTimeout(() => {
        driftHomingTimer = 0;
        driftWatching = true;
        checkDriftNow();
      }, COOLDOWN_MS);
    };

    const itemEls = new Map();
    for (const h of index) {
      const a = document.createElement("a");
      a.className = "bsw-toc-item";
      a.href = "#" + h.id;
      a.dataset.level = String(Math.min(h.level - minLevel + 1, 4));
      a.textContent = h.text;
      a.title = h.text;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const scroller = getScroller();
        if (scroller) {
          // Compute the heading's offset relative to the scroller, then
          // scrollTo — `scrollIntoView` walks up the ancestor chain and
          // sometimes lands on the wrong scroller (a parent flex box's
          // 1px overflow) when there are nested scroll contexts.
          const sRect = scroller.getBoundingClientRect();
          const eRect = h.el.getBoundingClientRect();
          const y = scroller.scrollTop + (eRect.top - sRect.top) - 24;
          scroller.scrollTo({ top: y, behavior: "auto" });
        } else {
          h.el.scrollIntoView({ behavior: "auto", block: "start" });
        }
        history.replaceState(null, "", "#" + h.id);
        setActive(a, h.el);
        // Pin the active id for a short window so the scroll-spy doesn't
        // immediately rewrite it to a neighbor (the spy band sits at
        // 10-30% of viewport; a click-target lands at ~24px from the top,
        // ABOVE the band, so the next heading inside the band would
        // otherwise win and the highlight would drift one section down).
        if (spyRef && typeof spyRef.pinTo === "function") spyRef.pinTo(h.id);
      });
      itemEls.set(h.id, a);
      list.appendChild(a);
    }

    panel.appendChild(header);
    panel.appendChild(list);
    return { panel, itemEls, setActive, closeBtn };
  }

  function buildRuler(index, minLevel, itemEls, onTickClick) {
    const ruler = document.createElement("div");
    ruler.className = "bsw-toc-ruler";
    ruler.setAttribute("aria-hidden", "true");
    // Drives gap clamp() in extension.css so denser docs auto-compress
    // without spilling past 60vh.
    ruler.style.setProperty("--bsw-ruler-count", String(index.length));

    const tickEls = new Map();
    for (const h of index) {
      const tick = document.createElement("button");
      tick.type = "button";
      tick.className = "bsw-toc-tick";
      tick.dataset.id = h.id;
      tick.dataset.level = String(Math.min(h.level - minLevel + 1, 4));
      tick.dataset.tooltip = h.text;
      tick.addEventListener("click", (e) => {
        e.stopPropagation();
        // Open the panel first (caller toggles the expand class), then
        // delegate to the panel item's click handler — same scroll math,
        // same history update, same setActive.
        if (typeof onTickClick === "function") onTickClick(h.id);
        const item = itemEls.get(h.id);
        if (item) item.click();
      });
      tickEls.set(h.id, tick);
      ruler.appendChild(tick);
    }
    return { ruler, tickEls };
  }

  // Click-driven expand/collapse. Two state classes on .view-content:
  //   bsw-with-toc       — TOC mounted (always on while mounted)
  //   bsw-toc-expanded   — panel open, article reflows narrower
  // Returns {expand, collapse} closures plus the wired close button. The
  // tick clicks and ruler-blank clicks are wired by mountTOC (which owns
  // the ruler element).
  function wireClickToggle(container, closeBtn) {
    const expand = () => container.classList.add("bsw-toc-expanded");
    const collapse = () => container.classList.remove("bsw-toc-expanded");
    const onClose = (e) => {
      e.preventDefault();
      e.stopPropagation();
      collapse();
    };
    closeBtn.addEventListener("click", onClose);
    return { expand, collapse, destroy() {
      closeBtn.removeEventListener("click", onClose);
    } };
  }

  function setupScrollSpy(index, itemEls, tickEls, getScroller, setPanelActive) {
    if (typeof IntersectionObserver !== "function") {
      return { disconnect: () => {}, pinTo: () => {} };
    }
    const scroller = getScroller();
    let lastId = null;
    let pinnedId = null;
    let pinnedUntil = 0;
    const apply = (id) => {
      // While pinned (set by a TOC click), ignore observer-driven changes
      // unless the observer happens to agree with the pinned id. The pin
      // lasts long enough for the post-click scroll/layout to settle but
      // expires before user starts scrolling again.
      if (Date.now() < pinnedUntil && id !== pinnedId) return;
      if (id === lastId) return;
      lastId = id;
      for (const t of tickEls.values()) t.classList.remove("is-active");
      const tick = id ? tickEls.get(id) : null;
      if (tick) tick.classList.add("is-active");
      // Mirror to panel so opening the overlay shows the same active row.
      const item = id ? itemEls.get(id) : null;
      if (item) setPanelActive(item);
    };
    const pinTo = (id) => {
      pinnedId = id;
      pinnedUntil = Date.now() + 500;
      apply(id);
    };
    let io, scrollTarget, onScroll;
    const wire = () => {
      const sc = getScroller();
      io = new IntersectionObserver(
        (entries) => {
          const visible = entries
            .filter((e) => e.isIntersecting)
            .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          if (!visible.length) return;
          apply(visible[0].target.id);
        },
        { root: sc || null, rootMargin: "-10% 0px -70% 0px", threshold: 0 }
      );
      for (const h of index) {
        if (h.el && h.id) io.observe(h.el);
      }
      scrollTarget = sc || window;
      onScroll = () => {
        const el = sc || document.scrollingElement || document.documentElement;
        if (!el || !index.length) return;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
        if (atBottom) apply(index[index.length - 1].id);
      };
      scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    };
    const teardown = () => {
      if (io) io.disconnect();
      if (scrollTarget) scrollTarget.removeEventListener("scroll", onScroll);
    };
    wire();
    return {
      disconnect: teardown,
      reconnect: () => { teardown(); wire(); },
      pinTo
    };
  }

  function mountTOC(index, mountEl) {
    if (!Array.isArray(index) || index.length < 2) return null;

    // One-time cleanup of the legacy collapsed-state persistence — the
    // new model is ephemeral (every page-load starts collapsed) so a
    // stale value would be silently ignored. Drop the key to keep
    // chrome.storage tidy.
    try { chrome.storage.local.remove("tocCollapsed"); } catch { /* no-op */ }

    const contentWrap = ensureContentWrap(mountEl);
    if (!contentWrap) return null;
    const container = contentWrap.parentNode;

    // .view-content gets bsw-with-toc as a "TOC mounted" marker. The
    // bsw-toc-expanded class (added on tick click) is what actually
    // reflows the article and slides the panel in. Default state: only
    // bsw-with-toc — ruler visible, article full width.
    container.classList.add("bsw-with-toc");

    // Re-base levels so an h2-starting doc still gets visual tier 1; cap
    // at 4 tiers (h5/h6 fold into tier 4).
    const minLevel = Math.min(...index.map((h) => h.level));
    const getScroller = makeScrollerResolver(mountEl);

    const aside = document.createElement("aside");
    aside.className = "bsw-column-toc";
    aside.setAttribute("aria-label", "Table of contents");

    // spyRef is a mutable ref filled in after setupScrollSpy runs, so the
    // click handlers built inside buildPanel can call into the spy's
    // pinTo without a forward-reference dance.
    const spyRef = { pinTo: null };
    const { panel, itemEls, setActive, closeBtn } = buildPanel(index, minLevel, getScroller, spyRef);
    aside.appendChild(panel);
    container.appendChild(aside);

    const toggle = wireClickToggle(container, closeBtn);

    const { ruler, tickEls } = buildRuler(index, minLevel, itemEls, () => toggle.expand());
    container.appendChild(ruler);
    // Touch / no-hover fallback: tap on the ruler background (not a tick)
    // also expands.
    const onRulerBlankClick = (e) => { if (e.target === ruler) toggle.expand(); };
    ruler.addEventListener("click", onRulerBlankClick);

    const spyHandle = setupScrollSpy(index, itemEls, tickEls, getScroller, setActive);
    spyRef.pinTo = spyHandle.pinTo;
    const unspy = spyHandle.disconnect;

    return {
      reconnectSpy() { spyHandle.reconnect(); },
      destroy() {
        toggle.destroy();
        unspy();
        ruler.removeEventListener("click", onRulerBlankClick);
        // Stale-destroy guard: destroyChromeHandle wraps in Promise.resolve,
        // so this can fire AFTER a newer mountTOC has already swapped in
        // fresh ruler/aside (cleanupColumnChrome detached ours). Stripping
        // bsw-with-toc / bsw-toc-expanded then would wipe state belonging
        // to the new mount — most visibly: split → full via right-column
        // would leave the new TOC mounted but classless, and clicking a
        // tick would hide the ruler without sliding in the panel.
        if (ruler.isConnected) {
          container.classList.remove("bsw-with-toc", "bsw-toc-expanded");
        }
        ruler.remove();
        aside.remove();
      }
    };
  }

  // ── Doc tools (copy / swap / download / toc-toggle) ────────────────
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

    // Re-render: drop existing width dropdown + action buttons before
    // re-adding so streaming refreshes don't stack duplicates.
    for (const old of tools.querySelectorAll(
      ":scope > .bsw-width-dropdown, " +
      ":scope > [data-action='edit'], " +
      ":scope > [data-action='editorial'], " +
      ":scope > [data-action='copy'], " +
      ":scope > [data-action='swap'], " +
      ":scope > [data-action='save'], " +
      ":scope > [data-action='saveback'], " +
      ":scope > [data-action='download']"
    )) {
      old.remove();
    }

    // Track elements added by THIS mount so destroy() only removes its own —
    // mountChrome is async, and a stale handle's destroy used to clear by
    // querying [data-action=...], which also nuked the freshly-mounted
    // buttons of a newer invocation (left toolbar disappearing on
    // enableSplit). In toc's design there is no .bsw-toc-toggle in tools
    // (the toggle moved to the ruler/aside) so insert() simply appends —
    // insertion order = visual order L→R.
    const toggle = tools.querySelector(":scope > .bsw-toc-toggle");
    const ownButtons = [];
    const insert = (btn) => {
      if (toggle) tools.insertBefore(btn, toggle);
      else tools.appendChild(btn);
      ownButtons.push(btn);
    };

    // Save — single button: write-back / Save As / download fallback.
    // Placed leftmost; dirty dot when edits are pending. Callers pass
    // hideSave=true when a local file is clean (disk still authoritative).
    let saveBtn = null;
    if (opts && typeof opts.onSave === "function") {
      saveBtn = makeToolButton({
        action: "save",
        tooltip: opts.saveTooltip || "保存",
        svg: saveIcon(),
        onClick: (ev) => {
          const clickPoint = ev && typeof ev.clientX === "number" && ev.clientX > 0
            ? { x: ev.clientX, y: ev.clientY }
            : saveBtn;
          Promise.resolve()
            .then(() => opts.onSave())
            .then((result) => {
              saveBtn.classList.remove("is-dirty");
              const mode = result && result.mode;
              const toast = mode === "download"
                ? (opts.saveDownloadText || "已下载")
                : (opts.saveDoneText || "已保存");
              showToast(clickPoint, toast);
            })
            .catch((err) => {
              if (err && (err.name === "AbortError" || /cancelled/i.test(err.message || ""))) {
                return; // user dismissed Save As — no toast
              }
              console.warn("[Baseline] save failed:", err);
              const denied = err && /permission/i.test(err.message || "");
              showToast(clickPoint, denied ? "未获得写入权限" : "保存失败");
            });
        }
      });
      if (opts.isDirty) saveBtn.classList.add("is-dirty");
      if (opts.hideSave) saveBtn.classList.add("bsw-hidden");
      insert(saveBtn);
    }

    // AI dropdown — translate + editorial layout modes.
    let edDropdown = null;
    let edMenu = null;
    let transDropdown = null;
    let transMenu = null;
    if (opts && typeof opts.onEditorial === "function") {
      edDropdown = document.createElement("div");
      edDropdown.className = "bsw-width-dropdown";

      const edTrigger = document.createElement("button");
      edTrigger.type = "button";
      edTrigger.className = "bsw-doc-tool bsw-width-trigger";
      edTrigger.dataset.action = "editorial";
      edTrigger.dataset.tooltip = "AI";
      edTrigger.setAttribute("aria-label", "AI");
      edTrigger.setAttribute("aria-haspopup", "menu");
      edTrigger.setAttribute("aria-expanded", "false");
      edTrigger.innerHTML = editorialIcon();
      edTrigger.addEventListener("click", (ev) => {
        ev.stopPropagation();
        var wasOpen = edMenu && !edMenu.hidden;
        closeAllMenus();
        if (!wasOpen) {
          edMenu.hidden = false;
          edTrigger.setAttribute("aria-expanded", "true");
          document.dispatchEvent(new CustomEvent("bsw:toolbar-open"));
        }
      });
      edDropdown.appendChild(edTrigger);

      edMenu = document.createElement("div");
      edMenu.className = "bsw-width-menu";
      edMenu.setAttribute("role", "menu");
      edMenu.hidden = true;
      var edModes = [
        { value: "slides", label: "AI Slides", icon:
          '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor">' +
          '<path d="m380-300 280-180-280-180v360ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560' +
          'q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm0-560v560-560Z"/></svg>' },
        { value: "report", label: "AI Report", icon:
          '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor">' +
          '<path d="M240-80q-50 0-85-35t-35-85v-120h120v-560h600v680q0 50-35 85t-85 35H240Zm480-80' +
          'q17 0 28.5-11.5T760-200v-600H320v480h360v120q0 17 11.5 28.5T720-160ZM360-600v-80h360v80H360Z' +
          'm0 120v-80h360v80H360ZM240-160h360v-80H200v40q0 17 11.5 28.5T240-160Zm0 0h-40 400-360Z"/></svg>' },
        { value: "dashboard", label: "AI Dashboard", icon:
          '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor">' +
          '<path d="M160-200q-33 0-56.5-23.5T80-280v-400q0-33 23.5-56.5T160-760h640q33 0 56.5 23.5T880-680v400' +
          'q0 33-23.5 56.5T800-200H160Zm400-320h240v-160H560v160ZM160-280h320v-400H160v400Zm160-140' +
          'q-25 0-42.5-17.5T260-480q0-25 17.5-42.5T320-540q25 0 42.5 17.5T380-480q0 25-17.5 42.5T320-420Z' +
          'm240 140h240v-160H560v160Z"/></svg>' }
      ];
      // Translate item (first in AI menu) — click label → suggested lang; click arrow → expand inline lang list
      if (typeof opts.onTranslateWithLang === "function" && Array.isArray(opts.translateLanguages)) {
        var suggested = opts.suggestedTargetLang || "English";
        var nativeNames = {
          "Auto": "Auto", "English": "English", "Chinese": "中文",
          "Spanish": "Español", "French": "Français", "German": "Deutsch",
          "Japanese": "日本語", "Korean": "한국어", "Portuguese": "Português", "Russian": "Русский"
        };

        const transRow = document.createElement("div");
        transRow.className = "bsw-ai-translate-row";

        const transLabel = document.createElement("button");
        transLabel.type = "button";
        transLabel.className = "bsw-width-option bsw-ai-translate-label";
        transLabel.setAttribute("role", "menuitem");
        transLabel.innerHTML =
          '<span class="bsw-width-option-icon">' + translateToolIcon() + '</span>' +
          '<span class="bsw-width-option-label">AI Translate</span>';
        transLabel.addEventListener("click", (ev) => {
          ev.stopPropagation();
          edMenu.hidden = true;
          edTrigger.setAttribute("aria-expanded", "false");
          Promise.resolve(opts.onTranslateWithLang(suggested)).then((res) => {
            if (res && res.error) showToast(edTrigger, res.error);
          });
        });

        const expandBtn = document.createElement("button");
        expandBtn.type = "button";
        expandBtn.className = "bsw-ai-translate-expand";
        expandBtn.setAttribute("aria-label", "选择语言");
        expandBtn.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>';

        const langList = document.createElement("div");
        langList.className = "bsw-ai-lang-list";
        langList.hidden = true;

        var langs = opts.translateLanguages.slice();
        var si = langs.indexOf(suggested);
        if (si > 0) { langs.splice(si, 1); langs.unshift(suggested); }
        for (var li = 0; li < langs.length; li++) {
          const lang = langs[li];
          const langBtn = document.createElement("button");
          langBtn.type = "button";
          langBtn.className = "bsw-width-option bsw-ai-lang-option" + (li === 0 ? " bsw-translate-suggested" : "");
          langBtn.dataset.value = lang;
          langBtn.setAttribute("role", "menuitem");
          langBtn.innerHTML = '<span class="bsw-width-option-label"></span>';
          langBtn.querySelector(".bsw-width-option-label").textContent = nativeNames[lang] || lang;
          langBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            edMenu.hidden = true;
            edTrigger.setAttribute("aria-expanded", "false");
            Promise.resolve(opts.onTranslateWithLang(lang)).then((res) => {
              if (res && res.error) showToast(edTrigger, res.error);
            });
          });
          langList.appendChild(langBtn);
        }

        expandBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          langList.hidden = !langList.hidden;
          expandBtn.classList.toggle("is-open", !langList.hidden);
        });

        transRow.appendChild(transLabel);
        transRow.appendChild(expandBtn);
        edMenu.appendChild(transRow);
        edMenu.appendChild(langList);
      }

      for (const mode of edModes) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "bsw-width-option";
        item.dataset.value = mode.value;
        item.setAttribute("role", "menuitem");
        item.innerHTML =
          '<span class="bsw-width-option-icon">' + mode.icon + '</span>' +
          '<span class="bsw-width-option-label"></span>';
        item.querySelector(".bsw-width-option-label").textContent = mode.label;
        item.addEventListener("click", (ev) => {
          ev.stopPropagation();
          edMenu.hidden = true;
          edTrigger.setAttribute("aria-expanded", "false");
          Promise.resolve(opts.onEditorial(mode.value)).then((res) => {
            if (res && res.error) showToast(edTrigger, res.error);
          });
        });
        edMenu.appendChild(item);
      }
      edDropdown.appendChild(edMenu);
      insert(edDropdown);
    }

    // Width dropdown comes after Save, followed by copy/swap.
    // The trigger is a single borderless icon button showing the current
    // selection; clicking opens a popup menu with icon+label rows. Caller
    // declares the option list (filtered per-surface: md gets Split, viewer
    // gets Bilingual) and the current selection; mountDocActions repaints
    // both the trigger icon and the active menu row on every call so
    // streaming refreshes don't flash.
    const withWidthControls = !opts || opts.withWidthControls !== false;
    const widthOptions = (opts && Array.isArray(opts.widthOptions)) ? opts.widthOptions : [];
    let widthDropdown = null;
    let widthTrigger = null;
    let widthMenu = null;
    let widthCurrent = opts && opts.currentWidth;
    let docClickHandler = null;
    let docKeyHandler = null;
    const widthOptionEls = new Map();
    function findWidthOption(value) {
      return widthOptions.find((w) => w.value === value) || widthOptions[0];
    }
    function closeWidthMenu() {
      if (widthMenu && !widthMenu.hidden) {
        widthMenu.hidden = true;
        if (widthTrigger) widthTrigger.setAttribute("aria-expanded", "false");
      }
    }
    function openWidthMenu() {
      if (widthMenu && widthMenu.hidden) {
        widthMenu.hidden = false;
        if (widthTrigger) widthTrigger.setAttribute("aria-expanded", "true");
        document.dispatchEvent(new CustomEvent("bsw:toolbar-open"));
      }
    }
    function paintActiveWidth(value) {
      widthCurrent = value;
      const cur = findWidthOption(value);
      if (widthTrigger && cur) {
        widthTrigger.innerHTML = widthIconFor(cur.value);
        widthTrigger.dataset.value = cur.value;
        widthTrigger.dataset.tooltip = cur.label;
        widthTrigger.setAttribute("aria-label", cur.label);
      }
      for (const [v, el] of widthOptionEls) {
        el.classList.toggle("is-active", v === value);
      }
    }
    if (withWidthControls && widthOptions.length && opts && typeof opts.onWidthChange === "function") {
      widthDropdown = document.createElement("div");
      widthDropdown.className = "bsw-width-dropdown";

      widthTrigger = document.createElement("button");
      widthTrigger.type = "button";
      widthTrigger.className = "bsw-doc-tool bsw-width-trigger";
      widthTrigger.dataset.action = "width";
      widthTrigger.setAttribute("aria-haspopup", "menu");
      widthTrigger.setAttribute("aria-expanded", "false");
      widthTrigger.addEventListener("click", (ev) => {
        ev.stopPropagation();
        var wasOpen = !widthMenu.hidden;
        closeAllMenus();
        if (!wasOpen) openWidthMenu();
      });
      widthDropdown.appendChild(widthTrigger);

      widthMenu = document.createElement("div");
      widthMenu.className = "bsw-width-menu";
      widthMenu.setAttribute("role", "menu");
      widthMenu.hidden = true;
      for (const w of widthOptions) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "bsw-width-option";
        item.dataset.value = w.value;
        item.setAttribute("role", "menuitemradio");
        item.innerHTML =
          '<span class="bsw-width-option-icon">' + widthIconFor(w.value) + '</span>' +
          '<span class="bsw-width-option-label"></span>';
        item.querySelector(".bsw-width-option-label").textContent = w.label;
        item.addEventListener("click", (ev) => {
          ev.stopPropagation();
          paintActiveWidth(w.value);
          closeWidthMenu();
          opts.onWidthChange(w.value);
        });
        widthOptionEls.set(w.value, item);
        widthMenu.appendChild(item);
      }
      widthDropdown.appendChild(widthMenu);
      insert(widthDropdown);

      paintActiveWidth(widthCurrent || (widthOptions[0] && widthOptions[0].value));
    }

    // Shared outside-click / Escape handler for all dropdowns.
    function closeAllMenus() {
      if (widthMenu && !widthMenu.hidden) {
        widthMenu.hidden = true;
        if (widthTrigger) widthTrigger.setAttribute("aria-expanded", "false");
      }
      if (transMenu && !transMenu.hidden) {
        transMenu.hidden = true;
        var tt = transDropdown && transDropdown.querySelector(".bsw-width-trigger");
        if (tt) tt.setAttribute("aria-expanded", "false");
      }
      if (edMenu && !edMenu.hidden) {
        edMenu.hidden = true;
        var et = edDropdown && edDropdown.querySelector(".bsw-width-trigger");
        if (et) et.setAttribute("aria-expanded", "false");
      }
    }
    if (widthDropdown || transDropdown || edDropdown) {
      docClickHandler = (ev) => {
        if (widthDropdown && widthDropdown.contains(ev.target)) return;
        if (transDropdown && transDropdown.contains(ev.target)) return;
        if (edDropdown && edDropdown.contains(ev.target)) return;
        closeAllMenus();
      };
      docKeyHandler = (ev) => {
        if (ev.key === "Escape") closeAllMenus();
      };
      document.addEventListener("click", docClickHandler);
      document.addEventListener("keydown", docKeyHandler);
      document.addEventListener("bsw:panel-open", closeAllMenus);
    }

    // Copy — raw markdown to clipboard.
    if (opts && typeof opts.onCopy === "function") {
      const copyBtn = makeToolButton({
        action: "copy",
        tooltip: opts.copyTooltip || "复制全文",
        svg: copyIcon(),
        onClick: () => {
          let text = "";
          try { text = opts.onCopy(); } catch (_) {}
          copyToClipboard(String(text || "")).then((ok) => {
            showToast(copyBtn, ok ? (opts.copyDoneText || "Copied") : "Copy failed");
          });
        }
      });
      insert(copyBtn);
    }

    if (opts && typeof opts.onSwap === "function") {
      insert(makeToolButton({
        action: "swap",
        tooltip: opts.swapTooltip || "打开其他",
        svg: folderOpenIcon(),
        onClick: () => opts.onSwap()
      }));
    }

    return {
      destroy() {
        if (docClickHandler) document.removeEventListener("click", docClickHandler);
        if (docKeyHandler) document.removeEventListener("keydown", docKeyHandler);
        for (const el of ownButtons) {
          if (el && el.parentNode) el.parentNode.removeChild(el);
        }
      },
      setDirty(dirty) {
        if (saveBtn) saveBtn.classList.toggle("is-dirty", !!dirty);
      },
      setSaveVisible(visible) {
        if (!saveBtn) return;
        saveBtn.classList.toggle("bsw-hidden", !visible);
      },
      // Alias kept for callers still using the old name during migration.
      setDownloadVisible(visible) {
        if (!saveBtn) return;
        saveBtn.classList.toggle("bsw-hidden", !visible);
      },
      setActiveWidth(value) {
        if (widthOptionEls.size) paintActiveWidth(value);
      }
    };
  }

  // ── Icons ──────────────────────────────────────────────────────────

  // "Copy as Markdown" glyph (Material Symbols copy with an "M" mark).
  // Tinted via currentColor so it follows the theme like the other icons.
  function copyIcon() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" ' +
      'viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">' +
      '<path d="M360-240q-33 0-56.5-23.5T280-320v-480q0-33 23.5-56.5T360-880h360' +
      'q33 0 56.5 23.5T800-800v480q0 33-23.5 56.5T720-240H360Zm0-80h360v-480H360v480Z' +
      'M200-80q-33 0-56.5-23.5T120-160v-560h80v560h440v80H200Zm210-360h60v-180h40v120h60' +
      'v-120h40v180h60v-200q0-17-11.5-28.5T630-680H450q-17 0-28.5 11.5T410-640v200Z' +
      'm-50 120v-480 480Z"/>' +
      '</svg>'
    );
  }

  // Material Symbols "save" — write-back-to-original-file button.
  function saveIcon() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" ' +
      'viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">' +
      '<path d="M840-680v480q0 33-23.5 56.5T760-120H200q-33 0-56.5-23.5T120-200' +
      'v-560q0-33 23.5-56.5T200-840h480l160 160Zm-80 34L646-760H200v560h560v-446Z' +
      'M480-240q50 0 85-35t35-85q0-50-35-85t-85-35q-50 0-85 35t-35 85q0 50 35 85t85 35Z' +
      'M240-560h360v-160H240v160Zm-40-86v446-560 114Z"/>' +
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

  // Width-mode glyphs — 24×24 mini document layouts (text lines only, no
  // paper frame). Filled with currentColor so they follow the same theme
  // tint as edit/copy/swap. Used by the dropdown trigger (current
  // selection) and each menu option row.
  function widthIconFor(value) {
    const open =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" ' +
      'viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">';
    const close = '</svg>';
    switch (value) {
      case "standard":
        return open +
          '<rect x="6" y="7" width="12" height="2"/>' +
          '<rect x="6" y="11" width="12" height="2"/>' +
          '<rect x="6" y="15" width="8" height="2"/>' +
          '<rect x="0" y="5" width="2" height="14"/>' +
          '<rect x="22" y="5" width="2" height="14"/>' + close;
      case "wide":
        return open +
          '<rect x="4" y="7" width="16" height="2"/>' +
          '<rect x="4" y="11" width="16" height="2"/>' +
          '<rect x="4" y="15" width="11" height="2"/>' +
          '<rect x="0" y="5" width="2" height="14"/>' +
          '<rect x="22" y="5" width="2" height="14"/>' + close;
      case "full":
        return open +
          '<rect x="2" y="7" width="20" height="2"/>' +
          '<rect x="2" y="11" width="20" height="2"/>' +
          '<rect x="2" y="15" width="13" height="2"/>' + close;
      case "split":
      case "bilingual":
        return open +
          '<rect x="4" y="7" width="7" height="2"/>' +
          '<rect x="4" y="11" width="7" height="2"/>' +
          '<rect x="4" y="15" width="4" height="2"/>' +
          '<rect x="13" y="7" width="7" height="2"/>' +
          '<rect x="13" y="11" width="7" height="2"/>' +
          '<rect x="13" y="15" width="5" height="2"/>' + close;
      default:
        return open + '<rect x="6" y="11" width="12" height="2"/>' + close;
    }
  }

  // Material Symbols "edit" (pencil) — the editor open affordance.
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

  // Material Symbols "download" — save the current markdown to disk.
  // Same outline weight as the other tool icons.
  function downloadIcon() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" ' +
      'viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">' +
      '<path d="M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200Z' +
      'M240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z"/>' +
      '</svg>'
    );
  }

  function editorialIcon() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" ' +
      'viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">' +
      '<path d="m176-120-56-56 301-302-181-45 198-123-17-234 179 151 216-88-87 217 151 178-234-16-124 198-45-181-301 301Z' +
      'm24-520-80-80 80-80 80 80-80 80Zm355 197 48-79 93 7-60-71 35-86-86 35-71-59 7 92-79 49 90 22 23 90Z' +
      'm165 323-80-80 80-80 80 80-80 80ZM569-570Z"/>' +
      '</svg>'
    );
  }

  function translateToolIcon() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" ' +
      'viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">' +
      '<path d="m475-80 181-480h82L920-80h-83l-43-122H603L560-80h-85ZM160-200' +
      'l-56-56 202-202q-35-35-63.5-80T190-640h84q20 39 40.5 68t48.5 58q33-33 68.5-92.5' +
      'T463-720H40v-80h280v-80h80v80h280v80H543q-23 75-61 148t-83 116l96 98-30 82-122-125' +
      '-202 201Zm468-72h144l-72-204-72 204Z"/>' +
      '</svg>'
    );
  }

  function cleanupColumnChrome(mountEl) {
    const container = mountEl && mountEl.closest(".view-content");
    if (!container) return;
    // mountTOC appends both .bsw-column-toc and .bsw-toc-ruler as direct
    // children of .view-content (sibling to .bsw-content-wrap), so look
    // for them there. Re-renders / translation streams call this before
    // re-mounting; leftovers from a prior pass would otherwise stack.
    const oldAside = container.querySelector(":scope > .bsw-column-toc");
    if (oldAside) oldAside.remove();
    const oldRuler = container.querySelector(":scope > .bsw-toc-ruler");
    if (oldRuler) oldRuler.remove();
    // Strip state classes — the next mountTOC re-adds bsw-with-toc, and
    // bsw-toc-collapsed is a legacy class from the toggle-based layout
    // (safe to remove unconditionally; cleans up older builds).
    container.classList.remove("bsw-with-toc", "bsw-toc-expanded", "bsw-toc-collapsed");
  }

  function mountChrome(mountEl, opts) {
    if (!mountEl) return null;
    cleanupColumnChrome(mountEl);
    const headingIndex = buildHeadingIndex(mountEl);
    mountHeadingAnchors(headingIndex);
    let tocHandle = null;
    const withTOC = !opts || opts.withTOC !== false;
    if (withTOC) {
      tocHandle = mountTOC(headingIndex, mountEl);
    }
    let actionsHandle = null;
    if (opts) {
      const actionOpts = {};
      if (typeof opts.getMarkdown === "function") {
        actionOpts.getMarkdown = opts.getMarkdown;
        actionOpts.onCopy = () => opts.getMarkdown();
      }
      if (typeof opts.onEdit === "function") {
        actionOpts.onEdit = opts.onEdit;
      }
      if (opts.editTooltip) actionOpts.editTooltip = opts.editTooltip;
      if (opts.copyTooltip) actionOpts.copyTooltip = opts.copyTooltip;
      if (opts.copyDoneText) actionOpts.copyDoneText = opts.copyDoneText;
      if (typeof opts.onSwap === "function") {
        actionOpts.onSwap = opts.onSwap;
      }
      if (opts.swapTooltip) actionOpts.swapTooltip = opts.swapTooltip;
      if (typeof opts.onSave === "function") {
        actionOpts.onSave = opts.onSave;
      }
      if (opts.saveTooltip) actionOpts.saveTooltip = opts.saveTooltip;
      if (opts.saveDoneText) actionOpts.saveDoneText = opts.saveDoneText;
      if (opts.saveDownloadText) actionOpts.saveDownloadText = opts.saveDownloadText;
      if (typeof opts.onEditorial === "function") {
        actionOpts.onEditorial = opts.onEditorial;
      }
      if (opts.editorialTooltip) actionOpts.editorialTooltip = opts.editorialTooltip;
      if (typeof opts.onTranslateWithLang === "function") {
        actionOpts.onTranslateWithLang = opts.onTranslateWithLang;
      }
      if (Array.isArray(opts.translateLanguages)) actionOpts.translateLanguages = opts.translateLanguages;
      if (opts.suggestedTargetLang) actionOpts.suggestedTargetLang = opts.suggestedTargetLang;
      if (opts.isDirty) actionOpts.isDirty = true;
      if (opts.hideSave) actionOpts.hideSave = true;
      if (Array.isArray(opts.widthOptions)) actionOpts.widthOptions = opts.widthOptions;
      if (opts.currentWidth) actionOpts.currentWidth = opts.currentWidth;
      if (typeof opts.onWidthChange === "function") actionOpts.onWidthChange = opts.onWidthChange;
      if (opts.withWidthControls === false) actionOpts.withWidthControls = false;
      actionsHandle = mountDocActions(mountEl, actionOpts);
    }
    return {
      destroy() {
        if (tocHandle) tocHandle.destroy();
        if (actionsHandle) actionsHandle.destroy();
      },
      reconnectSpy() {
        if (tocHandle && typeof tocHandle.reconnectSpy === "function") tocHandle.reconnectSpy();
      },
      setDirty(dirty) {
        if (actionsHandle && typeof actionsHandle.setDirty === "function") {
          actionsHandle.setDirty(dirty);
        }
      },
      setActiveWidth(value) {
        if (actionsHandle && typeof actionsHandle.setActiveWidth === "function") {
          actionsHandle.setActiveWidth(value);
        }
      },
      setSaveVisible(visible) {
        if (actionsHandle && typeof actionsHandle.setSaveVisible === "function") {
          actionsHandle.setSaveVisible(visible);
        } else if (actionsHandle && typeof actionsHandle.setDownloadVisible === "function") {
          actionsHandle.setDownloadVisible(visible);
        }
      },
      setDownloadVisible(visible) {
        if (actionsHandle && typeof actionsHandle.setSaveVisible === "function") {
          actionsHandle.setSaveVisible(visible);
        } else if (actionsHandle && typeof actionsHandle.setDownloadVisible === "function") {
          actionsHandle.setDownloadVisible(visible);
        }
      }
    };
  }

  // Single document-level paste listener; all pages share one registry so
  // viewer → BaselineSurface handoff can unregister/re-register columns.
  let pasteListenerBound = false;
  let pasteHoveredColumn = null;
  const pasteRegistry = new Map();
  let pasteIsEditable = () => false;
  let pasteConfirmReplace = () =>
    window.confirm("Replace current content with pasted Markdown?");
  // Last contextmenu position, used by the「粘贴 Markdown」extension menu
  // to route the paste in split view. Captured on mousedown (right button)
  // and the contextmenu event itself — whichever fires first on this page.
  let lastContextmenuPos = { x: 0, y: 0 };

  function resolvePasteColumn(e) {
    const fromTarget = e.target && e.target.closest
      ? e.target.closest(".view-content")
      : null;
    if (fromTarget && pasteRegistry.has(fromTarget)) return fromTarget;
    // Non-split: a single registered column handles every paste regardless
    // of where the user right-clicked (toolbar, gutter, body background).
    if (pasteRegistry.size === 1) return pasteRegistry.keys().next().value;
    // Split: prefer the column whose horizontal bounds contain the cursor,
    // so right-clicks on the header / gutter still route to the visually
    // adjacent column. mousedown→contextmenu carries clientX through.
    if (pasteRegistry.size > 1 && e && typeof e.clientX === "number") {
      for (const view of pasteRegistry.keys()) {
        const rect = view.getBoundingClientRect && view.getBoundingClientRect();
        if (!rect) continue;
        if (e.clientX >= rect.left && e.clientX <= rect.right) return view;
      }
    }
    if (pasteHoveredColumn && pasteRegistry.has(pasteHoveredColumn)) {
      return pasteHoveredColumn;
    }
    return pasteRegistry.size ? pasteRegistry.keys().next().value : null;
  }

  function bindColumnPaste({ isEditable, confirmReplace }) {
    if (typeof isEditable === "function") pasteIsEditable = isEditable;
    if (typeof confirmReplace === "function") pasteConfirmReplace = confirmReplace;

    function register(viewEl, handlers) {
      if (!viewEl) return;
      pasteRegistry.set(viewEl, handlers);
      if (viewEl.dataset.bswPasteReg) return;
      viewEl.dataset.bswPasteReg = "1";
      viewEl.addEventListener("mouseenter", () => {
        pasteHoveredColumn = viewEl;
      });
    }

    function unregister(viewEl) {
      pasteRegistry.delete(viewEl);
      if (pasteHoveredColumn === viewEl) pasteHoveredColumn = null;
    }

    if (!pasteListenerBound) {
      pasteListenerBound = true;
      // Track right-click position so the「粘贴 Markdown」menu can route to
      // the column the user actually pointed at. mousedown fires before the
      // OS shows the menu; contextmenu is the canonical signal.
      const recordPos = (e) => {
        if (typeof e.clientX === "number") {
          lastContextmenuPos = { x: e.clientX, y: e.clientY };
        }
      };
      document.addEventListener("mousedown", (e) => {
        if (e.button === 2) recordPos(e);
      }, true);
      document.addEventListener("contextmenu", recordPos, true);

      // Service worker → page: user clicked our context menu item. Read
      // clipboard now (the menu click counts as a user gesture in this tab)
      // and dispatch to the last-clicked column.
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((msg) => {
          if (!msg || msg.type !== "baselinePasteRequest") return;
          pasteFromClipboard({
            x: lastContextmenuPos.x,
            y: lastContextmenuPos.y
          });
        });
      }

      document.addEventListener("paste", (e) => {
        if (pasteIsEditable(e.target)) return;
        const cd = e.clipboardData || window.clipboardData;
        if (!cd) return;
        const text = cd.getData("text/plain");
        if (!text || !text.trim()) return;

        const column = resolvePasteColumn(e);
        if (!column) return;
        const handlers = pasteRegistry.get(column);
        if (!handlers || typeof handlers.onPaste !== "function") return;

        const hasContent = typeof handlers.hasContent === "function"
          ? handlers.hasContent()
          : false;
        if (hasContent && !pasteConfirmReplace()) return;

        e.preventDefault();
        handlers.onPaste(text);
      });
    }

    // Programmatic paste path used by the「粘贴 Markdown」context menu item.
    // The page's own contextmenu listener (baseline-shared.js) records the
    // cursor position; we reuse resolvePasteColumn so split-view routing
    // matches the native ⌘V path exactly.
    async function pasteFromClipboard(opts) {
      const x = opts && typeof opts.x === "number" ? opts.x : 0;
      const y = opts && typeof opts.y === "number" ? opts.y : 0;
      let text = "";
      try {
        text = await navigator.clipboard.readText();
      } catch (err) {
        console.warn("[Baseline] clipboard.readText failed:", err);
        return;
      }
      if (!text || !text.trim()) return;

      const synth = {
        clientX: x,
        clientY: y,
        target: document.elementFromPoint(x, y) || document.body
      };
      // The context menu now includes "editable" (so it shows on Open/Viewer
      // hero, which is contenteditable). On real form controls — actual
      // <input>/<textarea>/contenteditable not marked as our paste host —
      // bail so the user's clipboard text isn't redirected into the page
      // when they just wanted to paste into a search box.
      if (pasteIsEditable(synth.target)) return;
      const column = resolvePasteColumn(synth);
      if (!column) return;
      const handlers = pasteRegistry.get(column);
      if (!handlers || typeof handlers.onPaste !== "function") return;

      const hasContent = typeof handlers.hasContent === "function"
        ? handlers.hasContent()
        : false;
      if (hasContent && !pasteConfirmReplace()) return;

      handlers.onPaste(text);
    }

    return { register, unregister, pasteFromClipboard };
  }

  root.BaselineTOC = {
    buildHeadingIndex,
    mountHeadingAnchors,
    mountTOC,
    mountDocActions,
    mountChrome,
    bindColumnPaste,
    cleanupColumnChrome
  };
})(typeof window !== "undefined" ? window : globalThis);
