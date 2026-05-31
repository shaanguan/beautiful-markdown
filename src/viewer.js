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
    syncPresetMarker
  } = window.BaselineShared;

  // "bilingual" is viewer-only: the original .md tab strips it via
  // applyWidth's WIDTH_VALUES guard falls back to "standard" on .md tabs.
  const WIDTH_VALUES = new Set(["standard", "wide", "full", "bilingual"]);
  const WIDTH_CLASSES = [
    "bsw-width-standard", "bsw-width-wide", "bsw-width-full", "bsw-width-bilingual"
  ];

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

  function createStatusPill({ onCancel, onClose }) {
    const pill = document.createElement("div");
    pill.id = "bsw-viewer-status";

    const icon = document.createElement("span");
    icon.className = "bsw-viewer-status-icon is-spin";
    icon.innerHTML = spinnerSVG();

    const label = document.createElement("span");
    label.className = "bsw-viewer-status-label";
    label.textContent = "正在翻译…";

    const action = document.createElement("button");
    action.type = "button";
    action.className = "bsw-viewer-status-action";
    action.textContent = "取消";
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
          ? `正在翻译…(已生成 ${chars.toLocaleString()} 字符)`
          : "正在翻译…";
        action.textContent = "取消";
      },
      hide() {
        pill.hidden = true;
      },
      setError(message) {
        pill.classList.add("is-error");
        pill.hidden = false;
        icon.classList.remove("is-spin");
        icon.innerHTML = errorSVG();
        label.textContent = message || "翻译失败";
        action.textContent = "关闭";
      },
      setCancelled() {
        pill.classList.remove("is-error");
        pill.hidden = false;
        icon.classList.remove("is-spin");
        icon.innerHTML = errorSVG();
        label.textContent = "已取消";
        action.textContent = "关闭";
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
    h.textContent = "翻译失败";
    const p = document.createElement("p");
    p.textContent = message || "未知错误";
    wrap.appendChild(h);
    wrap.appendChild(p);
    state.mountEl.appendChild(wrap);
  }

  async function bootstrap() {
    const params = new URLSearchParams(location.search);
    const sessionId = params.get("session");
    const sourceName = params.get("name") || "document";
    const targetLanguage = params.get("lang") || "";

    const settings = Object.assign({}, DEFAULT_SETTINGS);
    let customPresets = await getCustomPresets();

    const builtIn = new Set(window.BaselineSwitcher.PRESETS.map((p) => p.value));
    const customIds = new Set(customPresets.map((p) => p.id));
    const presetKnown =
      builtIn.has(settings.preset) || customIds.has(settings.preset);
    if (!presetKnown) settings.preset = "default";

    const mountEl = buildScaffold();
    state.mountEl = mountEl;

    // Translation stream state (hoisted so column paste/swap can stop it).
    let done = false;
    let renderScheduled = false;
    let renderTimer = 0;
    let lastText = "";
    let statusPill = null;

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

    function openEditTab(markdown, name, column, mountEl) {
      openMarkdownInEditTab(markdown, name, column, mountEl).catch((err) => {
        console.warn("[Baseline] open edit tab failed:", err);
        if (statusPill) {
          statusPill.setError(
            "无法打开编辑页：" + ((err && err.message) || String(err))
          );
        }
      });
    }

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== "baselineEditApplied" || handedOff) return;
      const apply = () => {
        const label = msg.name || "编辑的内容";
        if (msg.column === "left") {
          originalMarkdown = msg.text;
          leftRendered = false;
          renderOriginal();
          return;
        }
        rightMarkdown = msg.text;
        lastText = msg.text;
        done = true;
        const savedScroll = readColumnScroll(mountEl);
        window.BaselineRenderer.renderTo(msg.text, mountEl)
          .then(() => {
            restoreColumnScroll(mountEl, savedScroll);
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

    function mountRightChrome() {
      if (!window.BaselineTOC || !window.BaselineTOC.mountChrome) return;
      window.BaselineTOC.mountChrome(mountEl, {
        getMarkdown: () => rightMarkdown || "",
        copyTooltip: "复制译文",
        copyDoneText: "译文已复制",
        onEdit: () => {
          openEditTab(
            rightMarkdown,
            sourceName,
            bilingualOn ? "right" : "main",
            mountEl
          );
        },
        editTooltip: "在新标签页编辑",
        onSwap: () => rightFileInput.click(),
        swapTooltip: "换文件",
        withTOC: !bilingualOn
      });
    }

    function mountLeftChrome() {
      if (!leftMountEl || !window.BaselineTOC || !window.BaselineTOC.mountChrome) return;
      window.BaselineTOC.mountChrome(leftMountEl, {
        getMarkdown: () => originalMarkdown || "",
        copyTooltip: "复制原文",
        copyDoneText: "原文已复制",
        onEdit: () => {
          openEditTab(
            originalMarkdown,
            leftFileName || sourceName,
            "left",
            leftMountEl
          );
        },
        editTooltip: "在新标签页编辑",
        onSwap: () => leftFileInput.click(),
        swapTooltip: "换文件",
        withTOC: false
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
      handoffToMdSurface(text, name || "粘贴的内容");
    }

    function handoffToMdSurface(text, name) {
      if (handedOff) return;
      handedOff = true;
      teardownViewerSessionUi();

      const label = name || "粘贴的内容";
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
          window.confirm("当前已有内容，是否用粘贴的 Markdown 替换？")
      })
      : null;

    function syncPasteRegistry() {
      if (handedOff || !pasteBinder || !rightView) return;
      pasteBinder.register(rightView, {
        hasContent: () => Boolean((rightMarkdown || lastText || "").trim()),
        onPaste: (text) => { ingestMarkdown(text, "粘贴的内容"); }
      });
      if (bilingualOn && leftView) {
        pasteBinder.register(leftView, {
          hasContent: () => Boolean(originalMarkdown && originalMarkdown.trim()),
          onPaste: (text) => { ingestMarkdown(text, "粘贴的内容"); }
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
      preview.appendChild(sizer);
      reading.appendChild(preview);
      view.appendChild(reading);
      return { view, sizer };
    }

    function renderOriginal() {
      if (handedOff || !leftMountEl || leftRendered) return;
      if (!originalMarkdown) return;
      window.BaselineRenderer.renderTo(originalMarkdown, leftMountEl)
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
    applyPreset(await loadPreset(settings.preset));
    syncPresetMarker(settings.preset);
    syncPasteRegistry();

    let lastPreset = settings.preset;
    let lastMode = settings.mode;
    let lastWidth = "standard";

    const switcher = window.BaselineSwitcher.mount({
      initial: { preset: settings.preset, mode: settings.mode, width: "standard" },
      customPresets: projectCustom(customPresets),
      // Viewer tabs never offer Translate again — only .md / open.html do.
      translateMode: "hidden",
      context: "viewer",
      onPresetChange: async (value) => {
        lastPreset = value;
        syncPresetMarker(value);
        applyPreset(await loadPreset(value));
      },
      onModeChange: (value) => {
        lastMode = value;
        applyMode(value);
      },
      onWidthChange: (value) => {
        lastWidth = value;
        applyWidth(value);
        if (value === "bilingual") enableBilingual();
        else disableBilingual();
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
    };
    chrome.storage.onChanged.addListener(syncStorageListener);

    // ── Translation session ────────────────────────────────────────────
    if (!sessionId) {
      showError("缺少会话 ID。请从原始文档点击翻译。");
      return;
    }

    let cancelled = false;

    statusPill = createStatusPill({
      onCancel: () => {
        if (done) return;
        cancelled = true;
        try { port && port.disconnect(); } catch (_) {}
        statusPill.setCancelled();
      },
      onClose: () => {
        // chrome.tabs.remove requires the tabs permission; fall back to
        // window.close() which works for tabs the extension opened.
        try { window.close(); } catch (_) {}
        statusPill.hide();
      }
    });
    statusPill.setBusy(0);

    try {
      port = chrome.runtime.connect({ name: "translator-session" });
    } catch (e) {
      statusPill.setError("无法连接翻译服务");
      showError("无法连接翻译服务：" + ((e && e.message) || String(e)));
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
            : window.BaselineRenderer.renderTo(lastText, mountEl));
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
        scheduleRender();
        return;
      }
      if (msg.type === "done") {
        done = true;
        lastText = msg.text;
        rightMarkdown = msg.text;
        statusPill.hide();
        if (renderTimer) {
          clearTimeout(renderTimer);
          renderTimer = 0;
          renderScheduled = false;
        }
        pendingRender
          .catch(() => {})
          .then(() => window.BaselineRenderer.renderTo(lastText, mountEl))
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
        statusPill.setError(msg.message || "翻译失败");
        showError(msg.message || "翻译失败");
        try { port.disconnect(); } catch (_) {}
        return;
      }
    });

    port.onDisconnect.addListener(() => {
      if (done || cancelled) return;
      const err = chrome.runtime.lastError;
      const message = (err && err.message) || "翻译服务断开连接。";
      statusPill.setError(message);
      showError(message);
    });

    try {
      port.postMessage({ type: "subscribe", sessionId });
    } catch (e) {
      const message = "无法订阅翻译会话：" + ((e && e.message) || String(e));
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
