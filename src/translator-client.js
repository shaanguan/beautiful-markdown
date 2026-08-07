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
  // Per-provider credential buckets. Each provider keeps its own
  // apiKey/model/baseUrl so switching from Google → OpenAI → Google
  // restores the user's last-saved Google key+model without retyping.
  // Top-level `apiKey`/`model`/`baseUrl` mirror the currently-selected
  // provider's bucket so translator-bg.js (which reads only top-level)
  // stays backward-compatible without an MV3 service-worker rewrite.
  const PROVIDER_DEFAULTS = {
    google: { apiKey: "", model: "gemini-3.5-flash" },
    openai: { apiKey: "", model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" }
  };

  const DEFAULTS = {
    provider: "google",
    apiKey: "",
    model: "gemini-3.5-flash",
    baseUrl: "https://api.openai.com/v1",
    providerCredentials: {
      google: Object.assign({}, PROVIDER_DEFAULTS.google),
      openai: Object.assign({}, PROVIDER_DEFAULTS.openai)
    },
    sourceLanguage: "Auto",
    targetLanguage: "English",
    preserveBlockquotes: true
  };

  // Legacy → canonical migration. Old installs persisted Chinese / native
  // script names (自动判断 / 中文 / Español ...). Map them forward on read
  // so the UI dropdowns (now all English) can find the saved value.
  const LEGACY_LANG_MAP = {
    "自动判断": "Auto",
    "中文":     "Chinese",
    "Español":  "Spanish",
    "Français": "French",
    "Deutsch":  "German",
    "日本語":   "Japanese",
    "한국어":   "Korean",
    "Português":"Portuguese",
    "Русский":  "Russian"
  };
  function normalizeLang(v) {
    if (!v) return v;
    return Object.prototype.hasOwnProperty.call(LEGACY_LANG_MAP, v)
      ? LEGACY_LANG_MAP[v]
      : v;
  }

  // Build a normalized providerCredentials object from stored data.
  // Legacy installs (no providerCredentials field) get the current provider's
  // bucket seeded from the top-level apiKey/model/baseUrl mirror so the user
  // doesn't lose their existing key on upgrade.
  function normalizeProviderCredentials(stored) {
    const out = {
      google: Object.assign({}, PROVIDER_DEFAULTS.google),
      openai: Object.assign({}, PROVIDER_DEFAULTS.openai)
    };
    const raw = stored && stored.providerCredentials;
    if (raw && typeof raw === "object") {
      if (raw.google && typeof raw.google === "object") {
        Object.assign(out.google, raw.google);
      }
      if (raw.openai && typeof raw.openai === "object") {
        Object.assign(out.openai, raw.openai);
      }
    }
    // Migration: seed the current provider's bucket from top-level mirrors
    // when the bucket is empty. Skip if the bucket already has a key — the
    // top-level mirror is just a reflection, never the source of truth.
    const cur = stored && stored.provider;
    if (cur === "google" || cur === "openai") {
      const bucket = out[cur];
      if (!bucket.apiKey && stored.apiKey) bucket.apiKey = stored.apiKey;
      if (!bucket.model && stored.model) bucket.model = stored.model;
      if (cur === "openai" && !bucket.baseUrl && stored.baseUrl) {
        bucket.baseUrl = stored.baseUrl;
      }
    }
    return out;
  }

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ [STORAGE_KEY]: {} }, (items) => {
          const stored = items[STORAGE_KEY] || {};
          const merged = Object.assign({}, DEFAULTS, stored);
          merged.sourceLanguage = normalizeLang(merged.sourceLanguage);
          merged.targetLanguage = normalizeLang(merged.targetLanguage);
          merged.providerCredentials = normalizeProviderCredentials(stored);
          resolve(merged);
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

        // Merge incoming providerCredentials (from buildSettingsView.collect)
        // on top of the existing buckets so per-provider state from inactive
        // tabs is preserved when the user saves with provider=X.
        const incomingBuckets = partial && partial.providerCredentials;
        const baseBuckets = curr.providerCredentials || {};
        next.providerCredentials = {
          google: Object.assign({}, baseBuckets.google, incomingBuckets && incomingBuckets.google),
          openai: Object.assign({}, baseBuckets.openai, incomingBuckets && incomingBuckets.openai)
        };

        // Always keep top-level apiKey/model/baseUrl in sync with the
        // currently-selected provider's bucket so translator-bg.js
        // (which reads only top-level) picks up the right credentials.
        const activeBucket = next.providerCredentials[next.provider];
        if (activeBucket) {
          if (activeBucket.apiKey !== undefined) next.apiKey = activeBucket.apiKey;
          if (activeBucket.model) next.model = activeBucket.model;
          if (activeBucket.baseUrl !== undefined) {
            next.baseUrl = activeBucket.baseUrl;
          }
        }

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
