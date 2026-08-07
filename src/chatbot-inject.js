/**
 * Auto-inject the user's selected text into a Chatbot's input field after
 * the "Ask AI" hand-off (selection-menu.js → askAction).
 *
 * Flow:
 *   1. Originating tab writes { botId, text, ts } to
 *      chrome.storage.local["bswPendingChatbotInject"].
 *   2. Originating tab opens the chatbot URL in a new tab.
 *   3. This script runs on that new tab. If the storage payload is fresh
 *      (≤ 30s) and matches the current host, it polls for the chat input
 *      and types the text via native setter / execCommand("insertText"),
 *      then clears the storage key.
 *
 * The clipboard is also populated by selection-menu.js as a backup, so
 * a manual ⌘V still works if the SPA changes its DOM and our selectors
 * stop matching.
 */

(function () {
  "use strict";

  const STORAGE_KEY = "bswPendingChatbotInject";
  const FRESHNESS_MS = 30 * 1000;
  const POLL_INTERVAL_MS = 200;
  const POLL_TIMEOUT_MS = 12 * 1000;

  function botIdForHost() {
    const h = location.hostname;
    if (h.endsWith("qianwen.com")) return "qianwen";
    if (h.endsWith("deepseek.com")) return "deepseek";
    if (h.endsWith("kimi.com")) return "kimi";
    return null;
  }

  // Heuristic input lookup per chatbot. SPA layouts move things around,
  // so the order of selectors matters: most specific first, then fallbacks.
  function findInput(botId) {
    if (botId === "qianwen") {
      // Qwen (qianwen.com) ships a contenteditable rich text input.
      return (
        document.querySelector('div[role="textbox"][contenteditable="true"]') ||
        document.querySelector('[contenteditable="true"]') ||
        document.querySelector("textarea")
      );
    }
    if (botId === "deepseek") {
      return (
        document.querySelector("textarea#chat-input") ||
        document.querySelector('textarea[placeholder]') ||
        document.querySelector("textarea")
      );
    }
    if (botId === "kimi") {
      return (
        document.querySelector('[role="textbox"][contenteditable="true"]') ||
        document.querySelector('[contenteditable="true"]') ||
        document.querySelector("textarea")
      );
    }
    return null;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 12) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }

  // React/Vue/Lit listen to native `input` events; setting `.value` directly
  // bypasses their internal trackers, so we go through the prototype setter
  // (the "React 16+ trick").
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function injectIntoTextarea(el, text) {
    el.focus();
    setNativeValue(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function injectIntoContentEditable(el, text) {
    el.focus();

    // Strategy 1: synthetic paste event with ClipboardData.
    // Lexical / ProseMirror / Slate / Tiptap all subscribe to `paste` and
    // run it through their internal text-insertion command, which keeps the
    // editor's *model* in sync with the DOM. Without this, frameworks that
    // own the DOM (Qwen and Kimi both ship Lexical) end up with visible
    // text but an empty internal state — the send button stays disabled
    // and further keystrokes are dropped because the editor thinks the
    // user is editing inside a stale selection.
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const ev = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      });
      // dispatchEvent returns false when a listener called preventDefault —
      // for editor paste handlers that's the *expected* path (they handled
      // the insert themselves and synced their model). Treat that as
      // success; otherwise verify by checking the DOM ended up with the
      // text and fall through to the next strategy if not.
      const ret = el.dispatchEvent(ev);
      if (!ret) return;
      if ((el.textContent || "").indexOf(text) !== -1) return;
    } catch (_) {}

    // Strategy 2: execCommand("insertText") — used to be the default; works
    // for plain contenteditable and React-controlled inputs but Lexical
    // may discard if focus state is off.
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      if (document.execCommand("insertText", false, text)) return;
    } catch (_) {}

    // Strategy 3: textContent + InputEvent. Last-resort; most frameworks
    // ignore this for state sync, but the user can ⌘V again.
    el.textContent = text;
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertFromPaste",
        data: text
      })
    );
  }

  function inject(el, text) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      injectIntoTextarea(el, text);
    } else {
      injectIntoContentEditable(el, text);
    }
  }

  function pollAndInject(botId, text) {
    const start = Date.now();
    let done = false;
    const tryOnce = () => {
      if (done) return;
      const el = findInput(botId);
      if (el && isVisible(el)) {
        done = true;
        try { inject(el, text); }
        catch (e) { console.warn("[Baseline] chatbot inject failed:", e); }
        return;
      }
      if (Date.now() - start >= POLL_TIMEOUT_MS) {
        done = true;
        console.warn(
          "[Baseline] chatbot input not found within timeout (botId=" +
            botId +
            "); user can ⌘V from clipboard."
        );
        return;
      }
      setTimeout(tryOnce, POLL_INTERVAL_MS);
    };
    tryOnce();
  }

  function consume() {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
    const myBot = botIdForHost();
    if (!myBot) return;
    chrome.storage.local.get(STORAGE_KEY, (items) => {
      if (chrome.runtime.lastError) return;
      const payload = items && items[STORAGE_KEY];
      if (!payload || !payload.text) return;
      const fresh = Date.now() - (payload.ts || 0) < FRESHNESS_MS;
      if (!fresh || payload.botId !== myBot) return;
      // Clear immediately so a soft reload doesn't re-inject.
      try { chrome.storage.local.remove(STORAGE_KEY); } catch (_) {}
      pollAndInject(myBot, String(payload.text));
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", consume, { once: true });
  } else {
    consume();
  }
})();
