/**
 * Markdown → Obsidian-style HTML rendering pipeline.
 *
 * The output DOM mirrors Obsidian's preview structure so that the Baseline
 * theme.css selectors (.markdown-preview-view, .markdown-rendered, etc.)
 * apply with no modification:
 *
 *   <body class="theme-light/dark">
 *     <div class="app-container">
 *       <div class="horizontal-main-container">
 *         <div class="workspace">
 *           <div class="markdown-reading-view">
 *             <div class="markdown-preview-view markdown-rendered is-readable-line-width">
 *               ...rendered markdown...
 *             </div>
 *           </div>
 *         </div>
 *       </div>
 *     </div>
 *   </body>
 */

(function (root) {
  "use strict";

  const { marked } = root;
  const DOMPurify = root.DOMPurify;
  const hljs = root.hljs;
  const renderMathInElement = root.renderMathInElement;
  const { obsidianExtensions } = root.BaselineObsidianSyntax;
  // mermaid is intentionally NOT captured here. It's ~2.5 MB and most .md
  // files don't contain a single mermaid block, so we lazy-load it inside
  // runMermaid() the first time a `pre.mermaid` node appears.

  // highlight.js auto-detection runs EVERY bundled grammar (~190 of them)
  // over the whole block, which dominates render time on code-heavy docs —
  // and the viewer re-renders on every streaming chunk, so the cost stacks.
  // Restrict auto-detect to a common subset: ~8× cheaper, and the long tail
  // of exotic grammars rarely improves the result for real-world code.
  const HLJS_AUTO_SUBSET = [
    "javascript", "typescript", "python", "bash", "shell", "json", "yaml",
    "xml", "html", "css", "scss", "less", "markdown", "java", "kotlin",
    "c", "cpp", "csharp", "go", "rust", "ruby", "php", "sql", "swift",
    "objectivec", "dockerfile", "ini", "toml", "diff", "makefile", "plaintext"
  ];
  // Above this size, even single-grammar highlighting is costly enough to
  // jank the tab (think a pasted minified bundle or a giant log). Fall back
  // to plain escaped text so a huge block can't freeze rendering.
  const HLJS_MAX_HIGHLIGHT_CHARS = 50000;

  // Per-render base URL for resolving relative images (set in renderTo).
  let renderBaseUrl = "";

  const PURIFY_OPTS = {
    ADD_ATTR: [
      "data-href", "data-alt", "data-tag", "target",
      "src", "alt", "title", "width", "height", "dir"
    ],
    ADD_TAGS: ["mark", "sub", "sup"]
  };

  const IMG_SRC_SAFE =
    /^(?:https?:|data:|blob:|file:|chrome-extension:)/i;

  function resolveImageHref(href) {
    const raw = (href || "").trim();
    if (!raw || IMG_SRC_SAFE.test(raw)) return raw;
    if (!renderBaseUrl) return raw;
    try {
      return new URL(raw, renderBaseUrl).href;
    } catch {
      return raw;
    }
  }

  // Configure marked once.
  marked.use(obsidianExtensions);
  marked.use({
    gfm: true,
    breaks: false,
    pedantic: false,
    renderer: {
      image(href, title, text) {
        const src = escapeAttr(resolveImageHref(href));
        const alt = escapeAttr(text || "");
        const titleAttr = title
          ? ` title="${escapeAttr(title)}"`
          : "";
        return `<img src="${src}" alt="${alt}"${titleAttr} loading="lazy" decoding="async">`;
      },
      // Custom code block renderer: tag mermaid, run highlight.js otherwise.
      code(code, infostring) {
        const lang = (infostring || "").trim().split(/\s+/)[0];
        if (lang === "mermaid") {
          return `<pre class="mermaid">${escapeHTML(code)}</pre>`;
        }
        let highlighted;
        if (code.length > HLJS_MAX_HIGHLIGHT_CHARS) {
          // Too big to highlight without risking a visible stall.
          highlighted = escapeHTML(code);
        } else if (lang && hljs.getLanguage(lang)) {
          try {
            highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
          } catch {
            highlighted = escapeHTML(code);
          }
        } else {
          try {
            highlighted = hljs.highlightAuto(code, HLJS_AUTO_SUBSET).value;
          } catch {
            highlighted = escapeHTML(code);
          }
        }
        const langClass = lang ? ` language-${escapeAttr(lang)}` : "";
        return `<pre><code class="hljs${langClass}">${highlighted}</code></pre>`;
      }
    }
  });

  function escapeHTML(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function escapeAttr(s) { return escapeHTML(s).replace(/'/g, "&#39;"); }

  const RTL_CHAR =
    /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

  function resolveImageUrls(mountEl) {
    mountEl.querySelectorAll("img[src]").forEach((img) => {
      const attr = img.getAttribute("src");
      if (!attr) return;
      const resolved = resolveImageHref(attr);
      if (resolved && resolved !== attr) img.setAttribute("src", resolved);
    });
  }

  function applyRtlDirection(mountEl) {
    const blocks = mountEl.querySelectorAll(
      "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, " +
      "figcaption, .callout, .admonition"
    );
    for (const el of blocks) {
      const text = el.textContent || "";
      if (!text.trim() || !RTL_CHAR.test(text)) continue;
      el.setAttribute("dir", "rtl");
    }
  }

  /**
   * Render markdown source into a DOM tree (already attached to `mountEl`).
   * @param {string} source markdown text
   * @param {HTMLElement} mountEl container to mount into
   * @param {{ baseUrl?: string }} [options]
   */
  async function renderTo(source, mountEl, options) {
    const base =
      (options && options.baseUrl) ||
      (typeof location !== "undefined" ? location.href : "");
    renderBaseUrl = base;
    let rawHtml;
    try {
      rawHtml = marked.parse(source);
    } finally {
      renderBaseUrl = "";
    }
    const clean = DOMPurify.sanitize(rawHtml, PURIFY_OPTS);
    mountEl.innerHTML = clean;
    resolveImageUrls(mountEl);
    applyRtlDirection(mountEl);

    // KaTeX: render after DOM injection.
    try {
      renderMathInElement(mountEl, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
          { left: "\\[", right: "\\]", display: true }
        ],
        throwOnError: false
      });
    } catch (e) {
      console.warn("[Baseline] KaTeX render failed:", e);
    }

    // Mermaid: cache each block's original source so we can re-render on
    // mode change without losing the diagram.
    const mermaidNodes = mountEl.querySelectorAll("pre.mermaid");
    for (const node of mermaidNodes) {
      if (!node.dataset.mermaidSource) {
        node.dataset.mermaidSource = node.textContent;
      }
    }
    // Per user spec: "代码块右上角 copy 按钮只有在鼠标 hover 代码块的时候才显示"
    // — inject the chip in the DOM but hide it via CSS opacity until
    // pre:hover. Must run AFTER mermaid source-cache (above) and BEFORE
    // runMermaid wipes the node, otherwise a stray .bsw-code-copy would
    // land inside the rendered Mermaid SVG. mountEl.innerHTML wipe on
    // each render means stale buttons are gone for free; we only need
    // the delegated listener once.
    injectCopyButtons(mountEl);
    injectTaskCheckboxes(mountEl);
    // After task items are tagged — fold toggles must not sit on task rows
    // (they would stack on the checkbox and break parent/child task layout).
    injectListFolds(mountEl);
    await runMermaid(mountEl);

    // Promote first <h1> as document title for nicer browser tab.
    // Skip the write when unchanged — during streaming translation the
    // viewer calls renderTo() on every chunk, and re-assigning the same
    // title makes the tab flicker on some platforms.
    const h1 = mountEl.querySelector("h1");
    if (h1) {
      const t = h1.textContent.trim();
      if (t && document.title !== t) document.title = t;
    }
  }

  // Lazy Mermaid loader. The bundle is huge and Mermaid blocks are rare,
  // so we don't pay for it on every .md page. Two paths:
  //   - Extension page (chrome-extension://): direct <script> append; the
  //     UMD bundle assigns to window.mermaid in the same world.
  //   - Content script (isolated world on a regular page): a <script> tag
  //     would inject into the page's main world, where the IIFE assignment
  //     is invisible to us. Ask the background worker to executeScript()
  //     into our isolated world via chrome.scripting.executeScript.
  let mermaidPromise = null;
  function ensureMermaid() {
    if (root.mermaid) return Promise.resolve(root.mermaid);
    if (mermaidPromise) return mermaidPromise;
    mermaidPromise = (location.protocol === "chrome-extension:"
      ? loadMermaidDirect()
      : loadMermaidViaBackground()
    ).then(() => {
      if (!root.mermaid) throw new Error("Mermaid script loaded but window.mermaid is undefined");
      return root.mermaid;
    }).catch((err) => {
      // Reset so a retry on the next render attempt can try again rather
      // than silently failing forever.
      mermaidPromise = null;
      throw err;
    });
    return mermaidPromise;
  }

  function loadMermaidDirect() {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("vendor/mermaid.min.js");
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load vendor/mermaid.min.js"));
      document.head.appendChild(s);
    });
  }

  function loadMermaidViaBackground() {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "loadMermaid" }, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) { reject(new Error(err.message)); return; }
          if (!resp || !resp.ok) {
            reject(new Error((resp && resp.error) || "Mermaid load failed"));
            return;
          }
          resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * (Re)initialize Mermaid for the current color scheme and render every
   * mermaid block in `mountEl`. Safe to call repeatedly — each call resets
   * the block to its cached source, strips Mermaid's processing marker,
   * and re-renders, so mode switches produce a fresh SVG in the new theme.
   *
   * If the document contains no mermaid blocks we never touch the loader,
   * so .md files without mermaid never pay the ~2.5 MB script cost.
   */
  async function runMermaid(mountEl) {
    const nodes = mountEl.querySelectorAll("pre.mermaid");
    if (!nodes.length) return;
    let mermaid;
    try {
      mermaid = await ensureMermaid();
    } catch (e) {
      console.warn("[Baseline] Mermaid lazy-load failed:", e);
      return;
    }
    try {
      const isDark = document.body.classList.contains("theme-dark");
      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? "dark" : "default",
        securityLevel: "strict"
      });
      for (const node of nodes) {
        const src = node.dataset.mermaidSource;
        if (!src) continue;
        node.removeAttribute("data-processed");
        node.innerHTML = "";
        node.textContent = src;
      }
      await mermaid.run({ nodes });
    } catch (e) {
      console.warn("[Baseline] Mermaid render failed:", e);
    }
  }

  // ── Code-block copy chip ─────────────────────────────────────────
  // Hidden by default, revealed on `pre:hover` (CSS). Click copies the
  // raw code text and flips the chip into a brief "Copied" affirmation.
  // Skips `pre.mermaid` — those are diagram sources, not user code, and
  // get replaced with an SVG once Mermaid runs.

  function injectCopyButtons(mountEl) {
    const blocks = mountEl.querySelectorAll("pre:not(.mermaid)");
    for (const pre of blocks) {
      // marked rewrites innerHTML on every chunk render, so duplicates
      // aren't possible across renders — but a block may already have a
      // chip if some upstream extension nested another <pre>. Guard anyway.
      if (pre.querySelector(":scope > .bsw-code-copy")) continue;
      const code = pre.querySelector("code");
      if (!code) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bsw-code-copy";
      btn.setAttribute("aria-label", "Copy code");
      btn.title = "Copy";
      btn.textContent = "Copy";
      pre.appendChild(btn);
    }
    // One delegated listener per mount — survives every innerHTML wipe
    // because it's attached to mountEl, not to any individual button.
    if (!mountEl.dataset.bswCopyDelegated) {
      mountEl.dataset.bswCopyDelegated = "1";
      mountEl.addEventListener("click", handleCopyClick);
    }
  }

  function handleCopyClick(evt) {
    const btn = evt.target.closest && evt.target.closest(".bsw-code-copy");
    if (!btn) return;
    const pre = btn.closest("pre");
    if (!pre) return;
    const code = pre.querySelector("code");
    if (!code) return;
    // textContent (not innerText) — preserves the literal source including
    // whitespace, since hljs wraps each token in inline <span>s and innerText
    // would honor any CSS-driven line-break/wrap rules along the way.
    const text = code.textContent;
    copyText(text).then(() => {
      btn.classList.add("is-copied");
      btn.textContent = "Copied";
      window.setTimeout(() => {
        btn.classList.remove("is-copied");
        btn.textContent = "Copy";
      }, 1200);
    }).catch(() => {
      btn.textContent = "Failed";
      window.setTimeout(() => { btn.textContent = "Copy"; }, 1200);
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // execCommand fallback for non-secure contexts (rare on extension pages,
    // but file:// occasionally hits it depending on Chrome flag state).
    return new Promise((resolve, reject) => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error("copy command rejected"));
      } catch (e) {
        reject(e);
      }
    });
  }

  // ── List-item fold chevrons ──────────────────────────────────────
  // Mark every <li> with a direct <ul>/<ol> child as foldable; prepend
  // a small chevron that toggles `.is-collapsed`. CSS does the actual
  // hiding (display:none on the nested list) and chevron rotation. State
  // is session-only — during streaming, mountEl.innerHTML is rewritten on
  // every chunk so fold state resets, but that matches user expectation
  // (folding mid-stream would fight the incoming nodes). On a final
  // render (non-streaming .md tabs, or post-stream viewer) fold state
  // persists until the user navigates away.
  //
  // One delegated click listener per mount — survives any innerHTML
  // wipe because it's attached to mountEl, not the buttons themselves.
  // Same shape as injectCopyButtons above.
  function injectListFolds(mountEl) {
    const items = mountEl.querySelectorAll("li");
    for (const li of items) {
      // Only direct nested list counts — paragraphs / inline children
      // inside the li aren't foldable.
      if (!li.querySelector(":scope > ul, :scope > ol")) continue;
      // Task rows use the checkbox as their marker; a fold chevron stacks on
      // top of it and breaks parent/child task hierarchy. Subtasks stay visible.
      if (li.classList.contains("task-list-item")) continue;
      if (li.querySelector(":scope > .bsw-fold-toggle")) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bsw-fold-toggle";
      btn.setAttribute("aria-label", "Toggle fold");
      btn.setAttribute("aria-expanded", "true");
      // The button stacks two glyphs in the SAME centered slot (the stylesheet
      // gives both inset:0 inside the button), so the swap is a pure in-place
      // crossfade with zero drift:
      //   .bsw-fold-dot     = a disc identical to a normal bullet (shown idle)
      //   .bsw-fold-chevron = an SVG triangle, ▾ on hover, ▸ when collapsed.
      // An SVG (not a "▾" text glyph) avoids font-dependent bearing offsets,
      // so it sits dead-center and matches the dot's color/size.
      const dot = document.createElement("span");
      dot.className = "bsw-fold-dot";
      dot.setAttribute("aria-hidden", "true");
      const chev = document.createElement("span");
      chev.className = "bsw-fold-chevron";
      chev.setAttribute("aria-hidden", "true");
      chev.innerHTML =
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
        '<path d="M6 9l6 6 6-6z"/></svg>';
      btn.appendChild(dot);
      btn.appendChild(chev);
      li.classList.add("bsw-foldable");
      // Ordered lists keep their native 1. 2. 3. markers — the chevron is an
      // extra affordance beside the number, not a substitute for it.
      if (li.parentElement && li.parentElement.tagName === "OL") {
        li.classList.add("bsw-fold-ordered");
      }
      li.insertBefore(btn, li.firstChild);
    }
    if (!mountEl.dataset.bswFoldDelegated) {
      mountEl.dataset.bswFoldDelegated = "1";
      mountEl.addEventListener("click", handleFoldClick);
    }
  }

  function handleFoldClick(evt) {
    const btn = evt.target.closest && evt.target.closest(".bsw-fold-toggle");
    if (!btn) return;
    const li = btn.closest("li");
    if (!li) return;
    // The chevron isn't a link, but it sits inside content that may be —
    // prevent accidental navigation when the user clicks the chevron.
    evt.preventDefault();
    evt.stopPropagation();
    const willCollapse = !li.classList.contains("is-collapsed");
    li.classList.toggle("is-collapsed", willCollapse);
    btn.setAttribute("aria-expanded", willCollapse ? "false" : "true");
  }

  // ── Checkable task lists (tri-state) ────────────────────────────
  // Three states, cycled by clicking the box:
  //   todo      `[ ]` → empty box
  //   done      `[x]` → box with a check
  //   cancelled `[-]` → box with an ✕ and struck-through text
  //
  // marked only parses `[ ]` / `[x]` (emitting a bare checkbox <li> WITHOUT
  // GitHub's task-list-item class), and renders `[-]` as literal text. So we:
  //   1. promote literal "[-] …" items into cancelled task items,
  //   2. tag every task <li> + parent list with the classes the CSS needs,
  //   3. drive state with checked + indeterminate (indeterminate == cancelled).
  // State lives for the render session only — a re-render (translation chunk,
  // width change) resets to source, same as folds.
  const TASK_STATES = ["todo", "done", "cancelled"];

  function applyTaskState(li, cb, state) {
    li.dataset.bswTask = state;
    // Visuals are driven by LI classes + Material SVG masks (extension.css)
    // — NOT by the checkbox's :checked, because preventDefault() in the click
    // handler reverts the native checked value after we run.
    li.classList.toggle("is-checked", state === "done");
    li.classList.toggle("is-cancelled", state === "cancelled");
    cb.checked = state === "done";
    cb.indeterminate = state === "cancelled";
    // aria-checked (attribute) isn't subject to the activation revert, so it
    // keeps assistive tech in sync: mixed == cancelled.
    cb.setAttribute("aria-checked",
      state === "done" ? "true" : state === "cancelled" ? "mixed" : "false");
  }

  // Turn `<li>[-] text</li>` (which GFM left as plain text) into a real
  // cancelled task item by prepending a checkbox and stripping the marker.
  function promoteCancelledItems(mountEl) {
    for (const li of mountEl.querySelectorAll("li")) {
      if (li.querySelector(":scope > input[type=checkbox]")) continue;
      const first = li.firstChild;
      if (!first || first.nodeType !== 3) continue;
      const m = first.nodeValue.match(/^\s*\[-\]\s+/);
      if (!m) continue;
      first.nodeValue = first.nodeValue.slice(m[0].length);
      const cb = document.createElement("input");
      cb.type = "checkbox";
      li.insertBefore(cb, li.firstChild);
      li.dataset.bswTask = "cancelled";
    }
  }

  function injectTaskCheckboxes(mountEl) {
    promoteCancelledItems(mountEl);

    const boxes = mountEl.querySelectorAll('li > input[type="checkbox"]');
    if (!boxes.length) return;

    for (const cb of boxes) {
      const li = cb.parentElement;
      if (!li) continue;

      li.classList.add("task-list-item");
      if (li.parentElement) li.parentElement.classList.add("contains-task-list");

      cb.disabled = false;
      const initial = li.dataset.bswTask || (cb.checked ? "done" : "todo");
      applyTaskState(li, cb, initial);

      // Avoid stacking listeners on re-renders.
      if (cb.dataset.bswTaskBound) continue;
      cb.dataset.bswTaskBound = "1";

      cb.addEventListener("click", (e) => {
        // We own the state machine — block the native two-state toggle and
        // any bubbling to the fold toggle / surrounding links.
        e.preventDefault();
        e.stopPropagation();
        const cur = li.dataset.bswTask || "todo";
        const next = TASK_STATES[(TASK_STATES.indexOf(cur) + 1) % TASK_STATES.length];
        applyTaskState(li, cb, next);
      });
    }
  }

  root.BaselineRenderer = { renderTo, runMermaid };
})(typeof window !== "undefined" ? window : globalThis);
