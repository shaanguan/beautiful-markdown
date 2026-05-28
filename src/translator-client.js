/**
 * Translator settings store — content-script side.
 *
 * Holds the translator settings layer that both the originating tab
 * (src/content.js) and the viewer tab (src/viewer.js) read at startup
 * and the switcher widget edits. The actual translation streaming
 * lives in the service worker (src/translator-bg.js); the originating
 * tab kicks it off with a chrome.runtime.sendMessage and the viewer
 * tab subscribes to the resulting session over a port.
 *
 * chrome.storage.local (not sync) on purpose: a user's API key should
 * never ride the cloud-sync channel to other devices, and we also
 * sidestep sync's 8KB/item cap.
 *
 * Single export: window.BaselineTranslator.
 */

(function (root) {
  "use strict";

  // Single storage entry keeps related settings atomic — partial writes
  // (e.g. changing target language) can't accidentally clobber the API key.
  const STORAGE_KEY = "translator";

  // `provider`: "google" | "openai"
  //   - google: Google AI Studio (Gemini); `model` from GOOGLE_MODEL_OPTIONS
  //   - openai: any OpenAI-compatible chat.completions endpoint
  //
  // Defaults pick Google + Gemini Flash because:
  //   - Free tier exists, so a user with a fresh API key can try the
  //     feature without thinking about billing.
  //   - Flash is fast on long docs; pro is overkill for translation.
  const DEFAULTS = {
    provider: "google",
    apiKey: "",
    model: "gemini-3.5-flash",
    baseUrl: "https://api.openai.com/v1",
    sourceLanguage: "自动判断",
    targetLanguage: "English",
    preserveBlockquotes: true
  };

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ [STORAGE_KEY]: {} }, (items) => {
          const stored = items[STORAGE_KEY] || {};
          resolve(Object.assign({}, DEFAULTS, stored));
        });
      } catch (_) {
        resolve(Object.assign({}, DEFAULTS));
      }
    });
  }

  function saveSettings(partial) {
    return new Promise((resolve, reject) => {
      loadSettings().then((curr) => {
        const next = Object.assign({}, curr, partial || {});
        try {
          chrome.storage.local.set({ [STORAGE_KEY]: next }, () => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(err.message || "storage set failed"));
            else resolve(next);
          });
        } catch (e) {
          reject(e);
        }
      }, reject);
    });
  }

  root.BaselineTranslator = {
    STORAGE_KEY,
    DEFAULTS,
    loadSettings,
    saveSettings
  };
})(typeof window !== "undefined" ? window : globalThis);
