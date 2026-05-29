/**
 * Content script entry point.
 *
 * Decides whether the current page is a markdown document, fetches the
 * raw source, and replaces the document body with a Baseline-themed
 * rendering. The floating in-page switcher is the only UI; there is no
 * popup. Cross-tab sync works via chrome.storage.onChanged.
 *
 * Storage layout:
 *   sync : { preset, mode, enabledOnHttp }   ← user selections
 *   local: { customPresets: [...] }          ← user-imported preset JSON
 *   Custom presets live in local because chrome.storage.sync has an 8KB
 *   per-item limit; a single rich preset can easily exceed that.
 *
 * Body class layout (rebuilt on every preset/mode change):
 *
 *   <body
 *     class="
 *       theme-light | theme-dark            ← resolved color mode
 *       <preset-common-classes>      *      ← always, when preset selected
 *       <preset-mode-light-classes>  *      ← only when in light mode
 *       <preset-mode-dark-classes>   *      ← only when in dark mode
 *     ">
 */

(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    preset: "default",
    mode: "auto",
    // Reading-column width: "standard" | "wide" | "full". Standard matches
    // the pre-existing layout (Obsidian's --file-line-width), so users who
    // never touched this setting see no change.
    width: "standard",
    // True by default: without a popup there is no in-page UI to flip this,
    // so refusing to render http(s) markdown would silently break the
    // extension on remote .md files.
    enabledOnHttp: true,
    // First-run hint: a small dismissible card that suggests setting the
    // browser as the default .md opener. Flips to true once the user clicks
    // dismiss; never shown again across devices (syncs via storage.sync).
    mdHintDismissed: false
  };

  const CUSTOM_PREFIX = "custom:";
  // "split" is the md-side two-pane mode: user picks an arbitrary second
  // markdown to compare side-by-side (independent scroll, no sync). The
  // viewer's "bilingual" mode is intentionally NOT in this set — applyWidth
  // strips unknown values back to "standard", so a viewer-set "bilingual"
  // syncs into a normal .md tab without breaking the layout.
  const WIDTH_VALUES = new Set(["standard", "wide", "full", "split"]);
  const WIDTH_CLASSES = [
    "bsw-width-standard", "bsw-width-wide", "bsw-width-full", "bsw-width-split"
  ];

  function isMarkdownURL(url) {
    try {
      const u = new URL(url);
      return /\.(md|markdown|mdown|mkd)(?:$|\?|#)/i.test(u.pathname);
    } catch {
      return false;
    }
  }

  function looksLikeMarkdownDocument() {
    const url = location.href;
    if (!isMarkdownURL(url)) return false;
    const body = document.body;
    if (!body) return false;
    const onlyPre = body.children.length === 1 && body.firstElementChild.tagName === "PRE";
    const textHeavy = body.textContent.trim().length > 0 && body.children.length <= 2;
    return onlyPre || textHeavy;
  }

  function getSyncSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => resolve(items));
    });
  }

  function getCustomPresets() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ customPresets: [] }, (items) => {
        const list = Array.isArray(items.customPresets) ? items.customPresets : [];
        resolve(list);
      });
    });
  }

  function setCustomPresets(list) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ customPresets: list }, () => resolve());
    });
  }

  // Compiles a raw preset JSON into the shape applyPreset() consumes.
  function compileFromJSON(json) {
    const compiled = window.BaselinePreset.compilePreset(json);
    return {
      css: window.BaselinePreset.presetToCSS(json),
      classesCommon: compiled.classesCommon,
      classesLight: compiled.classesLight,
      classesDark: compiled.classesDark
    };
  }

  function emptyPreset() {
    return { css: "", classesCommon: [], classesLight: [], classesDark: [] };
  }

  async function loadPreset(presetName) {
    if (!presetName || presetName === "default") return emptyPreset();

    if (presetName.startsWith(CUSTOM_PREFIX)) {
      const list = await getCustomPresets();
      const found = list.find((p) => p.id === presetName);
      if (!found) {
        console.warn("[Baseline] custom preset missing:", presetName);
        return emptyPreset();
      }
      try {
        return compileFromJSON(found.json);
      } catch (e) {
        console.warn("[Baseline] custom preset compile failed:", e);
        return emptyPreset();
      }
    }

    try {
      const url = chrome.runtime.getURL(`presets/${presetName}.json`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return compileFromJSON(json);
    } catch (e) {
      console.warn("[Baseline] preset load failed:", e);
      return emptyPreset();
    }
  }

  // Active state — kept so we can fully reconstruct body class list whenever
  // either preset or mode changes. `appliedClasses` remembers EVERY class we
  // last added so we can strip them all before applying a new preset; without
  // this, switching from preset A → B leaves A's color-scheme class on body
  // alongside B's, so the two color schemes fight and nothing visibly changes.
  const state = {
    mode: "light",                 // resolved mode: 'light' | 'dark'
    presetClasses: { common: [], light: [], dark: [] },
    appliedClasses: new Set(),     // every class we currently own on <body>
    mountEl: null                  // markdown sizer; used to re-render Mermaid
  };

  function rebuildBodyClasses() {
    const body = document.body;
    for (const c of state.appliedClasses) body.classList.remove(c);
    state.appliedClasses.clear();

    const add = (cls) => {
      body.classList.add(cls);
      state.appliedClasses.add(cls);
    };

    add(state.mode === "dark" ? "theme-dark" : "theme-light");
    for (const c of state.presetClasses.common) add(c);
    const modeClasses = state.mode === "dark"
      ? state.presetClasses.dark
      : state.presetClasses.light;
    for (const c of modeClasses) add(c);

    document.documentElement.style.colorScheme =
      state.mode === "dark" ? "dark" : "light";
  }

  // Filled in once the widget mounts so applyMode can notify it of the
  // resolved color scheme.
  let switcherRef = null;

  function applyMode(mode) {
    let resolved = mode;
    if (mode === "auto") {
      resolved = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark" : "light";
    }
    const changed = state.mode !== resolved;
    state.mode = resolved;
    rebuildBodyClasses();
    if (switcherRef) switcherRef.setColorScheme(resolved);
    // Mermaid bakes its theme into the SVG at render time; without a
    // re-run, a diagram drawn in dark mode stays dark after the user
    // switches to light (and vice-versa). Re-render after any actual
    // mode flip, but not on no-op calls (avoids flashing the diagram
    // during the very first paint, when render hasn't run yet).
    if (changed && state.mountEl && window.BaselineRenderer.runMermaid) {
      window.BaselineRenderer.runMermaid(state.mountEl);
    }
  }

  function applyWidth(width) {
    if (!WIDTH_VALUES.has(width)) width = "standard";
    const body = document.body;
    for (const c of WIDTH_CLASSES) body.classList.remove(c);
    body.classList.add("bsw-width-" + width);
  }

  function applyPreset(preset) {
    state.presetClasses = {
      common: preset.classesCommon || [],
      light: preset.classesLight || [],
      dark: preset.classesDark || []
    };
    let style = document.getElementById("baseline-preset-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "baseline-preset-style";
      document.head.appendChild(style);
    }
    style.textContent = preset.css || "";
    rebuildBodyClasses();
  }

  function buildScaffold() {
    const body = document.body;
    body.innerHTML = "";
    body.className = "";

    const app = document.createElement("div");
    app.className = "app-container";

    const main = document.createElement("div");
    main.className = "horizontal-main-container";

    const workspace = document.createElement("div");
    workspace.className = "workspace mod-vertical mod-root";

    const split = document.createElement("div");
    split.className = "workspace-split mod-vertical mod-root";

    const tabs = document.createElement("div");
    tabs.className = "workspace-tabs mod-top mod-active";

    const tabContainer = document.createElement("div");
    tabContainer.className = "workspace-tab-container";

    const leaf = document.createElement("div");
    leaf.className = "workspace-leaf mod-active";

    const leafContent = document.createElement("div");
    leafContent.className = "workspace-leaf-content";

    const view = document.createElement("div");
    view.className = "view-content";

    const reading = document.createElement("div");
    reading.className = "markdown-reading-view";

    const preview = document.createElement("div");
    preview.className =
      "markdown-preview-view markdown-rendered is-readable-line-width allow-fold-headings show-properties is-snapped";
    preview.id = "baseline-preview";

    const sizer = document.createElement("div");
    sizer.className = "markdown-preview-sizer markdown-preview-section";

    preview.appendChild(sizer);
    reading.appendChild(preview);
    view.appendChild(reading);
    leafContent.appendChild(view);
    leaf.appendChild(leafContent);
    tabContainer.appendChild(leaf);
    tabs.appendChild(tabContainer);
    split.appendChild(tabs);
    workspace.appendChild(split);
    main.appendChild(workspace);
    app.appendChild(main);
    body.appendChild(app);

    return sizer;
  }

  // ── 分栏视图 (split-pane) helpers ────────────────────────────────
  // Mirrors viewer.js's bilingual scaffold: append a sibling .view-content
  // to .workspace-leaf-content. The CSS rules under body.bsw-twopane-active
  // do the actual flex layout. Unlike bilingual we do NOT sync scroll; the
  // user picks an arbitrary second markdown file for free comparison.

  // Build the right-side .view-content + sizer chain. Same shape as
  // buildScaffold's view-content branch so theme/preset/width selectors
  // apply uniformly. `bsw-side-right` is left on so future right-only
  // tweaks have a hook; today only the column-1 vs column-2 toolbars
  // differ, and that difference is wholly in JS.
  function buildSplitScaffold() {
    const view = document.createElement("div");
    view.className = "view-content bsw-side-right";

    const reading = document.createElement("div");
    reading.className = "markdown-reading-view";

    const preview = document.createElement("div");
    preview.className =
      "markdown-preview-view markdown-rendered is-readable-line-width " +
      "allow-fold-headings show-properties is-snapped";

    const sizer = document.createElement("div");
    sizer.className = "markdown-preview-sizer markdown-preview-section";

    preview.appendChild(sizer);
    reading.appendChild(preview);
    view.appendChild(reading);
    return { view, preview, sizer };
  }

  // Empty-state UI for the second column: matches the dashed-border
  // "Import preset" affordance in the settings panel (.bsw-import-button)
  // so the chrome reads as the same "click to load" idiom the user already
  // knows. The honest note about image/wikilink limits sits underneath.
  function buildSplitEmptyUI(onPick) {
    const empty = document.createElement("div");
    empty.className = "bsw-split-empty";

    const btn = document.createElement("button");
    btn.type = "button";
    // Reuse the Import-preset visual: dashed border, ghost background,
    // accent on hover. `bsw-split-pick` only exists to widen the click
    // target inside the empty centred container.
    btn.className = "bsw-import-button bsw-split-pick";
    // Material Symbols folder_open SVG from BaselineTOC for icon parity
    // with edit/copy/swap in the doc-tools row.
    const iconHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" ' +
      'viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">' +
      '<path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h207' +
      'q16 0 30.5 6t25.5 17l57 57h360q33 0 56.5 23.5T920-640H447l-80-80H160v480' +
      'l96-320h684L837-217q-8 26-29.5 41.5T760-160H160Zm84-80h516l72-240H316' +
      'l-72 240Zm0 0 72-240-72 240Zm-84-400v-80 80Z"/>' +
      '</svg>';
    btn.innerHTML = iconHTML + '<span>Open markdown file</span>';
    btn.addEventListener("click", onPick);

    const note = document.createElement("p");
    note.className = "bsw-split-empty-note";
    // Honest about the structural limitation — File API gives us text,
    // not a directory base, so relative-path images won't resolve.
    note.textContent = "图片和 wikilink 链接可能无法解析";

    empty.appendChild(btn);
    empty.appendChild(note);
    return empty;
  }

  // Hidden <input type="file"> shared by both columns' file pickers. Same
  // pattern as theme-switcher.js's preset import flow. Each enableSplit()
  // call creates its own instance; rebind onLoaded per use to route the
  // result to the right column.
  function makeFileInput(onLoaded) {
    const input = document.createElement("input");
    input.type = "file";
    // Accept the markdown extensions we already recognise plus plain
    // text so a user with .txt notes can still load them. The OS dialog
    // still lets users override to "All Files".
    input.accept = ".md,.markdown,.mdown,.mkd,.txt,text/markdown,text/plain";
    input.hidden = true;
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        onLoaded(String(reader.result || ""), f.name || "");
      };
      reader.onerror = () => {
        console.warn("[Baseline] split file read failed:", reader.error);
      };
      reader.readAsText(f);
      // Reset so picking the same file twice still triggers change.
      input.value = "";
    });
    return input;
  }

  async function fetchRawMarkdown() {
    const pre = document.body.querySelector(":scope > pre");
    if (pre && pre.textContent && pre.textContent.length > 0) return pre.textContent;
    if (document.body.textContent && document.body.textContent.trim().length > 0) {
      return document.body.textContent;
    }
    const res = await fetch(location.href);
    return await res.text();
  }

  // Derive a deterministic, URL-safe slug from a user-supplied name.
  // Falls back to a timestamp suffix to guarantee uniqueness.
  function makeCustomId(name, existingIds) {
    const base = String(name || "preset")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "preset";
    let candidate = CUSTOM_PREFIX + base;
    let n = 2;
    while (existingIds.has(candidate)) {
      candidate = CUSTOM_PREFIX + base + "-" + n++;
    }
    return candidate;
  }

  // Returns the {id, name} projection that the switcher's UI needs;
  // the JSON body lives in storage and is only loaded on activation.
  function projectCustom(list) {
    return list.map((p) => ({ id: p.id, name: p.name }));
  }

  // Light-weight source-language sniff used to seed the Translate target
  // dropdown. Counts CJK Han characters vs. Latin letters in a stripped
  // copy of the markdown (code fences / inline code masked out so a doc
  // full of English identifiers doesn't drown out the prose). Above 30%
  // Han ⇒ treat as Chinese; otherwise treat as foreign and suggest
  // translating to Chinese. Returning a coarse "zh" / "other" rather than
  // an ISO code on purpose — we only need to pick one of two targets.
  function detectSourceLanguage(text) {
    if (!text) return "other";
    const stripped = String(text)
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]*`/g, " ");
    // CJK Unified Ideographs (U+4E00–U+9FFF) + Extension A (U+3400–U+4DBF).
    const han = (stripped.match(/[一-鿿㐀-䶿]/g) || []).length;
    const latin = (stripped.match(/[A-Za-z]/g) || []).length;
    const total = han + latin;
    if (total < 10) return "other";
    return (han / total) > 0.3 ? "zh" : "other";
  }

  // Per user spec (2026-05-28): Chinese source → suggest English; anything
  // else (including unknown / mixed) → suggest Chinese.
  function suggestedTargetLanguage(detected) {
    return detected === "zh" ? "English" : "中文";
  }

  // Open the current file in the user's editor via the `vscode://file/`
  // protocol — works for VS Code and Cursor (which registers the same
  // scheme). On other systems the browser shows the standard
  // "no app to handle this link" dialog, which is harmless.
  function openInLocalEditor() {
    if (location.protocol !== "file:") return;
    // pathname is URL-encoded; decode so `my doc.md` etc. round-trip
    // correctly. On Windows, pathname is "/C:/foo/bar.md" — vscode://file
    // wants "C:/foo/bar.md", so strip the leading slash for drive paths.
    let path;
    try { path = decodeURI(location.pathname); }
    catch { path = location.pathname; }
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    // Assigning to location.href triggers the protocol handler without
    // navigating away from the current page (Chrome detects the unknown
    // scheme, hands off to the OS, and the .md view stays put).
    try { location.href = "vscode://file/" + path; }
    catch (e) { console.warn("[Baseline] open in editor failed:", e); }
  }

  // Extracted so we can re-mount nav chrome after replacing mountEl's HTML
  // (translation swap rebuilds every heading, so the old IDs/anchors and the
  // old TOC entries become dangling — easier to rebuild than reconcile).
  function mountNavChrome(mountEl) {
    if (!window.BaselineTOC) return;
    // Wipe any prior TOC chrome so a re-mount (e.g. after a content swap)
    // doesn't stack a second copy. mountTOC reuses the .bsw-content-wrap
    // if present, so we only nuke the actual TOC pieces.
    const container = mountEl.closest(".view-content");
    if (container) {
      const oldToc = container.querySelector(":scope > #baseline-toc");
      if (oldToc) oldToc.remove();
      const oldToggle = container.querySelector(".bsw-doc-tools > .bsw-toc-toggle");
      if (oldToggle) oldToggle.remove();
      container.classList.remove("bsw-with-toc", "bsw-toc-collapsed");
    }
    const headingIndex = window.BaselineTOC.buildHeadingIndex(mountEl);
    window.BaselineTOC.mountHeadingAnchors(headingIndex);
    window.BaselineTOC.mountTOC(headingIndex, mountEl);
    // Doc-tools row: edit only when the source is a local file (the
    // protocol handler won't have anything sensible to do otherwise);
    // copy is always available and returns the raw markdown source.
    if (window.BaselineTOC.mountDocActions) {
      window.BaselineTOC.mountDocActions(mountEl, {
        onCopy: () => state.originalMarkdown || "",
        onEdit: location.protocol === "file:" ? openInLocalEditor : null,
        editTooltip: "在编辑器中打开"
      });
    }
    // Progress bar is body-attached and idempotent enough that re-calling it
    // after a content swap is harmless (the existing element keeps working).
    window.BaselineTOC.mountProgressBar();
  }

  // First-run hint: a small dismissible card recommending the user set
  // their browser as the default .md opener so double-click from the OS
  // lands in this viewer. Only meaningful on file:// — for http(s) the user
  // got here by clicking a link, "default opener" doesn't apply.
  function detectPlatformInstruction() {
    const ua = navigator.userAgent || "";
    if (/Mac OS X|Macintosh/i.test(ua)) {
      return "在 Finder 中右键 .md 文件 → 显示简介 → 打开方式选择当前浏览器 → 点击“全部更改”。";
    }
    if (/Windows/i.test(ua)) {
      return "右键 .md 文件 → 打开方式 → 选择其他应用 → 勾选“始终使用此应用” → 选择当前浏览器。";
    }
    return "在文件管理器中右键 .md 文件 → 属性/打开方式 → 选择当前浏览器并设为默认。";
  }

  function showDefaultOpenerHint() {
    if (location.protocol !== "file:") return;
    if (document.getElementById("bsw-md-hint")) return;

    const card = document.createElement("div");
    card.id = "bsw-md-hint";
    card.setAttribute("role", "status");

    const body = document.createElement("div");
    body.className = "bsw-md-hint-body";

    const title = document.createElement("div");
    title.className = "bsw-md-hint-title";
    title.textContent = "设为默认打开方式";

    const text = document.createElement("p");
    text.className = "bsw-md-hint-text";
    text.textContent = detectPlatformInstruction();

    body.appendChild(title);
    body.appendChild(text);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "bsw-md-hint-close";
    close.setAttribute("aria-label", "关闭");
    close.textContent = "×";

    const dismiss = () => {
      card.classList.add("is-leaving");
      // Persist first — if the user reloads mid-animation we still want it
      // to stay dismissed. Fire-and-forget is fine; failure here is benign
      // (worst case: they see the hint once more).
      try { chrome.storage.sync.set({ mdHintDismissed: true }); } catch (_) {}
      setTimeout(() => card.remove(), 200);
    };

    close.addEventListener("click", dismiss);

    card.appendChild(body);
    card.appendChild(close);
    document.body.appendChild(card);
  }

  async function activate() {
    if (!looksLikeMarkdownDocument()) return;

    const settings = await getSyncSettings();
    if (location.protocol !== "file:" && !settings.enabledOnHttp) return;

    // Split is a per-tab ephemeral state, intentionally NOT synced via
    // chrome.storage.sync (each tab picks its own 2nd file; propagating
    // it would leave other tabs with a useless empty column). An older
    // build did persist split — clean it out here so legacy storage
    // doesn't keep auto-enabling split on every tab.
    if (settings.width === "split") {
      settings.width = "standard";
      chrome.storage.sync.set({ width: "standard" });
    }

    let customPresets = await getCustomPresets();

    // If storage still holds a preset we no longer recognize (e.g. user
    // picked one before we trimmed the list, or deleted a custom one),
    // silently fall back to default.
    const builtIn = new Set(window.BaselineSwitcher.PRESETS.map((p) => p.value));
    const customIds = new Set(customPresets.map((p) => p.id));
    const presetKnown =
      builtIn.has(settings.preset) || customIds.has(settings.preset);
    if (!presetKnown) {
      settings.preset = "default";
      chrome.storage.sync.set({ preset: "default" });
    }

    const source = await fetchRawMarkdown();
    const mountEl = buildScaffold();
    state.mountEl = mountEl;

    // Cache the source for the Translate flow — the page's <pre> is gone
    // after buildScaffold() replaces document.body, and the Translate button
    // needs to hand the original markdown to the service worker on click.
    state.originalMarkdown = source;

    applyMode(settings.mode);
    applyWidth(settings.width);
    applyPreset(await loadPreset(settings.preset));

    await window.BaselineRenderer.renderTo(source, mountEl);

    mountNavChrome(mountEl);

    // ── 分栏视图 (split-pane) state ─────────────────────────────────
    // The user can pick a 2nd markdown via <input type="file"> to read
    // side-by-side. Independent scroll, no sync. State is per-tab and
    // per-session — closing the tab forgets the picked file.
    //
    // Each column owns its own [edit, copy, swap] doc-tools row built via
    // BaselineTOC.mountDocActions. Column 1 starts with the tab-URL file
    // (sourceMarkdown below), but the swap button lets it drift to any
    // user-picked file too — reloading restores the URL file.

    let splitOn = false;
    let splitView = null;        // .view-content.bsw-side-right (DOM)
    let splitMountEl = null;     // sizer inside splitView (null when empty)
    let splitPreview = null;     // .markdown-preview-view inside splitView
    let splitFileName = "";      // right-column's currently loaded filename

    // Column 1's source-of-truth text. Initially the tab-URL markdown;
    // swapping rebinds it so copy/edit reflect whatever is shown.
    let leftMarkdown = state.originalMarkdown || source;
    let leftFileName = "";

    // Two hidden inputs (one per column) — sharing one input forces us
    // to track "which column requested?" via a captured closure, and the
    // small DOM duplication is cheaper than that bookkeeping.
    const rightInput = makeFileInput((text, name) => {
      splitFileName = name;
      mountSplitContent(text);
    });
    const leftInput = makeFileInput((text, name) => {
      leftFileName = name;
      state.originalMarkdown = text;
      leftMarkdown = text;
      window.BaselineRenderer.renderTo(text, mountEl)
        .then(() => mountNavChrome(mountEl))
        // Re-add the swap button after mountNavChrome rebuilt the toolbar.
        .then(() => attachLeftSwapButton())
        .catch((e) => console.warn("[Baseline] left swap render failed:", e));
    });
    document.body.appendChild(rightInput);
    document.body.appendChild(leftInput);

    function getLeafContent() {
      // mountEl → preview-sizer; walk up to the .view-content's parent.
      const view = mountEl.closest(".view-content");
      return view && view.parentNode;
    }

    // Inject the swap button into column 1's existing doc-tools row.
    // Idempotent: removes any prior swap before re-adding so re-renders
    // don't stack duplicates. Only active while splitOn — disableSplit
    // strips it back out.
    function attachLeftSwapButton() {
      if (!splitOn) return;
      if (!window.BaselineTOC || !window.BaselineTOC.mountDocActions) return;
      // Edit only makes sense while column 1 still shows the tab-URL file.
      // After a swap, leftFileName is set and location.href no longer matches
      // the visible content — opening location in vscode would launch the
      // wrong file. Drop the button in that case rather than mislead.
      const canEdit = location.protocol === "file:" && !leftFileName;
      // mountDocActions wipes existing edit/copy/swap before re-adding,
      // so re-mounting with the full opt set keeps the row stable.
      window.BaselineTOC.mountDocActions(mountEl, {
        onCopy: () => leftMarkdown || "",
        onEdit: canEdit ? openInLocalEditor : null,
        editTooltip: "在编辑器中打开",
        onSwap: () => leftInput.click(),
        swapTooltip: leftFileName ? "换文件: " + leftFileName : "换文件"
      });
    }

    // Build the empty-state UI inside splitPreview, replacing whatever
    // is currently there (sizer or stale empty-state). Also removes the
    // right column's doc-tools row, since there's nothing to act on.
    function showSplitEmpty() {
      if (!splitPreview || !splitView) return;
      // Strip any prior content-wrap / doc-tools — empty state replaces
      // the entire reading view, not just the sizer.
      const reading = splitView.querySelector(".markdown-reading-view");
      if (reading) reading.innerHTML = "";
      const wrap = splitView.querySelector(":scope > .bsw-content-wrap");
      if (wrap) wrap.remove();
      splitMountEl = null;
      splitFileName = "";

      const empty = buildSplitEmptyUI(() => rightInput.click());
      // Re-attach to the existing reading-view so width-class padding
      // still applies. If reading was nuked, rebuild it.
      let rv = splitView.querySelector(".markdown-reading-view");
      if (!rv) {
        rv = document.createElement("div");
        rv.className = "markdown-reading-view";
        splitView.appendChild(rv);
      }
      const preview = document.createElement("div");
      preview.className =
        "markdown-preview-view markdown-rendered is-readable-line-width " +
        "allow-fold-headings show-properties is-snapped";
      preview.appendChild(empty);
      rv.appendChild(preview);
      splitPreview = preview;
    }

    // Replace the empty-state with a fresh sizer and render the picked
    // markdown. Mounts [edit, copy, swap] in the column's own doc-tools
    // row via mountDocActions — same chrome as column 1.
    function mountSplitContent(text) {
      if (!splitView) return;
      // Reset the column scaffold so we can call mountDocActions
      // cleanly (it walks .markdown-reading-view → .view-content).
      const rv = splitView.querySelector(".markdown-reading-view");
      if (rv) rv.innerHTML = "";
      const wrap = splitView.querySelector(":scope > .bsw-content-wrap");
      if (wrap) wrap.remove();

      let reading = splitView.querySelector(".markdown-reading-view");
      if (!reading) {
        reading = document.createElement("div");
        reading.className = "markdown-reading-view";
        splitView.appendChild(reading);
      }
      const preview = document.createElement("div");
      preview.className =
        "markdown-preview-view markdown-rendered is-readable-line-width " +
        "allow-fold-headings show-properties is-snapped";
      const sizer = document.createElement("div");
      sizer.className = "markdown-preview-sizer markdown-preview-section";
      preview.appendChild(sizer);
      reading.appendChild(preview);

      splitPreview = preview;
      splitMountEl = sizer;

      window.BaselineRenderer.renderTo(text, sizer)
        .then(() => {
          if (!window.BaselineTOC || !window.BaselineTOC.mountDocActions) return;
          window.BaselineTOC.mountDocActions(sizer, {
            onCopy: () => text || "",
            // Right column is an in-memory File — no path to hand to
            // a local editor, so skip the edit affordance.
            onEdit: null,
            onSwap: () => rightInput.click(),
            swapTooltip: splitFileName ? "换文件: " + splitFileName : "换文件"
          });
        })
        .catch((e) => console.warn("[Baseline] split render failed:", e));
    }

    function enableSplit() {
      if (splitOn) return;
      const leaf = getLeafContent();
      if (!leaf) return;
      splitOn = true;
      const built = buildSplitScaffold();
      splitView = built.view;
      splitPreview = built.preview;
      splitMountEl = null;
      splitFileName = "";
      // Append AFTER the existing column so reading order is current →
      // picked. The CSS uses `view-content + view-content` for the
      // separator, which targets the second one.
      leaf.appendChild(splitView);
      document.body.classList.add("bsw-twopane-active");
      document.body.classList.add("bsw-split-active");
      showSplitEmpty();
      attachLeftSwapButton();
    }

    function disableSplit() {
      if (!splitOn) return;
      splitOn = false;
      document.body.classList.remove("bsw-twopane-active");
      document.body.classList.remove("bsw-split-active");
      if (splitView && splitView.parentNode) {
        splitView.parentNode.removeChild(splitView);
      }
      splitView = null;
      splitPreview = null;
      splitMountEl = null;
      splitFileName = "";
      // Strip swap from column 1; mountNavChrome will rebuild the
      // canonical edit/copy/TOC set on its next call (e.g. content swap).
      // We do it inline here so the chrome reverts immediately on exit.
      if (window.BaselineTOC && window.BaselineTOC.mountDocActions) {
        window.BaselineTOC.mountDocActions(mountEl, {
          onCopy: () => state.originalMarkdown || "",
          onEdit: location.protocol === "file:" ? openInLocalEditor : null,
          editTooltip: "在编辑器中打开"
        });
      }
    }

    // Note: we do NOT auto-enable split from storage. Split is per-tab
    // ephemeral; the storage migration above coerces any legacy "split"
    // value back to "standard". The user re-enables split explicitly
    // per tab via the switcher.

    // Load translator settings up front so the switcher can paint the saved
    // target-language and model immediately on open. Done after first render
    // so render isn't blocked on a chrome.storage read.
    let translatorSettings = window.BaselineTranslator
      ? await window.BaselineTranslator.loadSettings()
      : null;

    // Auto-detect source language and pick a sensible default target for
    // THIS tab only. Chinese source ⇒ English; anything else ⇒ Chinese.
    // We mutate the in-memory copy so the dropdown / Translate click both
    // pick up the suggestion, but we deliberately don't persist — the
    // user's last explicit choice in storage stays intact, and if they
    // change the dropdown manually onTargetLanguageChange writes that.
    if (translatorSettings) {
      const detected = detectSourceLanguage(source);
      translatorSettings = Object.assign({}, translatorSettings, {
        targetLanguage: suggestedTargetLanguage(detected)
      });
    }

    // Track the last applied values so the cross-tab storage listener can
    // skip echoes from our own writes.
    let lastPreset = settings.preset;
    let lastMode = settings.mode;
    let lastWidth = settings.width;

    // Floating in-page switcher.
    //
    // UI updates run synchronously; the storage write is fire-and-forget so
    // a slow chrome.storage.sync round-trip (50–200ms when syncing across
    // devices) never delays the click.
    const switcher = window.BaselineSwitcher.mount({
      initial: { preset: settings.preset, mode: settings.mode, width: settings.width },
      customPresets: projectCustom(customPresets),
      translatorSettings: translatorSettings,
      // md surface — switcher shows 分栏视图 (and hides 双栏对照,
      // which is viewer-only).
      context: "md",
      onPresetChange: async (value) => {
        lastPreset = value;
        const preset = await loadPreset(value);
        applyPreset(preset);
        chrome.storage.sync.set({ preset: value });
      },
      onModeChange: (value) => {
        lastMode = value;
        applyMode(value);
        chrome.storage.sync.set({ mode: value });
      },
      onWidthChange: (value) => {
        lastWidth = value;
        applyWidth(value);
        if (value === "split") {
          enableSplit();
          // Per-tab ephemeral — don't write to chrome.storage.sync.
          // Other tabs keep whatever persisted width they had; storage
          // still holds the user's last non-split choice as the baseline.
        } else {
          disableSplit();
          chrome.storage.sync.set({ width: value });
        }
      },
      onImportPreset: async (name, json) => {
        // Refetch first — another tab could have imported in the meantime,
        // and overwriting with our stale array would lose their preset.
        customPresets = await getCustomPresets();
        const existingIds = new Set(customPresets.map((p) => p.id));
        const id = makeCustomId(name, existingIds);
        customPresets.push({ id, name: name.trim(), json });
        await setCustomPresets(customPresets);
        switcher.setCustomPresets(projectCustom(customPresets));
        return { ok: true, id };
      },
      onDeletePreset: async (id) => {
        customPresets = await getCustomPresets();
        customPresets = customPresets.filter((p) => p.id !== id);
        await setCustomPresets(customPresets);
        switcher.setCustomPresets(projectCustom(customPresets));
        // If the deleted preset was active, revert to default and apply.
        if (lastPreset === id) {
          lastPreset = "default";
          switcher.setPreset("default");
          applyPreset(await loadPreset("default"));
          chrome.storage.sync.set({ preset: "default" });
        }
      },
      onTargetLanguageChange: async (lang) => {
        if (!window.BaselineTranslator) return;
        try {
          translatorSettings = await window.BaselineTranslator
            .saveSettings({ targetLanguage: lang });
        } catch (e) {
          console.warn("[Baseline] save targetLanguage failed:", e);
        }
      },
      onTranslatorSettingsSave: async (next) => {
        if (!window.BaselineTranslator) return { ok: false, error: "Translator unavailable" };
        try {
          translatorSettings = await window.BaselineTranslator.saveSettings(next);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: (e && e.message) || "Save failed" };
        }
      },
      onTranslate: async () => {
        if (!translatorSettings || !translatorSettings.apiKey) {
          switcher.setTranslateState({
            phase: "error",
            message: "请先在 Settings 中填写 API Key。"
          });
          return;
        }
        // Translation now lives in a separate viewer tab so the original
        // file stays untouched. The service worker stages {markdown,
        // settings} keyed by sessionId, opens viewer.html with that id,
        // and the viewer subscribes on load to start the stream.
        // crypto.randomUUID gives us a collision-free key without pulling
        // in a uuid lib; available everywhere we run (MV3 / Chrome 92+).
        switcher.setTranslateState({ phase: "busy", message: "正在打开翻译标签…" });
        const sessionId = crypto.randomUUID();
        // Pass the source filename + chosen target language to the viewer
        // so the viewer's Edit button can name its on-disk download. The
        // original tab is the only place that knows the source path.
        let sourceName = "document";
        try {
          const pathname = decodeURI(location.pathname || "");
          const base = pathname.split("/").pop() || "";
          const noExt = base.replace(/\.(md|markdown|mdown|mkd)$/i, "");
          if (noExt) sourceName = noExt;
        } catch (_) { /* keep default */ }
        try {
          const resp = await chrome.runtime.sendMessage({
            type: "registerAndOpen",
            sessionId,
            markdown: state.originalMarkdown,
            settings: translatorSettings,
            sourceName,
            targetLanguage: translatorSettings.targetLanguage || ""
          });
          if (!resp || !resp.ok) {
            throw new Error((resp && resp.error) || "无法打开翻译标签");
          }
          switcher.setTranslateState({ phase: "idle", message: null });
        } catch (err) {
          switcher.setTranslateState({
            phase: "error",
            message: "无法打开翻译标签：" + ((err && err.message) || String(err))
          });
        }
      }
    });
    switcherRef = switcher;
    switcher.setColorScheme(state.mode);

    window.matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (lastMode === "auto") applyMode("auto");
      });

    // Live-sync across tabs viewing the same .md.
    //   sync : preset, mode  → re-apply if a peer changed selection
    //   local: customPresets → refresh widget list, re-apply if active
    //                           preset's JSON changed under us
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === "sync") {
        if (changes.preset && changes.preset.newValue !== lastPreset) {
          lastPreset = changes.preset.newValue;
          switcher.setPreset(lastPreset);
          applyPreset(await loadPreset(lastPreset));
        }
        if (changes.mode && changes.mode.newValue !== lastMode) {
          lastMode = changes.mode.newValue;
          switcher.setMode(lastMode);
          applyMode(lastMode);
        }
        if (changes.width && changes.width.newValue !== lastWidth) {
          // Inbound width changes only carry standard/wide/full — split is
          // per-tab and never written to storage. If a peer's width swap
          // arrives while we're locally in split, accept it and exit split:
          // the user explicitly changed reading-width preference, and
          // staying in split would silently ignore that.
          lastWidth = changes.width.newValue;
          switcher.setWidth(lastWidth);
          applyWidth(lastWidth);
          disableSplit();
        }
        return;
      }
      if (area === "local" && changes.customPresets) {
        customPresets = Array.isArray(changes.customPresets.newValue)
          ? changes.customPresets.newValue
          : [];
        switcher.setCustomPresets(projectCustom(customPresets));
        // If the active preset is custom, its body may have changed — or
        // it may have been deleted in another tab. Re-resolve either way.
        if (lastPreset.startsWith(CUSTOM_PREFIX)) {
          const stillExists = customPresets.some((p) => p.id === lastPreset);
          if (!stillExists) {
            lastPreset = "default";
            switcher.setPreset("default");
            chrome.storage.sync.set({ preset: "default" });
          }
          applyPreset(await loadPreset(lastPreset));
        }
      }
    });

    if (!settings.mdHintDismissed) showDefaultOpenerHint();
  }

  // "Extension context invalidated" fires when Chrome reloads / updates the
  // extension while the old content script is still alive in the page. Any
  // chrome.* call from the orphan script throws, and since `activate()` is
  // async, the rejection surfaces as "Uncaught (in promise)" in DevTools —
  // with the stack pointing at whatever sync line was on the stack at the
  // time (often createElement inside buildScaffold), which is misleading.
  // We swallow it silently: the page just needs a refresh to pick up the
  // new extension context, and the error is not actionable for the user.
  function runActivate() {
    activate().catch((err) => {
      const msg = (err && err.message) || String(err);
      if (msg.includes("Extension context invalidated")) return;
      console.error("[Baseline] activate failed:", err);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runActivate, { once: true });
  } else {
    runActivate();
  }
})();
