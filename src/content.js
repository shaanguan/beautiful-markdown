/**
 * Content script entry: detect .md pages, fetch source, hand off to BaselineSurface.
 */

(function () {
  "use strict";

  // Typography is now enforced by:
  //  - styles/typography.css (link loaded via manifest for .md pages)
  //  - commitPresetTypography / reassert via renderPreviewMarkdown wrapper in BaselineSurface
  // The previous large JS-injected style block has been removed to eliminate
  // duplication with typography.css. Devs: if CSS changes don't appear, reload
  // the unpacked extension from chrome://extensions/.

  const DEFAULT_SETTINGS = {
    preset: "default",
    mode: "auto",
    width: "standard",
    enabledOnHttp: true
  };

  const { fileNameFromPageUrl, recordRecentUrl, showDefaultOpenerHint } = window.BaselineShared;

  const state = { originalMarkdown: "" };

  function isMarkdownURL(url) {
    try {
      const u = new URL(url);
      return /\.(md|markdown|mdown|mkd)(?:$|\?|#)/i.test(u.pathname);
    } catch {
      return false;
    }
  }

  function isBaselineRenderedPage() {
    return Boolean(
      document.querySelector(".app-container .markdown-preview-sizer") ||
      document.getElementById("baseline-switcher")
    );
  }

  function looksLikeMarkdownDocument() {
    if (!isMarkdownURL(location.href)) return false;
    if (isBaselineRenderedPage()) return true;
    const body = document.body;
    if (!body) return false;
    const onlyPre = body.children.length === 1 && body.firstElementChild.tagName === "PRE";
    const textHeavy = body.textContent.trim().length > 0 && body.children.length <= 2;
    return onlyPre || textHeavy;
  }

  async function fetchRawMarkdown() {
    if (isBaselineRenderedPage()) {
      const res = await fetch(location.href);
      return await res.text();
    }
    const pre = document.body.querySelector(":scope > pre");
    if (pre && pre.textContent && pre.textContent.length > 0) return pre.textContent;
    const res = await fetch(location.href);
    return await res.text();
  }

  function translateSourceName() {
    try {
      const pathname = decodeURI(location.pathname || "");
      const base = pathname.split("/").pop() || "";
      const noExt = base.replace(/\.(md|markdown|mdown|mkd)$/i, "");
      if (noExt) return noExt;
    } catch (_) { /* keep default */ }
    return "document";
  }

  function prepareSettings(settings) {
    // bilingual is viewer-only; keep remembered standard/wide/full/split.
    if (settings.width === "bilingual") settings.width = "standard";
    return settings;
  }

  function releaseFoucGuard() {
    try { document.documentElement.classList.add("bsw-ready"); } catch (_) {}
  }

  async function activate() {
    if (!looksLikeMarkdownDocument()) { releaseFoucGuard(); return; }

    const extensionPrefs = await new Promise((resolve) => {
      chrome.storage.sync.get(
        { enabledOnHttp: true },
        (items) => resolve(items)
      );
    });
    if (location.protocol !== "file:" && !extensionPrefs.enabledOnHttp) {
      releaseFoucGuard();
      return;
    }

    const source = await fetchRawMarkdown();
    state.originalMarkdown = source;

    // Surface this page in open.html's "Recent" list. Dedup is by URL,
    // so refreshing the same file just bumps lastOpened.
    try {
      const name = fileNameFromPageUrl() || translateSourceName();
      Promise.resolve(recordRecentUrl(location.href, name))
        .catch(() => { /* non-critical */ });
    } catch (_) { /* non-critical */ }

    window.BaselineSurface.runBoot({
      syncDefaults: DEFAULT_SETTINGS,
      prepareSettings,
      scaffold: { replaceBody: true },
      persistSessionKey: "md:" + location.href,
      initial: {
        markdown: source,
        fileName: fileNameFromPageUrl(),
        // file:// pages are "opened locally" (double-clicked from Finder,
        // dropped on Chrome, etc.). Note: without a FileSystemFileHandle the
        // Save button still shows (Save As / download); fromLocalFile only
        // affects legacy origin markers used elsewhere.
        fromLocalFile: location.protocol === "file:"
      },
      pickLabel: "Open Markdown file",
      onMainMarkdownChange: (md) => {
        state.originalMarkdown = md;
      },
      getTranslateMarkdown: () => state.originalMarkdown,
      getTranslateSourceName: translateSourceName,
      onAfterBoot: () => {
        releaseFoucGuard();
        showDefaultOpenerHint();
      }
    });
  }

  function runActivate() {
    activate().catch((err) => {
      releaseFoucGuard();
      const msg = (err && err.message) || String(err);
      if (msg.includes("Extension context invalidated")) return;
      console.error("[Baseline] activate failed:", err);
    });
  }

  // Last-resort release: if no render has flipped the flag within 1.5s of DOM
  // ready, drop the visibility hold so the user is never stuck on a blank page
  // (e.g. unusual content types that slipped past the include_globs).
  setTimeout(releaseFoucGuard, 1500);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runActivate, { once: true });
  } else {
    runActivate();
  }
})();
