/**
 * Shared .md reading surface for content.js (file/http .md) and open.js
 * (extension blank tab). Theme, split pane, switcher, paste, and translate
 * wiring live here once; entry scripts only supply source-specific hooks.
 */
(function (root) {
  "use strict";

  const WIDTH_VALUES = new Set(["standard", "wide", "full", "split"]);
  const WIDTH_CLASSES = [
    "bsw-width-standard", "bsw-width-wide", "bsw-width-full", "bsw-width-split"
  ];

  const FOLDER_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" ' +
    'viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">' +
    '<path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h207' +
    "q16 0 30.5 6t25.5 17l57 57h360q33 0 56.5 23.5T920-640H447l-80-80H160v480" +
    "l96-320h684L837-217q-8 26-29.5 41.5T760-160H160Zm84-80h516l72-240H316" +
    "l-72 240Zm0 0 72-240-72 240Zm-84-400v-80 80Z\"/></svg>";

  const {
    CUSTOM_PREFIX,
    getCustomPresets,
    setCustomPresets,
    loadPreset,
    makeCustomId,
    projectCustom,
    saveTabSession,
    loadTabSession,
    clearTabSession,
    syncPresetMarker
  } = root.BaselineShared;

  /** Set during boot(); handles applyEdit write-back from edit.html. */
  let onEditApplied = null;

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "baselineEditApplied") return;
    const run = () => {
      if (onEditApplied) onEditApplied(msg);
    };
    if (msg.targetTabId == null) {
      run();
      return;
    }
    chrome.tabs.getCurrent((tab) => {
      if (!tab || tab.id !== msg.targetTabId) return;
      run();
    });
  });

  function detectSourceLanguage(text) {
    if (!text) return "other";
    const stripped = String(text)
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]*`/g, " ");
    const han = (stripped.match(/[一-鿿㐀-䶿]/g) || []).length;
    const latin = (stripped.match(/[A-Za-z]/g) || []).length;
    const total = han + latin;
    if (total < 10) return "other";
    return (han / total) > 0.3 ? "zh" : "other";
  }

  function suggestedTargetLanguage(detected) {
    return detected === "zh" ? "English" : "中文";
  }

  function isEditablePasteTarget(el) {
    if (!el) return false;
    if (el.closest && el.closest("#baseline-switcher")) return true;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
  }

  function ensureFilePageImagePolicy() {
    if (location.protocol !== "file:") return;
    if (document.querySelector("meta[data-bsw-img-csp]")) return;
    const meta = document.createElement("meta");
    meta.setAttribute("data-bsw-img-csp", "");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content =
      "img-src 'self' data: blob: https: http: file: chrome-extension:;";
    document.head.appendChild(meta);
  }

  function buildScaffold(scaffold) {
    const body = document.body;
    if (scaffold.replaceBody) {
      body.innerHTML = "";
      body.className = "";
      ensureFilePageImagePolicy();
    } else if (scaffold.bodyClass) {
      body.className = scaffold.bodyClass;
    }

    const app = document.createElement("div");
    app.className = "app-container";
    const main = document.createElement("div");
    main.className = "horizontal-main-container";
    const workspace = document.createElement("div");
    workspace.className = "workspace mod-vertical mod-root";
    const wsplit = document.createElement("div");
    wsplit.className = "workspace-split mod-vertical mod-root";
    const tabs = document.createElement("div");
    tabs.className = "workspace-tabs mod-top mod-active";
    const tabContainer = document.createElement("div");
    tabContainer.className = "workspace-tab-container";
    const leaf = document.createElement("div");
    leaf.className = "workspace-leaf mod-active";
    const leafContent = document.createElement("div");
    leafContent.className = "workspace-leaf-content";
    const view = document.createElement("div");
    view.className = scaffold.mainViewClass || "view-content";
    const reading = document.createElement("div");
    reading.className = "markdown-reading-view";
    const preview = document.createElement("div");
    preview.className =
      "markdown-preview-view markdown-rendered is-readable-line-width " +
      "allow-fold-headings show-properties is-snapped";
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
    wsplit.appendChild(tabs);
    workspace.appendChild(wsplit);
    main.appendChild(workspace);
    app.appendChild(main);
    body.appendChild(app);

    return sizer;
  }

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

  /** Open tab + split right column share the same empty affordance. */
  function buildColumnEmptyUI(onPick, label, options) {
    const empty = document.createElement("div");
    empty.className = "bsw-split-empty bsw-open-empty";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bsw-import-button bsw-split-pick";
    btn.innerHTML = FOLDER_ICON + "<span>" + label + "</span>";
    if (!(options && options.skipButtonClick)) {
      btn.addEventListener("click", onPick);
    }
    empty.appendChild(btn);

    const hint = document.createElement("p");
    hint.className = "bsw-split-empty-note bsw-open-paste-hint";
    const mod = navigator.platform.toUpperCase().indexOf("MAC") >= 0 ? "⌘" : "Ctrl";
    hint.innerHTML =
      "或按 <kbd>" + mod + "</kbd> + <kbd>V</kbd> 粘贴 Markdown 直接渲染";
    empty.appendChild(hint);

    return empty;
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
    return input;
  }

  /**
   * @param {object} opts
   * @param {object} opts.syncDefaults
   * @param {(settings: object) => object} [opts.prepareSettings]
   * @param {object} opts.scaffold
   * @param {object} [opts.initial] - { markdown, fileName }
   * @param {boolean} [opts.emptyStart]
   * @param {string} [opts.persistSessionKey] - sessionStorage key; survives refresh
   * @param {string} [opts.mainEditTooltip]
   * @param {string} [opts.splitEditTooltip]
   * @param {string} opts.pickLabel - split column empty picker
   * @param {() => string} opts.getTranslateMarkdown
   * @param {() => string} opts.getTranslateSourceName
   * @param {() => string|null} [opts.translateEmptyMessage]
   * @param {boolean} [opts.hideTranslateUntilContent]
   * @param {(md: string) => void} [opts.onMainMarkdownChange]
   * @param {"open"|"hidden"} [opts.translateMode]
   * @param {() => void} [opts.onAfterBoot]
   */
  async function boot(opts) {
    const prepared = opts.prepareSettings
      ? opts.prepareSettings(Object.assign({}, opts.syncDefaults))
      : Object.assign({}, opts.syncDefaults);

    let customPresets = await getCustomPresets();
    const builtIn = new Set(root.BaselineSwitcher.PRESETS.map((p) => p.value));
    const customIds = new Set(customPresets.map((p) => p.id));
    if (!(builtIn.has(prepared.preset) || customIds.has(prepared.preset))) {
      prepared.preset = "default";
    }

    // New document surfaces always start at standard width. Split / wide /
    // full stay per-tab for this session only (not shared across tabs).
    prepared.width = "standard";

    const ui = {
      mode: "light",
      presetClasses: { common: [], light: [], dark: [] },
      appliedClasses: new Set(),
      mountEl: null,
      hasMainContent: false
    };

    let switcherRef = null;
    let translatorSettings = null;

    function rebuildBodyClasses() {
      const body = document.body;
      for (const c of ui.appliedClasses) body.classList.remove(c);
      ui.appliedClasses.clear();
      const add = (cls) => {
        body.classList.add(cls);
        ui.appliedClasses.add(cls);
      };
      add(ui.mode === "dark" ? "theme-dark" : "theme-light");
      for (const c of ui.presetClasses.common) add(c);
      const modeClasses = ui.mode === "dark"
        ? ui.presetClasses.dark
        : ui.presetClasses.light;
      for (const c of modeClasses) add(c);
      document.documentElement.style.colorScheme =
        ui.mode === "dark" ? "dark" : "light";
    }

    function applyMode(mode) {
      let resolved = mode;
      if (mode === "auto") {
        resolved = window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark" : "light";
      }
      const changed = ui.mode !== resolved;
      ui.mode = resolved;
      rebuildBodyClasses();
      if (switcherRef) switcherRef.setColorScheme(resolved);
      if (changed && ui.mountEl && root.BaselineRenderer.runMermaid) {
        root.BaselineRenderer.runMermaid(ui.mountEl);
      }
    }

    function applyWidth(width) {
      if (width === "split") return;
      if (!WIDTH_VALUES.has(width)) width = "standard";
      const body = document.body;
      for (const c of WIDTH_CLASSES) body.classList.remove(c);
      body.classList.add("bsw-width-" + width);
    }

    function applyPreset(preset) {
      ui.presetClasses = {
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

    let mainChromeHandle = null;

    function updateTranslateUi() {
      const hideAllChrome = opts.emptyStart && !ui.hasMainContent;
      document.body.classList.toggle("bsw-open-chrome-hidden", hideAllChrome);
      if (switcherRef) {
        switcherRef.setUiHidden(hideAllChrome);
        if (!hideAllChrome) {
          const hideTranslate = opts.hideTranslateUntilContent
            ? (!ui.hasMainContent || splitOn)
            : splitOn;
          switcherRef.setTranslateUiHidden(hideTranslate);
        }
      }
    }

    let lastPreset = prepared.preset;
    let lastMode = prepared.mode;
    let lastWidth = prepared.width;

    const sessionKey = opts.persistSessionKey || null;
    let persistTimer = 0;

    function collectTabSession() {
      if (!sessionKey) return null;
      const mainScroll = ui.hasMainContent
        ? root.BaselineShared.readColumnScroll(mountEl)
        : 0;
      if (!opts.emptyStart) {
        if (!ui.hasMainContent) return null;
        return { v: 1, mainScroll };
      }
      return {
        v: 1,
        leftMarkdown,
        leftFileName,
        splitOn,
        splitMarkdown,
        splitFileName,
        mainScroll,
        splitScroll: splitOn && splitMountEl
          ? root.BaselineShared.readColumnScroll(splitMountEl)
          : 0,
        preset: lastPreset,
        mode: lastMode,
        width: lastWidth
      };
    }

    function flushTabSession() {
      if (!sessionKey) return;
      const snap = collectTabSession();
      if (!snap) {
        clearTabSession(sessionKey);
        return;
      }
      if (opts.emptyStart && !(snap.leftMarkdown && String(snap.leftMarkdown).trim())) {
        clearTabSession(sessionKey);
        return;
      }
      saveTabSession(sessionKey, snap);
    }

    function scheduleTabSessionPersist() {
      if (!sessionKey) return;
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = 0;
        flushTabSession();
      }, 400);
    }

    function applyStandardWidthLocal() {
      if (splitOn) return;
      lastWidth = "standard";
      applyWidth("standard");
      if (switcherRef) switcherRef.setWidth("standard");
    }

    ui.mountEl = buildScaffold(opts.scaffold);
    const mountEl = ui.mountEl;
    const mainView = mountEl.closest(".view-content");

    applyMode(prepared.mode);
    applyWidth(prepared.width);
    applyPreset(await loadPreset(prepared.preset));
    syncPresetMarker(prepared.preset);

    let leftMarkdown = (opts.initial && opts.initial.markdown) || "";
    let leftFileName = (opts.initial && opts.initial.fileName) || "";
    if (!leftFileName && root.BaselineShared && root.BaselineShared.fileNameFromPageUrl) {
      leftFileName = root.BaselineShared.fileNameFromPageUrl();
    }

    let splitOn = false;
    let splitView = null;
    let splitMountEl = null;
    let splitPreview = null;
    let splitFileName = "";
    let splitMarkdown = "";

    function syncOpenEmptyAreaClick() {
      if (!opts.emptyStart || !mainView) return;
      const empty = !ui.hasMainContent;
      mainView.classList.toggle("bsw-open-empty-clickable", empty);
      if (empty) {
        mainView.setAttribute("title", "点击打开 Markdown 文件");
      } else {
        mainView.removeAttribute("title");
      }
    }

    function onOpenEmptyAreaClick(e) {
      if (!opts.emptyStart || ui.hasMainContent) return;
      if (e.target.closest("#baseline-switcher, .bsw-doc-tools")) return;
      leftInput.click();
    }

    function splitColumnIsEmpty() {
      return !splitMarkdown || !splitMarkdown.trim();
    }

    function syncSplitEmptyAreaClick() {
      if (!splitView) return;
      const empty = splitOn && splitColumnIsEmpty();
      splitView.classList.toggle("bsw-open-empty-clickable", empty);
      if (empty) {
        splitView.setAttribute("title", "点击打开 Markdown 文件");
      } else {
        splitView.removeAttribute("title");
      }
    }

    function onSplitEmptyAreaClick(e) {
      if (!splitOn || !splitColumnIsEmpty()) return;
      if (e.target.closest("#baseline-switcher, .bsw-doc-tools")) return;
      rightInput.click();
    }

    function showMainEmptyState() {
      if (sessionKey) clearTabSession(sessionKey);
      mountEl.innerHTML = "";
      leftMarkdown = "";
      leftFileName = "";
      ui.hasMainContent = false;
      mountEl.appendChild(
        buildColumnEmptyUI(() => leftInput.click(), opts.pickLabel, {
          skipButtonClick: true
        })
      );
      syncOpenEmptyAreaClick();
      updateTranslateUi();
    }

    function mountMainChrome() {
      if (opts.emptyStart && !ui.hasMainContent) {
        if (mainChromeHandle) {
          mainChromeHandle.destroy();
          mainChromeHandle = null;
        }
        return;
      }
      if (!root.BaselineTOC || !root.BaselineTOC.mountChrome) return;
      if (mainChromeHandle) mainChromeHandle.destroy();
      mainChromeHandle = root.BaselineTOC.mountChrome(mountEl, {
        getMarkdown: () => leftMarkdown || "",
        onEdit: () => openEditTab(
          leftMarkdown,
          leftFileName,
          "main",
          mountEl
        ),
        editTooltip: opts.mainEditTooltip,
        onSwap: () => leftInput.click(),
        swapTooltip: leftFileName ? "换文件: " + leftFileName : "换文件",
        withTOC: !splitOn
      });
    }

    function mountSplitColumnChrome() {
      if (!splitMountEl || !root.BaselineTOC || !root.BaselineTOC.mountChrome) return;
      root.BaselineTOC.mountChrome(splitMountEl, {
        getMarkdown: () => splitMarkdown || "",
        onEdit: () => openEditTab(
          splitMarkdown,
          splitFileName,
          "right",
          splitMountEl
        ),
        editTooltip: opts.splitEditTooltip,
        onSwap: () => rightInput.click(),
        swapTooltip: splitFileName ? "换文件: " + splitFileName : "换文件",
        withTOC: false
      });
    }

    function refreshTranslatorTarget(text) {
      if (!switcherRef || !translatorSettings || !text) return;
      const detected = detectSourceLanguage(text);
      translatorSettings = Object.assign({}, translatorSettings, {
        targetLanguage: suggestedTargetLanguage(detected)
      });
      switcherRef.setTranslatorSettings(translatorSettings);
    }

    async function renderMainColumn(text, name, colOpts) {
      leftMarkdown = text;
      leftFileName = name || "";
      ui.hasMainContent = Boolean(text && text.trim());
      if (opts.onMainMarkdownChange) opts.onMainMarkdownChange(text, leftFileName);

      if (!ui.hasMainContent && opts.emptyStart) {
        showMainEmptyState();
        mountMainChrome();
        return;
      }

      const preserveScroll = colOpts && colOpts.preserveScroll;
      const savedScroll = preserveScroll
        ? root.BaselineShared.readColumnScroll(mountEl)
        : null;

      await root.BaselineRenderer.renderTo(text, mountEl);
      if (preserveScroll) {
        root.BaselineShared.restoreColumnScroll(mountEl, savedScroll);
      } else if (colOpts && colOpts.restoreScroll != null) {
        root.BaselineShared.restoreColumnScroll(mountEl, colOpts.restoreScroll);
      } else {
        root.BaselineShared.resetColumnScroll(mountEl);
      }
      applyStandardWidthLocal();
      mountMainChrome();
      syncOpenEmptyAreaClick();
      updateTranslateUi();
      refreshTranslatorTarget(text);
      scheduleTabSessionPersist();

      if (!mountEl.querySelector("h1") && leftFileName) {
        document.title = leftFileName;
      }
    }

    /** Paste and「换文件」share this path — only the input source differs. */
    /** Paste and「换文件」share this path — only the input source differs. */
    function replaceColumn(side, text, name, colOpts) {
      const label = name || "粘贴的内容";
      if (side === "left" || side === "main") {
        return renderMainColumn(text, label, colOpts);
      }
      if (side === "right") {
        splitMarkdown = text;
        splitFileName = label;
        return Promise.resolve(mountSplitContent(text, colOpts));
      }
      return Promise.resolve();
    }

    function editSessionName(stored) {
      if (stored && String(stored).trim()) return String(stored).trim();
      if (root.BaselineShared && root.BaselineShared.fileNameFromPageUrl) {
        return root.BaselineShared.fileNameFromPageUrl() || "";
      }
      return "";
    }

    function openEditTab(markdown, name, column, mountEl) {
      const shared = root.BaselineShared;
      if (!shared || typeof shared.openMarkdownInEditTab !== "function") return;
      shared.openMarkdownInEditTab(markdown, editSessionName(name), column, mountEl).catch((err) => {
        console.warn("[Baseline] open edit tab failed:", err);
      });
    }

    onEditApplied = (msg) => {
      const col = msg.column || "main";
      const label = msg.name || "编辑的内容";
      const preserveScroll = { preserveScroll: true };
      if (col === "right") {
        replaceColumn("right", msg.text, label, preserveScroll);
      } else {
        renderMainColumn(msg.text, label, preserveScroll);
      }
    };

    const rightInput = makeFileInput((text, name) => {
      replaceColumn("right", text, name || "");
    });
    const leftInput = makeFileInput((text, name) => {
      replaceColumn("left", text, name || "");
    });
    document.body.appendChild(rightInput);
    document.body.appendChild(leftInput);

    const pasteBinder = root.BaselineTOC && root.BaselineTOC.bindColumnPaste
      ? root.BaselineTOC.bindColumnPaste({
        isEditable: isEditablePasteTarget,
        confirmReplace: () =>
          window.confirm("当前已有内容，是否用粘贴的 Markdown 替换？")
      })
      : null;

    function syncPasteRegistry() {
      if (!pasteBinder) return;
      if (mainView) {
        pasteBinder.register(mainView, {
          hasContent: () => Boolean(leftMarkdown && leftMarkdown.trim()),
          onPaste: (text) => { replaceColumn("left", text, "粘贴的内容"); }
        });
      }
      if (splitOn && splitView) {
        pasteBinder.register(splitView, {
          hasContent: () => Boolean(splitMountEl && splitMarkdown && splitMarkdown.trim()),
          onPaste: (text) => { replaceColumn("right", text, "粘贴的内容"); }
        });
      } else if (splitView) {
        pasteBinder.unregister(splitView);
      }
    }

    function getLeafContent() {
      const view = mountEl && mountEl.closest(".view-content");
      if (view && view.parentNode) return view.parentNode;
      return document.querySelector(".workspace-leaf-content");
    }

    function showSplitEmpty() {
      if (!splitPreview || !splitView) return;
      const reading = splitView.querySelector(".markdown-reading-view");
      if (reading) reading.innerHTML = "";
      const wrap = splitView.querySelector(":scope > .bsw-content-wrap");
      if (wrap) wrap.remove();
      splitMountEl = null;
      splitMarkdown = "";
      splitFileName = "";

      const empty = buildColumnEmptyUI(() => rightInput.click(), opts.pickLabel, {
        skipButtonClick: true
      });
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
      syncSplitEmptyAreaClick();
      syncPasteRegistry();
    }

    function mountSplitContent(text, colOpts) {
      if (!splitView) return;
      splitMarkdown = text;
      const preserveScroll = colOpts && colOpts.preserveScroll;
      const prevMount = splitMountEl;
      const savedScroll = preserveScroll && prevMount
        ? root.BaselineShared.readColumnScroll(prevMount)
        : null;
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

      syncSplitEmptyAreaClick();
      root.BaselineRenderer.renderTo(text, sizer)
        .then(() => {
          if (preserveScroll) {
            root.BaselineShared.restoreColumnScroll(sizer, savedScroll);
          } else if (colOpts && colOpts.restoreScroll != null) {
            root.BaselineShared.restoreColumnScroll(sizer, colOpts.restoreScroll);
          } else {
            root.BaselineShared.resetColumnScroll(sizer);
          }
          mountSplitColumnChrome();
          syncSplitEmptyAreaClick();
          syncPasteRegistry();
          scheduleTabSessionPersist();
        })
        .catch((e) => console.warn("[Baseline] split render failed:", e));
    }

    function enableSplit() {
      if (splitOn) return;
      const leaf = getLeafContent();
      if (!leaf) return;
      const savedScroll = root.BaselineShared.readColumnScroll(mountEl);
      splitOn = true;
      const built = buildSplitScaffold();
      splitView = built.view;
      splitPreview = built.preview;
      splitMountEl = null;
      splitMarkdown = "";
      splitFileName = "";
      leaf.appendChild(splitView);
      splitView.addEventListener("click", onSplitEmptyAreaClick);
      document.body.classList.add("bsw-twopane-active");
      document.body.classList.add("bsw-split-active");
      updateTranslateUi();
      showSplitEmpty();
      mountMainChrome();
      syncPasteRegistry();
      root.BaselineShared.restoreColumnScroll(mountEl, savedScroll);
    }

    function disableSplit() {
      if (!splitOn) return;
      const savedScroll = root.BaselineShared.readColumnScroll(mountEl);
      splitOn = false;
      document.body.classList.remove("bsw-twopane-active");
      document.body.classList.remove("bsw-split-active");
      if (splitView) {
        splitView.removeEventListener("click", onSplitEmptyAreaClick);
        splitView.classList.remove("bsw-open-empty-clickable");
        splitView.removeAttribute("title");
        if (pasteBinder) pasteBinder.unregister(splitView);
        if (splitView.parentNode) splitView.parentNode.removeChild(splitView);
      }
      splitView = null;
      splitPreview = null;
      splitMountEl = null;
      splitMarkdown = "";
      splitFileName = "";
      mountMainChrome();
      syncPasteRegistry();
      updateTranslateUi();
      root.BaselineShared.restoreColumnScroll(mountEl, savedScroll);
      scheduleTabSessionPersist();
    }

    let savedSession = null;
    if (opts.emptyStart) {
      mainView.addEventListener("click", onOpenEmptyAreaClick);
      if (sessionKey) savedSession = loadTabSession(sessionKey);
      const canRestore = savedSession
        && savedSession.v === 1
        && savedSession.leftMarkdown
        && String(savedSession.leftMarkdown).trim();
      if (!canRestore) showMainEmptyState();
    } else if (opts.initial && opts.initial.markdown) {
      ui.hasMainContent = true;
      let restoreScroll = null;
      if (sessionKey) {
        const snap = loadTabSession(sessionKey);
        if (snap && snap.v === 1 && typeof snap.mainScroll === "number") {
          restoreScroll = snap.mainScroll;
        }
      }
      await root.BaselineRenderer.renderTo(opts.initial.markdown, mountEl);
      if (restoreScroll != null) {
        root.BaselineShared.restoreColumnScroll(mountEl, restoreScroll);
      } else {
        root.BaselineShared.resetColumnScroll(mountEl);
      }
      if (opts.onMainMarkdownChange) {
        opts.onMainMarkdownChange(
          opts.initial.markdown,
          opts.initial.fileName || ""
        );
      }
      scheduleTabSessionPersist();
    }

    mountMainChrome();
    syncPasteRegistry();

    const translateMode = opts.translateMode === "hidden" ? "hidden" : "open";

    translatorSettings = translateMode === "open" && root.BaselineTranslator
      ? await root.BaselineTranslator.loadSettings()
      : null;

    const seedMd = leftMarkdown || (opts.initial && opts.initial.markdown) || "";
    if (translatorSettings && seedMd) {
      translatorSettings = Object.assign({}, translatorSettings, {
        targetLanguage: suggestedTargetLanguage(detectSourceLanguage(seedMd))
      });
    }

    const switcher = root.BaselineSwitcher.mount({
      initial: {
        preset: prepared.preset,
        mode: prepared.mode,
        width: prepared.width
      },
      customPresets: projectCustom(customPresets),
      translatorSettings: translatorSettings,
      translateMode: translateMode,
      context: "md",
      onPresetChange: async (value) => {
        lastPreset = value;
        syncPresetMarker(value);
        applyPreset(await loadPreset(value));
        scheduleTabSessionPersist();
      },
      onModeChange: (value) => {
        lastMode = value;
        applyMode(value);
        scheduleTabSessionPersist();
      },
      onWidthChange: (value) => {
        lastWidth = value;
        applyWidth(value);
        if (value === "split") {
          enableSplit();
        } else {
          disableSplit();
        }
        updateTranslateUi();
        scheduleTabSessionPersist();
      },
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
        if (lastPreset === id) {
          lastPreset = "default";
          syncPresetMarker("default");
          switcher.setPreset("default");
          applyPreset(await loadPreset("default"));
        }
      },
      onTargetLanguageChange: async (lang) => {
        if (!root.BaselineTranslator) return;
        try {
          translatorSettings = await root.BaselineTranslator
            .saveSettings({ targetLanguage: lang });
        } catch (e) {
          console.warn("[Baseline] save targetLanguage failed:", e);
        }
      },
      onTranslatorSettingsSave: async (next) => {
        if (!root.BaselineTranslator) {
          return { ok: false, error: "Translator unavailable" };
        }
        try {
          translatorSettings = await root.BaselineTranslator.saveSettings(next);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: (e && e.message) || "Save failed" };
        }
      },
      onTranslate: translateMode === "open"
        ? async () => {
          const emptyMsg = opts.translateEmptyMessage && opts.translateEmptyMessage();
          if (emptyMsg) {
            switcher.setTranslateState({ phase: "error", message: emptyMsg });
            return;
          }
          if (!translatorSettings || !translatorSettings.apiKey) {
            switcher.setTranslateState({
              phase: "error",
              message: "请先在 Settings 中填写 API Key。"
            });
            return;
          }
          switcher.setTranslateState({ phase: "busy", message: "正在打开翻译标签…" });
          const sessionId = crypto.randomUUID();
          try {
            const resp = await chrome.runtime.sendMessage({
              type: "registerAndOpen",
              sessionId,
              markdown: opts.getTranslateMarkdown(),
              settings: translatorSettings,
              sourceName: opts.getTranslateSourceName(),
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
        : undefined
    });

    switcherRef = switcher;
    switcher.setColorScheme(ui.mode);
    updateTranslateUi(); /* hide switcher + doc-tools on empty open tab */

    async function restoreTabSession(saved) {
      if (!saved || saved.v !== 1) return;
      const md = saved.leftMarkdown == null ? "" : String(saved.leftMarkdown);
      if (!md.trim()) return;

      if (saved.preset) {
        lastPreset = saved.preset;
        syncPresetMarker(lastPreset);
        switcher.setPreset(lastPreset);
        applyPreset(await loadPreset(lastPreset));
      }
      if (saved.mode) {
        lastMode = saved.mode;
        switcher.setMode(lastMode);
        applyMode(lastMode);
      }

      const scrollOpts = typeof saved.mainScroll === "number"
        ? { restoreScroll: saved.mainScroll }
        : undefined;

      await renderMainColumn(md, saved.leftFileName || "", scrollOpts);

      if (saved.splitOn) {
        lastWidth = "split";
        switcher.setWidth("split");
        enableSplit();
        const splitMd = saved.splitMarkdown == null ? "" : String(saved.splitMarkdown);
        if (splitMd.trim()) {
          const splitScrollOpts = typeof saved.splitScroll === "number"
            ? { restoreScroll: saved.splitScroll }
            : undefined;
          mountSplitContent(splitMd, splitScrollOpts);
        }
      } else if (saved.width && saved.width !== "split" && WIDTH_VALUES.has(saved.width)) {
        lastWidth = saved.width;
        switcher.setWidth(lastWidth);
        applyWidth(lastWidth);
      }
      scheduleTabSessionPersist();
    }

    if (savedSession
      && savedSession.v === 1
      && savedSession.leftMarkdown
      && String(savedSession.leftMarkdown).trim()) {
      await restoreTabSession(savedSession);
    }

    if (sessionKey) {
      window.addEventListener("pagehide", flushTabSession);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushTabSession();
      });
    }

    window.matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (lastMode === "auto") applyMode("auto");
      });

    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== "local" || !changes.customPresets) return;
      customPresets = Array.isArray(changes.customPresets.newValue)
        ? changes.customPresets.newValue
        : [];
      switcher.setCustomPresets(projectCustom(customPresets));
      if (lastPreset.startsWith(CUSTOM_PREFIX)) {
        const stillExists = customPresets.some((p) => p.id === lastPreset);
        if (!stillExists) {
          lastPreset = "default";
          syncPresetMarker("default");
          switcher.setPreset("default");
          applyPreset(await loadPreset("default"));
        } else {
          syncPresetMarker(lastPreset);
          applyPreset(await loadPreset(lastPreset));
        }
      }
    });

    if (opts.onAfterBoot) {
      opts.onAfterBoot({ settings: prepared, mountEl });
    }

    return { mountEl, getLeftMarkdown: () => leftMarkdown };
  }

  function runBoot(opts) {
    boot(opts).catch((err) => {
      const msg = (err && err.message) || String(err);
      if (msg.includes("Extension context invalidated")) return;
      console.error("[Baseline] surface boot failed:", err);
    });
  }

  /** Same reading surface as file:// .md tabs (content.js / open.html). */
  function prepareMdReadingSettings(settings) {
    settings.width = "standard";
    return settings;
  }

  function runBootMdReadingPage(opts) {
    return runBoot(Object.assign({
      syncDefaults: { preset: "default", mode: "auto", width: "standard" },
      prepareSettings: prepareMdReadingSettings,
      pickLabel: "打开 Markdown 文件",
      mainEditTooltip: "在新标签页编辑",
      splitEditTooltip: "在新标签页编辑",
      translateMode: "open",
      getTranslateMarkdown: () => "",
      getTranslateSourceName: () => "document"
    }, opts));
  }

  root.BaselineSurface = {
    boot,
    runBoot,
    runBootMdReadingPage,
    prepareMdReadingSettings
  };
})(window);
