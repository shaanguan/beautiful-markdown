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

  // Web-clipper handoff: translator-bg staged {markdown, name, url} in
  // chrome.storage.session under bswClip:<id> and opened open.html?clip=<id>.
  // One-shot: we delete the key after reading, persist the doc into the
  // library (IndexedDB), and rewrite the URL to ?doc=<libId> so a reload
  // reopens the clip from the library instead of a dead session key.
  async function loadClipPayload() {
    const params = new URLSearchParams(location.search);
    const clipId = params.get("clip");
    if (!clipId || !chrome.storage || !chrome.storage.session) return null;
    const key = "bswClip:" + clipId;
    try {
      const items = await chrome.storage.session.get(key);
      const payload = items && items[key];
      if (!payload || !payload.markdown) return null;
      chrome.storage.session.remove(key);
      try {
        const libId = await window.BaselineShared.saveLibraryDoc({
          name: payload.name || "clipping.md",
          markdown: payload.markdown,
          source: "clip",
          url: payload.url || ""
        });
        history.replaceState(null, "", "open.html?doc=" + libId);
      } catch (e) {
        console.warn("[Baseline] clip → library save failed:", e);
      }
      return payload;
    } catch (_) {
      return null;
    }
  }

  // Reopen a library document (?doc=<id>): clip reloads and library-list
  // navigations both land here.
  async function loadLibraryPayload() {
    const params = new URLSearchParams(location.search);
    const docId = params.get("doc");
    if (!docId) return null;
    try {
      const doc = await window.BaselineShared.getLibraryDoc(docId);
      if (!doc || !doc.markdown) return null;
      return { markdown: doc.markdown, name: doc.name };
    } catch (_) {
      return null;
    }
  }

  async function run() {
    const clip = (await loadClipPayload()) || (await loadLibraryPayload());
    window.BaselineSurface.runBootMdReadingPage({
      scaffold: {
        bodyClass: "bsw-open-page",
        mainViewClass: "view-content bsw-side-right"
      },
      emptyStart: !clip,
      initial: clip
        ? { markdown: clip.markdown, fileName: clip.name || "clipping.md" }
        : undefined,
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
