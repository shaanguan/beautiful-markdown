/**
 * Web clipper page script (injected on demand via chrome.scripting).
 *
 * Runs in the extension's isolated world AFTER vendor/clipper.js, which
 * provides BaselineClipperLibs = { Readability, TurndownService, gfm }.
 * Exposes self.__bswClip(mode) — called by a follow-up executeScript from
 * the service worker — returning { ok, markdown, name, title, url }.
 *
 *   mode "page"      → Readability article extraction on a cloned document
 *   mode "selection" → current selection's HTML (falls back to "page")
 *
 * Output mirrors Obsidian Web Clipper: YAML frontmatter (title / source /
 * author / published / created / description / tags) + GFM markdown body.
 */
(function () {
  "use strict";

  if (self.__bswClip) return; // idempotent across repeated injections

  const libs = self.BaselineClipperLibs;

  function meta(sel) {
    const el = document.querySelector(sel);
    return (el && (el.getAttribute("content") || "").trim()) || "";
  }

  function firstMeta(list) {
    for (const sel of list) {
      const v = meta(sel);
      if (v) return v;
    }
    return "";
  }

  // Absolute-ify relative links/images so the markdown survives outside
  // the page. Runs on the detached extraction container, never live DOM.
  function resolveUrls(rootEl) {
    for (const img of rootEl.querySelectorAll("img")) {
      const raw = img.getAttribute("src") ||
        img.getAttribute("data-src") || img.getAttribute("data-original") || "";
      if (!raw) { img.remove(); continue; }
      try { img.setAttribute("src", new URL(raw, location.href).href); }
      catch (_) { /* leave as-is */ }
      img.removeAttribute("srcset");
    }
    for (const a of rootEl.querySelectorAll("a[href]")) {
      const raw = a.getAttribute("href") || "";
      if (raw.startsWith("#") || raw.startsWith("javascript:")) {
        // In-page anchors are meaningless in the clipped doc — keep text only.
        a.removeAttribute("href");
        continue;
      }
      try { a.setAttribute("href", new URL(raw, location.href).href); }
      catch (_) { /* leave as-is */ }
    }
  }

  function makeTurndown() {
    const td = new libs.TurndownService({
      headingStyle: "atx",
      hr: "---",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "*"
    });
    td.use(libs.gfm);
    td.remove(["script", "style", "noscript", "iframe", "object", "embed"]);
    return td;
  }

  function yamlQuote(v) {
    return '"' + String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      .replace(/\r?\n/g, " ").trim() + '"';
  }

  function isoDate(d) {
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function buildFrontmatter(info) {
    const lines = ["---"];
    lines.push("title: " + yamlQuote(info.title || "Untitled"));
    lines.push("source: " + yamlQuote(info.url));
    if (info.author) lines.push("author: " + yamlQuote(info.author));
    if (info.published) lines.push("published: " + yamlQuote(info.published));
    lines.push("created: " + isoDate(new Date()));
    if (info.description) {
      lines.push("description: " + yamlQuote(info.description));
    }
    lines.push("tags:");
    lines.push("  - clippings");
    lines.push("---");
    return lines.join("\n");
  }

  function pageInfo(article) {
    const canonical = document.querySelector('link[rel="canonical"]');
    return {
      title: (article && article.title) || document.title || "Untitled",
      url: (canonical && canonical.href) || location.href,
      author: (article && article.byline) ||
        firstMeta(['meta[name="author"]', 'meta[property="article:author"]']),
      published: (article && article.publishedTime) ||
        firstMeta([
          'meta[property="article:published_time"]',
          'meta[name="date"]',
          'meta[itemprop="datePublished"]'
        ]),
      description: (article && article.excerpt) ||
        firstMeta(['meta[name="description"]', 'meta[property="og:description"]'])
    };
  }

  function clipSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const box = document.createElement("div");
    for (let i = 0; i < sel.rangeCount; i++) {
      box.appendChild(sel.getRangeAt(i).cloneContents());
    }
    if (!box.textContent.trim()) return null;
    resolveUrls(box);
    return { html: box, article: null };
  }

  function clipPage() {
    // Readability mutates its input — always feed it a clone.
    let article = null;
    try {
      article = new libs.Readability(document.cloneNode(true)).parse();
    } catch (e) {
      console.warn("[Baseline clipper] Readability failed:", e);
    }
    const box = document.createElement("div");
    if (article && article.content) {
      box.innerHTML = article.content;
    } else {
      // Last resort: whole body clone (noisy, but never empty-handed).
      box.innerHTML = document.body ? document.body.innerHTML : "";
    }
    resolveUrls(box);
    return { html: box, article };
  }

  self.__bswClip = function (mode) {
    try {
      if (!libs) {
        return { ok: false, error: "clipper libs missing — reload the extension" };
      }
      const got = (mode === "selection" && clipSelection()) || clipPage();
      const info = pageInfo(got.article);
      const body = makeTurndown().turndown(got.html).trim();
      if (!body) return { ok: false, error: "nothing to clip on this page" };

      const markdown =
        buildFrontmatter(info) + "\n\n# " + info.title + "\n\n" + body + "\n";
      const name = (info.title || "clipping")
        .replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim()
        .slice(0, 120) + ".md";
      return { ok: true, markdown, name, title: info.title, url: info.url };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  };
})();
