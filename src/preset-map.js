/**
 * Preset → CSS variable / body class compiler.
 *
 * Style Settings preset JSON keys come in three shapes:
 *   1. baseline-style@@<varname>@@dark   → CSS var --<varname> under .theme-dark
 *   2. baseline-style@@<varname>@@light  → CSS var --<varname> under .theme-light
 *   3. baseline-style@@<key>             → behavior depends on the key's
 *                                          declared Style Settings type:
 *      - class-select: value is a class name; add it to <body>
 *      - class-toggle: when value is true, add the key itself as a class
 *      - variable-text / variable-select / variable-themed-color /
 *        variable-number / variable-number-slider: emit --<key>: <value>;
 *
 * The declared type per key is extracted from the @settings comment block
 * in theme.css. Without that map, a value like `"left"` (which Style Settings
 * treats as a variable-select value for --tab-text-align) was previously
 * mistaken for a body class — visibly breaking many presets.
 *
 * Special rules:
 *
 *  • *-override suffix: keys like `font-text-override` set the variable
 *    --font-text. Style Settings uses this suffix internally. Strip it
 *    before emitting the variable, and treat the key as variable-text
 *    regardless of whether it appears in the type map.
 *
 *  • Mode-scoped class-select: a handful of class-select keys describe a
 *    style that only makes sense in one color mode (the dark color scheme
 *    must not be applied in light mode, etc.). These are listed in
 *    MODE_SCOPED_CLASS_KEYS so the compiled output emits them into the
 *    light- or dark-only class bucket.
 */

