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

  // Configure marked once.
  marked.use(obsidianExtensions);
  marked.use({
    gfm: true,
    breaks: false,
    pedantic: false,
    renderer: {
      // Custom code block renderer: tag mermaid, run highlight.js otherwise.
      code(code, infostring) {
        const lang = (infostring || "").trim().split(/\s+/)[0];
        if (lang === "mermaid") {
          return `<pre class="mermaid">${escapeHTML(code)}</pre>`;
        }
        let highlighted;
        if (lang && hljs.getLanguage(lang)) {
          try {
            highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
          } catch {
            highlighted = escapeHTML(code);
          }
        } else {
          try {
            highlighted = hljs.highlightAuto(code).value;
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

  /**
   * Render markdown source into a DOM tree (already attached to `mountEl`).
   * @param {string} source markdown text
   * @param {HTMLElement} mountEl container to mount into
   */
  async function renderTo(source, mountEl) {
    const rawHtml = marked.parse(source);
    const clean = DOMPurify.sanitize(rawHtml, {
      ADD_ATTR: ["data-href", "data-alt", "data-tag", "target"],
      ADD_TAGS: ["mark"]
    });
    mountEl.innerHTML = clean;

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
      if (li.querySelector(":scope > .bsw-fold-toggle")) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bsw-fold-toggle";
      btn.setAttribute("aria-label", "Toggle fold");
      btn.setAttribute("aria-expanded", "true");
      // The button stacks two glyphs in the same absolute slot:
      //   .bsw-fold-dot     = our own bullet substitute (shown idle)
      //   .bsw-fold-chevron = ▾ that rotates to ▸ when collapsed (shown
      //                       on hover / focus / when collapsed)
      // Both sit at inset: 0 inside the button, so opacity-crossfade
      // produces a smooth swap with zero positional drift — the bullet
      // and the chevron occupy the exact same pixels at all times.
      const dot = document.createElement("span");
      dot.className = "bsw-fold-dot";
      dot.textContent = "•"; // •
      dot.setAttribute("aria-hidden", "true");
      const chev = document.createElement("span");
      chev.className = "bsw-fold-chevron";
      chev.textContent = "▾"; // ▾
      chev.setAttribute("aria-hidden", "true");
      btn.appendChild(dot);
      btn.appendChild(chev);
      li.classList.add("bsw-foldable");
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

  root.BaselineRenderer = { renderTo, runMermaid };
})(typeof window !== "undefined" ? window : globalThis);
