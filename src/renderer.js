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
  const { obsidianExtensions } = root.BaselineObsidianSyntax;
  // hljs / renderMathInElement / mermaid are intentionally NOT captured
  // here — all three are lazy-loaded on first need (see ensureVendor /
  // ensureMermaid below), so plain .md pages never pay for KaTeX (~275KB
  // + fonts), highlight.js (~125KB) or Mermaid (~2.5MB). Always resolve
  // them through `root.*` at call time.

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

  // Allow file:/data:/blob:/chrome-extension: — DOMPurify's default URI
  // whitelist strips them, which breaks local markdown images on file://
  // pages after relative paths are resolved to absolute file: URLs.
  const PURIFY_OPTS = {
    ADD_ATTR: [
      "data-href", "data-alt", "data-tag", "target",
      "src", "alt", "title", "width", "height", "dir"
    ],
    ADD_TAGS: ["mark", "sub", "sup"],
    ALLOWED_URI_REGEXP:
      /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|data|blob|file|chrome-extension):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
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
      // Keep relative src as-is through sanitize; resolveImageUrls runs after
      // with renderBaseUrl still set (absolute schemes pass through unchanged).
      image(href, title, text) {
        const src = escapeAttr((href || "").trim());
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
        // Lazy-loaded: renderTo awaits ensureVendor("hljs") before parsing
        // when the source contains a code fence, so hljs is normally present
        // here. If the load failed we fall back to escaped plain text.
        const hljs = root.hljs;
        let highlighted;
        if (!hljs || code.length > HLJS_MAX_HIGHLIGHT_CHARS) {
          // Missing highlighter, or too big to highlight without jank.
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

  // ── Frontmatter parser ──────────────────────────────────────────
  const TAG_KEYS = new Set(["tags", "aliases", "tag"]);

  function parseFrontmatter(raw) {
    const lines = raw.split(/\r?\n/);
    const entries = [];
    let curKey = null;
    let curArr = null;

    function flush() {
      if (curKey && curArr) {
        const type = TAG_KEYS.has(curKey) ? "tags" : "list";
        entries.push({ key: curKey, value: curArr, type });
      }
      curKey = null;
      curArr = null;
    }

    for (const line of lines) {
      const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)/);
      if (kv) {
        flush();
        const key = kv[1];
        let val = kv[2].trim();
        if (!val) {
          curKey = key;
          curArr = [];
          continue;
        }
        if (val.startsWith("[") && val.endsWith("]")) {
          const items = val.slice(1, -1).split(",")
            .map(s => stripQuotes(s.trim())).filter(Boolean);
          const type = TAG_KEYS.has(key) ? "tags" : "list";
          entries.push({ key, value: items, type });
          continue;
        }
        entries.push({ key, value: stripQuotes(val), type: "text" });
        continue;
      }
      const li = line.match(/^\s+-\s+(.*)/);
      if (li && curKey) {
        curArr = curArr || [];
        curArr.push(stripQuotes(li[1].trim()));
        continue;
      }
      if (curKey && !line.trim()) continue;
      flush();
    }
    flush();
    return entries;
  }

  function stripQuotes(s) {
    if (s.length >= 2 &&
      ((s[0] === '"' && s[s.length - 1] === '"') ||
       (s[0] === "'" && s[s.length - 1] === "'"))) {
      return s.slice(1, -1);
    }
    return s;
  }

  function buildFrontmatterDOM(entries) {
    const container = document.createElement("div");
    container.className = "bsw-fm-container is-collapsed";

    const heading = document.createElement("div");
    heading.className = "bsw-fm-heading";
    heading.setAttribute("role", "button");
    heading.setAttribute("tabindex", "0");
    heading.setAttribute("aria-expanded", "false");

    const chevron = document.createElement("span");
    chevron.className = "bsw-fm-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<path d="M6 9l6 6 6-6z"/></svg>';

    const label = document.createElement("span");
    label.className = "bsw-fm-heading-text";
    label.textContent = "Properties";

    heading.appendChild(chevron);
    heading.appendChild(label);
    container.appendChild(heading);

    const body = document.createElement("div");
    body.className = "bsw-fm-properties";

    for (const { key, value, type } of entries) {
      const row = document.createElement("div");
      row.className = "bsw-fm-property";

      const keyEl = document.createElement("span");
      keyEl.className = "bsw-fm-key";
      keyEl.textContent = key;
      row.appendChild(keyEl);

      const valEl = document.createElement("span");

      if (type === "tags" && Array.isArray(value)) {
        valEl.className = "bsw-fm-value bsw-fm-tags";
        for (const t of value) {
          const pill = document.createElement("span");
          pill.className = "bsw-fm-tag";
          pill.textContent = t;
          valEl.appendChild(pill);
        }
      } else if (type === "list" && Array.isArray(value)) {
        valEl.className = "bsw-fm-value";
        valEl.textContent = value.join(", ");
      } else if (!value && value !== 0) {
        valEl.className = "bsw-fm-value bsw-fm-value-empty";
        valEl.textContent = "empty";
      } else {
        valEl.className = "bsw-fm-value";
        valEl.textContent = String(value);
      }

      row.appendChild(valEl);
      body.appendChild(row);
    }

    container.appendChild(body);
    return container;
  }

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

  // ── Generic lazy vendor loader ──────────────────────────────────
  // Same dual path as Mermaid's loader: direct <script> on extension pages,
  // background executeScript into our isolated world on content pages.
  // `ready()` short-circuits when another page script already provided the
  // global (e.g. a stale HTML that still ships the <script> tag).
  const VENDOR_SPECS = {
    hljs: {
      files: ["vendor/highlight.min.js"],
      ready: () => !!root.hljs
    },
    katex: {
      files: ["vendor/katex.min.js", "vendor/katex-auto-render.min.js"],
      ready: () => typeof root.renderMathInElement === "function",
      css: "vendor/katex.min.css"
    }
  };
  const vendorPromises = {};

  function injectVendorCss(href) {
    const id = "bsw-vendor-css-" + href.replace(/[^a-z0-9]+/gi, "-");
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL(href);
    document.head.appendChild(link);
  }

  function loadVendorDirect(file) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL(file);
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load " + file));
      document.head.appendChild(s);
    });
  }

  function loadVendorViaBackground(name) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "loadVendor", name }, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) { reject(new Error(err.message)); return; }
          if (!resp || !resp.ok) {
            reject(new Error((resp && resp.error) || "Vendor load failed: " + name));
            return;
          }
          resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function ensureVendor(name) {
    const spec = VENDOR_SPECS[name];
    if (!spec) return Promise.reject(new Error("unknown vendor: " + name));
    if (spec.css) injectVendorCss(spec.css); // CSS is idempotent & cheap
    if (spec.ready()) return Promise.resolve();
    if (vendorPromises[name]) return vendorPromises[name];
    const load = location.protocol === "chrome-extension:"
      ? spec.files.reduce(
        (p, f) => p.then(() => loadVendorDirect(f)), Promise.resolve())
      : loadVendorViaBackground(name);
    vendorPromises[name] = load.then(() => {
      if (!spec.ready()) {
        throw new Error(name + " loaded but its global is undefined");
      }
    }).catch((err) => {
      vendorPromises[name] = null; // allow retry on next render
      throw err;
    });
    return vendorPromises[name];
  }

  // Cheap source sniffing — false positives just cost an unnecessary load,
  // false negatives would break rendering, so err on the loose side.
  function sourceNeedsHljs(src) {
    return /(^|\n)\s*(```|~~~)/.test(src);
  }
  function sourceNeedsKatex(src) {
    return src.includes("$") || src.includes("\\(") || src.includes("\\[");
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
    const fmMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const fmRaw = fmMatch ? fmMatch[1] : null;
    const stripped = fmMatch ? source.slice(fmMatch[0].length) : source;
    const wasExpanded = mountEl.dataset.bswFmExpanded === "1";

    // Pull in heavyweight vendors BEFORE the synchronous marked.parse —
    // the code renderer needs root.hljs in place. Load failures degrade
    // gracefully (plain code blocks / raw TeX), never block the render.
    const vendorWaits = [];
    if (sourceNeedsHljs(stripped)) {
      vendorWaits.push(ensureVendor("hljs").catch((e) =>
        console.warn("[Baseline] hljs lazy-load failed:", e)));
    }
    if (sourceNeedsKatex(stripped)) {
      vendorWaits.push(ensureVendor("katex").catch((e) =>
        console.warn("[Baseline] KaTeX lazy-load failed:", e)));
    }
    if (vendorWaits.length) await Promise.all(vendorWaits);

    let rawHtml;
    try {
      rawHtml = marked.parse(stripped);
      const clean = DOMPurify.sanitize(rawHtml, PURIFY_OPTS);
      mountEl.innerHTML = clean;

      if (fmRaw) {
        const entries = parseFrontmatter(fmRaw);
        if (entries.length) {
          const fmNode = buildFrontmatterDOM(entries);
          if (wasExpanded) {
            fmNode.classList.remove("is-collapsed");
            fmNode.querySelector(".bsw-fm-heading")
              .setAttribute("aria-expanded", "true");
          }
          mountEl.insertBefore(fmNode, mountEl.firstChild);
        }
      }
      if (!mountEl.dataset.bswFmDelegated) {
        mountEl.dataset.bswFmDelegated = "1";
        mountEl.addEventListener("click", handleFmToggle);
        mountEl.addEventListener("keydown", handleFmKeydown);
      }

      // Resolve relative images while renderBaseUrl is still set.
      resolveImageUrls(mountEl);
      applyRtlDirection(mountEl);
    } finally {
      renderBaseUrl = "";
    }

    // KaTeX: render after DOM injection. Lazy-loaded above; absent only
    // when the doc has no math or the load failed (raw TeX stays visible).
    if (typeof root.renderMathInElement === "function") {
      try {
        root.renderMathInElement(mountEl, {
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
    wrapTables(mountEl);
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

  // A column whose longest cell stays under this many display units reads as
  // a short field (status, size, date, count) rather than prose. CJK counts
  // double because those glyphs are roughly twice as wide as Latin ones.
  const TIGHT_COLUMN_MAX_UNITS = 12;
  const CJK_CHAR =
    /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

  function cellWidthUnits(cell) {
    const text = (cell.textContent || "").trim();
    let units = 0;
    for (const ch of text) units += CJK_CHAR.test(ch) ? 2 : 1;
    return units;
  }

  // CSS can't tell a "48px" column from a paragraph column, so measure each
  // column's longest cell and mark the uniformly-short ones nowrap. Under
  // table-layout: auto a nowrap column has max-content == min-content, so the
  // browser hands all the slack to the prose columns instead of breaking
  // "48px" across two lines in a narrow reading measure.
  function markTightColumns(table) {
    const rows = table.querySelectorAll("tr");
    if (!rows.length) return;
    const widest = [];
    for (const row of rows) {
      const cells = row.children;
      if (cells.length > widest.length) widest.length = cells.length;
      for (let i = 0; i < cells.length; i++) {
        // colspan breaks the one-cell-per-column model this relies on.
        if (cells[i].colSpan > 1) return;
        widest[i] = Math.max(widest[i] || 0, cellWidthUnits(cells[i]));
      }
    }
    if (widest.length < 2) return;
    for (const row of rows) {
      const cells = row.children;
      for (let i = 0; i < cells.length; i++) {
        // toggle, not add — streaming re-renders can revisit a table whose
        // column widths changed as later rows arrived.
        cells[i].classList.toggle(
          "bsw-col-tight",
          widest[i] <= TIGHT_COLUMN_MAX_UNITS
        );
      }
    }
  }

  // Wrap each <table> in a horizontally scrollable div so wide tables
  // (many columns or long unbreakable cell content) don't push the page
  // into horizontal scroll. The wrapper owns the rounded border + clipping
  // while the table itself shrinks them so the corners stay clean.
  function wrapTables(mountEl) {
    const tables = mountEl.querySelectorAll("table");
    for (const table of tables) {
      markTightColumns(table);
      const parent = table.parentNode;
      if (!parent) continue;
      if (parent.classList && parent.classList.contains("bsw-table-wrap")) continue;
      const wrap = document.createElement("div");
      wrap.className = "bsw-table-wrap";
      parent.insertBefore(wrap, table);
      wrap.appendChild(table);
    }
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

  function installTaskIconAssets(mountEl) {
    const runtime = typeof chrome !== "undefined" && chrome.runtime;
    if (!runtime || typeof runtime.getURL !== "function") return;
    const scope = mountEl.closest(".markdown-preview-view.markdown-rendered") || mountEl;
    if (!scope || !scope.style) return;
    const assets = {
      "--bsw-task-icon-todo": "icons/material/check_box_outline_blank_round_24px.svg",
      "--bsw-task-icon-done": "icons/material/check_box_round_24px.svg",
      "--bsw-task-icon-cancelled": "icons/material/indeterminate_check_box_round_24px.svg"
    };
    for (const [property, path] of Object.entries(assets)) {
      scope.style.setProperty(property, `url("${runtime.getURL(path)}")`);
    }
  }

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

  function cycleTaskListItem(li) {
    const cb =
      li.querySelector(':scope > input[type="checkbox"]') ||
      li.querySelector(':scope > p:first-child > input[type="checkbox"]');
    if (!cb) return;
    const cur = li.dataset.bswTask || "todo";
    const next = TASK_STATES[(TASK_STATES.indexOf(cur) + 1) % TASK_STATES.length];
    applyTaskState(li, cb, next);
  }

  function injectTaskCheckboxes(mountEl) {
    promoteCancelledItems(mountEl);

    // marked puts the box as a direct child for tight lists, or inside the
    // first <p> for loose lists — accept both.
    const boxes = mountEl.querySelectorAll(
      'li > input[type="checkbox"], li > p:first-child > input[type="checkbox"]'
    );
    if (boxes.length) installTaskIconAssets(mountEl);

    for (const cb of boxes) {
      const li = cb.closest("li");
      if (!li) continue;

      li.classList.add("task-list-item");
      if (li.parentElement) li.parentElement.classList.add("contains-task-list");

      cb.disabled = false;
      cb.removeAttribute("disabled");
      const initial = li.dataset.bswTask || (cb.checked ? "done" : "todo");
      applyTaskState(li, cb, initial);
    }

    // One delegated listener on the mount: whole-row clicks (and the
    // checkbox) cycle state. Survives re-renders; avoids per-LI bind drift.
    // Attach even when this render has no tasks (empty → load with tasks).
    if (mountEl.dataset.bswTaskDelegated) return;
    mountEl.dataset.bswTaskDelegated = "1";
    mountEl.addEventListener("click", (e) => {
      const li = e.target && e.target.closest && e.target.closest("li.task-list-item");
      if (!li || !mountEl.contains(li)) return;
      // Innermost task row only (nested lists).
      if (e.target.closest("li.task-list-item") !== li) return;
      // Leave real controls alone. NOTE: the reading sizer is marked
      // contenteditable (paste host) — must NOT treat that as a skip, or
      // every task click would no-op.
      if (e.target.closest("a[href], button, label, textarea, select")) return;
      const editable = e.target.closest("[contenteditable=\"true\"]");
      if (editable && editable.getAttribute("data-bsw-paste-host") !== "1") return;
      if (e.target.closest("code, pre") && !e.target.closest('input[type="checkbox"]')) {
        return;
      }
      // Only skip when the user dragged a range selection inside this row.
      const sel = window.getSelection && window.getSelection();
      if (
        sel &&
        !sel.isCollapsed &&
        String(sel).length > 0 &&
        sel.anchorNode &&
        li.contains(sel.anchorNode)
      ) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      cycleTaskListItem(li);
    });
  }

  // ── Frontmatter toggle ───────────────────────────────────────────
  function toggleFm(heading) {
    const container = heading.closest(".bsw-fm-container");
    if (!container) return;
    const mountEl = container.closest(".markdown-preview-view") || container.parentElement;
    const willCollapse = !container.classList.contains("is-collapsed");
    container.classList.toggle("is-collapsed", willCollapse);
    heading.setAttribute("aria-expanded", willCollapse ? "false" : "true");
    if (mountEl) mountEl.dataset.bswFmExpanded = willCollapse ? "0" : "1";
  }

  function handleFmToggle(evt) {
    const heading = evt.target.closest && evt.target.closest(".bsw-fm-heading");
    if (!heading) return;
    toggleFm(heading);
  }

  function handleFmKeydown(evt) {
    if (evt.key !== "Enter" && evt.key !== " ") return;
    const heading = evt.target.closest && evt.target.closest(".bsw-fm-heading");
    if (!heading) return;
    evt.preventDefault();
    toggleFm(heading);
  }

  root.BaselineRenderer = { renderTo, runMermaid };
})(typeof window !== "undefined" ? window : globalThis);