(function (root) {
  "use strict";

  const PREFIX = "baseline-style@@";

  // Generated from the @settings YAML block in theme.css. Only includes
  // keys that the 19 bundled presets actually reference; unknown keys
  // fall back to the value-based heuristic below.
  const KEY_TYPES = {
    "accented-interface": "class-toggle",
    "active-line-color": "class-select",
    "active-line-style": "class-select",
    "anim-motion-baseline": "variable-select",
    "anim-speed-modifier": "variable-number-slider",
    "background-contrast-dark": "class-select",
    "background-contrast-light": "class-select",
    "background-modifier-border": "variable-themed-color",
    "background-modifier-border-focus": "variable-themed-color",
    "background-modifier-border-hover": "variable-themed-color",
    "background-modifier-hover": "variable-themed-color",
    "background-primary": "variable-themed-color",
    "background-primary-alt": "variable-themed-color",
    "background-secondary": "variable-themed-color",
    "background-secondary-alt": "variable-themed-color",
    "bases-table-align-items": "variable-select",
    "bases-table-header-icon-display": "variable-select",
    "bases-toolbar-label-display": "variable-select",
    "blockquote-background-color": "variable-themed-color",
    "blockquote-border-color": "variable-themed-color",
    "blockquote-border-thickness": "variable-number-slider",
    "blockquote-font-style": "variable-select",
    "blockquote-style": "class-select",
    "bold-color": "variable-themed-color",
    "bold-folders": "class-toggle",
    "callouts-style": "class-select",
    "checkbox-radius": "variable-select",
    "code-comment": "variable-themed-color",
    "code-function": "variable-themed-color",
    "code-important": "variable-themed-color",
    "code-line-numbers": "class-toggle",
    "code-property": "variable-themed-color",
    "code-punctuation": "variable-themed-color",
    "code-scroll": "class-toggle",
    "code-style": "class-select",
    "code-value": "variable-themed-color",
    "col-lines": "class-toggle",
    "color-blue-rgb": "variable-themed-color",
    "color-cyan-rgb": "variable-themed-color",
    "color-green-rgb": "variable-themed-color",
    "color-orange-rgb": "variable-themed-color",
    "color-pink-rgb": "variable-themed-color",
    "color-purple-rgb": "variable-themed-color",
    "color-red-rgb": "variable-themed-color",
    "color-scheme-accent": "class-toggle",
    "color-scheme-dark": "class-select",
    "color-scheme-light": "class-select",
    "color-yellow-rgb": "variable-themed-color",
    "colorful-folders": "class-select",
    "colorful-headings": "class-select",
    "colorful-headings-text": "class-toggle",
    "density-modifier": "variable-number-slider",
    "divider-color": "variable-themed-color",
    "element-style": "class-select",
    "embed-style": "class-select",
    "file-header-font-weight": "variable-number-slider",
    "file-header-justify": "variable-select",
    "file-header-visibility": "class-select",
    "focus-view": "class-toggle",
    "font-ui-modifier": "variable-number-slider",
    "graph-node-tag": "variable-themed-color",
    "graph-node-unresolved": "variable-themed-color",
    "h1-color": "variable-themed-color",
    "h1-font": "variable-text",
    "h1-l": "class-toggle",
    "h1-size": "variable-text",
    "h1-weight": "variable-number-slider",
    "h2-color": "variable-themed-color",
    "h2-font": "variable-text",
    "h2-l": "class-toggle",
    "h2-size": "variable-text",
    "h2-style": "variable-select",
    "h2-transform": "variable-select",
    "h2-weight": "variable-number-slider",
    "h3-color": "variable-themed-color",
    "h3-font": "variable-text",
    "h3-l": "class-toggle",
    "h3-size": "variable-text",
    "h3-weight": "variable-number-slider",
    "h4-color": "variable-themed-color",
    "h4-font": "variable-text",
    "h4-l": "class-toggle",
    "h4-size": "variable-text",
    "h4-variant": "variable-select",
    "h4-weight": "variable-number-slider",
    "h5-color": "variable-themed-color",
    "h5-font": "variable-text",
    "h5-l": "class-toggle",
    "h5-size": "variable-text",
    "h5-variant": "variable-select",
    "h5-weight": "variable-number-slider",
    "h6-color": "variable-themed-color",
    "h6-font": "variable-text",
    "h6-l": "class-toggle",
    "h6-size": "variable-text",
    "h6-transform": "variable-select",
    "h6-variant": "variable-select",
    "h6-weight": "variable-number-slider",
    "header-height": "variable-text",
    "heading-spacing": "variable-text",
    "hide-baseline-info": "class-toggle",
    "hide-vault-switcher-off": "class-toggle",
    "hover-ribbon": "class-toggle",
    "hover-sidedock": "class-toggle",
    "hover-sidedock-trigger-area": "variable-select",
    "hover-sidedock-width": "variable-text",
    "hr-color": "variable-themed-color",
    "hr-thickness": "variable-number-slider",
    "icon-color": "variable-themed-color",
    "icon-color-hover": "variable-themed-color",
    "icon-stroke-modifier": "variable-number-slider",
    "img-grid": "class-toggle",
    "indentation-guide-color": "variable-select",
    "indentation-guide-width": "variable-number-slider",
    "inline-title-color": "variable-themed-color",
    "inline-title-font": "variable-text",
    "inline-title-size": "variable-text",
    "interactive-hover": "variable-themed-color",
    "interactive-normal": "variable-themed-color",
    "italic-color": "variable-themed-color",
    "large-new-note": "class-toggle",
    "layout-style": "class-select",
    "link-color": "variable-themed-color",
    "link-color-hover": "variable-themed-color",
    "link-external-color": "variable-themed-color",
    "link-external-color-hover": "variable-themed-color",
    "link-external-decoration": "variable-select",
    "menu-background": "variable-themed-color",
    "metadata-add-property": "class-select",
    "metadata-heading-off": "class-toggle",
    "metadata-icons-off": "class-toggle",
    "metadata-list-tags": "class-toggle",
    "metadata-style": "class-select",
    "mode-switcher-off": "class-toggle",
    "nav-action": "class-select",
    "nav-indentation-guide-color": "variable-select",
    "nav-indentation-guide-width": "variable-number-slider",
    "nav-item-active-style": "class-select",
    "nav-item-size": "variable-text",
    "p-spacing": "variable-text",
    "pdf-invert-dark": "class-toggle",
    "plugins-grid-off": "class-toggle",
    "prompt-background": "variable-themed-color",
    "radius-modifier": "variable-number-slider",
    "readable-spacing": "class-toggle",
    "readable-spacing-modifier": "variable-number-slider",
    "reduce-motion": "class-toggle",
    "row-alt": "class-toggle",
    "row-hover": "class-toggle",
    "row-lines": "class-toggle",
    "status-bar-style": "class-select",
    "strike-lists-off": "class-toggle",
    "tab-divider": "class-toggle",
    "tab-full-width": "class-toggle",
    "tab-left-style": "class-select",
    "tab-right-style": "class-select",
    "tab-stacked-header-width": "variable-text",
    "tab-stacked-spine-order": "variable-select",
    "tab-stacked-spine-orientation": "class-select",
    "tab-style": "class-select",
    "tab-text-align": "variable-select",
    "tab-top-left-style": "class-select",
    "tab-top-right-style": "class-select",
    "table-nowrap": "class-toggle",
    "table-numbers": "class-toggle",
    "table-tabular": "class-toggle",
    "table-text-align-body": "variable-select",
    "table-text-align-header": "variable-select",
    "table-width": "class-select",
    "tag-background": "variable-themed-color",
    "tag-background-hover": "variable-themed-color",
    "tag-border-width": "variable-number-slider",
    "tag-color": "variable-themed-color",
    "tag-radius": "variable-select",
    "text-faint": "variable-themed-color",
    "text-highlight": "variable-themed-color",
    "text-highlight-bg": "variable-themed-color",
    "text-muted": "variable-themed-color",
    "text-normal": "variable-themed-color",
    "text-normal-editor": "variable-themed-color",
    "text-selection": "variable-themed-color",
    "titlebar-text-off": "class-toggle",
    "titlebar-text-weight": "variable-number-slider",
    "translucent-dark-opacity": "variable-number-slider",
    "translucent-light-opacity": "variable-number-slider",
    "unstyled-tags": "class-toggle",
    "zoom-off": "class-toggle"
  };

  // class-select keys whose value must apply only in the matching color mode.
  // Without this, e.g. a preset's dark color scheme leaks into light mode.
  const MODE_SCOPED_CLASS_KEYS = {
    "color-scheme-light": "light",
    "color-scheme-dark": "dark",
    "background-contrast-light": "light",
    "background-contrast-dark": "dark"
  };

  // Type families.
  const VARIABLE_TYPES = new Set([
    "variable-text",
    "variable-select",
    "variable-themed-color",
    "variable-number",
    "variable-number-slider"
  ]);

  /**
   * @param {Record<string, string|boolean|number>} preset Raw preset JSON.
   * @returns {{cssLight:string, cssDark:string, cssBoth:string,
   *           classesCommon:string[], classesLight:string[], classesDark:string[]}}
   */
  function compilePreset(preset) {
    const lightVars = [];
    const darkVars = [];
    const bothVars = [];
    const classesCommon = [];
    const classesLight = [];
    const classesDark = [];

    for (const rawKey of Object.keys(preset)) {
      if (!rawKey.startsWith(PREFIX)) continue;
      const stripped = rawKey.slice(PREFIX.length);
      const value = preset[rawKey];

      // Skip null / undefined / explicit false. Booleans handled below
      // (false → no class). 0 is meaningful for variable-number, keep it.
      if (value === null || value === undefined) continue;

      const parts = stripped.split("@@");
      const varName = parts[0];
      const mode = parts[1]; // 'light' | 'dark' | undefined

      // -override suffix always denotes a CSS variable assignment.
      const isOverride = varName.endsWith("-override");
      const realVar = isOverride ? varName.slice(0, -"-override".length) : varName;

      // Mode-scoped values are always variable assignments — these are the
      // baseline-style@@<var>@@light|dark color overrides.
      if (mode === "light" || mode === "dark") {
        if (value === false || value === "") continue;
        const decl = `--${realVar}: ${value};`;
        (mode === "light" ? lightVars : darkVars).push(decl);
        continue;
      }

      const type = isOverride
        ? "variable-text"
        : (KEY_TYPES[varName] || inferType(value));

      if (type === "class-toggle") {
        // Toggle: when truthy, add the key itself as a body class.
        if (value === true) classesCommon.push(varName);
        continue;
      }

      if (type === "class-select") {
        if (typeof value !== "string" || value === "") continue;
        const scope = MODE_SCOPED_CLASS_KEYS[varName];
        if (scope === "light") classesLight.push(value);
        else if (scope === "dark") classesDark.push(value);
        else classesCommon.push(value);
        continue;
      }

      if (VARIABLE_TYPES.has(type)) {
        if (value === false || value === "") continue;
        bothVars.push(`--${realVar}: ${value};`);
        continue;
      }

      // info-text / heading / unknown → ignore.
    }

    return {
      cssLight: lightVars.join(""),
      cssDark: darkVars.join(""),
      cssBoth: bothVars.join(""),
      classesCommon,
      classesLight,
      classesDark
    };
  }

  // Fallback for keys not in KEY_TYPES (a handful exist in some presets).
  // Conservative: prefer variable over class, since unknown class-selects
  // would have been declared in the manifest.
  function inferType(value) {
    if (typeof value === "boolean") return "class-toggle";
    return "variable-text";
  }

  /** Build a stylesheet string from the compiled preset. */
  function presetToCSS(preset) {
    const c = compilePreset(preset);
    return [
      c.cssBoth ? `body{${c.cssBoth}}` : "",
      c.cssLight ? `body.theme-light{${c.cssLight}}` : "",
      c.cssDark ? `body.theme-dark{${c.cssDark}}` : ""
    ].filter(Boolean).join("\n");
  }

  root.BaselinePreset = { compilePreset, presetToCSS, PREFIX, KEY_TYPES };
})(typeof window !== "undefined" ? window : globalThis);
