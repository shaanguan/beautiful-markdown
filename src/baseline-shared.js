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
    const useLang = langPart && langPart !== "自动判断" ? langPart : "edited";
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
                resolve(item.filename.replace(/\\/g, "/"));
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
            reject(new Error((resp && resp.error) || "无法下载文件"));
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

    return { offset: 0, matched: false };
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

  /** Open a dedicated edit tab; Apply posts back to the originating tab. */
  function openMarkdownInEditTab(markdown, name, column, mountEl) {
    const md = markdown == null ? "" : String(markdown);
    const scroll = mountEl
      ? readEditScrollState(mountEl, md)
      : { scrollRatio: 0, scrollOffset: 0, scrollOffsetMatched: false };
    return new Promise((resolve, reject) => {
      chrome.tabs.getCurrent((tab) => {
        chrome.runtime.sendMessage(
          {
            type: "openEditTab",
            markdown: md,
            name: name == null ? "" : String(name),
            column: column || "main",
            scrollRatio: scroll.scrollRatio,
            scrollOffset: scroll.scrollOffset,
            scrollOffsetMatched: scroll.scrollOffsetMatched,
            sourceTabId: tab && tab.id != null ? tab.id : null
          },
          (resp) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (!resp || !resp.ok) {
              reject(new Error((resp && resp.error) || "无法打开编辑页"));
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

  /** Enables styles/claude-preset.css rules when the built-in Claude preset is active. */
  function syncPresetMarker(presetName) {
    const rootEl = document.documentElement;
    if (presetName === "claude") rootEl.setAttribute("data-bsw-preset", "claude");
    else rootEl.removeAttribute("data-bsw-preset");
  }

  root.BaselineShared = {
    CUSTOM_PREFIX,
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
    openMarkdownInEditTab,
    readEditScrollState,
    localPathFromFileUrl,
    fileNameFromPageUrl,
    getColumnScroller,
    readColumnScroll,
    restoreColumnScroll,
    resetColumnScroll
  };
})(typeof window !== "undefined" ? window : globalThis);
