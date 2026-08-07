/**
 * Viewer page bootstrap.
 *
 * Loaded by viewer.html (an extension-owned page opened from the
 * service worker after the user clicks Translate). Mirrors content.js
 * activate() — same scaffold DOM, same preset/mode/width loading, same
 * switcher widget — viewer-only: bilingual width (no split), no Translate
 * button. Subscribes to translator-bg until ingestMarkdown hands off to
 * BaselineSurface. Paste and「换文件」both call ingestMarkdown (same as .md surface).
 *
 * Session lifecycle:
 *   URL:  chrome-extension://<id>/viewer.html?session=<uuid>
 *   port: chrome.runtime.connect({ name: "translator-session" })
 *   msg:  { type: "subscribe", sessionId }
 *   recv: { type: "chunk"|"done"|"error", text|message }
 *
 * On `done` we mount the TOC (heading IDs are stable now); during
 * `chunk` we re-render the markdown but skip TOC rebuilds — heading
 * structure isn't final yet, and a per-chunk rebuild would thrash.
 */

(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    preset: "default",
    mode: "auto",
    width: "standard"
  };

  // Preset / custom-preset plumbing is shared with the .md content script.
  const {
    CUSTOM_PREFIX,
    getCustomPresets,
    setCustomPresets,
    loadPreset,
    makeCustomId,
    projectCustom,
    openMarkdownInEditTab,
    readColumnScroll,
    restoreColumnScroll,
    syncPresetMarker,
    commitPresetTypography,
    reassertTypographyLock,
    renderPreviewMarkdown
  } = window.BaselineShared;

  // "bilingual" is viewer-only: the original .md tab strips it via
  // applyWidth's WIDTH_VALUES guard falls back to "standard" on .md tabs.
  const WIDTH_VALUES = new Set(["standard", "wide", "full", "bilingual"]);
  const WIDTH_CLASSES = [
    "bsw-width-standard", "bsw-width-wide", "bsw-width-full", "bsw-width-bilingual"
  ];

  // Width-mode buttons surfaced in the top toolbar's segmented group.
  // Mirrors the labels that used to live in theme-switcher.js's WIDTHS
  // array — viewer offers Bilingual (two-pane original/translation),
  // not Split.
  const WIDTH_OPTIONS_VIEWER = [
    { value: "standard",  label: "标准" },
    { value: "wide",      label: "宽屏" },
    { value: "full",      label: "全宽" },
    { value: "bilingual", label: "双栏" }
  ];

  let isEditorial = false;

  const state = {
    mode: "light",
    presetClasses: { common: [], light: [], dark: [] },
    appliedClasses: new Set(),
    mountEl: null
  };

  function rebuildBodyClasses() {
    const body = document.body;
    for (const c of state.appliedClasses) body.classList.remove(c);
    state.appliedClasses.clear();
    const add = (cls) => { body.classList.add(cls); state.appliedClasses.add(cls); };
    add(state.mode === "dark" ? "theme-dark" : "theme-light");
    for (const c of state.presetClasses.common) add(c);
    const modeClasses = state.mode === "dark"
      ? state.presetClasses.dark
      : state.presetClasses.light;
    for (const c of modeClasses) add(c);
    document.documentElement.style.colorScheme =
      state.mode === "dark" ? "dark" : "light";
  }

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
    // Don't touch body.innerHTML — that would yank the <script> elements
    // mid-execution. Just clear the class list and append the app shell.
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
    // Mark which side this column is — bilingual mode adds a sibling
    // .view-content.bsw-side-left in front of this one for the original.
    view.className = "view-content bsw-side-right";
    const reading = document.createElement("div");
    reading.className = "markdown-reading-view";
    const preview = document.createElement("div");
    preview.className =
      "markdown-preview-view markdown-rendered is-readable-line-width allow-fold-headings show-properties is-snapped";
    preview.id = "baseline-preview";
    const sizer = document.createElement("div");
    sizer.className = "markdown-preview-sizer markdown-preview-section";
    window.BaselineShared.markAsPasteHost(sizer);

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

  function isEditablePasteTarget(el) {
    if (!el) return false;
    if (el.closest && el.closest("#baseline-switcher")) return true;
    // The translation sizer is marked contenteditable (so Chrome offers
    // Paste in its right-click menu and ⌘V fires a paste event), but our
    // page-level handler is what consumes pastes there — not the editor.
    // Without this bypass, both the right-click "Paste Markdown" handler
    // and the ⌘V flow would treat the sizer as a real form control and bail.
    if (el.closest && el.closest("[data-bsw-paste-host]")) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
  }

  function makeFileInput(onLoaded) {
    const input = document.createElement("input");
    input.type = "file";
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
        console.warn("[Baseline] file read failed:", reader.error);
      };
      reader.readAsText(f);
      input.value = "";
    });
    document.body.appendChild(input);
    return input;
  }

  // ── Status pill ────────────────────────────────────────────────────
  // Floating top-center indicator for the streaming state. Cancel just
  // disconnects the port; the service worker already aborts the upstream
  // fetch on disconnect, so no extra cancel message is needed.
  function spinnerSVG() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ' +
      'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
      'stroke-linecap="round" aria-hidden="true">' +
      '<path d="M21 12a9 9 0 1 1-6.2-8.55" opacity="0.9"/>' +
      '</svg>'
    );
  }

  function errorSVG() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ' +
      'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="10"/>' +
      '<line x1="12" y1="8" x2="12" y2="13"/>' +
      '<line x1="12" y1="16.5" x2="12" y2="16.5"/>' +
      '</svg>'
    );
  }

  function createStatusPill({ onCancel, onClose, busyLabel }) {
    const busyText = busyLabel || "Translating…";
    const pill = document.createElement("div");
    pill.id = "bsw-viewer-status";

    const icon = document.createElement("span");
    icon.className = "bsw-viewer-status-icon is-spin";
    icon.innerHTML = spinnerSVG();

    const label = document.createElement("span");
    label.className = "bsw-viewer-status-label";
    label.textContent = busyText;

    const action = document.createElement("button");
    action.type = "button";
    action.className = "bsw-viewer-status-action";
    action.textContent = "Cancel";
    action.addEventListener("click", () => {
      if (pill.classList.contains("is-error")) {
        if (typeof onClose === "function") onClose();
      } else {
        if (typeof onCancel === "function") onCancel();
      }
    });

    pill.appendChild(icon);
    pill.appendChild(label);
    pill.appendChild(action);
    document.body.appendChild(pill);

    return {
      el: pill,
      setBusy(chars) {
        pill.classList.remove("is-error");
        pill.hidden = false;
        icon.classList.add("is-spin");
        icon.innerHTML = spinnerSVG();
        label.textContent = chars > 0
          ? `${busyText} (${chars.toLocaleString()} 字符)`
          : busyText;
        action.textContent = "Cancel";
      },
      hide() {
        pill.hidden = true;
      },
      setError(message) {
        pill.classList.add("is-error");
        pill.hidden = false;
        icon.classList.remove("is-spin");
        icon.innerHTML = errorSVG();
        label.textContent = message || "Translation failed";
        action.textContent = "Close";
      },
      setCancelled() {
        pill.classList.remove("is-error");
        pill.hidden = false;
        icon.classList.remove("is-spin");
        icon.innerHTML = errorSVG();
        label.textContent = "Canceled";
        action.textContent = "Close";
      }
    };
  }

  // Render a fatal error inline so the user sees *something* instead of a
  // blank page. Used for missing session id, expired session, or worker
  // disconnect before `done`.
  function showError(message) {
    if (!state.mountEl) return;
    state.mountEl.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.style.padding = "2em";
    wrap.style.color = "var(--text-error, #c33)";
    wrap.style.fontFamily = "var(--font-text)";
    const h = document.createElement("h2");
    h.textContent = isEditorial ? "排版生成失败" : "Translation failed";
    const p = document.createElement("p");
    p.textContent = message || "Unknown error";
    wrap.appendChild(h);
    wrap.appendChild(p);
    state.mountEl.appendChild(wrap);
  }

  async function bootstrap() {
    const params = new URLSearchParams(location.search);
    const sessionId = params.get("session");
    const sourceName = params.get("name") || "document";
    const targetLanguage = params.get("lang") || "";
    isEditorial = params.get("mode") === "editorial";
    var editorialCacheKey = params.get("cacheKey") || "";
    var editorialMode = params.get("edMode") || "slides";

    const settings = Object.assign({}, DEFAULT_SETTINGS);
    // Support initial preset (e.g. claude) passed from surface via registerAndOpen payload
    const urlPreset = params.get("preset");
    if (urlPreset) settings.preset = urlPreset;
    let customPresets = await getCustomPresets();

    const builtIn = new Set(window.BaselineSwitcher.PRESETS.map((p) => p.value));
    const customIds = new Set(customPresets.map((p) => p.id));
    const presetKnown =
      builtIn.has(settings.preset) || customIds.has(settings.preset);
    if (!presetKnown) settings.preset = "default";

    let activePreset = settings.preset;  // single source per strategy, init once

    const mountEl = buildScaffold();
    state.mountEl = mountEl;
    // Do not force here — preset/attr may not be decided yet (mirror surface fix).
    // First force will happen after applyPreset + syncPresetMarker below.

    // Translation stream state (hoisted so column paste/swap can stop it).
    let done = false;
    let renderScheduled = false;
    let renderTimer = 0;
    let lastText = "";
    let statusPill = null;
    let rightChromeHandle = null;
    let rightDirty = false;
    let rightFromLocalFile = false;

    function refreshRightDownloadVisibility() {
      const visible = !rightFromLocalFile || rightDirty;
      Promise.resolve(rightChromeHandle).then((h) => {
        if (h && typeof h.setDownloadVisible === "function") h.setDownloadVisible(visible);
      });
    }

    function downloadRightMarkdown() {
      const shared = window.BaselineShared;
      if (!shared || typeof shared.downloadMarkdown !== "function") {
        return Promise.reject(new Error("downloadMarkdown unavailable"));
      }
      const name = rightFileName || sourceName || "untitled.md";
      return Promise.resolve(shared.downloadMarkdown(rightMarkdown || lastText || "", name))
        .then(() => {
          rightDirty = false;
          rightFromLocalFile = true;
          refreshRightDownloadVisibility();
        });
    }

    // ── Bilingual (双栏对照); swap/paste → BaselineSurface (plain .md) ─
    let handedOff = false;
    let originalMarkdown = "";
    let rightMarkdown = "";
    let leftFileName = "";
    let rightFileName = "";
    let bilingualOn = false;
    let leftView = null;
    let leftMountEl = null;
    let leftRendered = false;
    let scrollSyncTeardown = null;
    const rightView = mountEl.closest(".view-content");
    const leafContent = rightView && rightView.parentNode;

    function tearDownScrollSync() {
      if (scrollSyncTeardown) {
        scrollSyncTeardown();
        scrollSyncTeardown = null;
      }
    }

    function maybeSetupScrollSync() {
      tearDownScrollSync();
      if (handedOff || !bilingualOn || !leftView || !rightView) return;
      scrollSyncTeardown = setupScrollSync();
    }

    let port = null;
    let syncStorageListener = null;
    let schemeMq = null;
    let onSchemeChange = null;

    function stopTranslationStream() {
      done = true;
      tearDownScrollSync();
      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = 0;
        renderScheduled = false;
      }
      try { if (port) port.disconnect(); } catch (_) {}
      if (statusPill) statusPill.hide();
    }

    function openEditTab(markdown, name, column, mountEl, extra) {
      openMarkdownInEditTab(markdown, name, column, mountEl, extra).catch((err) => {
        console.warn("[Baseline] open edit tab failed:", err);
        if (statusPill) {
          statusPill.setError(
            "Could not open editor: " + ((err && err.message) || String(err))
          );
        }
      });
    }

    /**
     * Double-click reading column → jump to edit tab, caret at click point.
     * Mirrors baseline-surface.js's bindReadingDblClick (Direction 4).
     * `getColumn` is a thunk so the value reflects bilingualOn at fire time.
     */
    function bindReadingDblClick(rootEl, getMarkdown, getName, getColumn) {
      if (!rootEl) return;
      function isDblTargetEditable(target) {
        if (!target) return false;
        if (target.closest(".bsw-fold-toggle")) return false;
        if (target.closest(".task-list-item input[type=\"checkbox\"]")) return false;
        if (target.closest("a, button, input, textarea, select, summary")) return false;
        if (target.closest("#baseline-switcher, .bsw-doc-tools, .bsw-toc-chrome")) return false;
        const sizer = rootEl.classList.contains("markdown-preview-sizer")
          ? rootEl : rootEl.querySelector(".markdown-preview-sizer");
        return !!(sizer && sizer.contains(target));
      }
      // Suppress browser's native word-selection on the second mousedown of
      // a dblclick — see baseline-surface.js for the rationale.
      rootEl.addEventListener("mousedown", (event) => {
        if (event.button !== 0 || event.detail !== 2) return;
        if (!isDblTargetEditable(event.target)) return;
        event.preventDefault();
      });
      // 5s idle hover → "Double click to edit" hint (shared helper).
      if (window.BaselineShared
        && typeof window.BaselineShared.bindHoverEditHint === "function") {
        window.BaselineShared.bindHoverEditHint(rootEl, {
          isHoverEditable: isDblTargetEditable
        });
      }
      rootEl.addEventListener("dblclick", (event) => {
        if (event.button !== 0) return;
        const target = event.target;
        if (!isDblTargetEditable(target)) return;

        const sizer = rootEl.classList.contains("markdown-preview-sizer")
          ? rootEl
          : rootEl.querySelector(".markdown-preview-sizer");
        if (!sizer || !sizer.contains(target)) return;

        const markdown = getMarkdown();
        if (!markdown) return;

        const shared = window.BaselineShared;
        if (!shared || typeof shared.offsetForClickedPoint !== "function") return;
        const map = shared.offsetForClickedPoint(markdown, sizer, event);

        event.preventDefault();
        if (window.BaselineSelectionMenu
          && typeof window.BaselineSelectionMenu.suppressNext === "function") {
          window.BaselineSelectionMenu.suppressNext();
        }
        try { window.getSelection().removeAllRanges(); } catch (_) {}

        if (map && map.matched && Number.isFinite(map.offset)) {
          openEditTab(markdown, getName(), getColumn(), sizer, {
            selectionStart: map.offset,
            selectionEnd: map.offset
          });
        } else {
          console.warn("[Baseline] dblclick offset map failed", map);
          openEditTab(markdown, getName(), getColumn(), sizer);
        }
      });
    }

    bindReadingDblClick(
      mountEl,
      () => rightMarkdown || lastText || "",
      () => sourceName,
      () => bilingualOn ? "right" : "main"
    );
    if (window.BaselineSelectionMenu
      && typeof window.BaselineSelectionMenu.mount === "function") {
      window.BaselineSelectionMenu.mount(mountEl, {
        getMarkdown: () => rightMarkdown || lastText || "",
        getName: () => sourceName,
        getColumn: () => bilingualOn ? "right" : "main"
      });
    }

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== "baselineEditApplied" || handedOff) return;
      const apply = () => {
        if (msg.column === "left") {
          originalMarkdown = msg.text;
          leftRendered = false;
          renderOriginal();
          return;
        }
        rightFromLocalFile = false;
        rightMarkdown = msg.text;
        lastText = msg.text;
        done = true;
        const savedScroll = readColumnScroll(mountEl);
        renderPreviewMarkdown(mountEl, msg.text, activePreset)
          .then(() => {
            restoreColumnScroll(mountEl, savedScroll);
            rightDirty = true;
            mountRightChrome();
          })
          .catch((e) => console.warn("[Baseline] edit apply render failed:", e));
      };
      if (msg.targetTabId == null) {
        apply();
        return;
      }
      chrome.tabs.getCurrent((tab) => {
        if (!tab || tab.id !== msg.targetTabId) return;
        apply();
      });
    });

    // ── AI triggers (editorial + translate) for viewer toolbar ──
    var viewerTranslatorSettings = null;
    async function ensureViewerSettings() {
      if (viewerTranslatorSettings) return viewerTranslatorSettings;
      if (window.BaselineTranslator) {
        try { viewerTranslatorSettings = await window.BaselineTranslator.loadSettings(); }
        catch (_) {}
      }
      return viewerTranslatorSettings;
    }
    function viewerSuggestedLang(md) {
      if (!window.BaselineTranslatorCore) return "English";
      var src = detectLang(md || "");
      return src === "Chinese" ? "English" : "Chinese";
    }
    function detectLang(text) {
      var sample = (text || "").slice(0, 2000);
      var cjk = (sample.match(/[一-鿿㐀-䶿]/g) || []).length;
      return cjk > sample.length * 0.1 ? "Chinese" : "English";
    }
    async function viewerTriggerEditorial(markdown, fileName, mode) {
      if (!markdown || !markdown.trim()) return { error: "没有内容" };
      var s = await ensureViewerSettings();
      if (!s || !s.apiKey) return { error: "请先配置 API Key" };
      var m = mode || "slides";
      return new Promise(function (resolve) {
        var port;
        try { port = chrome.runtime.connect({ name: "editorial-direct" }); }
        catch (e) { resolve({ error: "无法连接后台服务" }); return; }
        var pill = window.BaselineSurface
          ? window.BaselineSurface.createPill(function () { try { port.disconnect(); } catch (_) {} pill.remove(); })
          : null;
        var settled = false;
        port.onMessage.addListener(function (msg) {
          if (!msg || settled) return;
          if (msg.type === "chunk" && pill) pill.update(msg.tokens || 0);
          if (msg.type === "done") { settled = true; if (pill) pill.remove(); try { port.disconnect(); } catch (_) {} return resolve(); }
          if (msg.type === "error") { settled = true; if (pill) pill.error(msg.message || "生成失败"); try { port.disconnect(); } catch (_) {} return resolve({ error: msg.message }); }
        });
        port.onDisconnect.addListener(function () {
          if (settled) return;
          settled = true;
          var err = chrome.runtime.lastError;
          if (pill) pill.error((err && err.message) || "生成中断");
          return resolve({ error: (err && err.message) || "生成中断" });
        });
        port.postMessage({ type: "startEditorial", markdown: markdown, settings: s, editorialMode: m, sourceName: fileName || "untitled.md" });
      });
    }
    async function viewerTriggerTranslate(markdown, fileName, lang) {
      if (!markdown || !markdown.trim()) return { error: "没有内容" };
      var s = await ensureViewerSettings();
      if (!s || !s.apiKey) return { error: "请先配置 API Key" };
      var sessId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
      chrome.runtime.sendMessage({
        type: "registerAndOpen",
        sessionId: sessId,
        markdown: markdown,
        settings: Object.assign({}, s, { targetLanguage: lang }),
        sourceName: fileName || "document",
        targetLanguage: lang,
        preset: activePreset
      });
    }

    // Shared by toolbar width buttons and (legacy) switcher callback so
    // both entry points produce identical state transitions: persist new
    // width, apply layout, toggle bilingual.
    function handleWidthChange(value) {
      lastWidth = value;
      applyWidth(value);
      if (value === "bilingual") enableBilingual();
      else disableBilingual();
      if (rightChromeHandle && typeof rightChromeHandle.reconnectSpy === "function") {
        rightChromeHandle.reconnectSpy();
      }
    }

    function mountRightChrome() {
      if (!window.BaselineTOC || !window.BaselineTOC.mountChrome) return;
      const handle = window.BaselineTOC.mountChrome(mountEl, {
        getMarkdown: () => rightMarkdown || "",
        copyTooltip: "Copy translation",
        copyDoneText: "Translation copied",
        onEdit: () => {
          openEditTab(
            rightMarkdown,
            sourceName,
            bilingualOn ? "right" : "main",
            mountEl
          );
        },
        editTooltip: "Edit in new tab",
        onSwap: () => rightFileInput.click(),
        swapTooltip: "Open another",
        onDownload: downloadRightMarkdown,
        downloadTooltip: "下载",
        downloadDoneText: "Downloaded",
        isDirty: rightDirty,
        hideDownload: rightFromLocalFile && !rightDirty,
        withTOC: !bilingualOn,
        widthOptions: WIDTH_OPTIONS_VIEWER,
        currentWidth: lastWidth,
        onWidthChange: handleWidthChange,
        onEditorial: (mode) => viewerTriggerEditorial(rightMarkdown, sourceName, mode),
        onTranslateWithLang: (lang) => viewerTriggerTranslate(rightMarkdown, sourceName, lang),
        translateLanguages: window.BaselineTranslatorCore
          ? window.BaselineTranslatorCore.LANGUAGE_OPTIONS : [],
        suggestedTargetLang: viewerSuggestedLang(rightMarkdown)
      });
      rightChromeHandle = handle;
    }

    function mountLeftChrome() {
      if (!leftMountEl || !window.BaselineTOC || !window.BaselineTOC.mountChrome) return;
      window.BaselineTOC.mountChrome(leftMountEl, {
        getMarkdown: () => originalMarkdown || "",
        copyTooltip: "Copy source",
        copyDoneText: "Source copied",
        onEdit: () => {
          openEditTab(
            originalMarkdown,
            leftFileName || sourceName,
            "left",
            leftMountEl
          );
        },
        editTooltip: "Edit in new tab",
        onSwap: () => leftFileInput.click(),
        swapTooltip: "Open another",
        withTOC: false,
        widthOptions: WIDTH_OPTIONS_VIEWER,
        currentWidth: lastWidth,
        onWidthChange: handleWidthChange,
        onEditorial: (mode) => viewerTriggerEditorial(originalMarkdown, leftFileName || sourceName, mode),
        onTranslateWithLang: (lang) => viewerTriggerTranslate(originalMarkdown, leftFileName || sourceName, lang),
        translateLanguages: window.BaselineTranslatorCore
          ? window.BaselineTranslatorCore.LANGUAGE_OPTIONS : [],
        suggestedTargetLang: viewerSuggestedLang(originalMarkdown)
      });
    }

    function teardownViewerSessionUi() {
      stopTranslationStream();
      disableBilingual();
      if (pasteBinder) {
        if (rightView) pasteBinder.unregister(rightView);
        if (leftView) pasteBinder.unregister(leftView);
      }
      document.getElementById("baseline-switcher")?.remove();
      document.getElementById("bsw-viewer-status")?.remove();
      document.querySelector(".app-container")?.remove();
      switcherRef = null;
      if (syncStorageListener) {
        chrome.storage.onChanged.removeListener(syncStorageListener);
        syncStorageListener = null;
      }
      if (schemeMq && onSchemeChange) {
        schemeMq.removeEventListener("change", onSchemeChange);
        schemeMq = null;
        onSchemeChange = null;
      }
    }

    // Paste and「换文件」→ leave translation UI, same as opening a .md file.
    function ingestMarkdown(text, name) {
      if (handedOff) return;
      handoffToMdSurface(text, name || "Pasted content");
    }

    function handoffToMdSurface(text, name) {
      if (handedOff) return;
      handedOff = true;
      teardownViewerSessionUi();

      const label = name || "Pasted content";
      const surfaceState = { leftMarkdown: text, leftFileName: label };

      // Same module as file:// .md — including the Translate affordance.
      window.BaselineSurface.runBootMdReadingPage({
        initial: { markdown: text, fileName: label },
        scaffold: { mainViewClass: "view-content bsw-side-right" },
        onMainMarkdownChange: (md, n) => {
          surfaceState.leftMarkdown = md;
          surfaceState.leftFileName = n || "";
        },
        getTranslateMarkdown: () => surfaceState.leftMarkdown,
        getTranslateSourceName: () => {
          const base = (surfaceState.leftFileName || "document")
            .replace(/\.(md|markdown|mdown|mkd)$/i, "");
          return base || "document";
        }
      });
    }

    const leftFileInput = makeFileInput((text, name) => {
      ingestMarkdown(text, name || "");
    });
    const rightFileInput = makeFileInput((text, name) => {
      ingestMarkdown(text, name || "");
    });

    const pasteBinder = window.BaselineTOC && window.BaselineTOC.bindColumnPaste
      ? window.BaselineTOC.bindColumnPaste({
        isEditable: isEditablePasteTarget,
        confirmReplace: () =>
          window.confirm("Replace current content with pasted Markdown?")
      })
      : null;

    function syncPasteRegistry() {
      if (handedOff || !pasteBinder || !rightView) return;
      pasteBinder.register(rightView, {
        hasContent: () => Boolean((rightMarkdown || lastText || "").trim()),
        onPaste: (text) => { ingestMarkdown(text, "Pasted content"); }
      });
      if (bilingualOn && leftView) {
        pasteBinder.register(leftView, {
          hasContent: () => Boolean(originalMarkdown && originalMarkdown.trim()),
          onPaste: (text) => { ingestMarkdown(text, "Pasted content"); }
        });
      } else if (leftView) {
        pasteBinder.unregister(leftView);
      }
    }

    function buildLeftScaffold() {
      // Mirrors buildScaffold()'s view-content > reading-view > preview > sizer
      // chain, marked as the left side so CSS can flex it next to the right.
      const view = document.createElement("div");
      view.className = "view-content bsw-side-left";
      const reading = document.createElement("div");
      reading.className = "markdown-reading-view";
      const preview = document.createElement("div");
      preview.className =
        "markdown-preview-view markdown-rendered is-readable-line-width " +
        "allow-fold-headings show-properties is-snapped";
      const sizer = document.createElement("div");
      sizer.className = "markdown-preview-sizer markdown-preview-section";
      window.BaselineShared.markAsPasteHost(sizer);
      preview.appendChild(sizer);
      reading.appendChild(preview);
      view.appendChild(reading);
      return { view, sizer };
    }

    function renderOriginal() {
      if (handedOff || !leftMountEl || leftRendered) return;
      if (!originalMarkdown) return;
      renderPreviewMarkdown(leftMountEl, originalMarkdown, activePreset)
        .then(() => {
          leftRendered = true;
          mountLeftChrome();
          syncPasteRegistry();
          maybeSetupScrollSync();
        })
        .catch((e) => console.warn("[Baseline] original render failed:", e));
    }

    // Build a paragraph index for one scroll container — list of
    // { top, el } where top is the block's offset relative to the
    // container's scroll content. Cheap to rebuild (a few hundred blocks
    // max), so we recompute on each sync rather than invalidating on
    // every chunk re-render.
    function indexBlocks(container) {
      const sizer = container.querySelector(".markdown-preview-sizer");
      if (!sizer) return [];
      const cr = container.getBoundingClientRect();
      const baseTop = container.scrollTop - cr.top;
      const out = [];
      for (const el of sizer.children) {
        const er = el.getBoundingClientRect();
        out.push({ top: er.top + baseTop, el });
      }
      return out;
    }

    function setupScrollSync() {
      if (!leftView || !rightView) return null;
      let activeSide = "left";
      let suppress = false;
      let raf = 0;

      const onEnter = (side) => () => { activeSide = side; };
      leftView.addEventListener("mouseenter", onEnter("left"));
      rightView.addEventListener("mouseenter", onEnter("right"));

      function syncFrom(side) {
        if (suppress) return;
        const src = side === "left" ? leftView : rightView;
        const dst = side === "left" ? rightView : leftView;
        const srcIdx = indexBlocks(src);
        const dstIdx = indexBlocks(dst);
        if (!srcIdx.length || !dstIdx.length) return;
        // "Anchor" line ~40px below the column's top — a block whose top
        // is at or above this line is "current."
        const anchor = src.scrollTop + 40;
        let i = 0;
        while (i + 1 < srcIdx.length && srcIdx[i + 1].top <= anchor) i++;
        const offsetIntoBlock = anchor - srcIdx[i].top;
        const j = Math.min(i, dstIdx.length - 1);
        suppress = true;
        dst.scrollTop = dstIdx[j].top + offsetIntoBlock - 40;
        // Release on the next frame so the destination's own scroll
        // event (echo) is ignored.
        requestAnimationFrame(() => { suppress = false; });
      }

      function schedule(side) {
        if (activeSide !== side) return;
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          syncFrom(side);
        });
      }

      const onLeftScroll  = () => schedule("left");
      const onRightScroll = () => schedule("right");
      leftView.addEventListener("scroll", onLeftScroll,  { passive: true });
      rightView.addEventListener("scroll", onRightScroll, { passive: true });

      return () => {
        leftView.removeEventListener("scroll", onLeftScroll);
        rightView.removeEventListener("scroll", onRightScroll);
        leftView.removeEventListener("mouseenter", onEnter("left"));
        rightView.removeEventListener("mouseenter", onEnter("right"));
        if (raf) cancelAnimationFrame(raf);
      };
    }

    function enableBilingual() {
      if (handedOff || bilingualOn) return;
      bilingualOn = true;
      if (!leafContent) return;
      // Build left column once per enable cycle; teardown removes it.
      const built = buildLeftScaffold();
      leftView = built.view;
      leftMountEl = built.sizer;
      leftRendered = false;
      bindReadingDblClick(
        leftMountEl,
        () => originalMarkdown || "",
        () => leftFileName || sourceName,
        () => "left"
      );
      if (window.BaselineSelectionMenu
        && typeof window.BaselineSelectionMenu.mount === "function") {
        window.BaselineSelectionMenu.mount(leftMountEl, {
          getMarkdown: () => originalMarkdown || "",
          getName: () => leftFileName || sourceName,
          getColumn: () => "left"
        });
      }
      // Insert left BEFORE the existing right column so reading order
      // is left → right.
      leafContent.insertBefore(leftView, rightView);
      // Two-pane shared class drives layout (see extension.css); the
      // bilingual-specific class is for any future bilingual-only tweaks.
      document.body.classList.add("bsw-twopane-active");
      document.body.classList.add("bsw-bilingual-active");
      renderOriginal();
      maybeSetupScrollSync();
      mountRightChrome();
      syncPasteRegistry();
    }

    function disableBilingual() {
      if (!bilingualOn) return;
      bilingualOn = false;
      document.body.classList.remove("bsw-twopane-active");
      document.body.classList.remove("bsw-bilingual-active");
      tearDownScrollSync();
      if (leftView && pasteBinder) pasteBinder.unregister(leftView);
      if (leftView && leftView.parentNode) leftView.parentNode.removeChild(leftView);
      leftView = null;
      leftMountEl = null;
      leftRendered = false;
      mountRightChrome();
      syncPasteRegistry();
    }

    applyMode(settings.mode);
    applyWidth("standard");
    await commitPresetTypography(state.mountEl, activePreset, (p) => applyPreset(p));
    syncPasteRegistry();

    let lastMode = settings.mode;
    let lastWidth = "standard";

    const switcher = window.BaselineSwitcher.mount({
      initial: { preset: activePreset, mode: settings.mode, width: "standard" },
      customPresets: projectCustom(customPresets),
      // Viewer tabs never offer Translate again — only .md / open.html do.
      translateMode: "hidden",
      context: "viewer",
      onPresetChange: async (value) => {
        activePreset = value;
        await commitPresetTypography(state.mountEl, value, (p) => applyPreset(p));
        if (bilingualOn && leftMountEl) {
          reassertTypographyLock(leftMountEl, value);
        }
      },
      onModeChange: (value) => {
        lastMode = value;
        applyMode(value);
      },
      onWidthChange: handleWidthChange,
      onImportPreset: async (name, json) => {
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
        if (activePreset === id) {
          activePreset = "default";
          await commitPresetTypography(state.mountEl, "default", (p) => applyPreset(p));
          if (bilingualOn && leftMountEl) {
            reassertTypographyLock(leftMountEl, "default");
          }
          switcher.setPreset("default");
        }
      },
    });
    switcherRef = switcher;
    switcher.setColorScheme(state.mode);

    schemeMq = window.matchMedia("(prefers-color-scheme: dark)");
    onSchemeChange = () => {
      if (lastMode === "auto") applyMode("auto");
    };
    schemeMq.addEventListener("change", onSchemeChange);

    syncStorageListener = async (changes, area) => {
      if (area !== "local" || !changes.customPresets) return;
      customPresets = Array.isArray(changes.customPresets.newValue)
        ? changes.customPresets.newValue
        : [];
      switcher.setCustomPresets(projectCustom(customPresets));
      if (activePreset.startsWith(CUSTOM_PREFIX)) {
        const stillExists = customPresets.some((p) => p.id === activePreset);
        if (!stillExists) {
          activePreset = "default";
          await commitPresetTypography(state.mountEl, "default", (p) => applyPreset(p));
          if (bilingualOn && leftMountEl) {
            reassertTypographyLock(leftMountEl, "default");
          }
          switcher.setPreset("default");
        } else {
          await commitPresetTypography(state.mountEl, activePreset, (p) => applyPreset(p));
          if (bilingualOn && leftMountEl) {
            reassertTypographyLock(leftMountEl, activePreset);
          }
        }
      }
    };
    chrome.storage.onChanged.addListener(syncStorageListener);

    // ── Translation session ────────────────────────────────────────────
    if (!sessionId) {
      showError(isEditorial
        ? "缺少会话 ID，请从源文档重新点击排版按钮。"
        : "Missing session ID. Click Translate from the source document.");
      return;
    }

    let cancelled = false;

    statusPill = createStatusPill({
      busyLabel: isEditorial ? "Generating layout…" : "Translating…",
      onCancel: () => {
        if (done) return;
        cancelled = true;
        try { port && port.disconnect(); } catch (_) {}
        statusPill.setCancelled();
      },
      onClose: () => {
        try { window.close(); } catch (_) {}
        statusPill.hide();
      }
    });
    statusPill.setBusy(0);

    try {
      port = chrome.runtime.connect({ name: "translator-session" });
    } catch (e) {
      var connErr = isEditorial ? "无法连接后台服务" : "Could not connect to translator";
      statusPill.setError(connErr);
      showError(connErr + ": " + ((e && e.message) || String(e)));
      return;
    }

    const RENDER_THROTTLE_MS = 200;
    let pendingRender = Promise.resolve();

    function hasActiveSelectionIn(el) {
      const sel = window.getSelection && window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
      for (let i = 0; i < sel.rangeCount; i++) {
        if (el.contains(sel.getRangeAt(i).commonAncestorContainer)) return true;
      }
      return false;
    }

    function scheduleRender() {
      if (renderScheduled || handedOff) return;
      renderScheduled = true;
      renderTimer = setTimeout(() => {
        renderScheduled = false;
        renderTimer = 0;
        if (done || handedOff) return;
        if (hasActiveSelectionIn(mountEl)) {
          // User is selecting/reading — try again later instead of
          // yanking the DOM out from under them. The next chunk will
          // also call scheduleRender; whichever fires first paints.
          scheduleRender();
          return;
        }
        pendingRender = pendingRender
          .catch(() => {})
          .then(() => done
            ? undefined
            : renderPreviewMarkdown(mountEl, lastText, activePreset));
      }, RENDER_THROTTLE_MS);
    }

    port.onMessage.addListener((msg) => {
      if (!msg || handedOff) return;
      if (msg.type === "original") {
        originalMarkdown = msg.text || "";
        if (bilingualOn) renderOriginal();
        return;
      }
      if (msg.type === "chunk") {
        lastText = msg.text;
        statusPill.setBusy(lastText.length);
        if (!isEditorial) scheduleRender();
        return;
      }
      if (msg.type === "done") {
        done = true;
        lastText = msg.text;
        if (isEditorial) {
          statusPill.hide();
          try { port.disconnect(); } catch (_) {}
          var edHtml = lastText;
          var isSlides = /=== SLIDE 1 ===/.test(edHtml);

          // Cache the result for next time
          if (editorialCacheKey) {
            var cacheObj = {};
            cacheObj[editorialCacheKey] = edHtml;
            chrome.storage.session.set(cacheObj);
          }

          if (isSlides) {
            chrome.storage.session.set({ slidesHtml: edHtml }, function () {
              var spUrl = chrome.runtime.getURL("slides-player.html");
              window.open(spUrl, "_blank");
            });
          } else {
            var edUrl = chrome.runtime.getURL("editorial.html");
            var w2 = window.open(edUrl, "_blank");
            if (w2) {
              window.addEventListener("message", function edReady(e) {
                if (e.data && e.data.type === "editorial-ready") {
                  window.removeEventListener("message", edReady);
                  w2.postMessage({ type: "editorial-html", html: edHtml }, chrome.runtime.getURL(""));
                }
              });
            }
          }
          // Download to subfolder and cache path
          var edFolders = { slides: "AI Slides", report: "AI Report", dashboard: "AI Dashboard" };
          var folder = edFolders[editorialMode] || "AI Slides";
          var base = (sourceName || "document").replace(/\.[^.]+$/, "");
          var dlFilename = "Beautiful Markdown/" + folder + "/" + base + ".html";
          var blob = new Blob([edHtml], { type: "text/html;charset=utf-8" });
          var dlUrl = URL.createObjectURL(blob);
          chrome.downloads.download({
            url: dlUrl,
            filename: dlFilename,
            saveAs: false,
            conflictAction: "overwrite"
          }, function (downloadId) {
            if (!downloadId) { URL.revokeObjectURL(dlUrl); return; }
            function onChanged(delta) {
              if (delta.id !== downloadId) return;
              if (delta.state && delta.state.current === "complete") {
                chrome.downloads.onChanged.removeListener(onChanged);
                chrome.downloads.search({ id: downloadId }, function (items) {
                  URL.revokeObjectURL(dlUrl);
                  if (!items || !items[0] || !items[0].filename) return;
                  var filePath = items[0].filename;
                  if (editorialCacheKey) {
                    var obj = {};
                    obj[editorialCacheKey] = filePath;
                    chrome.storage.local.set(obj);
                  }
                });
              }
              if (delta.state && delta.state.current === "interrupted") {
                chrome.downloads.onChanged.removeListener(onChanged);
                URL.revokeObjectURL(dlUrl);
              }
            }
            chrome.downloads.onChanged.addListener(onChanged);
          });
          return;
        }
        rightMarkdown = msg.text;
        statusPill.hide();
        if (renderTimer) {
          clearTimeout(renderTimer);
          renderTimer = 0;
          renderScheduled = false;
        }
        pendingRender
          .catch(() => {})
          .then(() => renderPreviewMarkdown(mountEl, lastText, activePreset))
          .then(() => {
            mountRightChrome();
            syncPasteRegistry();
          })
          .catch((e) => console.warn("[Baseline] final render failed:", e));
        try { port.disconnect(); } catch (_) {}
        return;
      }
      if (msg.type === "error") {
        done = true;
        var fallback = isEditorial ? "排版生成失败" : "Translation failed";
        statusPill.setError(msg.message || fallback);
        showError(msg.message || fallback);
        try { port.disconnect(); } catch (_) {}
        return;
      }
    });

    port.onDisconnect.addListener(() => {
      if (done || cancelled) return;
      const err = chrome.runtime.lastError;
      const message = (err && err.message) || (isEditorial ? "服务连接中断" : "Translator disconnected.");
      statusPill.setError(message);
      showError(message);
    });

    try {
      port.postMessage({ type: "subscribe", sessionId });
    } catch (e) {
      const message = (isEditorial ? "无法订阅会话: " : "Could not subscribe to translation session: ") + ((e && e.message) || String(e));
      statusPill.setError(message);
      showError(message);
    }
  }

  function run() {
    bootstrap().catch((err) => {
      const msg = (err && err.message) || String(err);
      if (msg.includes("Extension context invalidated")) return;
      console.error("[Baseline] viewer bootstrap failed:", err);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();
