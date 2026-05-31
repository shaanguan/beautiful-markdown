/**
 * Extension blank tab (open.html): empty start, same reading surface as .md tabs.
 */

(function () {
  "use strict";

  const surfaceState = { leftMarkdown: "", leftFileName: "" };

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
      },
      hideTranslateUntilContent: true,
      translateEmptyMessage: () => {
        if (!surfaceState.leftMarkdown || !surfaceState.leftMarkdown.trim()) {
          return "请先打开或粘贴 Markdown。";
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
