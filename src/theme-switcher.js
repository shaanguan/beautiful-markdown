/**
 * Floating in-page theme switcher.
 *
 * Renders a small button in the bottom-right corner of the rendered
 * markdown page. Clicking it expands a panel containing:
 *   - Color mode row: Auto / Light / Dark
 *   - Built-in preset list (4 curated themes)
 *   - Custom preset list, with import (paste JSON or load file) and
 *     a Marketplace link so users can grab more presets
 *
 * The widget itself is a thin UI shell — it doesn't know how to apply
 * presets or persist them. content.js wires it up via mount() callbacks
 * (onPresetChange / onModeChange / onImportPreset / onDeletePreset) so
 * the same code path handles built-in and user-imported presets.
 *
 * Custom preset id convention: `custom:<slug>` — anything not in PRESETS
 * is treated as custom by content.js.
 */

(function (root) {
  "use strict";

  const MARKETPLACE_URL = "https://aaaaalexis.github.io/obsidian-baseline/marketplace/";
  const GOOGLE_AI_STUDIO_API_KEY_URL = "https://aistudio.google.com/app/apikey";

  // Curated built-in presets. Must stay in sync with presets/*.json.
  // Keeping the list short on purpose — extras go through the custom
  // import flow so users only see what we actively maintain.
  const PRESETS = [
    { value: "default",     label: "Vibe" },
    { value: "claude",      label: "Claude" },
    { value: "minimal",     label: "Minimal" },
    { value: "stone-gnome", label: "Stone" },
    { value: "paper",       label: "Paper" }
  ];

  const MODES = [
    { value: "auto",  label: "Auto" },
    { value: "light", label: "Light" },
    { value: "dark",  label: "Dark" }
  ];

  // Reading-width options now live in the top-toolbar segmented group;
  // see WIDTH_OPTIONS_MD in src/baseline-surface.js and
  // WIDTH_OPTIONS_VIEWER in src/viewer.js for the canonical lists.

  /**
   * Mount the floating switcher into document.body.
   *
   * @param {object} opts
   * @param {{preset:string, mode:string}} opts.initial Initial selection.
   * @param {Array<{id:string,name:string}>} [opts.customPresets] Initial
   *   list of user-imported presets (id format: "custom:<slug>"). The
   *   widget only needs id/name to render rows; loading the JSON body is
   *   content.js's job via onPresetChange.
   * @param {(preset:string)=>void} opts.onPresetChange
   * @param {(mode:string)=>void}   opts.onModeChange
   * @param {(width:string)=>void}  [opts.onWidthChange] One of "standard" |
   *   "wide" | "full". content.js translates this into a body class.
   * @param {(name:string, json:object)=>Promise<{ok:boolean,error?:string,id?:string}>} opts.onImportPreset
   *   Async because the host saves to chrome.storage.local. On success
   *   the widget rebuilds its custom list with the returned id selected.
   * @param {(id:string)=>Promise<void>} opts.onDeletePreset
   * @param {object} [opts.translatorSettings] Initial translator settings.
   *   Falls back to BaselineTranslator.DEFAULTS. Owned by the host so the
   *   widget can render the saved target language and current model without
   *   round-tripping through chrome.storage on every open.
   * @param {(lang:string)=>void}   [opts.onTargetLanguageChange] Fires when
   *   the user picks a different target language from the main-panel
   *   dropdown. Host should persist immediately so a refresh doesn't lose it.
   * @param {()=>void}              [opts.onTranslate] User clicked the
   *   Translate button while phase=idle|error. Host opens the viewer tab
   *   and drives setTranslateState through busy → idle/error.
   * @param {"open"|"hidden"}       [opts.translateMode] "open" (default)
   *   renders the Translate row; "hidden" omits it entirely. The viewer
   *   tab passes "hidden" so the translated view doesn't offer to translate
   *   itself again.
   * @param {(settings:object)=>Promise<{ok:boolean,error?:string}>} [opts.onTranslatorSettingsSave]
   *   Host persists translator settings (incl. API key) to chrome.storage.local.
   *   On success the widget closes the settings sub-view and updates its
   *   internal copy so the next translate call uses the new values.
   * @returns {{
   *   setPreset:(v:string)=>void,
   *   setMode:(v:string)=>void,
   *   setWidth:(v:string)=>void,
   *   setColorScheme:(resolved:'light'|'dark')=>void,
   *   setCustomPresets:(list:Array)=>void,
   *   setTranslateState:(s:{phase?:'idle'|'busy'|'error', message?:string|null})=>void,
   *   setTranslatorSettings:(s:object)=>void,
   *   setTranslateUiHidden:(hidden:boolean)=>void,
   *   destroy:()=>void
   * }}
   */
  function mount(opts) {
    // Translator defaults are pulled from BaselineTranslator (loaded by the
    // content-script bundle) when the caller doesn't supply them, so the
    // widget still degrades gracefully if the translator module is missing.
    const tDefaults = (root.BaselineTranslator && root.BaselineTranslator.DEFAULTS) || {
      provider: "google", apiKey: "", model: "gemini-3.5-flash",
      baseUrl: "https://api.openai.com/v1",
      sourceLanguage: "Auto", targetLanguage: "English"
    };

    const state = {
      preset: opts.initial.preset || "default",
      mode: opts.initial.mode || "auto",
      width: opts.initial.width || "standard",
      customPresets: Array.isArray(opts.customPresets) ? opts.customPresets.slice() : [],
      // Which floating panel is currently visible:
      //   "theme"     — color mode / reading width / preset / custom / import
      //   "translate" — source/target language + translate button + status
      //   "apikey"    — provider / apiKey / model / baseUrl (AI-call layer)
      //   null        — all panels hidden
      // The three panels are mutually exclusive — opening one auto-closes the others.
      openPanel: null,
      importing: false,
      translatorSettings: Object.assign({}, tDefaults, opts.translatorSettings || {}),
      // "idle" | "busy" | "done" | "error"
      translatePhase: "idle",
      translateMessage: "",
      translateUiHidden: false
    };

    const root_ = document.createElement("div");
    root_.id = "baseline-switcher";
    root_.setAttribute("data-baseline-ui", "switcher");

    // Small × button injected into each panel's top-right. Closes whichever
    // panel hosts it. Cheaper than tracking which panel is open — the click
    // just flips the central state via setOpenPanel(null) (defined later).
    function makePanelCloseBtn() {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bsw-panel-close";
      btn.setAttribute("aria-label", "Close");
      btn.setAttribute("title", "关闭");
      btn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" ' +
        'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.4" stroke-linecap="round" aria-hidden="true">' +
        '<path d="M6 6 L18 18 M18 6 L6 18"/></svg>';
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        setOpenPanel(null);
      });
      return btn;
    }

    // ── Theme toggle + panel ─────────────────────────────────────────
    const themeToggle = document.createElement("button");
    themeToggle.type = "button";
    themeToggle.id = "baseline-switcher-toggle";
    themeToggle.setAttribute("aria-label", "Theme & preset");
    themeToggle.setAttribute("title", "主题 / 预设");
    themeToggle.innerHTML = paintIcon();

    const themePanel = document.createElement("div");
    themePanel.id = "baseline-switcher-panel";
    themePanel.setAttribute("role", "dialog");
    themePanel.hidden = true;

    // Main panel content (mode + presets + custom). Wrapped in a div so
    // the import overlay can hide it as one unit without losing scroll
    // position or rebuilding the DOM.
    const main = document.createElement("div");
    main.className = "bsw-main";

    // ── Mode section ─────────────────────────────────────────────────
    const modeSection = document.createElement("div");
    modeSection.className = "bsw-section";

    const modeLabel = document.createElement("div");
    modeLabel.className = "bsw-section-label";
    modeLabel.textContent = "Color mode";
    modeSection.appendChild(modeLabel);

    const modeRow = document.createElement("div");
    modeRow.className = "bsw-modes";
    modeRow.setAttribute("role", "group");
    modeRow.setAttribute("aria-label", "Color mode");
    const modeButtons = new Map();
    for (const m of MODES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bsw-mode-item";
      btn.dataset.value = m.value;
      btn.textContent = m.label;
      btn.addEventListener("click", () => {
        setMode(m.value);
        opts.onModeChange && opts.onModeChange(m.value);
      });
      modeButtons.set(m.value, btn);
      modeRow.appendChild(btn);
    }
    modeSection.appendChild(modeRow);

    // Width selection moved to the top-toolbar dropdown (see
    // src/toc.js → mountDocActions → .bsw-width-dropdown). The switcher
    // panel no longer surfaces a Reading-width row, but setWidth() is
    // kept as a state-only stub so external callers that still invoke
    // `switcher.setWidth(...)` for reverse-sync don't break.

    // ── Built-in preset section ──────────────────────────────────────
    const presetSection = document.createElement("div");
    presetSection.className = "bsw-section";

    const presetLabel = document.createElement("div");
    presetLabel.className = "bsw-section-label";
    presetLabel.textContent = "Preset";
    presetSection.appendChild(presetLabel);

    const presetWrap = document.createElement("div");
    presetWrap.className = "bsw-presets";
    presetWrap.setAttribute("role", "listbox");
    presetWrap.setAttribute("aria-label", "Preset");
    const presetButtons = new Map();
    for (const p of PRESETS) {
      const btn = makePresetItem(p.value, p.label, false);
      presetButtons.set(p.value, btn);
      presetWrap.appendChild(btn);
    }
    presetSection.appendChild(presetWrap);

    // ── Custom preset section ────────────────────────────────────────
    const customSection = document.createElement("div");
    customSection.className = "bsw-section";

    const customHeader = document.createElement("div");
    customHeader.className = "bsw-section-header";

    const customLabel = document.createElement("div");
    customLabel.className = "bsw-section-label";
    customLabel.textContent = "Custom";
    customHeader.appendChild(customLabel);

    const marketplaceLink = document.createElement("a");
    marketplaceLink.className = "bsw-marketplace-link";
    marketplaceLink.href = MARKETPLACE_URL;
    marketplaceLink.target = "_blank";
    marketplaceLink.rel = "noopener noreferrer";
    marketplaceLink.title = "浏览主题市场";
    marketplaceLink.innerHTML = 'Marketplace ' + extIcon();
    customHeader.appendChild(marketplaceLink);

    customSection.appendChild(customHeader);

    const customWrap = document.createElement("div");
    customWrap.className = "bsw-presets bsw-custom-presets";
    customWrap.setAttribute("role", "listbox");
    customWrap.setAttribute("aria-label", "Custom preset");
    customSection.appendChild(customWrap);

    // Map of custom preset id -> DOM row (rebuilt on every setCustomPresets).
    const customButtons = new Map();

    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "bsw-import-button";
    importBtn.innerHTML = plusIcon() + '<span>Import preset</span>';
    importBtn.addEventListener("click", () => openImport());
    customSection.appendChild(importBtn);

    // ── Translate section ────────────────────────────────────────────
    // Lives in its own floating panel (built further down). The AI-call
    // settings (provider / API key / model / rewriteSystemPrompt) used to
    // hang off a "Settings" link here; v1.4 split them into their own
    // panel ("apikey"), reachable from the third bottom-right button.
    // The viewer tab passes translateMode === "hidden" so a translated
    // page doesn't offer to translate itself again.
    const translateMode = opts.translateMode === "hidden" ? "hidden" : "open";
    let translateBtn = null;
    let translateStatus = null;
    let translateSection = null;
    // Hoisted: applyControlsDisabled() references langSelect / sourceLangSelect
    // unconditionally. Leaving them inside the if-block makes mount()
    // ReferenceError in the viewer tab and tear the whole switcher down.
    let langSelect = null;
    let sourceLangSelect = null;
    if (translateMode === "open") {
      translateSection = document.createElement("div");
      translateSection.className = "bsw-section";
      // The translate panel only has this single section, so its label is
      // redundant with the panel title — kept implicit. Subsequent fields
      // get appended directly to translateSection below.

      const Core = root.BaselineTranslatorCore;
      const AUTO = (Core && Core.AUTO_LANGUAGE) || "Auto";
      const LANGS = (Core && Core.LANGUAGE_OPTIONS) ||
        [AUTO, "English", "Chinese", "Spanish", "French", "German",
         "Japanese", "Korean", "Portuguese", "Russian"];
      // Display each option in its native script — easier to scan than a
      // list of English exonyms when the user is browsing for "their"
      // language. Values stay canonical English so persistence + prompt
      // construction in translator-core aren't affected.
      const LANG_LABELS = {
        "Auto":       "Auto",
        "English":    "English",
        "Chinese":    "中文",
        "Spanish":    "Español",
        "French":     "Français",
        "German":     "Deutsch",
        "Japanese":   "日本語",
        "Korean":     "한국어",
        "Portuguese": "Português",
        "Russian":    "Русский"
      };
      const labelFor = (lang) => LANG_LABELS[lang] || lang;

      // Source language dropdown — defaults to "Auto" since auto-detect is
      // the sensible source default. Persisted on change via
      // onTranslatorSettingsChange so the API Key panel stays in sync.
      const sourceLangWrap = document.createElement("label");
      sourceLangWrap.className = "bsw-translate-lang";
      const sourceLangSpan = document.createElement("span");
      sourceLangSpan.textContent = "Source language";
      sourceLangSelect = document.createElement("select");
      sourceLangSelect.className = "bsw-translate-select";
      for (const lang of LANGS) {
        const opt = document.createElement("option");
        opt.value = lang;
        opt.textContent = labelFor(lang);
        sourceLangSelect.appendChild(opt);
      }
      sourceLangSelect.value = state.translatorSettings.sourceLanguage || AUTO;
      sourceLangSelect.addEventListener("change", () => {
        state.translatorSettings.sourceLanguage = sourceLangSelect.value;
        opts.onSourceLanguageChange &&
          opts.onSourceLanguageChange(sourceLangSelect.value);
      });
      sourceLangWrap.appendChild(sourceLangSpan);
      sourceLangWrap.appendChild(sourceLangSelect);
      translateSection.appendChild(sourceLangWrap);

      // Target language dropdown — sourced from translator-core so the
      // option list stays in sync with the rest of the pipeline. We strip
      // the "Auto" sentinel since "translate to auto-detect" makes no sense.
      const langWrap = document.createElement("label");
      langWrap.className = "bsw-translate-lang";
      const langSpan = document.createElement("span");
      langSpan.textContent = "Target language";
      langSelect = document.createElement("select");
      langSelect.className = "bsw-translate-select";
      for (const lang of LANGS) {
        if (lang === AUTO) continue;
        const opt = document.createElement("option");
        opt.value = lang;
        opt.textContent = labelFor(lang);
        langSelect.appendChild(opt);
      }
      langSelect.value = state.translatorSettings.targetLanguage || "English";
      langSelect.addEventListener("change", () => {
        state.translatorSettings.targetLanguage = langSelect.value;
        // Persist immediately so a refresh doesn't lose the choice. The
        // host is free to ignore this (e.g. in a future preview mode).
        opts.onTargetLanguageChange && opts.onTargetLanguageChange(langSelect.value);
      });
      langWrap.appendChild(langSpan);
      langWrap.appendChild(langSelect);
      translateSection.appendChild(langWrap);

      translateBtn = document.createElement("button");
      translateBtn.type = "button";
      translateBtn.className = "bsw-btn bsw-btn-primary bsw-translate-btn";
      // Label is set by paintTranslate(); leaving the initial textContent empty
      // so the first paintTranslate() call owns the full innerHTML (spinner +
      // label) without a flash of plain "Translate" text first.
      translateBtn.addEventListener("click", () => {
        // Translation lives in a separate viewer tab now, so the button is a
        // two-state affair: idle/error → kick off; busy → status only (no
        // cancel — the originating-tab request is over once the viewer opens).
        if (state.translatePhase === "busy") return;
        opts.onTranslate && opts.onTranslate();
      });
      translateSection.appendChild(translateBtn);

      translateStatus = document.createElement("div");
      translateStatus.className = "bsw-translate-status";
      translateStatus.hidden = true;
      translateSection.appendChild(translateStatus);
    }

    // Panel title — displayed at the top of the theme panel for visual
    // hierarchy parity with the translate / model panels.
    const themePanelTitle = document.createElement("div");
    themePanelTitle.className = "bsw-panel-title";
    themePanelTitle.textContent = "Theme";
    main.appendChild(themePanelTitle);

    main.appendChild(modeSection);
    main.appendChild(presetSection);
    main.appendChild(customSection);

    // ── Import overlay (lives inside the theme panel) ────────────────
    // Takes over the theme panel when the user clicks Import — keeps the
    // panel's outer geometry stable so the user doesn't see a resize jump.
    const importView = buildImportView({
      onCancel: () => closeImport(),
      onSubmit: async (name, jsonText) => {
        const parsed = tryParseJSON(jsonText);
        if (!parsed.ok) {
          importView.showError(parsed.error);
          return;
        }
        importView.showError("");
        importView.setBusy(true);
        try {
          const result = await opts.onImportPreset(name, parsed.value);
          if (!result || !result.ok) {
            importView.showError((result && result.error) || "Could not save preset.");
            return;
          }
          closeImport();
          if (result.id) {
            setPreset(result.id);
            opts.onPresetChange && opts.onPresetChange(result.id);
          }
        } finally {
          importView.setBusy(false);
        }
      }
    });
    importView.root.hidden = true;

    themePanel.appendChild(makePanelCloseBtn());
    themePanel.appendChild(main);
    themePanel.appendChild(importView.root);

    // ── Translate panel + toggle ─────────────────────────────────────
    // Translate is its own top-level panel; the API-call settings (provider,
    // API key, model, system prompt) moved out to the dedicated "apikey"
    // panel in v1.4. translateMode === "hidden" drops both toggle + panel.
    let translatePanel = null;
    let translateToggle = null;
    if (translateSection) {
      translatePanel = document.createElement("div");
      translatePanel.id = "baseline-translate-panel";
      translatePanel.setAttribute("role", "dialog");
      translatePanel.hidden = true;

      const translateMain = document.createElement("div");
      translateMain.className = "bsw-main";
      const translatePanelTitle = document.createElement("div");
      translatePanelTitle.className = "bsw-panel-title";
      translatePanelTitle.textContent = "Translate";
      translateMain.appendChild(translatePanelTitle);
      translateMain.appendChild(translateSection);
      translatePanel.appendChild(makePanelCloseBtn());
      translatePanel.appendChild(translateMain);

      translateToggle = document.createElement("button");
      translateToggle.type = "button";
      translateToggle.id = "baseline-translate-toggle";
      translateToggle.setAttribute("aria-label", "Translate");
      translateToggle.setAttribute("title", "翻译");
      translateToggle.innerHTML = translateIcon();
    }

    // ── API Key panel + toggle ───────────────────────────────────────
    // Hosts the AI-call settings form (provider/apiKey/model/baseUrl/
    // sourceLanguage/rewriteSystemPrompt). v1.4 split this out of the
    // translate panel's "Settings" overlay so the API key & the rewrite
    // system prompt have a stable home that's reachable even when the
    // translate UI is hidden (e.g. inside the translated viewer tab).
    const settingsView = buildSettingsView({
      initial: state.translatorSettings,
      onCancel: () => setOpenPanel(null),
      onSubmit: async (settings) => {
        settingsView.setBusy(true);
        try {
          const result = opts.onTranslatorSettingsSave
            ? await opts.onTranslatorSettingsSave(settings)
            : { ok: true };
          if (result && result.ok === false) {
            settingsView.showError(result.error || "Could not save settings.");
            return;
          }
          state.translatorSettings = Object.assign({}, settings);
          // Keep the translate panel's target-language dropdown in sync —
          // the user may have changed it inside the form. Guarded because
          // translateMode === "hidden" leaves langSelect null.
          if (langSelect && langSelect.value !== state.translatorSettings.targetLanguage) {
            langSelect.value = state.translatorSettings.targetLanguage;
          }
          setOpenPanel(null);
        } finally {
          settingsView.setBusy(false);
        }
      }
    });

    const apiKeyPanel = document.createElement("div");
    apiKeyPanel.id = "baseline-apikey-panel";
    apiKeyPanel.setAttribute("role", "dialog");
    apiKeyPanel.hidden = true;
    const apiKeyMain = document.createElement("div");
    apiKeyMain.className = "bsw-main";
    apiKeyMain.appendChild(settingsView.root);
    apiKeyPanel.appendChild(makePanelCloseBtn());
    apiKeyPanel.appendChild(apiKeyMain);

    const apiKeyToggle = document.createElement("button");
    apiKeyToggle.type = "button";
    apiKeyToggle.id = "baseline-apikey-toggle";
    apiKeyToggle.setAttribute("aria-label", "Model & API key");
    apiKeyToggle.setAttribute("title", "模型 / API Key");
    apiKeyToggle.innerHTML = keyIcon();

    themeToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpenPanel(state.openPanel === "theme" ? null : "theme");
    });

    if (translateToggle) {
      translateToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        setOpenPanel(state.openPanel === "translate" ? null : "translate");
      });
    }

    apiKeyToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpenPanel(state.openPanel === "apikey" ? null : "apikey");
    });

    // Modal backdrop: full-viewport overlay that intercepts hover + click
    // while a panel is open. Sits just below #baseline-switcher (which uses
    // the max int z-index) so the toggles and panel stay interactive. The
    // background is fully transparent on purpose — we want interaction
    // blocked, not a visual dim.
    const backdrop = document.createElement("div");
    backdrop.className = "bsw-panel-backdrop";
    backdrop.hidden = true;
    backdrop.addEventListener("click", () => setOpenPanel(null));
    document.body.appendChild(backdrop);

    const onDocClick = (e) => {
      if (!state.openPanel) return;
      if (root_.contains(e.target)) return;
      setOpenPanel(null);
    };
    document.addEventListener("click", onDocClick);

    const onKey = (e) => {
      if (e.key !== "Escape" || !state.openPanel) return;
      if (state.openPanel === "theme" && state.importing) {
        closeImport();
        return;
      }
      setOpenPanel(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("bsw:toolbar-open", () => {
      if (state.openPanel) setOpenPanel(null);
    });

    // next: "theme" | "translate" | "apikey" | null. The three panels are
    // mutually exclusive — opening one closes the others.
    function setOpenPanel(next) {
      state.openPanel = next;
      themePanel.hidden = next !== "theme";
      themeToggle.setAttribute("aria-expanded", String(next === "theme"));
      if (translatePanel) {
        translatePanel.hidden = next !== "translate";
        translateToggle.setAttribute("aria-expanded", String(next === "translate"));
      }
      apiKeyPanel.hidden = next !== "apikey";
      apiKeyToggle.setAttribute("aria-expanded", String(next === "apikey"));
      backdrop.hidden = next === null;
      if (next !== null) {
        document.dispatchEvent(new CustomEvent("bsw:panel-open"));
      }
      // Reset sub-views when their owning panel hides.
      if (next !== "theme" && state.importing) closeImport();
      if (next === "apikey") {
        // Refresh the form against the latest persisted settings so we
        // don't show stale values from a previous open.
        settingsView.refresh(state.translatorSettings);
        settingsView.focus();
      }
      if (next === "theme") {
        const active = presetButtons.get(state.preset) || customButtons.get(state.preset);
        if (active) active.scrollIntoView({ block: "nearest" });
      }
    }

    function openImport() {
      state.importing = true;
      main.hidden = true;
      importView.root.hidden = false;
      importView.reset();
      importView.focus();
    }

    function closeImport() {
      state.importing = false;
      importView.root.hidden = true;
      main.hidden = false;
    }

    function makePresetItem(value, label, deletable) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bsw-preset-item";
      btn.dataset.value = value;
      btn.setAttribute("role", "option");

      const check = document.createElement("span");
      check.className = "bsw-preset-check";
      check.setAttribute("aria-hidden", "true");
      check.innerHTML = checkIcon();

      const labelEl = document.createElement("span");
      labelEl.className = "bsw-preset-label";
      labelEl.textContent = label;

      btn.appendChild(check);
      btn.appendChild(labelEl);

      btn.addEventListener("click", () => {
        setPreset(value);
        opts.onPresetChange && opts.onPresetChange(value);
      });

      if (deletable) {
        const del = document.createElement("span");
        del.className = "bsw-preset-delete";
        del.setAttribute("role", "button");
        del.setAttribute("tabindex", "0");
        del.setAttribute("aria-label", `Delete preset ${label}`);
        del.title = "删除";
        del.innerHTML = xIcon();
        const handleDelete = (e) => {
          e.stopPropagation();
          if (!confirm(`Delete custom preset "${label}"?`)) return;
          opts.onDeletePreset && opts.onDeletePreset(value);
        };
        del.addEventListener("click", handleDelete);
        del.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleDelete(e);
          }
        });
        btn.appendChild(del);
      }

      return btn;
    }

    function renderCustomPresets() {
      customWrap.innerHTML = "";
      customButtons.clear();
      for (const cp of state.customPresets) {
        const btn = makePresetItem(cp.id, cp.name, true);
        customButtons.set(cp.id, btn);
        customWrap.appendChild(btn);
      }
      paintActive();
      // Custom rows were just rebuilt — re-apply the current disable state
      // so a translation that's already in flight still locks them out.
      applyControlsDisabled();
    }

    function paintActive() {
      const allButtons = new Map([...presetButtons, ...customButtons]);
      for (const [v, btn] of allButtons) {
        const active = v === state.preset;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", String(active));
      }
      for (const [v, btn] of modeButtons) {
        btn.classList.toggle("is-active", v === state.mode);
      }
    }

    // Lock down every "changes-the-page" control during a streaming
    // translation. Reason: a mode/preset/width swap mid-stream rebuilds the
    // body class list and triggers a Mermaid/KaTeX re-render against partial
    // markdown — the race produced empty diagrams + missing math in earlier
    // tests. Settings/Import open sub-views that hide `.bsw-main`, which
    // would visually orphan the in-flight status indicator. The Translate
    // button itself stays enabled because it owns the Cancel affordance.
    function applyControlsDisabled() {
      const busy = state.translatePhase === "busy";
      for (const btn of modeButtons.values()) btn.disabled = busy;
      for (const btn of presetButtons.values()) btn.disabled = busy;
      for (const btn of customButtons.values()) btn.disabled = busy;
      if (langSelect) langSelect.disabled = busy;
      importBtn.disabled = busy;
      // The API Key toggle is a panel-switch, not a translation control,
      // but opening it mid-stream would let a user save a different model
      // and confuse the in-flight request. Lock the toggle for the duration.
      apiKeyToggle.disabled = busy;
    }

    // Phases: idle → busy (briefly, while we register the session + open
    // the viewer tab) → idle | error. The busy branch uses innerHTML for
    // the spinner; other branches use textContent so user-supplied status
    // messages can't smuggle markup.
    function paintTranslate() {
      const phase = state.translatePhase;
      const msg = state.translateMessage;
      root_.classList.toggle("is-translating", phase === "busy");
      applyControlsDisabled();
      if (!translateBtn) return;
      translateStatus.classList.remove("is-error");
      if (phase === "busy") {
        translateBtn.innerHTML = spinnerIcon() + '<span>Translating…</span>';
        translateBtn.disabled = true;
        translateStatus.hidden = !msg;
        translateStatus.textContent = msg || "";
      } else if (phase === "error") {
        translateBtn.textContent = "Retry";
        translateBtn.disabled = false;
        translateStatus.hidden = false;
        translateStatus.textContent = msg || "Translation failed";
        translateStatus.classList.add("is-error");
      } else {
        translateBtn.textContent = "Translate";
        translateBtn.disabled = false;
        translateStatus.hidden = !msg;
        translateStatus.textContent = msg || "";
      }
    }

    function escapeHtml(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function setPreset(value) {
      state.preset = value;
      paintActive();
    }

    function setMode(value) {
      state.mode = value;
      paintActive();
    }

    // Width selection now lives in the top-toolbar segmented group; this
    // function is a state-only stub so reverse-sync calls from the host
    // (`switcher.setWidth(value)`) still mutate state without throwing.
    function setWidth(value) {
      state.width = value;
    }

    function setCustomPresets(list) {
      state.customPresets = Array.isArray(list) ? list.slice() : [];
      renderCustomPresets();
    }

    function setTranslateState(next) {
      const n = next || {};
      if (typeof n.phase === "string") state.translatePhase = n.phase;
      // `message` is optional — pass null to clear; undefined leaves it.
      if (n.message !== undefined) state.translateMessage = n.message || "";
      paintTranslate();
    }

    function setTranslatorSettings(settings) {
      state.translatorSettings = Object.assign({}, state.translatorSettings, settings || {});
      // langSelect / sourceLangSelect are null when the widget was mounted
      // with translateMode:"hidden" (e.g. in the viewer tab). Without this
      // guard, syncing settings via storage.onChanged from another tab
      // would throw a TypeError.
      if (langSelect && langSelect.value !== state.translatorSettings.targetLanguage) {
        langSelect.value = state.translatorSettings.targetLanguage;
      }
      if (sourceLangSelect &&
          sourceLangSelect.value !== state.translatorSettings.sourceLanguage) {
        sourceLangSelect.value = state.translatorSettings.sourceLanguage;
      }
      // If the API Key panel is currently open, refresh its form so a
      // settings change pushed from another tab is visible immediately.
      if (state.openPanel === "apikey") {
        settingsView.refresh(state.translatorSettings);
      }
    }

    /** Hide the translate toggle/panel (e.g. md 分栏视图 — compare two files, no translate). */
    function setTranslateUiHidden(hidden) {
      if (!translateToggle) {
        if (window.__BSW_DBG_TRANSLATE_TOGGLE) {
          console.log("[BSW] setTranslateUiHidden no-op (translateToggle=null)", hidden);
        }
        return;
      }
      state.translateUiHidden = !!hidden;
      root_.classList.toggle("bsw-translate-ui-hidden", hidden);
      translateToggle.hidden = hidden;
      if (hidden) {
        if (state.openPanel === "translate") setOpenPanel(null);
        else if (translatePanel) translatePanel.hidden = true;
      } else if (translatePanel) {
        translatePanel.hidden = state.openPanel !== "translate";
      }
      if (window.__BSW_DBG_TRANSLATE_TOGGLE) {
        const cs = getComputedStyle(translateToggle);
        console.log("[BSW] setTranslateUiHidden", {
          hidden,
          toggleHiddenAttr: translateToggle.hidden,
          toggleDisplay: cs.display,
          toggleVisibility: cs.visibility,
          toggleRect: translateToggle.getBoundingClientRect(),
          rootClass: root_.className,
          bodyHasSplitActive: document.body.classList.contains("bsw-split-active"),
          bodyHasChromeHidden: document.body.classList.contains("bsw-open-chrome-hidden"),
          rootHidden: root_.hidden
        });
      }
    }

    /** Hide the whole switcher (e.g. plugin blank tab before any content). */
    function setUiHidden(hidden) {
      const h = !!hidden;
      root_.hidden = h;
      if (h) {
        setOpenPanel(null);
        if (translatePanel) translatePanel.hidden = true;
        apiKeyPanel.hidden = true;
      }
    }

    /**
     * Apply the widget's color palette (theme-light / theme-dark) independent
     * of preset. Pass the page's RESOLVED mode ("light" or "dark"), not the
     * user's choice ("auto" / "light" / "dark"). Without this the widget
     * reads preset CSS variables and visibly flickers on every theme switch.
     */
    function setColorScheme(resolved) {
      root_.classList.toggle("theme-dark", resolved === "dark");
      root_.classList.toggle("theme-light", resolved !== "dark");
    }

    renderCustomPresets();
    setPreset(state.preset);
    setMode(state.mode);
    setWidth(state.width);
    setColorScheme(state.mode === "dark" ? "dark" : "light");
    paintTranslate();

    root_.appendChild(themePanel);
    if (translatePanel) root_.appendChild(translatePanel);
    root_.appendChild(apiKeyPanel);

    // Vertical column of 3 toggles, anchored bottom-right. Reading top→
    // bottom: Theme / Translate / API Key — matches the user's mental
    // priority (visual customization first, action second, config last).
    // translateMode === "hidden" simply drops the middle button; the column
    // stays a single chip group so the spacing remains balanced.
    const toggleGroup = document.createElement("div");
    toggleGroup.className = "baseline-toggle-group";
    toggleGroup.appendChild(themeToggle);
    if (translateToggle) {
      toggleGroup.appendChild(translateToggle);
    }
    toggleGroup.appendChild(apiKeyToggle);
    root_.appendChild(toggleGroup);
    document.body.appendChild(root_);

    function destroy() {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      root_.remove();
    }

    return {
      setPreset,
      setMode,
      setWidth,
      setColorScheme,
      setCustomPresets,
      setTranslateState,
      setTranslatorSettings,
      setTranslateUiHidden,
      setUiHidden,
      destroy
    };
  }

  // ── Import view ────────────────────────────────────────────────────

  function buildImportView({ onCancel, onSubmit }) {
    const root_ = document.createElement("div");
    root_.className = "bsw-import";

    const header = document.createElement("div");
    header.className = "bsw-import-header";

    const back = document.createElement("button");
    back.type = "button";
    back.className = "bsw-import-back";
    back.setAttribute("aria-label", "Back");
    back.innerHTML = backIcon();
    back.addEventListener("click", () => onCancel());
    header.appendChild(back);

    const title = document.createElement("div");
    title.className = "bsw-import-title";
    title.textContent = "Import preset";
    header.appendChild(title);

    const hint = document.createElement("div");
    hint.className = "bsw-import-hint";
    hint.innerHTML =
      'Download a preset from the ' +
      '<a href="' + MARKETPLACE_URL + '" target="_blank" rel="noopener noreferrer">marketplace</a>' +
      ', then paste its JSON below or load it from a file.';

    const nameWrap = document.createElement("label");
    nameWrap.className = "bsw-import-field";
    const nameLabel = document.createElement("span");
    nameLabel.textContent = "Name";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "bsw-import-name";
    nameInput.placeholder = "My preset";
    nameInput.maxLength = 60;
    nameWrap.appendChild(nameLabel);
    nameWrap.appendChild(nameInput);

    const jsonWrap = document.createElement("label");
    jsonWrap.className = "bsw-import-field";
    const jsonLabel = document.createElement("span");
    jsonLabel.textContent = "Preset JSON";
    const jsonInput = document.createElement("textarea");
    jsonInput.className = "bsw-import-json";
    jsonInput.placeholder = '{\n  "baseline-style@@…": "…"\n}';
    jsonInput.spellcheck = false;
    jsonWrap.appendChild(jsonLabel);
    jsonWrap.appendChild(jsonInput);

    const error = document.createElement("div");
    error.className = "bsw-import-error";
    error.hidden = true;

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "application/json,.json";
    fileInput.hidden = true;
    fileInput.addEventListener("change", () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        jsonInput.value = String(reader.result || "");
        // Auto-fill name from filename if name field is empty.
        if (!nameInput.value.trim()) {
          const base = f.name.replace(/\.json$/i, "").replace(/[-_]+/g, " ").trim();
          if (base) nameInput.value = base;
        }
      };
      reader.readAsText(f);
      fileInput.value = "";
    });

    const buttons = new Map(); // name → button (so setBusy can disable all)

    const actions = document.createElement("div");
    actions.className = "bsw-import-actions";

    const fileBtn = document.createElement("button");
    fileBtn.type = "button";
    fileBtn.className = "bsw-btn bsw-btn-ghost";
    fileBtn.textContent = "Load file…";
    fileBtn.addEventListener("click", () => fileInput.click());
    buttons.set("file", fileBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "bsw-btn bsw-btn-ghost";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => onCancel());
    buttons.set("cancel", cancelBtn);

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "bsw-btn bsw-btn-primary";
    submitBtn.textContent = "Import";
    submitBtn.addEventListener("click", () => {
      const name = (nameInput.value || "").trim();
      const json = jsonInput.value || "";
      if (!name) {
        showError("Give the preset a name.");
        nameInput.focus();
        return;
      }
      if (!json.trim()) {
        showError("Paste a preset JSON or load it from a file.");
        jsonInput.focus();
        return;
      }
      // Surface any rejection from onSubmit (e.g. chrome.storage quota,
      // preset compile crash) instead of letting it become a silent
      // unhandled rejection in DevTools.
      Promise.resolve(onSubmit(name, json)).catch((e) => {
        const msg = (e && (e.message || e.toString())) || "Import failed.";
        showError(msg);
        try { setBusy(false); } catch (_) { /* no-op */ }
      });
    });
    buttons.set("submit", submitBtn);

    actions.appendChild(fileBtn);
    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    actions.appendChild(spacer);
    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);

    root_.appendChild(header);
    root_.appendChild(hint);
    root_.appendChild(nameWrap);
    root_.appendChild(jsonWrap);
    root_.appendChild(error);
    root_.appendChild(actions);
    root_.appendChild(fileInput);

    function showError(msg) {
      if (!msg) {
        error.hidden = true;
        error.textContent = "";
        return;
      }
      error.hidden = false;
      error.textContent = msg;
    }

    function reset() {
      nameInput.value = "";
      jsonInput.value = "";
      showError("");
      setBusy(false);
    }

    function focus() {
      nameInput.focus();
    }

    function setBusy(busy) {
      for (const b of buttons.values()) b.disabled = busy;
      nameInput.disabled = busy;
      jsonInput.disabled = busy;
      submitBtn.textContent = busy ? "Importing…" : "Import";
    }

    return { root: root_, showError, reset, focus, setBusy };
  }

  // ── AI Settings sub-view ─────────────────────────────────────────────
  // Companion overlay to buildImportView. Both reuse the .bsw-import-*
  // classes (header / field / actions / btn) so the two views share their
  // visual language; only the field set differs.
  function buildSettingsView({ initial, onCancel, onSubmit }) {
    const Core = root.BaselineTranslatorCore;
    const PROVIDERS = [
      { value: "google", label: "Google AI Studio" },
      { value: "openai", label: "OpenAI-compatible" }
    ];
    const root_ = document.createElement("div");
    root_.className = "bsw-import bsw-settings";

    // Panel title — sits flush at the top, matching the Theme/Translate panels.
    const title = document.createElement("div");
    title.className = "bsw-panel-title";
    title.textContent = "Model";

    // Mirrors Obsidian's `display()` rebuild pattern: provider-specific
    // fields are torn down and re-rendered on provider switch, so the form
    // body for Google (api key + model dropdown) and OpenAI (base url + api
    // key + free-text model) can have wholly different shapes. The cached
    // values live in `pendingState` so switching provider preserves what
    // the user has typed in each branch within the session.
    let activeProvider = initial.provider || "google";
    // Per-provider pendingState so switching tabs in the form preserves
    // what was typed in each branch within the session, AND so a Save
    // round-trips every provider's bucket back into storage (not just
    // the currently active one). hydratePending() seeds these from
    // initial.providerCredentials when present (post-v1.4 storage shape)
    // or falls back to legacy top-level fields for the active provider.
    const pendingState = {
      googleApiKey: "",
      googleModel: "",
      openAiApiKey: "",
      openAiModel: "",
      openAiBaseUrl: ""
    };
    function hydratePending(src) {
      const s = src || {};
      const creds = (s.providerCredentials) || {};
      const g = creds.google || {};
      const o = creds.openai || {};
      pendingState.googleApiKey = g.apiKey || "";
      pendingState.googleModel = g.model || "";
      pendingState.openAiApiKey = o.apiKey || "";
      pendingState.openAiModel = o.model || "";
      pendingState.openAiBaseUrl = o.baseUrl || "";
      // Legacy fallback: storage written before #18 has no
      // providerCredentials yet; seed the active provider's bucket from
      // top-level apiKey/model/baseUrl so the user's existing key shows up.
      const prov = s.provider || "google";
      if (prov === "google" && !pendingState.googleApiKey && s.apiKey) {
        pendingState.googleApiKey = s.apiKey;
        if (!pendingState.googleModel && s.model) pendingState.googleModel = s.model;
      }
      if (prov === "openai" && !pendingState.openAiApiKey && s.apiKey) {
        pendingState.openAiApiKey = s.apiKey;
        if (!pendingState.openAiModel && s.model) pendingState.openAiModel = s.model;
        if (!pendingState.openAiBaseUrl && s.baseUrl) pendingState.openAiBaseUrl = s.baseUrl;
      }
    }
    hydratePending(initial);

    // Field handles re-bound by renderProviderFields() on each provider
    // switch — collect()/setBusy()/refresh() read through this object so
    // they never hold stale closures to torn-down inputs.
    const fields = {
      apiKey: null,
      model: null,        // <select> for google, <input type=text> for openai
      baseUrl: null       // only present for openai
    };

    // ── Provider segmented control ───────────────────────────────
    const providerField = document.createElement("div");
    providerField.className = "bsw-import-field";
    const providerSpan = document.createElement("span");
    providerSpan.textContent = "Provider";
    providerField.appendChild(providerSpan);

    const providerRow = document.createElement("div");
    providerRow.className = "bsw-modes bsw-settings-segments";
    providerRow.setAttribute("role", "group");
    providerRow.setAttribute("aria-label", "Provider");
    const providerBtns = new Map();
    for (const p of PROVIDERS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bsw-mode-item";
      btn.dataset.value = p.value;
      btn.textContent = p.label;
      btn.addEventListener("click", () => {
        if (p.value === activeProvider) return;
        stashCurrent();
        activeProvider = p.value;
        paintProvider();
        renderProviderFields();
      });
      providerBtns.set(p.value, btn);
      providerRow.appendChild(btn);
    }
    providerField.appendChild(providerRow);

    function paintProvider() {
      for (const [v, btn] of providerBtns) {
        btn.classList.toggle("is-active", v === activeProvider);
      }
    }

    // ── Provider-specific fields container ───────────────────────
    const providerFieldsHost = document.createElement("div");
    providerFieldsHost.className = "bsw-settings-provider-fields";

    function makeField(label, desc) {
      const wrap = document.createElement("label");
      wrap.className = "bsw-import-field";
      const labelSpan = document.createElement("span");
      labelSpan.textContent = label;
      wrap.appendChild(labelSpan);
      // control gets appended by the caller; description goes after so the
      // hint sits flush under the input.
      if (desc) {
        const descEl = document.createElement("div");
        descEl.className = "bsw-field-desc";
        descEl.textContent = desc;
        wrap._desc = descEl;
      }
      return wrap;
    }

    function appendField(host, field, control) {
      field.appendChild(control);
      if (field._desc) field.appendChild(field._desc);
      host.appendChild(field);
    }

    function stashCurrent() {
      if (!fields.apiKey) return;
      if (activeProvider === "google") {
        pendingState.googleApiKey = fields.apiKey.value;
        pendingState.googleModel = fields.model ? fields.model.value : "";
      } else {
        pendingState.openAiApiKey = fields.apiKey.value;
        pendingState.openAiModel = fields.model ? fields.model.value : "";
        pendingState.openAiBaseUrl = fields.baseUrl ? fields.baseUrl.value : "";
      }
    }

    // Custom combobox dropdowns register document-level mousedown
    // listeners (outside-click close). On provider switch we tear down
    // the host element, but the listener is on `document` — it would
    // outlive its panel and keep firing. Stash teardown fns here and
    // run them at the start of each rebuild.
    let comboCleanups = [];
    function flushComboCleanups() {
      for (const fn of comboCleanups) {
        try { fn(); } catch { /* no-op */ }
      }
      comboCleanups = [];
    }

    function renderProviderFields() {
      flushComboCleanups();
      providerFieldsHost.innerHTML = "";
      fields.apiKey = null;
      fields.model = null;
      fields.baseUrl = null;

      if (activeProvider === "google") {
        // API Key
        const keyField = makeField(
          "API key",
          "Google AI Studio key. Stored only in this browser."
        );
        // Right-aligned external link to the AI Studio key page — mirrors
        // the Marketplace link in the Custom section header.
        const keyLink = document.createElement("a");
        keyLink.className = "bsw-field-link";
        keyLink.href = GOOGLE_AI_STUDIO_API_KEY_URL;
        keyLink.target = "_blank";
        keyLink.rel = "noopener noreferrer";
        keyLink.title = "在 Google AI Studio 创建或查看 API Key";
        keyLink.innerHTML = 'Get key ' + extIcon();
        const keyLabelSpan = keyField.querySelector("span");
        if (keyLabelSpan) {
          keyLabelSpan.classList.add("bsw-field-label-row");
          keyLabelSpan.appendChild(keyLink);
        }
        const keyInput = document.createElement("input");
        keyInput.type = "password";
        keyInput.className = "bsw-import-name";
        keyInput.autocomplete = "off";
        keyInput.spellcheck = false;
        keyInput.placeholder = "AIza...";
        keyInput.value = pendingState.googleApiKey || "";
        appendField(providerFieldsHost, keyField, keyInput);
        fields.apiKey = keyInput;

        // Model: text input + custom popover dropdown.
        //
        // We tried `<input list=...>` + `<datalist>` first, but the
        // browser-native datalist filters its option list against the
        // current input value — when the input already holds a preset
        // model (the common case), the dropdown either shows just that
        // one row or appears empty depending on the engine, and the
        // chevron affordance is inconsistent across Chrome/Firefox/
        // Safari. We need a picker that ALWAYS lists every preset
        // regardless of input contents, so we render our own.
        const modelField = makeField(
          "Model",
          "Pick a preset or type a custom model name (e.g. a newer Gemini snapshot)."
        );
        const modelCombo = document.createElement("div");
        modelCombo.className = "bsw-combo";

        const modelInput = document.createElement("input");
        modelInput.type = "text";
        modelInput.className = "bsw-import-name bsw-combo-input";
        modelInput.autocomplete = "off";
        modelInput.spellcheck = false;
        modelInput.placeholder =
          (Core && Core.PRIMARY_MODEL) || "gemini-3.5-flash";
        modelInput.value = pendingState.googleModel || "";

        const modelToggle = document.createElement("button");
        modelToggle.type = "button";
        modelToggle.className = "bsw-combo-toggle";
        modelToggle.setAttribute("aria-label", "Pick a preset model");
        modelToggle.title = "选择预设模型";
        modelToggle.setAttribute("aria-haspopup", "listbox");
        modelToggle.setAttribute("aria-expanded", "false");
        modelToggle.tabIndex = -1;
        modelToggle.innerHTML =
          '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" ' +
          'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
          'stroke-linejoin="round" aria-hidden="true">' +
          '<polyline points="6 9 12 15 18 9"/></svg>';

        const modelPanel = document.createElement("div");
        modelPanel.className = "bsw-combo-panel";
        modelPanel.setAttribute("role", "listbox");
        modelPanel.hidden = true;

        const closeModelPanel = () => {
          if (modelPanel.hidden) return;
          modelPanel.hidden = true;
          modelToggle.setAttribute("aria-expanded", "false");
          modelCombo.classList.remove("is-open");
        };
        const openModelPanel = () => {
          if (!modelPanel.hidden) return;
          modelPanel.hidden = false;
          modelToggle.setAttribute("aria-expanded", "true");
          modelCombo.classList.add("is-open");
        };

        const models = (Core && Core.GOOGLE_MODEL_OPTIONS) || [];
        for (const m of models) {
          const opt = document.createElement("button");
          opt.type = "button";
          opt.className = "bsw-combo-option";
          opt.setAttribute("role", "option");
          opt.textContent = m;
          opt.addEventListener("click", () => {
            modelInput.value = m;
            closeModelPanel();
            modelInput.focus();
          });
          modelPanel.appendChild(opt);
        }
        // Trailing custom-model sentinel — clicking it just dismisses the
        // panel and parks focus in the input so the user can type.
        const customOpt = document.createElement("button");
        customOpt.type = "button";
        customOpt.className = "bsw-combo-option is-custom";
        customOpt.setAttribute("role", "option");
        customOpt.textContent = "Custom model…";
        customOpt.addEventListener("click", () => {
          closeModelPanel();
          modelInput.focus();
          modelInput.select();
        });
        modelPanel.appendChild(customOpt);

        modelToggle.addEventListener("click", (e) => {
          e.stopPropagation();
          if (modelPanel.hidden) openModelPanel();
          else closeModelPanel();
        });
        // Outside-click & Esc both dismiss. Use mousedown capture so the
        // panel closes BEFORE focus moves into another field — otherwise
        // a click on a sibling input would briefly leave the panel open
        // overlapping the new control.
        const onOutside = (e) => {
          if (modelPanel.hidden) return;
          if (modelCombo.contains(e.target)) return;
          closeModelPanel();
        };
        document.addEventListener("mousedown", onOutside, true);
        modelPanel.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
            closeModelPanel();
            modelInput.focus();
          }
        });
        modelInput.addEventListener("keydown", (e) => {
          if (e.key === "Escape" && !modelPanel.hidden) closeModelPanel();
          else if (e.key === "ArrowDown" && modelPanel.hidden) {
            e.preventDefault();
            openModelPanel();
            const first = modelPanel.querySelector(".bsw-combo-option");
            if (first) first.focus();
          }
        });
        // Tear down the document listener when the picker is rebuilt
        // (provider switch) so we don't leak handlers across rebuilds.
        comboCleanups.push(() =>
          document.removeEventListener("mousedown", onOutside, true)
        );

        modelCombo.appendChild(modelInput);
        modelCombo.appendChild(modelToggle);
        modelCombo.appendChild(modelPanel);
        appendField(providerFieldsHost, modelField, modelCombo);
        fields.model = modelInput;
      } else {
        // OpenAI-compatible: Base URL + API Key + free-text Model
        const baseField = makeField(
          "Base URL",
          "e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1. Pointing at /chat/completions also works."
        );
        const baseInput = document.createElement("input");
        baseInput.type = "url";
        baseInput.className = "bsw-import-name";
        baseInput.autocomplete = "off";
        baseInput.spellcheck = false;
        baseInput.placeholder =
          (Core && Core.OPENAI_DEFAULT_BASE_URL) || "https://api.openai.com/v1";
        baseInput.value = pendingState.openAiBaseUrl || "";
        appendField(providerFieldsHost, baseField, baseInput);
        fields.baseUrl = baseInput;

        const keyField = makeField(
          "API key",
          "Stored only in this browser."
        );
        const keyInput = document.createElement("input");
        keyInput.type = "password";
        keyInput.className = "bsw-import-name";
        keyInput.autocomplete = "off";
        keyInput.spellcheck = false;
        keyInput.placeholder = "sk-...";
        keyInput.value = pendingState.openAiApiKey || "";
        appendField(providerFieldsHost, keyField, keyInput);
        fields.apiKey = keyInput;

        const modelField = makeField(
          "Model",
          "Use the model name your provider supports, e.g. gpt-4o-mini, deepseek-chat, moonshot-v1-8k."
        );
        const modelInput = document.createElement("input");
        modelInput.type = "text";
        modelInput.className = "bsw-import-name";
        modelInput.autocomplete = "off";
        modelInput.spellcheck = false;
        modelInput.placeholder =
          (Core && Core.OPENAI_DEFAULT_MODEL) || "gpt-4o-mini";
        modelInput.value = pendingState.openAiModel || "";
        appendField(providerFieldsHost, modelField, modelInput);
        fields.model = modelInput;
      }

      // Reflect busy state on the freshly-built controls.
      if (busyState) applyBusyToFields();
    }

    // ── Error + actions ──────────────────────────────────────────
    const error = document.createElement("div");
    error.className = "bsw-import-error";
    error.hidden = true;

    const actions = document.createElement("div");
    actions.className = "bsw-import-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "bsw-btn bsw-btn-ghost";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => onCancel());

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "bsw-btn bsw-btn-primary";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () => {
      const collected = collect();
      if (!collected.apiKey) {
        showError("Enter an API key.");
        if (fields.apiKey) fields.apiKey.focus();
        return;
      }
      if (activeProvider === "openai" && !collected.baseUrl) {
        showError("Enter a base URL for the OpenAI-compatible endpoint.");
        if (fields.baseUrl) fields.baseUrl.focus();
        return;
      }
      showError("");
      onSubmit(collected);
    });

    // Right-aligned, Cancel ▸ Save with a small gap. .bsw-import-actions
    // sets justify-content: flex-end so the pair sits flush to the right.
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    root_.appendChild(title);
    root_.appendChild(providerField);
    root_.appendChild(providerFieldsHost);
    root_.appendChild(error);
    root_.appendChild(actions);

    function showError(msg) {
      if (!msg) {
        error.hidden = true;
        error.textContent = "";
        return;
      }
      error.hidden = false;
      error.textContent = msg;
    }

    function refresh(settings) {
      const s = settings || {};
      activeProvider = s.provider || "google";
      hydratePending(s);
      paintProvider();
      renderProviderFields();
      // Keep `initial` in sync so collect() preserves the latest known
      // sourceLanguage / targetLanguage across saves.
      initial = Object.assign({}, initial, s);
      showError("");
    }

    function collect() {
      // First stash whatever is currently in the visible inputs into the
      // active provider's pendingState slot, then emit a snapshot for BOTH
      // providers so saving on one tab doesn't wipe the other's bucket.
      stashCurrent();
      const googleModelFallback = (Core && Core.PRIMARY_MODEL) || "gemini-3.5-flash";
      const openAiModelFallback = (Core && Core.OPENAI_DEFAULT_MODEL) || "gpt-4o-mini";
      const openAiBaseFallback =
        (Core && Core.OPENAI_DEFAULT_BASE_URL) || "https://api.openai.com/v1";
      const buckets = {
        google: {
          apiKey: (pendingState.googleApiKey || "").trim(),
          model: (pendingState.googleModel || "").trim() || googleModelFallback
        },
        openai: {
          apiKey: (pendingState.openAiApiKey || "").trim(),
          model: (pendingState.openAiModel || "").trim() || openAiModelFallback,
          baseUrl: (pendingState.openAiBaseUrl || "").trim() || openAiBaseFallback
        }
      };
      const active = buckets[activeProvider] || buckets.google;
      return {
        provider: activeProvider,
        // Top-level fields mirror the active provider for translator-bg.js.
        apiKey: active.apiKey,
        model: active.model,
        baseUrl: (active.baseUrl !== undefined ? active.baseUrl : openAiBaseFallback),
        providerCredentials: buckets,
        // sourceLanguage / targetLanguage are owned by the translate panel;
        // preserve whatever the last known value was so we don't blow them
        // away on save from the model panel.
        sourceLanguage: (initial && initial.sourceLanguage) ||
                        ((Core && Core.AUTO_LANGUAGE) || "Auto"),
        targetLanguage: (initial && initial.targetLanguage) || "English",
        preserveBlockquotes: true
      };
    }

    let busyState = false;
    function applyBusyToFields() {
      const busy = busyState;
      if (fields.apiKey) fields.apiKey.disabled = busy;
      if (fields.model) {
        fields.model.disabled = busy;
        // Mirror disabled state onto the combo chevron so the popover
        // can't be opened while a translation is in flight.
        const combo = fields.model.closest(".bsw-combo");
        if (combo) {
          const toggle = combo.querySelector(".bsw-combo-toggle");
          if (toggle) toggle.disabled = busy;
        }
      }
      if (fields.baseUrl) fields.baseUrl.disabled = busy;
    }
    function setBusy(busy) {
      busyState = !!busy;
      for (const btn of providerBtns.values()) btn.disabled = busy;
      applyBusyToFields();
      cancelBtn.disabled = busy;
      saveBtn.disabled = busy;
      saveBtn.textContent = busy ? "Saving…" : "Save";
    }

    function focus() {
      if (fields.apiKey) fields.apiKey.focus();
    }

    refresh(initial);
    return { root: root_, refresh, showError, setBusy, focus };
  }

  function tryParseJSON(text) {
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, error: "Preset must be a JSON object." };
      }
      return { ok: true, value };
    } catch (e) {
      return { ok: false, error: "Invalid JSON: " + (e.message || "parse error") };
    }
  }

  // ── Inline SVGs (keep external icon deps at zero) ──────────────────

  // Material Symbols "palette" — same visual concept as the previous custom
  // icon but uses the cleaner Google-issued geometry that matches the
  // top-right toolbar's icon family.
  function paintIcon() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" ' +
      'viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">' +
      '<path d="M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480' +
      'q0-83 32.5-156t88-127Q256-817 330-848.5T488-880q80 0 151 27.5t124.5 76' +
      'q53.5 48.5 85 115T880-518q0 115-70 176.5T640-280h-74q-9 0-12.5 5t-3.5 11' +
      'q0 12 15 34.5t15 51.5q0 50-27.5 74T480-80Zm0-400Zm-177 23q17-17 17-43' +
      't-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Z' +
      'm120-160q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43' +
      'q17 17 43 17t43-17Zm200 0q17-17 17-43t-17-43q-17-17-43-17t-43 17' +
      'q-17 17-17 43t17 43q17 17 43 17t43-17Zm120 160q17-17 17-43t-17-43' +
      'q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17ZM480-160' +
      'q9 0 14.5-5t5.5-13q0-14-15-33t-15-57q0-42 29-67t71-25h70q66 0 113-38.5' +
      'T800-518q0-121-92.5-201.5T488-800q-136 0-232 93t-96 227q0 133 93.5 226.5' +
      'T480-160Z"/>' +
      '</svg>'
    );
  }

  function checkIcon() {
    return (
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
      'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="20 6 9 17 4 12"/>' +
      '</svg>'
    );
  }

  function plusIcon() {
    return (
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="12" y1="5" x2="12" y2="19"/>' +
      '<line x1="5" y1="12" x2="19" y2="12"/>' +
      '</svg>'
    );
  }

  function xIcon() {
    return (
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" ' +
      'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="6" y1="6" x2="18" y2="18"/>' +
      '<line x1="6" y1="18" x2="18" y2="6"/>' +
      '</svg>'
    );
  }

  function backIcon() {
    return (
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="19" y1="12" x2="5" y2="12"/>' +
      '<polyline points="12 19 5 12 12 5"/>' +
      '</svg>'
    );
  }

  // Spinner: 3/4 arc that the CSS rotates 360° on a 1s loop. Mirrors
  // Obsidian's `ai-translator-ribbon-loading` SVG approach so the busy
  // state feels familiar to users coming from the source plugin.
  function spinnerIcon() {
    return (
      '<svg class="bsw-translate-spinner" viewBox="0 0 24 24" width="14" height="14" ' +
      'fill="none" stroke="currentColor" stroke-width="2.5" ' +
      'stroke-linecap="round" aria-hidden="true">' +
      '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>' +
      '</svg>'
    );
  }

  // Material Symbols "key" — third sibling of paintIcon / translateIcon for
  // the new bottom-right API Key toggle.
  function keyIcon() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" ' +
      'viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">' +
      '<path d="M280-400q-33 0-56.5-23.5T200-480q0-33 23.5-56.5T280-560q33 0 56.5 23.5T360-480' +
      'q0 33-23.5 56.5T280-400Zm0 160q-100 0-170-70T40-480q0-100 70-170t170-70q72 0 130.5 38.5' +
      'T499-580h381l80 80-160 160-80-60-80 60-85-60h-56q-23 63-81.5 101.5T280-240Zm0-80' +
      'q56 0 98.5-34t56.5-86h125l58 41 82-61 71 55 75-75-40-40H435q-14-52-56.5-86T280-640' +
      'q-66 0-113 47t-47 113q0 66 47 113t113 47Z"/>' +
      '</svg>'
    );
  }

  // Material Symbols "translate" — same family as paintIcon() so the two
  // bottom-right toggles read as siblings.
  function translateIcon() {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" ' +
      'viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">' +
      '<path d="m475-80 181-480h82L920-80h-83l-43-122H603L560-80h-85ZM160-200' +
      'l-56-56 202-202q-35-35-63.5-80T190-640h84q20 39 40.5 68t48.5 58q33-33 68.5-92.5' +
      'T463-720H40v-80h280v-80h80v80h280v80H543q-23 75-61 148t-83 116l96 98-30 82-122-125' +
      '-202 201Zm468-72h144l-72-204-72 204Z"/>' +
      '</svg>'
    );
  }

  function extIcon() {
    return (
      '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true" style="vertical-align:-1px;margin-left:2px;">' +
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
      '<polyline points="15 3 21 3 21 9"/>' +
      '<line x1="10" y1="14" x2="21" y2="3"/>' +
      '</svg>'
    );
  }

  root.BaselineSwitcher = { mount, PRESETS, MODES, MARKETPLACE_URL };
})(typeof window !== "undefined" ? window : globalThis);
