/**
 * Shared .md reading surface for content.js (file/http .md) and open.js
 * (extension blank tab). Theme, split pane, switcher, paste, and translate
 * wiring live here once; entry scripts only supply source-specific hooks.
 */
(function (root) {
  "use strict";

  function createEditorialPill(onCancel) {
    var el = document.createElement("div");
    el.id = "bsw-editorial-pill";
    el.style.cssText =
      "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);" +
      "display:flex;align-items:center;gap:8px;padding:6px 14px;" +
      "background:rgba(0,0,0,.82);color:#fff;border-radius:999px;" +
      "font:12px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;" +
      "backdrop-filter:blur(12px);z-index:99999;user-select:none;" +
      "transition:background .2s,opacity .2s;";
    var spinner = document.createElement("span");
    spinner.className = "bsw-pill-spinner";
    spinner.style.cssText =
      "width:14px;height:14px;border:2px solid rgba(255,255,255,.3);" +
      "border-top-color:#fff;border-radius:50%;animation:bsw-spin .6s linear infinite;flex-shrink:0;";
    var label = document.createElement("span");
    label.textContent = "Generating…";
    var btn = document.createElement("button");
    btn.textContent = "Cancel";
    btn.style.cssText =
      "border:0;background:rgba(255,255,255,.15);color:#fff;" +
      "padding:3px 10px;border-radius:99px;cursor:pointer;font:inherit;";
    btn.addEventListener("click", onCancel);
    el.appendChild(spinner);
    el.appendChild(label);
    el.appendChild(btn);
    if (!document.getElementById("bsw-pill-keyframes")) {
      var style = document.createElement("style");
      style.id = "bsw-pill-keyframes";
      style.textContent = "@keyframes bsw-spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(style);
    }
    document.body.appendChild(el);
    var autoRemoveTimer = null;
    return {
      update: function (tokens) {
        label.textContent = tokens > 0
          ? "Generating… " + tokens.toLocaleString() + " tokens"
          : "Generating…";
      },
      error: function (msg) {
        spinner.style.display = "none";
        btn.style.display = "none";
        label.textContent = msg || "生成失败";
        el.style.background = "rgba(180,40,40,.85)";
        autoRemoveTimer = setTimeout(function () {
          if (el.parentNode) el.parentNode.removeChild(el);
        }, 4000);
      },
      remove: function () {
        if (autoRemoveTimer) clearTimeout(autoRemoveTimer);
        if (el.parentNode) el.parentNode.removeChild(el);
      }
    };
  }

  const WIDTH_VALUES = new Set(["standard", "wide", "full", "split"]);
  const WIDTH_CLASSES = [
    "bsw-width-standard", "bsw-width-wide", "bsw-width-full", "bsw-width-split"
  ];

  // Width-mode buttons surfaced in the top toolbar's segmented group.
  // Mirrors the labels that used to live in theme-switcher.js's WIDTHS
  // array — "Split" is .md-only (viewer.js has its own Bilingual list).
  const WIDTH_OPTIONS_MD = [
    { value: "standard", label: "标准" },
    { value: "wide",     label: "宽屏" },
    { value: "full",     label: "全宽" },
    { value: "split",    label: "分栏" }
  ];

  const FOLDER_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" ' +
    'viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">' +
    '<path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h207' +
    "q16 0 30.5 6t25.5 17l57 57h360q33 0 56.5 23.5T920-640H447l-80-80H160v480" +
    "l96-320h684L837-217q-8 26-29.5 41.5T760-160H160Zm84-80h516l72-240H316" +
    "l-72 240Zm0 0 72-240-72 240Zm-84-400v-80 80Z\"/></svg>";

  const HERO_SVG_ATTRS =
    'xmlns="http://www.w3.org/2000/svg" width="22" height="22" ' +
    'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true"';

  const HERO_ICON_SHIELD =
    "<svg " + HERO_SVG_ATTRS + ">" +
    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' +
    "</svg>";

  const HERO_ICON_LINK =
    "<svg " + HERO_SVG_ATTRS + ">" +
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
    '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' +
    "</svg>";

  const HERO_ICON_SCALES =
    "<svg " + HERO_SVG_ATTRS + ">" +
    '<path d="M12 3v18"/>' +
    '<path d="M8 21h8"/>' +
    '<path d="M5 6l14 0"/>' +
    '<path d="M5 6l-3 8h6l-3-8z"/>' +
    '<path d="M19 6l-3 8h6l-3-8z"/>' +
    "</svg>";

  const HERO_ICON_EYE =
    "<svg " + HERO_SVG_ATTRS + ">" +
    '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/>' +
    '<circle cx="12" cy="12" r="3"/>' +
    "</svg>";

  const HERO_FEATURES = [
    { icon: HERO_ICON_SHIELD, title: "Zero Modification", sub: "Preserve Knowledge as is." },
    { icon: HERO_ICON_LINK, title: "Zero Dependency", sub: "Independent of Any Medium." },
    { icon: HERO_ICON_SCALES, title: "Zero Bias", sub: "Present Knowledge, Not Opinions." },
    { icon: HERO_ICON_EYE, title: "Zero Distraction", sub: "Designed for Natural Reading." }
  ];

  function buildOpenHero() {
    const hero = document.createElement("div");
    hero.className = "bsw-open-hero";
    hero.innerHTML =
      '<div class="bsw-open-hero-logo" aria-hidden="true"></div>' +
      '<h1 class="bsw-open-hero-title">Beautiful,<br>Yet <span>Faithful</span></h1>' +
      '<div class="bsw-open-hero-rule"></div>' +
      '<p class="bsw-open-hero-label">PHILOSOPHY</p>' +
      '<p class="bsw-open-hero-tag">AI for Knowledge,<br>Knowledge for Humans.</p>';

    const list = document.createElement("ul");
    list.className = "bsw-open-hero-features";
    HERO_FEATURES.forEach((f) => {
      const li = document.createElement("li");
      li.innerHTML =
        '<span class="bsw-open-hero-icon">' + f.icon + "</span>" +
        '<div class="bsw-open-hero-feat">' +
          '<p class="bsw-open-hero-feat-title">' + f.title + "</p>" +
          '<p class="bsw-open-hero-feat-sub">' + f.sub + "</p>" +
        "</div>";
      list.appendChild(li);
    });
    hero.appendChild(list);
    return hero;
  }

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
    syncPresetMarker,
    getRecentDocs,
    recordRecentHandle,
    removeRecentDoc,
    readRecentDoc,
    commitPresetTypography,
    renderPreviewMarkdown,
    reassertTypographyLock
  } = root.BaselineShared;

  const PICKER_TYPES = [{
    description: "Markdown",
    accept: { "text/markdown": [".md", ".markdown", ".mdown", ".mkd"] }
  }];

  function relativeTime(ts) {
    if (!ts) return "";
    const diff = Date.now() - ts;
    if (diff < 60_000) return "Just now";
    if (diff < 3_600_000) {
      const m = Math.floor(diff / 60_000);
      return m + (m === 1 ? " min ago" : " mins ago");
    }
    if (diff < 86_400_000) {
      const h = Math.floor(diff / 3_600_000);
      return h + (h === 1 ? " hr ago" : " hrs ago");
    }
    if (diff < 172_800_000) return "Yesterday";
    if (diff < 604_800_000) {
      const d = Math.floor(diff / 86_400_000);
      return d + (d === 1 ? " day ago" : " days ago");
    }
    const d = new Date(ts);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return months[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
  }

  const ICON_DOC =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" ' +
    'fill="currentColor" aria-hidden="true">' +
    '<path d="M320-240h320v-80H320v80Zm0-160h320v-80H320v80ZM240-80q-33 0' +
    '-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33' +
    '-23.5 56.5T720-80H240Zm280-560v-160H240v640h480v-480H520ZM240-800v160' +
    '-160 640-640Z"/></svg>';
  const ICON_FOLDER =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" ' +
    'fill="currentColor" aria-hidden="true">' +
    '<path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h207' +
    'q16 0 30.5 6t25.5 17l57 57h360q33 0 56.5 23.5T920-640v400q0 33-23.5 ' +
    '56.5T840-160H160Zm0-80h680v-400H447l-80-80H160v480Zm0 0v-480 480Z"/></svg>';
  const ICON_GLOBE =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" ' +
    'fill="currentColor" aria-hidden="true">' +
    '<path d="M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 ' +
    '31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 ' +
    '85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-82q26' +
    '-36 45-75t31-83H404q12 44 31 83t45 75Zm-104-16q-18-33-31.5-68.5T322-320' +
    'H204q29 50 72.5 87t99.5 55Zm208 0q56-18 99.5-55t72.5-87H638q-9 38-22.5 ' +
    '73.5T584-178ZM170-400h136q-3-20-4.5-39.5T300-480q0-21 1.5-40.5T306-560H170' +
    'q-5 20-7.5 39.5T160-480q0 21 2.5 40.5T170-400Zm216 0h188q3-20 4.5-39.5T580' +
    '-480q0-21-1.5-40.5T574-560H386q-3 20-4.5 39.5T380-480q0 21 1.5 40.5T386-400' +
    'Zm268 0h136q5-20 7.5-39.5T800-480q0-21-2.5-40.5T790-560H654q3 20 4.5 39.5' +
    'T660-480q0 21-1.5 40.5T654-400Zm-16-240h118q-29-50-72.5-87T584-782q18 33 ' +
    '31.5 68.5T638-640Zm-234 0h152q-12-44-31-83t-45-75q-26 36-45 75t-31 83Zm' +
    '-200 0h118q9-38 22.5-73.5T376-782q-56 18-99.5 55T204-640Z"/></svg>';
  // Explicit width/height attrs are load-bearing: the parent .markdown-rendered
  // sets `svg:not(.svg-icon) { height: auto }` with higher specificity than
  // .bsw-recent-remove svg, collapsing the icon to 0 height. Inline attrs win.
  const ICON_CLOSE =
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" ' +
    'viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">' +
    '<path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 ' +
    '224 224 224-56 56-224-224-224 224Z"/></svg>';

  // Chevron used by the open-page recent list to hint at scrollable overflow.
  const ICON_CHEVRON_DOWN =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="6 9 12 15 18 9"/></svg>';

  function recentEntryIcon(entry) {
    if (entry.kind === "handle") return ICON_DOC;
    if (entry.kind === "url" && entry.url) {
      try {
        const u = new URL(entry.url);
        return u.protocol === "file:" ? ICON_FOLDER : ICON_GLOBE;
      } catch (_) { return ICON_DOC; }
    }
    return ICON_DOC;
  }

  // Subtitle is the secondary line — answers "where is this from?" without
  // duplicating the filename. Kept short so two-line items align cleanly.
  function recentEntrySubtitle(entry) {
    if (entry.kind === "handle") return "Local file";
    if (entry.kind === "url" && entry.url) {
      try {
        const u = new URL(entry.url);
        if (u.protocol === "file:") {
          let p;
          try { p = decodeURI(u.pathname || ""); }
          catch { p = u.pathname || ""; }
          if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
          const last = p.lastIndexOf("/");
          const dir = last > 0 ? p.slice(0, last) : p;
          return dir || "Local path";
        }
        return u.host || entry.url;
      } catch (_) { return entry.url; }
    }
    return "";
  }

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
    // Content scripts don't have chrome.tabs; bg already used
    // tabs.sendMessage(sourceTabId, ...) to reach us, so we're the right tab.
    if (!chrome.tabs || typeof chrome.tabs.getCurrent !== "function") {
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
    return (han / total) > 0.15 ? "zh" : "other";
  }

  function suggestedTargetLanguage(detected) {
    // Returns canonical English language names — matches translator-core.js
    // LANGUAGE_OPTIONS so the dropdown can find the value when it lands in
    // chrome.storage.local. Legacy "中文" values are migrated forward by
    // translator-client.js loadSettings.
    return detected === "zh" ? "English" : "Chinese";
  }

  // Forwards to BaselineShared.markAsPasteHost. Kept as a local stub so
  // call sites here read symmetrically with viewer.js (both reach the
  // shared impl). See baseline-shared.js for the why.
  function markAsPasteHost(el) {
    window.BaselineShared.markAsPasteHost(el);
  }

  function isEditablePasteTarget(el) {
    if (!el) return false;
    if (el.closest && el.closest("#baseline-switcher")) return true;
    // The open-page hero is marked contenteditable purely so Chrome offers
    // the "Paste" item in its right-click menu and routes ⌘V's paste event
    // here. We handle the content ourselves — never treat it as a real
    // input target (would let the browser insert raw text into the hero).
    if (el.closest && el.closest("[data-bsw-paste-host]")) return false;
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
    markAsPasteHost(sizer);

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

  // Slim scaffold for the blank-tab empty state: just body, no Obsidian
  // wrapper chain. Returns null because there is no mountEl yet — the
  // hero element built by showMainEmptyState will be appended directly to
  // body. When content arrives, upgradeToFullScaffold() builds the full
  // chain so theme.css / renderer targets land in the right place.
  function buildSlimScaffold(scaffold) {
    const body = document.body;
    if (scaffold.replaceBody) {
      body.innerHTML = "";
      body.className = "";
      ensureFilePageImagePolicy();
    } else if (scaffold.bodyClass) {
      body.className = scaffold.bodyClass;
    }
    return null;
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
    markAsPasteHost(sizer);
    preview.appendChild(sizer);
    reading.appendChild(preview);
    view.appendChild(reading);
    return { view, preview, sizer };
  }

  /** Open tab + split right column share the same empty affordance. */
  function buildColumnEmptyUI(onPick, label, options) {
    const opt = options || {};
    const empty = document.createElement("div");
    empty.className = "bsw-split-empty bsw-open-empty";

    // Paste-host on BOTH empty variants (open hero + split right column).
    // Principle: wherever ⌘V works, right-click → Paste must work too.
    // contenteditable elements force-allow text selection at the browser
    // level — CSS user-select: none can't beat that, so we also block
    // selectstart and clear any selection that sneaks in (drag from
    // outside, programmatic, etc.). The copyright <a> is unaffected:
    // selectstart on links isn't required to activate their click.
    markAsPasteHost(empty);
    empty.addEventListener("selectstart", (e) => {
      e.preventDefault();
    });
    empty.addEventListener("mouseup", () => {
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.rangeCount && empty.contains(sel.anchorNode)) {
        sel.removeAllRanges();
      }
    });

    let stack = empty;
    if (opt.includeHero) {
      empty.classList.add("bsw-open-empty-hero");
      const heroEl = buildOpenHero();
      empty.appendChild(heroEl);
      stack = document.createElement("div");
      stack.className = "bsw-open-stack";
      empty.appendChild(stack);
      // Bottom-left copyright. Fixed-positioned so it sits flush against the
      // viewport edge; left+bottom share the same offset as Beautiful's left
      // edge (hero left:30 + hero padding-left clamp(48px,4vw,80px)).
      // Anchor with mailto so a click opens the user's default mail client
      // pre-addressed to me. No subject/body — those leak into the browser's
      // link-preview status bar at the page bottom and tie the email to the
      // current document, which the user explicitly does not want.
      const copyright = document.createElement("a");
      copyright.className = "bsw-open-copyright";
      copyright.href = "mailto:jxaa103024@yeah.net";
      copyright.title = "Send feedback to Zhoubo";
      copyright.textContent = "© Zhoubo";
      // Inside a contenteditable host, link clicks would place the caret
      // instead of navigating. Opt out + handle the click explicitly so a
      // bare left-click reliably opens the mailto: URL.
      copyright.setAttribute("contenteditable", "false");
      copyright.addEventListener("mousedown", (e) => e.stopPropagation());
      copyright.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = copyright.href;
      });
      heroEl.appendChild(copyright);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bsw-import-button bsw-split-pick";
    const mod = navigator.platform.toUpperCase().indexOf("MAC") >= 0 ? "⌘" : "Ctrl";
    // Paste hint lives INSIDE the button now (as a span — <p> isn't valid
    // phrasing content inside <button>) and sits 4px below the label.
    btn.innerHTML = FOLDER_ICON +
      '<span class="bsw-pick-textstack">' +
        '<span class="bsw-pick-label">' + label + '</span>' +
        '<span class="bsw-split-empty-note bsw-open-paste-hint">' +
          "Or press <kbd>" + mod + "</kbd> + <kbd>V</kbd> to paste Markdown" +
        '</span>' +
      '</span>';
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onPick();
    });
    stack.appendChild(btn);

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
        onLoaded(String(reader.result || ""), f.name || "", null);
      };
      reader.onerror = () => {
        console.warn("[Baseline] file read failed:", reader.error);
      };
      reader.readAsText(f);
      input.value = "";
    });
    return input;
  }

  // Prefer File System Access API so we can persist a FileSystemFileHandle
  // and re-open the same file later without another picker dialog. Falls
  // back to <input type="file"> when the API is missing (mostly non-
  // Chromium browsers; Chrome extensions always have it).
  async function pickFileViaApi() {
    if (typeof window.showOpenFilePicker !== "function") return null;
    let handles;
    try {
      handles = await window.showOpenFilePicker({
        multiple: false,
        types: PICKER_TYPES,
        excludeAcceptAllOption: false
      });
    } catch (e) {
      if (e && (e.name === "AbortError" || e.code === 20)) return null;
      console.warn("[Baseline] showOpenFilePicker failed:", e);
      return null;
    }
    const handle = handles && handles[0];
    if (!handle) return null;
    let file;
    try { file = await handle.getFile(); }
    catch (e) { console.warn("[Baseline] handle.getFile failed:", e); return null; }
    const text = await file.text();
    return { text, name: file.name || handle.name || "", handle };
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
      // Broadcast the resolved mode so any open edit tab can mirror the
      // reading tab's Dark/Light without each maintaining its own toggle.
      // Most-recent reading-tab write wins (single user, single intent).
      try {
        chrome.storage.local.set({ bswEditFollowMode: resolved });
      } catch (_) { /* extension context invalidated; harmless */ }
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
    let splitChromeHandle = null;
    // Dirty bit per column: true after an edit applies, cleared on download
    // and whenever the column's content is freshly loaded (pick / paste /
    // recent / empty-state). mountChrome reads this at mount time; live
    // updates use the returned handle's setDirty() to flip the dot without
    // rebuilding the toolbar.
    let leftDirty = false;
    let splitDirty = false;
    // Origin marker per column: true when content came straight from disk
    // (Open File / drag-drop / Recent entry / local-file content boot) and
    // hasn't been edited since. While true and !dirty, the Download button
    // hides — the on-disk copy is still authoritative. Flips to false once
    // the user pastes / translates / loads new content, or sets back to true
    // after a download (which conceptually re-syncs disk).
    // leftFromLocalFile is seeded further down once we've parsed opts.initial
    // (need access to opts before we can read .fromLocalFile). Both default
    // to false; the boot path below sets leftFromLocalFile if applicable.
    let leftFromLocalFile = false;
    let splitFromLocalFile = false;

    function refreshDownloadVisibility(side) {
      const handle = side === "right" ? splitChromeHandle : mainChromeHandle;
      if (!handle) return;
      const dirty = side === "right" ? splitDirty : leftDirty;
      const fromLocal = side === "right" ? splitFromLocalFile : leftFromLocalFile;
      const visible = !fromLocal || dirty;
      // mountChrome is async; the handle may still be a Promise.
      Promise.resolve(handle).then((resolved) => {
        if (resolved && typeof resolved.setDownloadVisible === "function") {
          resolved.setDownloadVisible(visible);
        }
      });
    }

    function downloadLeftMarkdown() {
      const shared = root.BaselineShared;
      if (!shared || typeof shared.downloadMarkdown !== "function") {
        return Promise.reject(new Error("downloadMarkdown unavailable"));
      }
      const name = leftFileName || "untitled.md";
      return Promise.resolve(shared.downloadMarkdown(leftMarkdown || "", name))
        .then(() => {
          leftDirty = false;
          // The on-disk file now matches what the user saved, so treat it
          // as a local file again — the button hides until the next edit.
          leftFromLocalFile = true;
          refreshDownloadVisibility("left");
        });
    }

    function downloadSplitMarkdown() {
      const shared = root.BaselineShared;
      if (!shared || typeof shared.downloadMarkdown !== "function") {
        return Promise.reject(new Error("downloadMarkdown unavailable"));
      }
      const name = splitFileName || "untitled.md";
      return Promise.resolve(shared.downloadMarkdown(splitMarkdown || "", name))
        .then(() => {
          splitDirty = false;
          splitFromLocalFile = true;
          refreshDownloadVisibility("right");
        });
    }

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
        leftFromLocalFile,
        splitOn,
        splitMarkdown,
        splitFileName,
        splitFromLocalFile,
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
      if (mainChromeHandle && typeof mainChromeHandle.setActiveWidth === "function") {
        mainChromeHandle.setActiveWidth("standard");
      }
    }

    // Lazy scaffold: for the blank-tab empty state we skip the 11-layer
    // Obsidian wrapper chain and let the hero sit directly under body.
    // Once real content arrives (file pick / paste / session restore) we
    // call upgradeToFullScaffold() to build the chain and re-bind listeners.
    const startSlim = !!(opts.emptyStart
      && !(opts.initial && opts.initial.markdown));
    let mountEl = null;
    let mainView = null;

    function bindMainSurfaceListeners() {
      if (!mountEl) return;
      bindReadingDblClick(
        mountEl,
        () => leftMarkdown || "",
        () => leftFileName || "",
        "main",
        () => mainLoadedAt
      );
      if (root.BaselineSelectionMenu
        && typeof root.BaselineSelectionMenu.mount === "function") {
        root.BaselineSelectionMenu.mount(mountEl, {
          getMarkdown: () => leftMarkdown || "",
          getName: () => leftFileName || "",
          getColumn: () => "main"
        });
      }
    }

    if (startSlim) {
      buildSlimScaffold(opts.scaffold);
      ui.mountEl = null;
    } else {
      ui.mountEl = buildScaffold(opts.scaffold);
      mountEl = ui.mountEl;
      mainView = mountEl.closest(".view-content");
      bindMainSurfaceListeners();
      // NOTE: do not call internal lock here. Preset decision not yet made; use commitPresetTypography after applyPreset.
    }

    // Promote slim → full scaffold when real content arrives. Called from
    // renderMainColumn / restoreTabSession before renderTo. Idempotent.
    // No downgrade path: once promoted, stays promoted (a subsequent
    // showMainEmptyState falls back to the in-sizer empty hero rather than
    // tearing the scaffold back down).
    function upgradeToFullScaffold() {
      if (mountEl) return;
      const slimHero = document.body
        .querySelector(":scope > .bsw-open-empty");
      if (slimHero) slimHero.remove();
      unbindSlimBodyDblclick();
      disableSlimBodyPaste();
      ui.mountEl = buildScaffold(opts.scaffold);
      mountEl = ui.mountEl;
      mainView = mountEl.closest(".view-content");
      bindMainSurfaceListeners();
      // NOTE: typography lock intentionally omitted here. upgradeToFullScaffold can be
      // triggered early; commitPresetTypography (or render wrapper) after preset decision will handle it.
      if (opts.emptyStart && mainView) {
        mainView.addEventListener("dblclick", onOpenEmptyAreaClick);
      }
      // Move the paste-target registration from body → real mainView now
      // that it exists, so subsequent pastes route through the column.
      syncPasteRegistry();
    }

    // In slim mode the .view-content target doesn't exist, so the
    // "dblclick anywhere empty to pick a file" affordance hangs off body.
    // Helpers are idempotent and self-tracking via the bound flag.
    let slimBodyDblBound = false;
    function bindSlimBodyDblclick() {
      if (slimBodyDblBound) return;
      document.body.addEventListener("dblclick", onOpenEmptyAreaClick);
      slimBodyDblBound = true;
    }
    // ⌘V and right-click paste are both handled by the contenteditable
    // marker on .bsw-open-empty (set in buildColumnEmptyUI) + the document
    // paste listener in toc.js (bindColumnPaste) — no slim-mode keydown
    // helper needed. Kept as no-ops so existing call sites stay valid.
    function enableSlimBodyPaste() { /* no-op */ }
    function disableSlimBodyPaste() { /* no-op */ }
    function unbindSlimBodyDblclick() {
      if (!slimBodyDblBound) return;
      document.body.removeEventListener("dblclick", onOpenEmptyAreaClick);
      slimBodyDblBound = false;
    }

    applyMode(prepared.mode);
    applyWidth(prepared.width);
    await commitPresetTypography(mountEl, prepared.preset, (p) => applyPreset(p));

    let leftMarkdown = (opts.initial && opts.initial.markdown) || "";
    let leftFileName = (opts.initial && opts.initial.fileName) || "";
    if (!leftFileName && root.BaselineShared && root.BaselineShared.fileNameFromPageUrl) {
      leftFileName = root.BaselineShared.fileNameFromPageUrl();
    }
    // Caller (content.js) marks file:// pages as locally opened. The flag
    // here seeds leftFromLocalFile so the first chrome mount can decide
    // whether to hide the Download button. Set BEFORE mountMainChrome runs.
    leftFromLocalFile = !!(opts.initial && opts.initial.fromLocalFile);

    let splitOn = false;
    let splitView = null;
    let splitMountEl = null;
    let splitPreview = null;
    let splitFileName = "";
    let splitMarkdown = "";

    // Suppress the「双击进入编辑态」path right after a fresh content load,
    // so the second click of a dblclick on a recent item (or any picker
    // affordance) doesn't accidentally land on the newly painted content
    // and open the edit tab. 500ms covers typical render latency plus
    // user reaction.
    const LOAD_DBLCLICK_GUARD_MS = 500;
    let mainLoadedAt = 0;
    let splitLoadedAt = 0;
    function bumpMainLoaded() { mainLoadedAt = Date.now(); }
    function bumpSplitLoaded() { splitLoadedAt = Date.now(); }

    function syncOpenEmptyAreaClick() {
      if (!opts.emptyStart || !mainView) return;
      const empty = !ui.hasMainContent;
      mainView.classList.toggle("bsw-open-empty-clickable", empty);
      if (empty) {
        mainView.setAttribute("title", "Double-click to open a Markdown file");
      } else {
        mainView.removeAttribute("title");
      }
    }

    function onOpenEmptyAreaClick(e) {
      if (!opts.emptyStart || ui.hasMainContent) return;
      if (e.target.closest("#baseline-switcher, .bsw-doc-tools")) return;
      if (e.target.closest(".bsw-recent-list")) return;
      pickFor("left");
    }

    function splitColumnIsEmpty() {
      return !splitMarkdown || !splitMarkdown.trim();
    }

    function syncSplitEmptyAreaClick() {
      if (!splitView) return;
      const empty = splitOn && splitColumnIsEmpty();
      splitView.classList.toggle("bsw-open-empty-clickable", empty);
      if (empty) {
        splitView.setAttribute("title", "Double-click to open a Markdown file");
      } else {
        splitView.removeAttribute("title");
      }
    }

    function onSplitEmptyAreaClick(e) {
      if (!splitOn || !splitColumnIsEmpty()) return;
      if (e.target.closest("#baseline-switcher, .bsw-doc-tools")) return;
      if (e.target.closest(".bsw-recent-list")) return;
      pickFor("right");
    }

    function showMainEmptyState() {
      if (sessionKey) clearTabSession(sessionKey);
      leftMarkdown = "";
      leftFileName = "";
      leftDirty = false;
      ui.hasMainContent = false;
      const empty = buildColumnEmptyUI(() => pickFor("left"), opts.pickLabel, {
        includeHero: !!opts.emptyStart
      });
      if (mountEl) {
        // Full scaffold present (post-upgrade rare path): empty hero in sizer.
        mountEl.innerHTML = "";
        mountEl.appendChild(empty);
      } else {
        // Slim scaffold: hero is body's direct child. Strip any prior hero
        // first so repeated calls don't stack heroes.
        const prior = document.body
          .querySelector(":scope > .bsw-open-empty");
        if (prior) prior.remove();
        document.body.appendChild(empty);
        bindSlimBodyDblclick();
        enableSlimBodyPaste();
      }
      // Open tab only: surface the recent list under the picker button.
      if (opts.emptyStart && opts.showRecents !== false) {
        const recentSlot = document.createElement("div");
        recentSlot.className = "bsw-recent-slot";
        const stack = empty.querySelector(".bsw-open-stack") || empty;
        stack.appendChild(recentSlot);
        refreshRecentList(recentSlot, "left");
        // Down-chevron sibling of the stack: appears when the recent list
        // overflows the stack's scroll budget (max-height = 100vh − 160px),
        // and only while the stack is at the default scroll position.
        if (stack !== empty) {
          mountStackOverflowArrow(empty, stack);
        }
      }
      syncOpenEmptyAreaClick();
      updateTranslateUi();
    }

    function mountStackOverflowArrow(empty, stack) {
      // Skip if already mounted (showMainEmptyState may run more than once).
      if (stack.querySelector(":scope > .bsw-stack-overflow-arrow")) return;
      const arrow = document.createElement("div");
      arrow.className = "bsw-stack-overflow-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.innerHTML = ICON_CHEVRON_DOWN;
      stack.appendChild(arrow);

      // Feather gradient — inside scroll container, sticky to bottom.
      let feather = stack.querySelector(":scope > .bsw-stack-feather");
      if (!feather) {
        feather = document.createElement("div");
        feather.className = "bsw-stack-feather";
        feather.setAttribute("aria-hidden", "true");
        stack.appendChild(feather);
      }

      const update = () => {
        const overflowing = stack.scrollHeight > stack.clientHeight + 1;
        const atTop = stack.scrollTop <= 1;
        const distanceFromBottom =
          stack.scrollHeight - stack.clientHeight - stack.scrollTop;
        const recentItems = stack.querySelectorAll(".bsw-recent-item");
        empty.classList.toggle("has-overflow-arrow", recentItems.length > 3 && overflowing && distanceFromBottom > 1 && stack.scrollTop <= 50);
        feather.classList.toggle(
          "is-visible",
          overflowing && distanceFromBottom > 1
        );
      };
      stack.addEventListener("scroll", update, { passive: true });
      // Recompute when the stack's own box resizes (viewport changes) AND
      // when the recent list's content changes (renderRecentList swaps the
      // slot's innerHTML, which changes scrollHeight without changing the
      // stack's border-box). Observe both for the union of both signals.
      if (typeof ResizeObserver === "function") {
        const ro = new ResizeObserver(update);
        ro.observe(stack);
        const slot = stack.querySelector(":scope > .bsw-recent-slot");
        if (slot) ro.observe(slot);
      }
      // Two rAFs: first lets the recent list's getRecentDocs() promise
      // resolve & render; second lets layout settle so scrollHeight is real.
      requestAnimationFrame(() => requestAnimationFrame(update));
    }

    function renderRecentList(slot, list, side, opts) {
      slot.innerHTML = "";
      if (!list || !list.length) return;
      const narrow = !!(opts && opts.narrow);
      const wrap = document.createElement("div");
      wrap.className = "bsw-recent-list" + (narrow ? " bsw-recent-list--narrow" : "");

      const heading = document.createElement("div");
      heading.className = "bsw-recent-heading";
      const headingText = document.createElement("span");
      headingText.className = "bsw-recent-heading-text";
      headingText.textContent = "Recent";
      heading.appendChild(headingText);
      wrap.appendChild(heading);

      const ul = document.createElement("ul");
      ul.className = "bsw-recent-items";
      for (const entry of list) {
        const li = document.createElement("li");
        li.className = "bsw-recent-item";
        li.setAttribute("data-kind", entry.kind);
        // Whole row is the click target — icon, name, time, and the gaps
        // between them all open the entry. The delete button stops propagation
        // so its clicks don't also trigger an open. stopPropagation on the li
        // prevents the click from bubbling to the surrounding view-level
        // dblclick area (which would otherwise fire the empty-area picker).
        li.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openRecentEntry(entry, side).catch((e) =>
            console.warn("[Baseline] open recent failed:", e));
        });

        const iconWrap = document.createElement("span");
        iconWrap.className = "bsw-recent-icon";
        iconWrap.innerHTML = recentEntryIcon(entry);

        const main = document.createElement("button");
        main.type = "button";
        main.className = "bsw-recent-main";
        main.title = entry.url || entry.name || "";
        const nm = document.createElement("span");
        nm.className = "bsw-recent-name";
        nm.textContent = entry.name || entry.url || "(untitled)";
        main.appendChild(nm);

        const time = document.createElement("span");
        time.className = "bsw-recent-time";
        time.textContent = relativeTime(entry.lastOpened);

        const del = document.createElement("button");
        del.type = "button";
        del.className = "bsw-recent-remove";
        del.title = "Remove from recent";
        del.setAttribute("aria-label", "Remove from recent");
        // Text glyph instead of inline SVG — sidesteps the
        // .markdown-rendered svg:not(.svg-icon) {height:auto} cascade that
        // was collapsing the icon to 0 height despite explicit sizing.
        del.textContent = "×";
        del.addEventListener("click", (ev) => {
          ev.stopPropagation();
          removeRecentDoc(entry.id)
            .then(() => refreshRecentList(slot, side, opts))
            .catch((e) => console.warn("[Baseline] remove recent failed:", e));
        });

        li.appendChild(iconWrap);
        li.appendChild(main);
        li.appendChild(time);
        li.appendChild(del);
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
      slot.appendChild(wrap);
    }

    function refreshRecentList(slot, side, opts) {
      getRecentDocs()
        .then((list) => renderRecentList(slot, list, side, opts))
        .catch((e) => console.warn("[Baseline] load recent failed:", e));
    }

    // mountChrome is async → handle is a Promise. Destroy via .then so we
    // don't synchronously call `.destroy()` on a Promise (TypeError that
    // throws out of disableSplit and leaves the translate toggle stuck
    // hidden — see Task #19).
    function destroyChromeHandle(h) {
      if (!h) return;
      Promise.resolve(h).then((resolved) => {
        if (resolved && typeof resolved.destroy === "function") {
          resolved.destroy();
        }
      });
    }

    // Shared by toolbar width buttons and (legacy) switcher callback so
    // both entry points produce identical state transitions: persist new
    // width, apply layout, toggle split, then schedule a tab-session save.
    function handleWidthChange(value) {
      lastWidth = value;
      applyWidth(value);
      if (value === "split") {
        enableSplit();
      } else {
        disableSplit();
      }
      if (mainChromeHandle && typeof mainChromeHandle.reconnectSpy === "function") {
        mainChromeHandle.reconnectSpy();
      }
      updateTranslateUi();
      scheduleTabSessionPersist();
    }

    async function triggerTranslateWithLang(lang) {
      if (!leftMarkdown || !leftMarkdown.trim()) {
        return { error: "没有内容" };
      }
      if (!translatorSettings) {
        if (root.BaselineTranslator) {
          try { translatorSettings = await root.BaselineTranslator.loadSettings(); }
          catch (_) {}
        }
      }
      if (!translatorSettings || !translatorSettings.apiKey) {
        return { error: "请先配置 API Key" };
      }
      translatorSettings.targetLanguage = lang;
      if (root.BaselineTranslator) {
        root.BaselineTranslator.saveSettings({ targetLanguage: lang }).catch(() => {});
      }
      const sessionId = crypto.randomUUID();
      try {
        const resp = await chrome.runtime.sendMessage({
          type: "registerAndOpen",
          sessionId,
          markdown: leftMarkdown,
          settings: translatorSettings,
          sourceName: leftFileName || "untitled.md",
          targetLanguage: lang,
          preset: lastPreset
        });
        if (!resp || !resp.ok) {
          return { error: (resp && resp.error) || "无法打开翻译页" };
        }
      } catch (err) {
        return { error: (err && err.message) || "无法打开翻译页" };
      }
    }


    function openEditorialResult(html, mode, sourceName, cacheKey) {
      var isSlides = /=== SLIDE 1 ===/.test(html);
      var storageKey = isSlides ? "slidesHtml" : "editorialHtml";
      var page = isSlides ? "slides-player.html" : "editorial.html";
      var data = {};
      data[storageKey] = html;
      chrome.storage.session.set(data, function () {
        chrome.runtime.sendMessage({ type: "openExtensionPage", page: page });
      });
      // Download via background and cache path
      var folders = { slides: "AI Slides", report: "AI Report", dashboard: "AI Dashboard" };
      var folder = folders[mode] || "AI Slides";
      var base = (sourceName || "document").replace(/\.[^.]+$/, "");
      var dlFilename = "Beautiful Markdown/" + folder + "/" + base + ".html";
      chrome.runtime.sendMessage({
        type: "downloadEditorial",
        html: html,
        filename: dlFilename,
        cacheKey: cacheKey
      });
    }

    async function runEditorialFor(markdown, fileName, mode) {
      if (!markdown || !markdown.trim()) {
        return { error: "没有内容" };
      }
      if (!translatorSettings) {
        if (root.BaselineTranslator) {
          try { translatorSettings = await root.BaselineTranslator.loadSettings(); }
          catch (_) {}
        }
      }
      if (!translatorSettings || !translatorSettings.apiKey) {
        return { error: "请先配置 API Key" };
      }

      var m = mode || "slides";

      // Run AI via port, show loading on current page
      return new Promise(function (resolve) {
        var port;
        try { port = chrome.runtime.connect({ name: "editorial-direct" }); }
        catch (e) { resolve({ error: "无法连接后台服务" }); return; }

        var pill = createEditorialPill(function () {
          try { port.disconnect(); } catch (_) {}
          pill.remove();
        });

        var settled = false;
        port.onMessage.addListener(function (msg) {
          if (!msg || settled) return;
          if (msg.type === "chunk") {
            pill.update(msg.tokens || 0);
          }
          if (msg.type === "done") {
            settled = true;
            pill.remove();
            try { port.disconnect(); } catch (_) {}
            return resolve();
          }
          if (msg.type === "error") {
            settled = true;
            try { port.disconnect(); } catch (_) {}
            pill.error(msg.message || "生成失败");
            return resolve();
          }
        });

        port.onDisconnect.addListener(function () {
          if (settled) return;
          settled = true;
          var err = chrome.runtime.lastError;
          pill.error((err && err.message) || "生成中断");
          return resolve();
        });

        port.postMessage({
          type: "startEditorial",
          markdown: markdown,
          settings: translatorSettings,
          editorialMode: m,
          sourceName: fileName || "untitled.md"
        });
      });
    }

    function triggerEditorial(mode) {
      return runEditorialFor(leftMarkdown, leftFileName, mode);
    }

    function mountMainChrome() {
      if (opts.emptyStart && !ui.hasMainContent) {
        if (mainChromeHandle) {
          destroyChromeHandle(mainChromeHandle);
          mainChromeHandle = null;
        }
        return;
      }
      if (!root.BaselineTOC || !root.BaselineTOC.mountChrome) return;
      if (mainChromeHandle) destroyChromeHandle(mainChromeHandle);
      mainChromeHandle = root.BaselineTOC.mountChrome(mountEl, {
        getMarkdown: () => leftMarkdown || "",
        onEdit: () => openEditTab(
          leftMarkdown,
          leftFileName,
          "main",
          mountEl
        ),
        editTooltip: opts.mainEditTooltip,
        onSwap: () => pickFor("left"),
        swapTooltip: "打开其他",
        onDownload: downloadLeftMarkdown,
        downloadTooltip: "下载",
        downloadDoneText: "Downloaded",
        isDirty: leftDirty,
        hideDownload: leftFromLocalFile && !leftDirty,
        withTOC: !splitOn,
        widthOptions: WIDTH_OPTIONS_MD,
        currentWidth: lastWidth,
        onWidthChange: handleWidthChange,
        onEditorial: triggerEditorial,
        onTranslateWithLang: triggerTranslateWithLang,
        translateLanguages: root.BaselineTranslatorCore
          ? root.BaselineTranslatorCore.LANGUAGE_OPTIONS
          : [],
        suggestedTargetLang: suggestedTargetLanguage(
          detectSourceLanguage(leftMarkdown || "")
        )
      });
    }

    function mountSplitColumnChrome() {
      if (!splitMountEl || !root.BaselineTOC || !root.BaselineTOC.mountChrome) return;
      if (splitChromeHandle) destroyChromeHandle(splitChromeHandle);
      splitChromeHandle = root.BaselineTOC.mountChrome(splitMountEl, {
        getMarkdown: () => splitMarkdown || "",
        onEdit: () => openEditTab(
          splitMarkdown,
          splitFileName,
          "right",
          splitMountEl
        ),
        editTooltip: opts.splitEditTooltip,
        onSwap: () => pickFor("right"),
        swapTooltip: "打开其他",
        onDownload: downloadSplitMarkdown,
        downloadTooltip: "下载",
        downloadDoneText: "Downloaded",
        isDirty: splitDirty,
        hideDownload: splitFromLocalFile && !splitDirty,
        withTOC: false,
        widthOptions: WIDTH_OPTIONS_MD,
        currentWidth: lastWidth,
        // Picking a single-column width from the RIGHT column promotes
        // the right file into the main column (the left file is dropped).
        // Picking "split" again is a no-op. Otherwise fall through to the
        // shared handler (which keeps left content and toggles split).
        onWidthChange: (value) => {
          if (value !== "split" && splitMarkdown) {
            const promotedText = splitMarkdown;
            const promotedName = splitFileName;
            const promotedFromLocal = splitFromLocalFile;
            lastWidth = value;
            applyWidth(value);
            disableSplit();
            leftFromLocalFile = promotedFromLocal;
            renderMainColumn(promotedText, promotedName, { resetWidth: false });
            return;
          }
          handleWidthChange(value);
        },
        onEditorial: (mode) => {
          return runEditorialFor(splitMarkdown, splitFileName, mode);
        },
        onTranslateWithLang: async (lang) => {
          if (!splitMarkdown || !splitMarkdown.trim()) return { error: "没有内容" };
          if (!translatorSettings) {
            if (root.BaselineTranslator) {
              try { translatorSettings = await root.BaselineTranslator.loadSettings(); }
              catch (_) {}
            }
          }
          if (!translatorSettings || !translatorSettings.apiKey) return { error: "请先配置 API Key" };
          translatorSettings.targetLanguage = lang;
          if (root.BaselineTranslator) root.BaselineTranslator.saveSettings({ targetLanguage: lang }).catch(() => {});
          const sid = crypto.randomUUID();
          try {
            const resp = await chrome.runtime.sendMessage({
              type: "registerAndOpen", sessionId: sid,
              markdown: splitMarkdown, settings: translatorSettings,
              sourceName: splitFileName || "untitled.md", targetLanguage: lang,
              preset: lastPreset
            });
            if (!resp || !resp.ok) return { error: (resp && resp.error) || "无法打开翻译页" };
          } catch (err) { return { error: (err && err.message) || "无法打开翻译页" }; }
        },
        translateLanguages: root.BaselineTranslatorCore
          ? root.BaselineTranslatorCore.LANGUAGE_OPTIONS : [],
        suggestedTargetLang: suggestedTargetLanguage(
          detectSourceLanguage(splitMarkdown || "")
        )
      });
    }

    // mainChromeHandle/splitChromeHandle are Promises (mountChrome is async).
    // Unwrap before calling setDirty so callers don't crash on a not-yet-
    // resolved handle.
    function setColumnDirty(handle, dirty) {
      if (!handle) return;
      Promise.resolve(handle).then((resolved) => {
        if (resolved && typeof resolved.setDirty === "function") {
          resolved.setDirty(dirty);
        }
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
      bumpMainLoaded();
      leftMarkdown = text;
      leftFileName = name || "";
      // Default: fresh load clears dirty. onEditApplied flips it back to
      // true AFTER this resolves so edit paths still show the dot.
      leftDirty = false;
      ui.hasMainContent = Boolean(text && text.trim());
      if (opts.onMainMarkdownChange) opts.onMainMarkdownChange(text, leftFileName);

      // Run language detection BEFORE renderTo so a renderer exception
      // can't strand the translator on the wrong targetLanguage (Task #29:
      // paste flow wasn't auto-picking target language).
      refreshTranslatorTarget(text);

      if (!ui.hasMainContent && opts.emptyStart) {
        showMainEmptyState();
        mountMainChrome();
        return;
      }

      // Slim-scaffold pages reach here with mountEl === null on their first
      // content arrival (file pick / paste / session restore). Promote to
      // the full scaffold before any mountEl access. No-op if already full.
      upgradeToFullScaffold();
      await commitPresetTypography(mountEl, lastPreset, (p) => applyPreset(p));

      const preserveScroll = colOpts && colOpts.preserveScroll;
      const savedScroll = preserveScroll
        ? root.BaselineShared.readColumnScroll(mountEl)
        : null;

      await renderPreviewMarkdown(mountEl, text, lastPreset);
      bumpMainLoaded();
      if (preserveScroll) {
        root.BaselineShared.restoreColumnScroll(mountEl, savedScroll);
      } else if (colOpts && colOpts.restoreScroll != null) {
        root.BaselineShared.restoreColumnScroll(mountEl, colOpts.restoreScroll);
      } else {
        root.BaselineShared.resetColumnScroll(mountEl);
      }
      // resetWidth:false skips the standard-width snap — used by the
      // split→single promotion path, which has already set lastWidth to
      // whatever the user picked in the right column's dropdown.
      if (!colOpts || colOpts.resetWidth !== false) {
        applyStandardWidthLocal();
      }
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
    function replaceColumn(side, text, name, colOpts) {
      const label = name || "Pasted content";
      // Origin: explicit colOpts.fromLocalFile wins; otherwise default to
      // false (paste / translation / edit write-back are NOT local files,
      // even if the file they replace was). Callers that load from disk
      // (pickFor, openRecentEntry for file kind, file-input fallback)
      // must pass fromLocalFile: true.
      const fromLocal = !!(colOpts && colOpts.fromLocalFile);
      if (side === "left" || side === "main") {
        leftFromLocalFile = fromLocal;
        const p = renderMainColumn(text, label, colOpts);
        // renderMainColumn (re)mounts the chrome, which reads
        // leftFromLocalFile/leftDirty for the initial hideDownload value.
        // No extra refresh needed for the initial render, but we still call
        // refresh here so any in-flight chrome promise picks up the latest.
        Promise.resolve(p).then(() => refreshDownloadVisibility("left"));
        return p;
      }
      if (side === "right") {
        // Safety net: if split somehow got torn down between the recent-list
        // mount and the user's click, re-arm it instead of silently no-oping
        // inside mountSplitContent's `if (!splitView) return;` guard.
        if (!splitOn || !splitView) enableSplit();
        splitMarkdown = text;
        splitFileName = label;
        splitFromLocalFile = fromLocal;
        const p = Promise.resolve(mountSplitContent(text, colOpts));
        p.then(() => refreshDownloadVisibility("right"));
        return p;
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

    function openEditTab(markdown, name, column, mountEl, extra) {
      const shared = root.BaselineShared;
      if (!shared || typeof shared.openMarkdownInEditTab !== "function") return;
      shared.openMarkdownInEditTab(
        markdown,
        editSessionName(name),
        column,
        mountEl,
        extra
      ).catch((err) => {
        console.warn("[Baseline] open edit tab failed:", err);
      });
    }

    /**
     * Double-clicking the reading surface jumps to the edit tab with the
     * caret positioned at the clicked source-character offset (Direction 4).
     * Skips elements that already own a click handler (Task checkbox / list
     * fold chevron) so we don't compete with those interactions, and skips
     * non-text targets where caret mapping would be meaningless.
     */
    function bindReadingDblClick(rootEl, getMarkdown, getName, column, getLoadedAt) {
      if (!rootEl) return;
      function withinLoadGuard() {
        if (typeof getLoadedAt !== "function") return false;
        const ts = getLoadedAt();
        if (!ts) return false;
        return Date.now() - ts < LOAD_DBLCLICK_GUARD_MS;
      }
      // Returns true when the dblclick on this target should open the edit
      // tab (and therefore should NOT also commit a native word-selection).
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
      // Suppress the browser's native word-selection on the SECOND mousedown
      // of a double-click. Without this the user sees a single word flash
      // selected before edit.html opens — visually noisy and confusing.
      // detail===2 is the second mousedown of a dblclick sequence.
      rootEl.addEventListener("mousedown", (event) => {
        if (event.button !== 0 || event.detail !== 2) return;
        if (!isDblTargetEditable(event.target)) return;
        if (withinLoadGuard()) { event.preventDefault(); return; }
        event.preventDefault();
      });
      // Affordance for users who don't know dblclick→edit exists: after the
      // pointer has been idle on body content for 5s, surface a tooltip.
      if (root.BaselineShared
        && typeof root.BaselineShared.bindHoverEditHint === "function") {
        root.BaselineShared.bindHoverEditHint(rootEl, {
          isHoverEditable: isDblTargetEditable
        });
      }
      rootEl.addEventListener("dblclick", (event) => {
        if (event.button !== 0) return;
        const target = event.target;
        if (!isDblTargetEditable(target)) return;
        if (withinLoadGuard()) { event.preventDefault(); return; }

        const sizer = rootEl.classList.contains("markdown-preview-sizer")
          ? rootEl
          : rootEl.querySelector(".markdown-preview-sizer");
        if (!sizer || !sizer.contains(target)) return;

        const markdown = getMarkdown();
        if (!markdown) return;

        const shared = root.BaselineShared;
        if (!shared || typeof shared.offsetForClickedPoint !== "function") return;
        const map = shared.offsetForClickedPoint(markdown, sizer, event);

        event.preventDefault();
        // Prevent the selectionchange that the native dblclick word-selection
        // would emit from triggering the滑词菜单(Direction 2).
        if (root.BaselineSelectionMenu
          && typeof root.BaselineSelectionMenu.suppressNext === "function") {
          root.BaselineSelectionMenu.suppressNext();
        }
        try { window.getSelection().removeAllRanges(); } catch (_) {}

        // Only pass the caret offset when block matching succeeded; without
        // a real match we'd land at offset 0 (top of the file), which is
        // worse than letting edit.js fall back to its scroll restore path.
        if (map && map.matched && Number.isFinite(map.offset)) {
          openEditTab(markdown, getName(), column, sizer, {
            selectionStart: map.offset,
            selectionEnd: map.offset
          });
        } else {
          console.warn("[Baseline] dblclick offset map failed", map);
          openEditTab(markdown, getName(), column, sizer);
        }
      });
    }

    onEditApplied = (msg) => {
      const col = msg.column || "main";
      const label = msg.name || "Edited content";
      const preserveScroll = { preserveScroll: true };
      // Edit diverges the in-memory copy from disk, so the column is no
      // longer "fromLocalFile" — flip BEFORE the re-render so the fresh
      // chrome mount inside renderMainColumn sees the right state and
      // doesn't hide the Download button at mount time.
      if (col === "right") {
        splitFromLocalFile = false;
      } else {
        leftFromLocalFile = false;
      }
      const flipDirty = () => {
        if (col === "right") {
          splitDirty = true;
          setColumnDirty(splitChromeHandle, true);
          refreshDownloadVisibility("right");
        } else {
          leftDirty = true;
          setColumnDirty(mainChromeHandle, true);
          refreshDownloadVisibility("left");
        }
      };
      if (col === "right") {
        Promise.resolve(replaceColumn("right", msg.text, label, preserveScroll))
          .then(flipDirty);
      } else {
        Promise.resolve(renderMainColumn(msg.text, label, preserveScroll))
          .then(flipDirty);
      }
    };

    const rightInput = makeFileInput((text, name, handle) => {
      replaceColumn("right", text, name || "", { fromLocalFile: true });
      if (handle) recordRecentHandle(handle, name || "").catch(() => {});
    });
    const leftInput = makeFileInput((text, name, handle) => {
      replaceColumn("left", text, name || "", { fromLocalFile: true });
      if (handle) recordRecentHandle(handle, name || "").catch(() => {});
    });
    document.body.appendChild(rightInput);
    document.body.appendChild(leftInput);

    // Guard for any user-initiated replacement of a column's content: if
    // that column has an applied edit that hasn't been downloaded yet,
    // confirm before we throw it away. Returns true to proceed, false to
    // bail. Same wording shape as the edit popup's swap confirm so users
    // see consistent "use Download (top right) to save first" guidance.
    function confirmDiscardIfDirty(side) {
      const dirty = side === "right" ? splitDirty : leftDirty;
      if (!dirty) return true;
      return window.confirm(
        "You have unsaved edits in this document.\n\n" +
        "Opening another file will discard them. " +
        "Click Cancel and use the Download button (top right) " +
        "to save first.\n\n" +
        "Click OK to discard and open the new file."
      );
    }

    // Unified picker: prefer File System Access API so we keep a handle for
    // the "Recent" list; fall back to the hidden <input type="file"> when
    // the API is unavailable or the user already triggered it via the
    // legacy click path.
    async function pickFor(side) {
      if (!confirmDiscardIfDirty(side)) return false;
      const picked = await pickFileViaApi();
      if (picked) {
        if (picked.handle) {
          recordRecentHandle(picked.handle, picked.name).catch(() => {});
        }
        await replaceColumn(side === "right" ? "right" : "left",
          picked.text, picked.name, { fromLocalFile: true });
        return true;
      }
      // showOpenFilePicker missing → fall back to file input.
      if (typeof window.showOpenFilePicker !== "function") {
        (side === "right" ? rightInput : leftInput).click();
        return true;
      }
      return false;
    }

    async function openRecentEntry(entry, side) {
      if (entry.kind === "url" && entry.url) {
        const target = side === "right" ? "right" : "left";
        if (splitOn || side === "right") {
          if (!confirmDiscardIfDirty(target)) return;
          try {
            let text = null;
            try {
              const res = await fetch(entry.url);
              if (res.ok) text = await res.text();
            } catch (_) { /* fetch blocked (file:// same-origin) */ }
            if (text == null) {
              try {
                const resp = await chrome.runtime.sendMessage(
                  { type: "fetchUrl", url: entry.url });
                if (resp && resp.ok) text = resp.text;
              } catch (_) { /* bg fetch also failed */ }
            }
            if (text != null) {
              recordRecentUrlBump(entry).catch(() => {});
              const isLocal = /^file:/i.test(entry.url);
              await replaceColumn(target, text, entry.name || "",
                { fromLocalFile: isLocal });
              return;
            }
          } catch (_) { /* all attempts failed — fall through to navigate */ }
        }
        recordRecentUrlBump(entry).catch(() => {});
        location.href = entry.url;
        return;
      }
      const target = side === "right" ? "right" : "left";
      if (!confirmDiscardIfDirty(target)) return;
      const loaded = await readRecentDoc(entry);
      if (!loaded) {
        if (window.confirm("文件无法访问，可能已被移动或删除。\n从最近列表中移除？")) {
          removeRecentDoc(entry.id).catch(() => {});
          const slot = mountEl.closest(".view-content");
          if (slot) {
            getRecentDocs()
              .then((list) => renderRecentList(slot, list, side, opts))
              .catch(() => {});
          }
        }
        return;
      }
      // If a fresh handle came back (handles can be revoked then re-issued by
      // the browser), refresh storage so the next click skips the perm prompt.
      if (loaded.handle) {
        recordRecentHandle(loaded.handle, loaded.name).catch(() => {});
      } else if (entry.kind === "url") {
        // Bump lastOpened so url entries also reorder on use.
        recordRecentUrlBump(entry).catch(() => {});
      }
      // file-system entries (kind === "file") were just read from disk and
      // count as local files for the Download-button hide rule. URL entries
      // (kind === "url") came from the network — keep Download visible.
      const fromLocalFile = entry.kind !== "url";
      await replaceColumn(target, loaded.text, loaded.name || entry.name || "",
        { fromLocalFile });
    }

    async function recordRecentUrlBump(entry) {
      const list = await getRecentDocs();
      const found = list.find((e) => e.id === entry.id);
      if (!found) return;
      found.lastOpened = Date.now();
      await root.BaselineShared.setRecentDocs(list);
    }

    const pasteBinder = root.BaselineTOC && root.BaselineTOC.bindColumnPaste
      ? root.BaselineTOC.bindColumnPaste({
        isEditable: isEditablePasteTarget,
        confirmReplace: () =>
          window.confirm("Replace current content with pasted Markdown?")
      })
      : null;

    let mainPasteHost = null;
    function syncPasteRegistry() {
      if (!pasteBinder) return;
      // Slim scaffold has no .view-content yet, so ⌘V / right-click → Paste
      // has no registered column to route to. Fall back to document.body so
      // the size-1 path in resolvePasteColumn picks it up; swap to the real
      // mainView once upgradeToFullScaffold builds it.
      const desired = mainView || document.body;
      if (mainPasteHost && mainPasteHost !== desired) {
        pasteBinder.unregister(mainPasteHost);
      }
      mainPasteHost = desired;
      pasteBinder.register(desired, {
        hasContent: () => Boolean(leftMarkdown && leftMarkdown.trim()),
        onPaste: (text) => { replaceColumn("left", text, "Pasted content"); }
      });
      if (splitOn && splitView) {
        pasteBinder.register(splitView, {
          hasContent: () => Boolean(splitMountEl && splitMarkdown && splitMarkdown.trim()),
          onPaste: (text) => { replaceColumn("right", text, "Pasted content"); }
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
      splitDirty = false;

      const empty = buildColumnEmptyUI(() => pickFor("right"), opts.pickLabel);
      // Mirror the open-tab affordance: recent list under the picker, with
      // the narrow variant so the two-line items still breathe inside a
      // half-width column.
      const recentSlot = document.createElement("div");
      recentSlot.className = "bsw-recent-slot";
      empty.appendChild(recentSlot);
      refreshRecentList(recentSlot, "right", { narrow: true });

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
      bumpSplitLoaded();
      splitMarkdown = text;
      // Fresh load via pick/paste/recent: clear dirty. onEditApplied flips
      // back to true after this returns.
      splitDirty = false;
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
      markAsPasteHost(sizer);
      preview.appendChild(sizer);
      reading.appendChild(preview);

      splitPreview = preview;
      splitMountEl = sizer;
      bindReadingDblClick(
        sizer,
        () => splitMarkdown || "",
        () => splitFileName || "",
        "right",
        () => splitLoadedAt
      );
      if (root.BaselineSelectionMenu
        && typeof root.BaselineSelectionMenu.mount === "function") {
        root.BaselineSelectionMenu.mount(sizer, {
          getMarkdown: () => splitMarkdown || "",
          getName: () => splitFileName || "",
          getColumn: () => "right"
        });
      }

      syncSplitEmptyAreaClick();
      renderPreviewMarkdown(sizer, text, lastPreset)
        .then(() => {
          bumpSplitLoaded();
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
      splitDirty = false;
      leaf.appendChild(splitView);
      splitView.addEventListener("dblclick", onSplitEmptyAreaClick);
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
        splitView.removeEventListener("dblclick", onSplitEmptyAreaClick);
        splitView.classList.remove("bsw-open-empty-clickable");
        splitView.removeAttribute("title");
        if (pasteBinder) pasteBinder.unregister(splitView);
        if (splitView.parentNode) splitView.parentNode.removeChild(splitView);
      }
      splitView = null;
      splitPreview = null;
      splitChromeHandle = null;
      splitMountEl = null;
      splitMarkdown = "";
      splitFileName = "";
      splitDirty = false;
      mountMainChrome();
      syncPasteRegistry();
      updateTranslateUi();
      root.BaselineShared.restoreColumnScroll(mountEl, savedScroll);
      scheduleTabSessionPersist();
    }

    let savedSession = null;
    if (opts.emptyStart) {
      // In slim mode mainView is null; showMainEmptyState binds the
      // dblclick on document.body instead. canRestore → restoreTabSession
      // later triggers upgradeToFullScaffold which binds on the real
      // mainView created at that point.
      if (mainView) {
        mainView.addEventListener("dblclick", onOpenEmptyAreaClick);
      }
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
      await renderPreviewMarkdown(mountEl, opts.initial.markdown, prepared.preset);
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

    const translateMode = "hidden";

    if (root.BaselineTranslator) {
      try { translatorSettings = await root.BaselineTranslator.loadSettings(); }
      catch (_) {}
    }

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
        await commitPresetTypography(mountEl, value, (p) => applyPreset(p));
        if (splitOn && splitMountEl) {
          reassertTypographyLock(splitMountEl, value);
        }
        scheduleTabSessionPersist();
      },
      onModeChange: (value) => {
        lastMode = value;
        applyMode(value);
        scheduleTabSessionPersist();
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
        if (lastPreset === id) {
          lastPreset = "default";
          await commitPresetTypography(mountEl, "default", (p) => applyPreset(p));
          if (splitOn && splitMountEl) {
            reassertTypographyLock(splitMountEl, "default");
          }
          switcher.setPreset("default");
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
        await commitPresetTypography(mountEl, lastPreset, (p) => applyPreset(p));
        if (splitOn && splitMountEl) {
          reassertTypographyLock(splitMountEl, lastPreset);
        }
        switcher.setPreset(lastPreset);
      }
      if (saved.mode) {
        lastMode = saved.mode;
        switcher.setMode(lastMode);
        applyMode(lastMode);
      }

      const scrollOpts = typeof saved.mainScroll === "number"
        ? { restoreScroll: saved.mainScroll }
        : undefined;

      // Preserve the "opened-from-disk" origin marker across reloads —
      // renderMainColumn calls mountMainChrome which reads leftFromLocalFile
      // to decide whether to hide the Download button. Without this, a
      // reload would resurrect the button on an unedited local file.
      leftFromLocalFile = !!saved.leftFromLocalFile;

      await renderMainColumn(md, saved.leftFileName || "", scrollOpts);

      if (saved.splitOn) {
        lastWidth = "split";
        switcher.setWidth("split");
        enableSplit();
        if (mainChromeHandle && typeof mainChromeHandle.setActiveWidth === "function") {
          mainChromeHandle.setActiveWidth("split");
        }
        const splitMd = saved.splitMarkdown == null ? "" : String(saved.splitMarkdown);
        if (splitMd.trim()) {
          splitFromLocalFile = !!saved.splitFromLocalFile;
          const splitScrollOpts = typeof saved.splitScroll === "number"
            ? { restoreScroll: saved.splitScroll }
            : undefined;
          mountSplitContent(splitMd, splitScrollOpts);
        }
      } else if (saved.width && saved.width !== "split" && WIDTH_VALUES.has(saved.width)) {
        lastWidth = saved.width;
        switcher.setWidth(lastWidth);
        applyWidth(lastWidth);
        if (mainChromeHandle && typeof mainChromeHandle.setActiveWidth === "function") {
          mainChromeHandle.setActiveWidth(lastWidth);
        }
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

    // Edited-but-not-downloaded guard: leftDirty / splitDirty flip to true
    // when the edit popup applies a change back into this surface (see the
    // baselineEditApplied handler in onEdited) and clear when the user
    // downloads that column. Browser-native confirm — Chrome controls the
    // dialog text, no custom buttons possible. User can cancel the close,
    // hit Download manually, then close again.
    window.addEventListener("beforeunload", (e) => {
      if (!leftDirty && !splitDirty) return;
      e.preventDefault();
      e.returnValue = "";
    });

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
          await commitPresetTypography(mountEl, "default", (p) => applyPreset(p));
          if (splitOn && splitMountEl) {
            reassertTypographyLock(splitMountEl, "default");
          }
          switcher.setPreset("default");
        } else {
          await commitPresetTypography(mountEl, lastPreset, (p) => applyPreset(p));
          if (splitOn && splitMountEl) {
            reassertTypographyLock(splitMountEl, lastPreset);
          }
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
      pickLabel: "Open Markdown file",
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
    prepareMdReadingSettings,
    createPill: createEditorialPill
  };
})(window);
