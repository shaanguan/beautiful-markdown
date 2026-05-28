# Beautiful Markdown

Render local & remote `.md` files in Chrome with the look of the
[Obsidian Baseline theme](https://github.com/aaaaalexis/obsidian-baseline) —
including the full marketplace of community presets.

![Baseline](icons/icon128.png)

## Features

- Auto-renders `*.md`, `*.markdown`, `*.mdown`, `*.mkd` opened via `file://`
- Also renders remote `http(s)` markdown pages (on by default)
- Output DOM mimics Obsidian's preview structure so the original
  `theme.css` applies 1:1
- 4 curated presets bundled (Baseline, Claude, Minimal, Stone) — plus
  import any preset from the
  [Baseline marketplace](https://aaaaalexis.github.io/obsidian-baseline/marketplace/)
  by pasting JSON or loading a `.json` file. Custom presets are saved
  locally and survive across tabs and reloads.
- Switch live from the floating in-page widget (bottom-right)
- KaTeX math (`$…$`, `$$…$$`)
- Mermaid diagrams (` ```mermaid `)
- highlight.js code highlighting (auto-detected language)
- Obsidian-flavored extras: `[[wikilink]]`, `[[link|alias]]`,
  `![[embed.png]]`, `#tag`, `==highlight==`
- Auto / Light / Dark color mode

## Installation (developer mode)

1. Open `chrome://extensions/`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder: `~/Documents/projects/chrome-baseline-md`
5. Open the extension's **Details** page
   → enable **Allow access to file URLs** (required for `file://` rendering)

## Usage

- Drag any `.md` file into Chrome — done.
- Click the **paint-bucket button** in the bottom-right of the rendered
  page to open the switcher:
  - Pick a **Color mode** (Auto / Light / Dark)
  - Pick a built-in **Preset**
  - Or **Import preset** to paste / load a `.json` file from the
    [marketplace](https://aaaaalexis.github.io/obsidian-baseline/marketplace/).
    Imported presets show up in the **Custom** list and can be deleted
    by hovering the row.

## Architecture

```
chrome-baseline-md/
├── manifest.json           MV3 manifest
├── src/
│   ├── content.js          Entry: detects markdown, builds Obsidian DOM
│   ├── renderer.js         marked → sanitize → DOM, then KaTeX & Mermaid
│   ├── obsidian-syntax.js  marked extensions: wikilink/embed/tag/highlight
│   ├── preset-map.js       Translates preset JSON → CSS variables + body classes
│   └── theme-switcher.js   Floating in-page switcher (mode / preset / import)
├── styles/
│   ├── theme.css           Baseline theme (verbatim from obsidian-baseline)
│   └── extension.css       Scaffold, fallbacks, switcher widget styling
├── presets/                Built-in preset JSON (claude / minimal / stone-gnome)
├── vendor/                 marked, DOMPurify, hljs, katex, mermaid
└── icons/                  16/48/128 PNG icons
```

The trick that makes Baseline's CSS apply unchanged is the **DOM scaffold**
built in `content.js` — we wrap rendered markdown in the same nested
`workspace > leaf > markdown-reading-view > markdown-preview-view.markdown-rendered`
hierarchy that Obsidian uses, so every selector in `theme.css` matches.

Preset switching translates each `baseline-style@@<varname>@@<mode>`
key into a CSS custom-property declaration scoped to `.theme-light` or
`.theme-dark` on `<body>`, mirroring the way the Style Settings plugin
applies presets inside Obsidian.

## Limitations / known gaps

- **Style Settings UI not implemented**: bundled and imported presets
  apply wholesale — the full Style Settings UI (toggles, sliders,
  custom fonts) is not exposed.
- **Excalidraw / Dataview / Canvas / Properties** are Obsidian plugin
  features and not supported.
- **Wikilinks navigate via anchor only** — there is no vault to resolve
  the target. Clicks scroll to a same-page anchor if one matches.
- KaTeX fonts are bundled locally; first paint may briefly show fallback
  glyphs while font files load over `file://`.
- **CSP-strict pages** may block the content script. The extension is
  designed for `file://` markdown — http(s) support is best-effort.

## Licenses

- Baseline theme — MIT, © Alexis C
- marked — MIT
- DOMPurify — Apache 2.0 / MPL 2.0
- highlight.js — BSD 3-Clause
- KaTeX — MIT
- Mermaid — MIT
- This extension — MIT
