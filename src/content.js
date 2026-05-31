/**
 * Content script entry: detect .md pages, fetch source, hand off to BaselineSurface.
 */

(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    preset: "default",
    mode: "auto",
    width: "standard",
    enabledOnHttp: true,
    mdHintDismissed: false
  };

  const { fileNameFromPageUrl } = window.BaselineShared;

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

  function detectPlatformInstruction() {
    const ua = navigator.userAgent || "";
    if (/Mac OS X|Macintosh/i.test(ua)) {
      return "在 Finder 中右键 .md 文件 → 显示简介 → 打开方式选择当前浏览器 → 点击“全部更改”。";
    }
    if (/Windows/i.test(ua)) {
      return "右键 .md 文件 → 打开方式 → 选择其他应用 → 勾选“始终使用此应用” → 选择当前浏览器。";
    }
    return "在文件管理器中右键 .md 文件 → 属性/打开方式 → 选择当前浏览器并设为默认。";
  }

  function showDefaultOpenerHint() {
    if (location.protocol !== "file:") return;
    if (document.getElementById("bsw-md-hint")) return;

    const card = document.createElement("div");
    card.id = "bsw-md-hint";
    card.setAttribute("role", "status");

    const body = document.createElement("div");
    body.className = "bsw-md-hint-body";

    const title = document.createElement("div");
    title.className = "bsw-md-hint-title";
    title.textContent = "设为默认打开方式";

    const text = document.createElement("p");
    text.className = "bsw-md-hint-text";
    text.textContent = detectPlatformInstruction();

    body.appendChild(title);
    body.appendChild(text);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "bsw-md-hint-close";
    close.setAttribute("aria-label", "关闭");
    close.textContent = "×";

    const dismiss = () => {
      card.classList.add("is-leaving");
      try { chrome.storage.sync.set({ mdHintDismissed: true }); } catch (_) {}
      setTimeout(() => card.remove(), 200);
    };

    close.addEventListener("click", dismiss);
    card.appendChild(body);
    card.appendChild(close);
    document.body.appendChild(card);
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
    if (settings.width === "split") settings.width = "standard";
    return settings;
  }

  async function activate() {
    if (!looksLikeMarkdownDocument()) return;

    const extensionPrefs = await new Promise((resolve) => {
      chrome.storage.sync.get(
        { enabledOnHttp: true, mdHintDismissed: false },
        (items) => resolve(items)
      );
    });
    if (location.protocol !== "file:" && !extensionPrefs.enabledOnHttp) return;

    const source = await fetchRawMarkdown();
    state.originalMarkdown = source;

    window.BaselineSurface.runBoot({
      syncDefaults: DEFAULT_SETTINGS,
      prepareSettings,
      scaffold: { replaceBody: true },
      persistSessionKey: "md:" + location.href,
      initial: { markdown: source, fileName: fileNameFromPageUrl() },
      pickLabel: "打开 Markdown 文件",
      onMainMarkdownChange: (md) => {
        state.originalMarkdown = md;
      },
      getTranslateMarkdown: () => state.originalMarkdown,
      getTranslateSourceName: translateSourceName,
      onAfterBoot: () => {
        if (!extensionPrefs.mdHintDismissed) showDefaultOpenerHint();
      }
    });
  }

  function runActivate() {
    activate().catch((err) => {
      const msg = (err && err.message) || String(err);
      if (msg.includes("Extension context invalidated")) return;
      console.error("[Baseline] activate failed:", err);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runActivate, { once: true });
  } else {
    runActivate();
  }
})();
