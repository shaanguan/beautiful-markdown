/**
 * Viewer page bootstrap.
 *
 * Loaded by viewer.html (an extension-owned page opened from the
 * service worker after the user clicks Translate). Mirrors content.js
 * activate() — same scaffold DOM, same preset/mode/width loading, same
 * switcher widget — but instead of fetching a .md file it subscribes to a
 * translation session in the background and streams chunks into the
 * reading view.
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

  const CUSTOM_PREFIX = "custom:";
  // "bilingual" is viewer-only: the original .md tab strips it via
  // applyWidth's WIDTH_VALUES guard, so a synced setting from the viewer
  // gracefully falls back to "standard" there.
  const WIDTH_VALUES = new Set(["standard", "wide", "full", "bilingual"]);
  const WIDTH_CLASSES = [
    "bsw-width-standard", "bsw-width-wide", "bsw-width-full", "bsw-width-bilingual"
  ];

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
      if (!found) return emptyPreset();
      try { return compileFromJSON(found.json); }
      catch (e) { console.warn("[Baseline] custom preset compile failed:", e); return emptyPreset(); }
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

  function projectCustom(list) {
    return list.map((p) => ({ id: p.id, name: p.name }));
  }

  function mountNavChrome(mountEl, getCopyText, onEdit) {
    if (!window.BaselineTOC) return;
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
    // Edit on the viewer means "save the translation to disk and open it
    // in VS Code" — translated content has no source path, so we mint one
    // by routing through chrome.downloads. Copy is always available.
    if (window.BaselineTOC.mountDocActions) {
      window.BaselineTOC.mountDocActions(mountEl, {
        onCopy: typeof getCopyText === "function" ? getCopyText : () => "",
        copyTooltip: "复制译文",
        onEdit: typeof onEdit === "function" ? onEdit : null,
        editTooltip: "下载并用编辑器打开"
      });
    }
    window.BaselineTOC.mountProgressBar();
  }

  // Build the on-disk filename for the Edit button. Sanitize the source
  // name (Chrome rejects path separators / control chars in download
  // filenames) and append the target language so the user can tell
  // multiple translations apart in their Downloads folder.
  function sanitizeFilenamePart(s, fallback) {
    // Strip Windows-illegal chars + control chars so Chrome doesn't
    // reject the download. Spaces and hyphens are kept — they're
    // valid on every OS and the user's source filename may rely on them.
    const cleaned = String(s == null ? "" : s)
      .replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, "")
      .replace(/^\.+/, "")
      .trim();
    return cleaned || fallback;
  }

  function buildTranslatedFilename(sourceName, lang) {
    const base = sanitizeFilenamePart(sourceName, "document");
    const langPart = sanitizeFilenamePart(lang, "");
    // "自动判断" is the auto-detect sentinel — fall back to a neutral
    // label so we don't bake the marker into the filename.
    const useLang = langPart && langPart !== "自动判断" ? langPart : "translated";
    return `${base}.${useLang}.md`;
  }

  // Save the translated markdown to disk via chrome.downloads, then hand
  // the resulting absolute path off to VS Code via the vscode://file/
  // protocol. We need the absolute path (not the blob URL) because the
  // editor doesn't speak blob:.
  function downloadAndOpenInEditor(text, filename) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = URL.createObjectURL(new Blob([text || ""], { type: "text/markdown" }));
      } catch (e) {
        reject(e);
        return;
      }

      chrome.downloads.download(
        { url, filename, saveAs: false, conflictAction: "uniquify" },
        (downloadId) => {
          if (chrome.runtime.lastError || !downloadId) {
            try { URL.revokeObjectURL(url); } catch (_) {}
            reject(new Error(
              (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
              "无法启动下载"
            ));
            return;
          }

          const onChanged = (delta) => {
            if (delta.id !== downloadId) return;
            if (delta.state && delta.state.current === "complete") {
              chrome.downloads.onChanged.removeListener(onChanged);
              try { URL.revokeObjectURL(url); } catch (_) {}
              chrome.downloads.search({ id: downloadId }, (items) => {
                const item = items && items[0];
                if (!item || !item.filename) {
                  reject(new Error("无法获取下载文件路径"));
                  return;
                }
                // Windows paths use backslashes; vscode://file/ expects
                // forward slashes. Drive prefix (C:) stays intact.
                const path = item.filename.replace(/\\/g, "/");
                try {
                  location.href = "vscode://file/" + path;
                  resolve();
                } catch (err) {
                  reject(err);
                }
              });
            } else if (delta.state && delta.state.current === "interrupted") {
              chrome.downloads.onChanged.removeListener(onChanged);
              try { URL.revokeObjectURL(url); } catch (_) {}
              reject(new Error("下载被中断"));
            }
          };
          chrome.downloads.onChanged.addListener(onChanged);
        }
      );
    });
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

    const settings = await getSyncSettings();
    let customPresets = await getCustomPresets();

    const builtIn = new Set(window.BaselineSwitcher.PRESETS.map((p) => p.value));
    const customIds = new Set(customPresets.map((p) => p.id));
    const presetKnown =
      builtIn.has(settings.preset) || customIds.has(settings.preset);
    if (!presetKnown) settings.preset = "default";

    const mountEl = buildScaffold();
    state.mountEl = mountEl;

    // ── Bilingual (双栏对照) state ─────────────────────────────────────
    // Original markdown is sent on the translator-session port right
    // after subscribe (translator-bg.js). We stash it here so toggling
    // 双栏对照 later can render the left column instantly.
    let originalMarkdown = "";
    let bilingualOn = false;
    let leftView = null;        // .view-content.bsw-side-left
    let leftMountEl = null;     // .markdown-preview-sizer inside leftView
    let leftRendered = false;
    let scrollSyncTeardown = null;
    const rightView = mountEl.closest(".view-content");
    const leafContent = rightView && rightView.parentNode;

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
      if (!leftMountEl || leftRendered) return;
      if (!originalMarkdown) return; // wait for the "original" message
      window.BaselineRenderer.renderTo(originalMarkdown, leftMountEl)
        .then(() => { leftRendered = true; })
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
      if (bilingualOn) return;
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
      document.body.classList.add("bsw-bilingual-active");
      renderOriginal();
      scrollSyncTeardown = setupScrollSync();
    }

    function disableBilingual() {
      if (!bilingualOn) return;
      bilingualOn = false;
      document.body.classList.remove("bsw-bilingual-active");
      if (scrollSyncTeardown) { scrollSyncTeardown(); scrollSyncTeardown = null; }
      if (leftView && leftView.parentNode) leftView.parentNode.removeChild(leftView);
      leftView = null;
      leftMountEl = null;
      leftRendered = false;
    }

    applyMode(settings.mode);
    applyWidth(settings.width);
    applyPreset(await loadPreset(settings.preset));
    // Honour 双栏对照 from synced settings on first paint. The "original"
    // message hasn't arrived yet — renderOriginal() will fire when it does.
    if (settings.width === "bilingual") enableBilingual();

    let translatorSettings = window.BaselineTranslator
      ? await window.BaselineTranslator.loadSettings()
      : null;

    let lastPreset = settings.preset;
    let lastMode = settings.mode;
    let lastWidth = settings.width;

    const switcher = window.BaselineSwitcher.mount({
      initial: { preset: settings.preset, mode: settings.mode, width: settings.width },
      customPresets: projectCustom(customPresets),
      translatorSettings: translatorSettings,
      // Viewer is the translated view itself — no point offering to
      // translate it again. Hides the entire Translate row.
      translateMode: "hidden",
      // Show the 双栏对照 width option — viewer has both texts in scope.
      bilingualEnabled: true,
      onPresetChange: async (value) => {
        lastPreset = value;
        applyPreset(await loadPreset(value));
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
        if (value === "bilingual") enableBilingual();
        else disableBilingual();
        chrome.storage.sync.set({ width: value });
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
      }
    });
    switcherRef = switcher;
    switcher.setColorScheme(state.mode);

    window.matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (lastMode === "auto") applyMode("auto");
      });

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
          lastWidth = changes.width.newValue;
          switcher.setWidth(lastWidth);
          applyWidth(lastWidth);
          if (lastWidth === "bilingual") enableBilingual();
          else disableBilingual();
        }
        return;
      }
      if (area === "local" && changes.customPresets) {
        customPresets = Array.isArray(changes.customPresets.newValue)
          ? changes.customPresets.newValue
          : [];
        switcher.setCustomPresets(projectCustom(customPresets));
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

    // ── Translation session ────────────────────────────────────────────
    if (!sessionId) {
      showError("缺少会话 ID。请从原始文档点击翻译。");
      return;
    }

    let done = false;
    let cancelled = false;
    let port;

    const statusPill = createStatusPill({
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

    let lastText = "";
    // Stream-render strategy:
    //   1. Time-throttle (not RAF) — RAF can fire 60×/sec, but each
    //      renderTo() wipes mountEl.innerHTML, which destroys text
    //      selection, kills hover/focus state, and re-flows headings out
    //      from under the user. 200ms gives the eye a chance to settle
    //      between updates without making the stream feel choppy.
    //   2. Defer when the user has an active text selection inside
    //      mountEl. They're trying to read or copy — re-drawing the DOM
    //      under them would wipe the selection. We re-arm the timer so
    //      the next chunk (or selection release) gets rendered.
    //   3. Chain every render through `pendingRender` so two renderTo()
    //      calls never run against mountEl concurrently (they'd race in
    //      KaTeX/Mermaid passes and flicker the DOM). The done-handler
    //      awaits this chain before the final render + mountNavChrome.
    const RENDER_THROTTLE_MS = 200;
    let renderScheduled = false;
    let renderTimer = 0;
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
      if (renderScheduled) return;
      renderScheduled = true;
      renderTimer = setTimeout(() => {
        renderScheduled = false;
        renderTimer = 0;
        if (done) return;
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
      if (!msg) return;
      if (msg.type === "original") {
        // Bg ships the source markdown right after subscribe so bilingual
        // mode can render a left column without re-fetching the file.
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
        statusPill.hide();
        if (renderTimer) {
          clearTimeout(renderTimer);
          renderTimer = 0;
          renderScheduled = false;
        }
        // Await any in-flight chunk render so the final pass + TOC mount
        // sees a settled tree rather than racing against it.
        const editHandler = () => {
          const filename = buildTranslatedFilename(sourceName, targetLanguage);
          downloadAndOpenInEditor(lastText, filename).catch((err) => {
            console.warn("[Baseline] edit-in-editor failed:", err);
            statusPill.setError(
              "无法打开编辑器：" + ((err && err.message) || String(err))
            );
          });
        };
        pendingRender
          .catch(() => {})
          .then(() => window.BaselineRenderer.renderTo(lastText, mountEl))
          .then(() => mountNavChrome(mountEl, () => lastText, editHandler))
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
