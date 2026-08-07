/**
 * Pure builder for viewer tab URL (extracted per strategist rec for testability).
 * Used by translator-bg handler and verified in verify-typography.
 */
function buildViewerTabUrl(fields) {
  const params = new URLSearchParams();
  if (fields && fields.sessionId) params.set("session", fields.sessionId);
  if (fields && fields.sourceName) params.set("name", fields.sourceName);
  if (fields && fields.targetLanguage) params.set("lang", fields.targetLanguage);
  if (fields && fields.preset) params.set("preset", fields.preset);
  if (fields && fields.mode) params.set("mode", fields.mode);
  if (fields && fields.cacheKey) params.set("cacheKey", fields.cacheKey);
  if (fields && fields.editorialMode) params.set("edMode", fields.editorialMode);
  // runtime may be chrome or undefined in test
  const getURL = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL
    : (p) => p;
  return getURL("viewer.html?" + params.toString());
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildViewerTabUrl };
} else {
  (typeof window !== "undefined" ? window : globalThis).ViewerLaunch = { buildViewerTabUrl };
}
