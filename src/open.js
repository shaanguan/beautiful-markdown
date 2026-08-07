/**
 * Extension blank tab (open.html): empty start, same reading surface as .md tabs.
 */

(function () {
  "use strict";

  const surfaceState = { leftMarkdown: "", leftFileName: "" };
  // First time the Open tab actually renders something (picked/pasted file
  // or restored session), surface the "Set Chrome as default opener" card.
  // Storage flag inside the helper makes this idempotent across sessions.
  let hintFired = false;
  function maybeShowHint() {
    if (hintFired) return;
    if (!surfaceState.leftMarkdown || !surfaceState.leftMarkdown.trim()) return;
    hintFired = true;
    try { window.BaselineShared.showDefaultOpenerHint(); } catch (_) {}
  }

  function run() {
    window.BaselineSurface.runBootMdReadingPage({
      scaffold: {
        bodyClass: "bsw-open-page",
        mainViewClass: "view-content bsw-side-right"
      },
      emptyStart: true,
      persistSessionKey: "open",
      onMainMarkdownChange: (md, name) => {
        surfaceState.leftMarkdown = md;
        surfaceState.leftFileName = name || "";
        maybeShowHint();
      },
      hideTranslateUntilContent: true,
      translateEmptyMessage: () => {
        if (!surfaceState.leftMarkdown || !surfaceState.leftMarkdown.trim()) {
          return "Open or paste Markdown to begin.";
        }
        return null;
      },
      getTranslateMarkdown: () => surfaceState.leftMarkdown,
      getTranslateSourceName: () => {
        const base = (surfaceState.leftFileName || "document")
          .replace(/\.(md|markdown|mdown|mkd)$/i, "");
        return base || "document";
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();
