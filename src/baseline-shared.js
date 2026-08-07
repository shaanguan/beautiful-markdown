/**
 * Shared view helpers for the .md content script and the viewer page.
 *
 * content.js (the in-page .md renderer) and viewer.js (the translation
 * viewer) historically carried byte-for-byte copies of the preset and
 * custom-preset plumbing. They diverge in their scaffolds, width values,
 * and switcher wiring — but the storage access, preset compilation, and
 * id helpers are identical. Extracting them here removes that duplication
 * so a fix to (say) the custom-preset compile path only has to land once.
 *
 * Exposed as window.BaselineShared; loaded after preset-map.js (it calls
 * window.BaselinePreset at runtime) and before content.js / viewer.js.
 *
 * Storage layout (unchanged):
 *   chrome.storage.local: { customPresets: [{ id, name, json }, ...] }
 *   Custom presets live in local because chrome.storage.sync has an 8KB
 *   per-item limit; a single rich preset can easily exceed that.
 */

(function (root) {
  "use strict";

  const CUSTOM_PREFIX = "custom:";

  // ── Tooltip localization ────────────────────────────────────────────
  // Per product rule: visible UI text is hardcoded English everywhere;
  // ONLY button-hover tooltips follow the browser's UI language. We keep
  // a tiny in-process string table here (zh + en) instead of going to
  // chrome.i18n / _locales — the surface is small and we want one source.
  //
  // Lang detection: prefer chrome.i18n.getUILanguage() (extension UI lang)
  // and fall back to navigator.language. Anything not starting with "zh"
  // → English. Extend the table below as new tooltip keys are added.
  function detectUILang() {
    let raw = "";
    try {
      if (chrome && chrome.i18n && typeof chrome.i18n.getUILanguage === "function") {
        raw = chrome.i18n.getUILanguage() || "";
      }
    } catch (_) {}
    if (!raw) raw = (navigator && navigator.language) || "en";
    return /^zh\b/i.test(raw) ? "zh" : "en";
  }
  const UI_LANG = detectUILang();
  const TOOLTIPS = {
    "toc.expand":          { en: "Expand outline",            zh: "展开目录" },
    "toc.collapse":        { en: "Collapse outline",          zh: "关闭目录" },
    "tool.copy":           { en: "Copy markdown",             zh: "复制全文" },
    "tool.copy_source":    { en: "Copy source",               zh: "复制原文" },
    "tool.copy_translation": { en: "Copy translation",        zh: "复制译文" },
    "tool.swap":           { en: "Open another",              zh: "打开其他" },
    "tool.swap_named":     { en: "Open another",              zh: "打开其他" },
    "tool.download":       { en: "Download",                  zh: "下载" },
    "tool.download_named": { en: "Download",                  zh: "下载" },
    "tool.edit":           { en: "Edit in popup",             zh: "在弹出窗口编辑" },
    "edit.undo":           { en: "Undo",                      zh: "撤销" },
    "edit.undo_kbd":       { en: "Undo (⌘Z)",                 zh: "撤销 (⌘Z)" },
    "edit.redo":           { en: "Redo",                      zh: "重做" },
    "edit.redo_kbd":       { en: "Redo (⌘⇧Z)",               zh: "重做 (⌘⇧Z)" },
    "edit.save":           { en: "Save",                      zh: "保存" },
    "edit.save_kbd":       { en: "Save (⌘↵)",                 zh: "保存 (⌘↵)" },
    "panel.close":         { en: "Close",                     zh: "关闭" },
    "panel.theme":         { en: "Theme & preset",            zh: "主题 / 预设" },
    "panel.translate":     { en: "Translate",                 zh: "翻译" },
    "panel.api_key":       { en: "Model & API key",           zh: "模型 / API Key" },
    "panel.marketplace":   { en: "Browse the theme marketplace", zh: "浏览主题市场" },
    "panel.delete_preset": { en: "Delete preset",             zh: "删除" },
    "panel.api_key_link":  { en: "Create or view an API key in Google AI Studio", zh: "在 Google AI Studio 创建或查看 API Key" },
    "panel.model_combo":   { en: "Pick a preset model",       zh: "选择预设模型" },
    "selection.ask_ai":    { en: "Copy and jump to selected chatbot", zh: "复制并跳转到所选 Chatbot" },
    "hint.close":          { en: "Dismiss",                   zh: "关闭" },
    "hover.dblclick_edit": { en: "Double click to edit",      zh: "双击编辑" }
  };
  function t(key, vars) {
    const entry = TOOLTIPS[key];
    let s = entry ? (entry[UI_LANG] || entry.en) : key;
    if (vars) {
      for (const k of Object.keys(vars)) {
        s = s.replace("{" + k + "}", String(vars[k]));
      }
    }
    return s;
  }
  // Expose under both root.BaselineI18n (preferred new API) and as a member
  // of root.BaselineShared so legacy callers can reach it via the existing
  // namespace without an extra script load.
  root.BaselineI18n = { lang: UI_LANG, t };

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

  // Derive a deterministic, URL-safe slug from a user-supplied name.
  // Falls back to a timestamp-free numeric suffix to guarantee uniqueness.
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

  // Open `path` in a local editor, preferring Cursor and falling back to
  // VS Code. Both register an `<app>://file/<path>` scheme; a sandboxed
  // page can't query which is installed, so fire cursor:// and fall back
  // to vscode:// if the window doesn't blur within 500ms.
  function openPathInEditor(path) {
    const fallback = setTimeout(() => {
      try { location.href = "vscode://file/" + path; } catch (_) {}
    }, 500);
    window.addEventListener("blur", () => clearTimeout(fallback), { once: true });
    try { location.href = "cursor://file/" + path; }
    catch (e) {
      clearTimeout(fallback);
      console.warn("[Baseline] open in editor failed:", e);
    }
  }

  function sanitizeFilenamePart(s, fallback) {
    const cleaned = String(s == null ? "" : s)
      .replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, "")
      .replace(/^\.+/, "")
      .trim();
    return cleaned || fallback;
  }

  // Mint a download filename for path-less markdown (viewer translation,
  // pasted content, file-picker swaps). `lang` may be a target language
  // label or a plain basename suffix.
  function buildEditFilename(sourceName, lang) {
    const base = sanitizeFilenamePart(sourceName, "document");
    const langPart = sanitizeFilenamePart(lang, "");
    const useLang = langPart && langPart !== "自动判断" && langPart !== "Auto"
      ? langPart
      : "edited";
    return `${base}.${useLang}.md`;
  }

  function downloadViaExtension(text, filename) {
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
              "Could not start download"
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
                  reject(new Error("Could not resolve downloaded file path"));
                  return;
                }
                resolve(item.filename.replace(/\\/g, "/"));
              });
            } else if (delta.state && delta.state.current === "interrupted") {
              chrome.downloads.onChanged.removeListener(onChanged);
              try { URL.revokeObjectURL(url); } catch (_) {}
              reject(new Error("Download interrupted"));
            }
          };
          chrome.downloads.onChanged.addListener(onChanged);
        }
      );
    });
  }

  function downloadViaServiceWorker(text, filename) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "downloadMarkdown", text: text || "", filename },
        (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!resp || !resp.ok || !resp.path) {
            reject(new Error((resp && resp.error) || "Could not download file"));
            return;
          }
          resolve(resp.path);
        }
      );
    });
  }

  // Save markdown to disk, then open the absolute path in a local editor.
  // Extension pages (viewer / open.html) call chrome.downloads directly;
  // content scripts route through the service worker (no downloads API).
  function downloadAndOpenInEditor(text, filename) {
    const download = location.protocol === "chrome-extension:"
      ? downloadViaExtension(text, filename)
      : downloadViaServiceWorker(text, filename);
    return download.then((path) => {
      openPathInEditor(path);
    });
  }

  // Plain download (no editor handoff). Same routing as downloadAndOpenInEditor.
  function downloadMarkdown(text, filename) {
    return location.protocol === "chrome-extension:"
      ? downloadViaExtension(text, filename)
      : downloadViaServiceWorker(text, filename);
  }

  // Decode a file:// tab URL pathname into a local path suitable for
  // cursor:// / vscode:// handlers (handles Windows drive prefixes).
  function localPathFromFileUrl() {
    if (location.protocol !== "file:") return "";
    let path;
    try { path = decodeURI(location.pathname || ""); }
    catch { path = location.pathname || ""; }
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    return path;
  }

  /** Basename from the tab URL (e.g. file://…/notes.md → "notes.md"). */
  function fileNameFromPageUrl(href) {
    try {
      const u = new URL(href || location.href);
      let seg = u.pathname || "";
      try { seg = decodeURI(seg); }
      catch { /* keep raw */ }
      const base = seg.split("/").filter(Boolean).pop() || "";
      if (!base) return "";
      if (u.protocol === "file:" || /\.(md|markdown|mdown|mkd)$/i.test(base)) {
        return base;
      }
    } catch (_) { /* ignore */ }
    return "";
  }

  function isScrollableOverflow(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.overflowY !== "auto" && cs.overflowY !== "scroll") return false;
    return el.scrollHeight > el.clientHeight + 1;
  }

  function getAppScrollRoot() {
    if (document.body.classList.contains("bsw-twopane-active")) return null;
    const app = document.querySelector(".app-container");
    return isScrollableOverflow(app) ? app : null;
  }

  // Which element scrolls for this column (matches toc.js anchor-jump logic).
  function getColumnScroller(mountEl) {
    if (!mountEl) return getAppScrollRoot();
    const viewContent = mountEl.closest(".view-content");
    const readingView = mountEl.closest(".markdown-reading-view");
    if (viewContent && document.body.classList.contains("bsw-twopane-active")) {
      return viewContent;
    }
    if (isScrollableOverflow(readingView)) return readingView;
    return getAppScrollRoot();
  }

  function readColumnScroll(mountEl) {
    const scroller = getColumnScroller(mountEl);
    if (scroller) return scroller.scrollTop;
    return window.scrollY || document.documentElement.scrollTop || 0;
  }

  // Restore after layout changes (e.g. leaving 分栏). Double-apply on rAF
  // because removing bsw-twopane-active can reflow the scroll container.
  function restoreColumnScroll(mountEl, scrollTop) {
    if (scrollTop == null || scrollTop < 0) return;
    const apply = () => {
      const scroller = getColumnScroller(mountEl);
      if (scroller) scroller.scrollTop = scrollTop;
      else window.scrollTo(0, scrollTop);
    };
    apply();
    requestAnimationFrame(apply);
  }

  // After swap/paste replaces a column's markdown, scroll back to the top.
  function resetColumnScroll(mountEl) {
    if (!mountEl) return;
    const scroller = getColumnScroller(mountEl);
    if (scroller) scroller.scrollTop = 0;
    else window.scrollTo(0, 0);
  }

  function findColumnSizer(mountEl) {
    if (!mountEl) return null;
    if (mountEl.classList && mountEl.classList.contains("markdown-preview-sizer")) {
      return mountEl;
    }
    return mountEl.querySelector(".markdown-preview-sizer");
  }

  // Matches TOC anchor jump inset (toc.js scrollTo … - 24).
  const READING_VIEW_INSET = 24;

  function readScrollRatio(scroller) {
    if (!scroller) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (max <= 0) return 0;
      return (window.scrollY || 0) / max;
    }
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max <= 0) return 0;
    return scroller.scrollTop / max;
  }

  /** Scroll ratio from rendered content height (aligns better with source lines). */
  function readContentScrollRatio(scroller, sizer) {
    if (!sizer) return readScrollRatio(scroller);
    const viewH = scroller ? scroller.clientHeight : window.innerHeight;
    const scrollPos = scroller ? scroller.scrollTop : (window.scrollY || 0);
    const max = Math.max(0, sizer.scrollHeight - viewH);
    if (max <= 0) return 0;
    return Math.min(1, Math.max(0, (scrollPos + READING_VIEW_INSET) / max));
  }

  /** First block intersecting the reading viewport top (same rule as TOC jumps). */
  function findTopVisibleBlock(sizer, scroller) {
    const blocks = sizer.children;
    if (!blocks.length) return null;
    const anchorY = scroller
      ? scroller.getBoundingClientRect().top + READING_VIEW_INSET
      : READING_VIEW_INSET;
    for (const child of blocks) {
      const r = child.getBoundingClientRect();
      if (r.bottom > anchorY + 1) return child;
    }
    return blocks[0];
  }

  function offsetForRenderedBlock(markdown, block) {
    if (!block || !markdown) return { offset: 0, matched: false };
    const md = String(markdown);
    const snippet = String(block.textContent || "").trim();
    const firstLine = snippet.split("\n")[0].trim();

    const probes = [];
    if (firstLine.length >= 4) probes.push(firstLine);
    if (snippet.length >= 6) probes.push(snippet.slice(0, Math.min(200, snippet.length)));

    for (const probe of probes) {
      const idx = md.indexOf(probe);
      if (idx >= 0) return { offset: idx, matched: true };
    }

    const tag = block.tagName ? block.tagName.toUpperCase() : "";
    if (/^H[1-6]$/.test(tag) && snippet) {
      const level = Number(tag.charAt(1));
      const escaped = snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp("^#{1," + level + "}\\s+" + escaped, "m");
      const m = md.match(re);
      if (m && m.index != null) return { offset: m.index, matched: true };
    }

    // Inline-syntax-tolerant fallback: rendered text often differs from
    // source because of `**bold**`, `[link](url)`, `[[wiki|alias]]`,
    // `==highlight==`, etc. Walk the first few alphanumeric tokens of the
    // snippet and find a position in source where they appear in order
    // within a small character window (so we don't accidentally match a
    // distant paragraph that happens to contain the same words).
    const tokens = snippet
      .split(/[^A-Za-z0-9一-鿿]+/)
      .filter((w) => w.length >= 2)
      .slice(0, 4);
    if (tokens.length >= 1) {
      const first = tokens[0];
      const window = Math.max(80, first.length * 8);
      let searchFrom = 0;
      while (searchFrom < md.length) {
        const idx = md.indexOf(first, searchFrom);
        if (idx < 0) break;
        let cursor = idx + first.length;
        let allFound = true;
        for (let i = 1; i < tokens.length; i++) {
          const next = md.indexOf(tokens[i], cursor);
          if (next < 0 || next - cursor > window) { allFound = false; break; }
          cursor = next + tokens[i].length;
        }
        if (allFound) {
          // Reject if the matched region spans a paragraph boundary —
          // this means we accidentally matched tokens across a heading
          // and the paragraph below it rather than within a single block.
          const region = md.slice(idx, cursor);
          if (region.includes("\n\n") || region.includes("\r\n\r\n")) {
            searchFrom = idx + first.length;
            continue;
          }
          // Back up past inline emphasis markers (*_~=`) immediately
          // before the matched token so the walk in offsetForRangePoint
          // starts at the same visible-char boundary as the DOM text.
          let adj = idx;
          while (adj > 0 && "*_~=`".includes(md[adj - 1])) adj--;
          if (adj > 0 && md[adj - 1] === "\n") {
            // Already at line start — use adj.
          } else if (adj >= idx) {
            adj = idx;
          }
          return { offset: adj, matched: true };
        }
        searchFrom = idx + first.length;
      }
    }

    return { offset: 0, matched: false };
  }

  /**
   * Map a DOM (node, offsetInNode) position inside the rendered reading
   * column to a source-markdown character offset.
   *
   * Strategy:
   *   1. Walk up to the top-level block child of `mountEl`.
   *   2. Reuse offsetForRenderedBlock to anchor that block in source.
   *   3. Concat rendered text from block start → the given point, then
   *      find that substring in source markdown after the block anchor.
   *   4. Fall back to the block anchor on failure (so syntax like
   *      `==highlight==` or `[[wikilink|alias]]` won't break callers).
   */
  function offsetForRangePoint(markdown, mountEl, node, offsetInNode) {
    if (!markdown || !mountEl || !node) {
      return { offset: 0, matched: false };
    }
    if (!mountEl.contains(node)) {
      return { offset: 0, matched: false };
    }

    let block = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (block && block.parentNode && block.parentNode !== mountEl) {
      block = block.parentNode;
    }
    if (!block || block.parentNode !== mountEl) {
      return { offset: 0, matched: false };
    }

    // For lists, narrow to the specific <li> so the text walk doesn't
    // span multiple items (the walk can't skip `- ` list markers).
    const blockTag = block.tagName && block.tagName.toUpperCase();
    if (blockTag === "UL" || blockTag === "OL") {
      let li = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      while (li && li !== block) {
        if (li.tagName && li.tagName.toUpperCase() === "LI") break;
        li = li.parentElement;
      }
      if (li && li.tagName && li.tagName.toUpperCase() === "LI") {
        block = li;
      }
    }

    // Mermaid: the rendered SVG/labels don't appear verbatim in the source.
    // Anchor on the mermaid source captured at render time and place the
    // caret at the start of the diagram's first source line (just inside
    // the opening ```mermaid fence). Better than landing at file top.
    if (block.tagName === "PRE" && block.classList.contains("mermaid")) {
      const md = String(markdown);
      const src = block.dataset && block.dataset.mermaidSource;
      if (src) {
        const firstLine = String(src).split("\n").find((l) => l.trim().length >= 3);
        if (firstLine) {
          const idx = md.indexOf(firstLine.trim());
          if (idx >= 0) return { offset: idx, matched: true };
        }
      }
      const fence = md.indexOf("```mermaid");
      if (fence >= 0) {
        const nl = md.indexOf("\n", fence);
        return { offset: nl >= 0 ? nl + 1 : fence, matched: true };
      }
      return { offset: 0, matched: false };
    }

    const blockMap = offsetForRenderedBlock(markdown, block);
    if (!blockMap.matched) return blockMap;

    let textBefore = "";
    try {
      const range = document.createRange();
      range.setStart(block, 0);
      if (node.nodeType === Node.TEXT_NODE) {
        const len = node.length || 0;
        range.setEnd(node, Math.max(0, Math.min(offsetInNode || 0, len)));
      } else {
        // Element node + child-index offset: place end before the Nth child.
        const childCount = node.childNodes ? node.childNodes.length : 0;
        const idx = Math.max(0, Math.min(offsetInNode || 0, childCount));
        if (idx >= childCount) {
          range.setEnd(node, childCount);
        } else {
          range.setEndBefore(node.childNodes[idx]);
        }
      }
      textBefore = range.toString();
    } catch (_) {
      return blockMap;
    }
    if (!textBefore) {
      // Anchor lands at the very first visible character of the block — the
      // user expressed "from the start of this block", so the source slice
      // should include leading markdown syntax (#, >, -, |). blockMap.offset
      // points at the start of the rendered text (e.g. "Heading" inside
      // `# Heading`); back up to column 0 so the `# ` prefix is captured.
      const mdStr = String(markdown);
      let i = blockMap.offset;
      while (i > 0 && mdStr[i - 1] !== "\n") i--;
      return { offset: i, matched: true };
    }

    const md = String(markdown);
    const blockStart = blockMap.offset;

    let idx = md.indexOf(textBefore, blockStart);
    if (idx >= 0) {
      return { offset: idx + textBefore.length, matched: true };
    }
    const tailLen = Math.min(24, textBefore.length);
    const tail = textBefore.slice(textBefore.length - tailLen);
    idx = md.indexOf(tail, blockStart);
    if (idx >= 0) {
      return { offset: idx + tail.length, matched: true };
    }

    // textBefore failed verbatim — likely because the block contains
    // inline markdown (`**bold**`, `[txt](url)`, `[[wiki|alias]]`) that
    // gets stripped by textContent. Walk the source from blockStart and
    // count visible-text characters until we have consumed `textBefore`
    // worth. This isn't pixel-perfect but lands the caret in the same
    // sentence rather than at the top.
    const target = textBefore.length;
    let consumed = 0;
    let i = blockStart;
    while (i < md.length && consumed < target) {
      const ch = md[i];
      // Skip simple inline markers that don't contribute to rendered text.
      if (ch === "*" || ch === "_" || ch === "~" || ch === "=" || ch === "`") {
        i++; continue;
      }
      if (ch === "\\" && i + 1 < md.length) { i += 2; consumed++; continue; }
      if (ch === "[") {
        if (md[i + 1] === "[") {
          // Wikilink [[name|alias]] — skip "[[name|" and consume alias text.
          const end = md.indexOf("]]", i + 2);
          if (end < 0) break;
          const inner = md.slice(i + 2, end);
          const pipe = inner.lastIndexOf("|");
          const visible = pipe >= 0 ? inner.slice(pipe + 1) : inner;
          consumed += visible.length;
          i = end + 2;
          continue;
        }
        // Markdown link [text](url) — count text only, skip (url).
        const close = md.indexOf("]", i + 1);
        if (close > 0 && md[close + 1] === "(") {
          const text = md.slice(i + 1, close);
          consumed += text.length;
          const paren = md.indexOf(")", close + 2);
          i = paren > 0 ? paren + 1 : close + 1;
          continue;
        }
      }
      // Stop at block boundary so we don't drift into the next paragraph.
      if (ch === "\n" && md[i + 1] === "\n") break;
      consumed++;
      i++;
    }
    if (consumed > 0) return { offset: i, matched: true };
    return blockMap;
  }

  /**
   * Map a click point inside the rendered reading column to a source
   * markdown character offset. Used by double-click → edit (光标定位).
   */
  function offsetForClickedPoint(markdown, mountEl, clickEvent) {
    if (!markdown || !mountEl || !clickEvent) {
      return { offset: 0, matched: false };
    }
    let node = null;
    let nodeOffset = 0;
    if (typeof document.caretPositionFromPoint === "function") {
      const pos = document.caretPositionFromPoint(clickEvent.clientX, clickEvent.clientY);
      if (pos) {
        node = pos.offsetNode;
        nodeOffset = pos.offset;
      }
    } else if (typeof document.caretRangeFromPoint === "function") {
      const range = document.caretRangeFromPoint(clickEvent.clientX, clickEvent.clientY);
      if (range) {
        node = range.startContainer;
        nodeOffset = range.startOffset;
      }
    }
    return offsetForRangePoint(markdown, mountEl, node, nodeOffset);
  }

  /** Map the reading column's scroll position to edit-tab coordinates. */
  function readEditScrollState(mountEl, markdown) {
    const scroller = getColumnScroller(mountEl);
    const sizer = findColumnSizer(mountEl);
    const scrollRatio = readContentScrollRatio(scroller, sizer);
    let scrollOffset = 0;
    let scrollOffsetMatched = false;
    if (sizer) {
      const block = findTopVisibleBlock(sizer, scroller);
      const mapped = offsetForRenderedBlock(markdown, block);
      scrollOffset = mapped.offset;
      scrollOffsetMatched = mapped.matched;
    }
    return { scrollRatio, scrollOffset, scrollOffsetMatched };
  }

  /**
   * Open a dedicated edit tab; Apply posts back to the originating tab.
   *
   * `extra` (optional):
   *   - selectionStart, selectionEnd: source-offset coordinates. When both
   *     are provided, edit.js focuses the textarea with that range selected.
   *     Equal start/end positions a bare cursor (used by 双击进编辑).
   */
  function openMarkdownInEditTab(markdown, name, column, mountEl, extra) {
    const md = markdown == null ? "" : String(markdown);
    const scroll = mountEl
      ? readEditScrollState(mountEl, md)
      : { scrollRatio: 0, scrollOffset: 0, scrollOffsetMatched: false };

    let selectionStart = null;
    let selectionEnd = null;
    if (extra && Number.isFinite(extra.selectionStart)) {
      selectionStart = Math.max(0, Math.floor(extra.selectionStart));
      const endRaw = Number.isFinite(extra.selectionEnd)
        ? Math.floor(extra.selectionEnd)
        : selectionStart;
      selectionEnd = Math.max(selectionStart, endRaw);
    }

    // Resolve our own tab id when running in an extension page
    // (open.html / viewer.html / edit.html) so the bg can route the
    // applyEdit response back. In content scripts (file://*.md),
    // chrome.tabs is unavailable; bg falls back to sender.tab.id.
    const resolveSourceTabId = () => new Promise((resolve) => {
      try {
        if (chrome.tabs && typeof chrome.tabs.getCurrent === "function") {
          chrome.tabs.getCurrent((tab) => {
            // chrome.runtime.lastError can fire here when called from a
            // non-tab context (worker iframe, etc.); silently treat as null.
            void chrome.runtime.lastError;
            resolve(tab && tab.id != null ? tab.id : null);
          });
          return;
        }
      } catch (_) { /* fall through */ }
      resolve(null);
    });

    return new Promise((resolve, reject) => {
      resolveSourceTabId().then((sourceTabId) => {
        chrome.runtime.sendMessage(
          {
            type: "openEditTab",
            markdown: md,
            name: name == null ? "" : String(name),
            column: column || "main",
            scrollRatio: scroll.scrollRatio,
            scrollOffset: scroll.scrollOffset,
            scrollOffsetMatched: scroll.scrollOffsetMatched,
            selectionStart,
            selectionEnd,
            sourceTabId
          },
          (resp) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (!resp || !resp.ok) {
              reject(new Error((resp && resp.error) || "Could not open editor"));
              return;
            }
            resolve(resp);
          }
        );
      });
    });
  }

  const TAB_SESSION_PREFIX = "bsw-tab:";

  function saveTabSession(key, data) {
    if (!key) return;
    try {
      sessionStorage.setItem(TAB_SESSION_PREFIX + key, JSON.stringify(data));
    } catch (_) { /* quota */ }
  }

  function loadTabSession(key) {
    if (!key) return null;
    try {
      const raw = sessionStorage.getItem(TAB_SESSION_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function clearTabSession(key) {
    if (!key) return;
    try {
      sessionStorage.removeItem(TAB_SESSION_PREFIX + key);
    } catch (_) { /* ignore */ }
  }

  /** Exposes the active built-in preset to expression-only CSS. */
  function syncPresetMarker(presetName) {
    const rootEl = document.documentElement;
    if (presetName && presetName !== "default") rootEl.setAttribute("data-bsw-preset", presetName);
    else rootEl.removeAttribute("data-bsw-preset");
  }

  // Single source of truth for the CSS custom properties that force/clear manage
  // for typography locking (see typography.css and force/clear functions).
  const TYPOGRAPHY_LOCK_VARS = [
    "--line-height-normal",
    "--p-spacing",
    "--heading-spacing",
    "--readable-spacing-modifier",
    "--file-line-width"
  ];

  /** Clear inline reading-contract values from the preview container and root. */
  function clearTypographyLock(previewEl) {
    if (!previewEl || !previewEl.style || typeof previewEl.style.removeProperty !== "function") return;
    let target = previewEl;
    if (target && typeof target.closest === "function") {
      const p = target.closest(".markdown-preview-view.markdown-rendered");
      if (p) target = p;
    }
    const root = document.documentElement;
    const remove = (k) => {
      try { target.style.removeProperty(k); } catch (_) {}
      if (root && root.style) {
        try { root.style.removeProperty(k); } catch (_) {}
      }
    };
    TYPOGRAPHY_LOCK_VARS.forEach((k) => {
      remove(k);
    });
    // Direct properties that typography.css and force set on the container
    ["line-height", "letter-spacing", "font-family", "font-size"].forEach((k) => {
      remove(k);
    });
  }

  /**
   * One commit point for preset + typography lock.
   * Always:
   *   syncPresetMarker -> apply the preset (via caller fn) -> force or clear lock
   * This eliminates ordering bugs and duplicated trios across files.
   */
  async function commitPresetTypography(previewEl, presetName, applyPresetFn) {
    syncPresetMarker(presetName);
    const preset = await loadPreset(presetName);
    if (typeof applyPresetFn === "function") {
      await applyPresetFn(preset);
    }
    forceTypographyLock(previewEl);
  }

  /**
   * Re-assert the typography lock after a renderTo repaint (no preset load).
   * Called from render wrapper.
   */
  function reassertTypographyLock(previewEl, presetName) {
    forceTypographyLock(previewEl);
  }

  function resolvePreview(mountEl) {
    if (!mountEl) return null;
    if (mountEl.closest) {
      const p = mountEl.closest(".markdown-preview-view.markdown-rendered");
      if (p) return p;
    }
    // fallback: if mountEl is the sizer, walk up or assume parent logic used by callers
    return mountEl;
  }

  /**
   * Wrapper that does renderTo then reasserts the lock for the active preset.
   * Grep gate: callers should use this instead of bare renderTo for preview markdown.
   */
  function renderPreviewMarkdown(mountEl, markdown, presetName) {
    // renderTarget must be the sizer (content container) that renderTo populates with innerHTML.
    // lockTarget is the ancestor view for vars and spacing rules.
    let renderTarget = mountEl;
    let lockTarget = mountEl;
    if (mountEl && typeof mountEl.closest === 'function') {
      const view = mountEl.closest('.markdown-preview-view.markdown-rendered');
      if (view) lockTarget = view;
      // renderTarget stays as the original mount (the sizer returned by buildScaffold)
    }
    const renderer = (typeof window !== "undefined" && window.BaselineRenderer) || globalThis.BaselineRenderer;
    if (!renderer || typeof renderer.renderTo !== "function") {
      return Promise.resolve().then(() => reassertTypographyLock(lockTarget, presetName));
    }
    return renderer.renderTo(markdown, renderTarget).then(() => {
      reassertTypographyLock(lockTarget, presetName);
    });
  }

  // ---- Recent documents ---------------------------------------------------
  // chrome.storage.local: { recentDocs: [{ id, kind, name, url?, handleKey?,
  //                                        lastOpened }] }
  // kind = "handle" → file picked via showOpenFilePicker; handleKey points
  //                   into IndexedDB store "handles" (extension origin only).
  // kind = "url"    → file:// or http(s):// page rendered by content.js;
  //                   url is the navigation target and is reopened by
  //                   chrome.tabs.create.
  const RECENT_DOCS_KEY = "recentDocs";
  const RECENT_DOCS_LIMIT = 10;
  const HANDLE_DB_NAME = "baseline-recent";
  const HANDLE_DB_VERSION = 1;
  const HANDLE_STORE = "handles";

  function openHandleDB() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(HANDLE_DB_NAME, HANDLE_DB_VERSION); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(HANDLE_STORE)) {
          db.createObjectStore(HANDLE_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function withHandleStore(mode, fn) {
    return openHandleDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, mode);
      const store = tx.objectStore(HANDLE_STORE);
      let result;
      try { result = fn(store); }
      catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  function saveFileHandle(key, handle) {
    return withHandleStore("readwrite", (store) => { store.put(handle, key); });
  }

  function loadFileHandle(key) {
    return openHandleDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, "readonly");
      const req = tx.objectStore(HANDLE_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    }));
  }

  function deleteFileHandle(key) {
    return withHandleStore("readwrite", (store) => { store.delete(key); });
  }

  function getRecentDocs() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [RECENT_DOCS_KEY]: [] }, (items) => {
        const list = Array.isArray(items[RECENT_DOCS_KEY])
          ? items[RECENT_DOCS_KEY] : [];
        resolve(list);
      });
    });
  }

  function setRecentDocs(list) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [RECENT_DOCS_KEY]: list }, () => resolve());
    });
  }

  function makeRecentId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "r-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  }

  // Record a URL-based recent (file:// or http(s)://). Dedup by exact URL.
  async function recordRecentUrl(url, name) {
    if (!url) return;
    const list = await getRecentDocs();
    const now = Date.now();
    const existing = list.find((e) => e.kind === "url" && e.url === url);
    if (existing) {
      existing.lastOpened = now;
      if (name) existing.name = name;
    } else {
      list.push({
        id: makeRecentId(),
        kind: "url",
        url,
        name: name || url,
        lastOpened: now
      });
    }
    await pruneAndSave(list);
  }

  // Record a handle-based recent. Same handle → dedup via isSameEntry so a
  // user reopening the same file via the picker bumps the existing entry
  // instead of cluttering the list.
  async function recordRecentHandle(handle, name) {
    if (!handle) return;
    const list = await getRecentDocs();
    const now = Date.now();
    let matched = null;
    for (const entry of list) {
      if (entry.kind !== "handle" || !entry.handleKey) continue;
      try {
        const stored = await loadFileHandle(entry.handleKey);
        if (stored && typeof stored.isSameEntry === "function") {
          if (await stored.isSameEntry(handle)) { matched = entry; break; }
        }
      } catch (_) { /* stale entry; ignore */ }
    }
    if (matched) {
      matched.lastOpened = now;
      if (name) matched.name = name;
    } else {
      const handleKey = makeRecentId();
      try { await saveFileHandle(handleKey, handle); }
      catch (e) {
        console.warn("[Baseline] saveFileHandle failed:", e);
        return;
      }
      list.push({
        id: makeRecentId(),
        kind: "handle",
        handleKey,
        name: name || (handle.name || "document.md"),
        lastOpened: now
      });
    }
    await pruneAndSave(list);
  }

  async function pruneAndSave(list) {
    list.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
    const dropped = list.splice(RECENT_DOCS_LIMIT);
    for (const e of dropped) {
      if (e.kind === "handle" && e.handleKey) {
        try { await deleteFileHandle(e.handleKey); }
        catch (_) { /* ignore */ }
      }
    }
    await setRecentDocs(list);
  }

  async function removeRecentDoc(id) {
    const list = await getRecentDocs();
    const idx = list.findIndex((e) => e.id === id);
    if (idx < 0) return;
    const [removed] = list.splice(idx, 1);
    if (removed && removed.kind === "handle" && removed.handleKey) {
      try { await deleteFileHandle(removed.handleKey); }
      catch (_) { /* ignore */ }
    }
    await setRecentDocs(list);
  }

  // Read content from a recent entry. For handles this triggers a permission
  // prompt on first use per browser session. Returns {text, name, handle?}
  // or null on failure / user denial.
  async function readRecentDoc(entry) {
    if (!entry) return null;
    if (entry.kind === "handle") {
      let handle;
      try { handle = await loadFileHandle(entry.handleKey); }
      catch (e) {
        console.warn("[Baseline] loadFileHandle failed:", e);
        return null;
      }
      if (!handle) return null;
      try {
        if (typeof handle.requestPermission === "function") {
          const perm = await handle.requestPermission({ mode: "read" });
          if (perm !== "granted") return null;
        }
        const file = await handle.getFile();
        const text = await file.text();
        return { text, name: file.name || entry.name || "", handle };
      } catch (e) {
        console.warn("[Baseline] read handle failed:", e);
        return null;
      }
    }
    if (entry.kind === "url") {
      try {
        const res = await fetch(entry.url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const text = await res.text();
        return { text, name: entry.name || "" };
      } catch (e) {
        console.warn("[Baseline] fetch recent url failed:", e);
        return null;
      }
    }
    return null;
  }

  // Marks an element as a "paste host": contenteditable so Chrome offers
  // Paste in the right-click menu and ⌘V fires a paste event. Non-paste
  // inputs are blocked so the user can't actually type into it. Page-level
  // paste handler (toc.js bindColumnPaste) consumes the event.
  // Lives here (not baseline-surface.js) because viewer.js — the standalone
  // translation page — needs it too, and viewer.js doesn't load surface.
  function markAsPasteHost(el) {
    if (el.getAttribute("data-bsw-paste-host") === "1") return;
    // `plaintext-only` forces a UA-level pre-wrap mode that author CSS cannot
    // override, making formatter newlines around block elements visible.
    // A regular editing host still exposes Paste; beforeinput below prevents
    // every mutation except the paste event consumed by the page handler.
    el.setAttribute("contenteditable", "true");
    el.setAttribute("data-bsw-paste-host", "1");
    el.setAttribute("spellcheck", "false");
    // Keep the rendered document in normal HTML flow. This also acts as a
    // fallback if Chrome changes the default style of regular editing hosts.
    el.style.setProperty("white-space", "normal", "important");
    el.addEventListener("beforeinput", (e) => {
      if (e.inputType === "insertFromPaste") return;
      // Form controls have their own editing model — don't block their typing
      // even when an ancestor is contenteditable (matters once we mark body).
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (t && t.isContentEditable && t !== el) return;
      e.preventDefault();
    });
    // Right-click in contenteditable auto-selects the word under cursor
    // (Chrome's default so Cut/Copy have a target). We just want the
    // Paste menu — clear that selection right after contextmenu fires.
    // NOTE: do NOT preventDefault on mousedown button=2 — on macOS Chrome
    // the contextmenu event is generated FROM that mousedown, so
    // preventDefault kills the menu entirely.
    let priorSelectionEmpty = false;
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 2) return;
      const sel = window.getSelection && window.getSelection();
      priorSelectionEmpty = !sel || sel.rangeCount === 0 || sel.isCollapsed;
    });
    el.addEventListener("contextmenu", () => {
      if (!priorSelectionEmpty) return;
      // rAF: let the menu open with its native selection state, then
      // clear the highlight after. User sees the menu, then the brief
      // word highlight disappears.
      requestAnimationFrame(() => {
        const sel = window.getSelection && window.getSelection();
        if (sel && !sel.isCollapsed) sel.removeAllRanges();
      });
    });
  }

  // ── Hover-edit hint ─────────────────────────────────────────────────
  // After the user has hovered idle on rendered body content for HINT_MS
  // milliseconds, surface a small "Double click to edit" tooltip near the
  // pointer. The hint is purely an affordance — it does NOT change click
  // behavior. Any movement or click hides it and restarts the timer.
  //
  // Single shared tooltip element under <body> so multiple bind sites
  // share one DOM node. isHoverEditable(target) lets callers reuse the
  // exact same gating as bindReadingDblClick (skip checkboxes, code-fold
  // chevrons, chrome UI, etc.) so the hint only appears where dblclick
  // actually opens the editor.
  const HOVER_EDIT_HINT_MS = 5000;
  const HOVER_EDIT_HINT_ID = "bsw-hover-edit-hint";

  function getHoverHintEl() {
    let el = document.getElementById(HOVER_EDIT_HINT_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = HOVER_EDIT_HINT_ID;
      el.className = "bsw-hover-hint";
      el.setAttribute("role", "tooltip");
      document.body.appendChild(el);
    }
    return el;
  }

  function bindHoverEditHint(rootEl, opts) {
    if (!rootEl) return;
    const isEditable = opts && typeof opts.isHoverEditable === "function"
      ? opts.isHoverEditable
      : () => true;
    const delayMs = (opts && Number.isFinite(opts.delayMs))
      ? opts.delayMs : HOVER_EDIT_HINT_MS;
    const text = (opts && opts.text) || "Double click to edit";

    let timer = 0;
    let lastX = 0;
    let lastY = 0;
    let visible = false;

    function hide() {
      if (timer) { clearTimeout(timer); timer = 0; }
      if (!visible) return;
      const el = document.getElementById(HOVER_EDIT_HINT_ID);
      if (el) el.classList.remove("is-visible");
      visible = false;
    }

    function show() {
      const el = getHoverHintEl();
      el.textContent = text;
      // Position offset from cursor so the hint doesn't sit under the
      // pointer (which would block the next mousemove and feel stuck).
      const PAD_X = 14;
      const PAD_Y = 18;
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      el.style.left = "0px";
      el.style.top = "0px";
      el.classList.add("is-visible");
      const rect = el.getBoundingClientRect();
      let left = lastX + PAD_X;
      let top = lastY + PAD_Y;
      if (left + rect.width + 8 > vw) left = lastX - PAD_X - rect.width;
      if (top + rect.height + 8 > vh) top = lastY - PAD_Y - rect.height;
      if (left < 4) left = 4;
      if (top < 4) top = 4;
      el.style.left = Math.round(left) + "px";
      el.style.top = Math.round(top) + "px";
      visible = true;
    }

    function schedule(target, x, y) {
      lastX = x; lastY = y;
      if (timer) clearTimeout(timer);
      if (!isEditable(target)) { hide(); return; }
      timer = setTimeout(() => { show(); }, delayMs);
    }

    rootEl.addEventListener("mousemove", (e) => {
      if (visible) hide();
      schedule(e.target, e.clientX, e.clientY);
    });
    rootEl.addEventListener("mouseleave", hide);
    rootEl.addEventListener("mousedown", hide);
    rootEl.addEventListener("wheel", hide, { passive: true });
    rootEl.addEventListener("keydown", hide);
  }

  // ── Default-opener hint card ────────────────────────────────────────
  // Bottom-left card shown ONCE per user (storage flag mdHintDismissed)
  // the first time we render any document. Tells the user how to set
  // Chrome as the default opener for .md files. Lives here because both
  // the in-page content script (content.js) and the Open tab (open.js)
  // need to surface it on first render.
  //
  // Inline Chrome logo. 200x200 viewBox, scaled by CSS — three petals
  // (red top, yellow bottom-right, green bottom-left) tangent to an
  // inner blue disc.
  const CHROME_LOGO_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 200 200" aria-hidden="true">' +
      '<circle cx="100" cy="100" r="98" fill="#fff"/>' +
      '<path fill="#EA4335" d="M16.86 52A96 96 0 0 1 183.14 52L134.64 80A40 40 0 0 0 65.36 80Z"/>' +
      '<path fill="#FBBC04" d="M183.14 52A96 96 0 0 1 100 196L100 140A40 40 0 0 0 134.64 80Z"/>' +
      '<path fill="#34A853" d="M100 196A96 96 0 0 1 16.86 52L65.36 80A40 40 0 0 0 100 140Z"/>' +
      '<circle cx="100" cy="100" r="40" fill="#fff"/>' +
      '<circle cx="100" cy="100" r="36" fill="#4285F4"/>' +
    '</svg>';

  function detectDefaultOpenerInstruction() {
    const ua = navigator.userAgent || "";
    if (/Mac OS X|Macintosh/i.test(ua)) {
      return "In Finder, right-click a .md file → Get Info → Open With → pick Google Chrome → Change All…";
    }
    if (/Windows/i.test(ua)) {
      return "Right-click a .md file → Open with → Choose another app → check “Always use this app” → pick Google Chrome.";
    }
    return "In your file manager, right-click a .md file → Properties / Open With → set Google Chrome as the default app.";
  }

  function showDefaultOpenerHint() {
    if (!document || !document.body) return;
    if (document.getElementById("bsw-md-hint")) return;

    // Storage flag honored here (not at call sites) so callers don't have
    // to plumb the read; the cost is one chrome.storage.sync.get per render
    // entry-point on pages that load this script.
    chrome.storage.sync.get({ mdHintDismissed: false }, (items) => {
      if (items && items.mdHintDismissed) return;
      if (document.getElementById("bsw-md-hint")) return;

      const card = document.createElement("div");
      card.id = "bsw-md-hint";
      card.setAttribute("role", "status");

      const icon = document.createElement("div");
      icon.className = "bsw-md-hint-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = CHROME_LOGO_SVG;

      const body = document.createElement("div");
      body.className = "bsw-md-hint-body";

      const title = document.createElement("div");
      title.className = "bsw-md-hint-title";
      title.textContent = "Set Chrome as default opener";

      const text = document.createElement("p");
      text.className = "bsw-md-hint-text";
      text.textContent = detectDefaultOpenerInstruction();

      body.appendChild(title);
      body.appendChild(text);

      const close = document.createElement("button");
      close.type = "button";
      close.className = "bsw-md-hint-close";
      close.setAttribute("aria-label", "Dismiss");
      close.textContent = "×";

      const dismiss = () => {
        card.classList.add("is-leaving");
        try { chrome.storage.sync.set({ mdHintDismissed: true }); } catch (_) {}
        setTimeout(() => card.remove(), 200);
      };

      close.addEventListener("click", dismiss);
      card.appendChild(icon);
      card.appendChild(body);
      card.appendChild(close);
      document.body.appendChild(card);
    });
  }

  /**
   * Force the active reading metrics on the preview container. Values are
   * sourced from typography.css. All four built-in presets resolve to the same
   * measured reading geometry; preset identity changes expression only.
   */
  function forceTypographyLock(previewEl) {
    if (!previewEl || !previewEl.style || typeof previewEl.style.setProperty !== "function") return;

    // Always target the preview container (not sizer child) for container styles.
    // Preset identity does not change the locked reading geometry.
    let target = previewEl;
    if (target && typeof target.closest === "function") {
      const preview = target.closest(".markdown-preview-view.markdown-rendered");
      if (preview) target = preview;
    }

    // Also force on the root (html) so vars win over body declarations in theme.css
    const root = document.documentElement;
    const set = (k, v) => {
      try { target.style.setProperty(k, v, "important"); } catch (_) {}
      if (root && root.style) {
        try { root.style.setProperty(k, v, "important"); } catch (_) {}
      }
    };
    set("--line-height-normal", "var(--bsw-typography-line-height)");
    set("--p-spacing", "var(--bsw-typography-paragraph-spacing)");
    set("--heading-spacing", "var(--bsw-typography-heading-spacing)");
    set("--readable-spacing-modifier", "1");
    set("--file-line-width", "var(--bsw-typography-column-width)");
    set("line-height", "var(--bsw-typography-line-height)");
    // Additional direct props for robustness against late theme rules
    set("font-size", "var(--bsw-typography-font-size)");
    set("letter-spacing", "0");
  }

  root.BaselineShared = {
    CUSTOM_PREFIX,
    markAsPasteHost,
    bindHoverEditHint,
    showDefaultOpenerHint,
    saveTabSession,
    loadTabSession,
    clearTabSession,
    syncPresetMarker,
    getCustomPresets,
    setCustomPresets,
    compileFromJSON,
    emptyPreset,
    loadPreset,
    makeCustomId,
    projectCustom,
    openPathInEditor,
    sanitizeFilenamePart,
    buildEditFilename,
    downloadAndOpenInEditor,
    downloadMarkdown,
    openMarkdownInEditTab,
    readEditScrollState,
    offsetForRenderedBlock,
    offsetForRangePoint,
    offsetForClickedPoint,
    localPathFromFileUrl,
    fileNameFromPageUrl,
    getColumnScroller,
    readColumnScroll,
    restoreColumnScroll,
    resetColumnScroll,
    getRecentDocs,
    setRecentDocs,
    recordRecentUrl,
    recordRecentHandle,
    removeRecentDoc,
    readRecentDoc,
    TYPOGRAPHY_LOCK_VARS,
    clearTypographyLock,
    forceTypographyLock,
    commitPresetTypography,
    reassertTypographyLock,
    renderPreviewMarkdown,
    resolvePreview
  };
})(typeof window !== "undefined" ? window : globalThis);
