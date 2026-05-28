/**
 * Translator service worker (MV3 background).
 *
 * Owns the streaming model call so the API key never rides through the
 * page, and so the long-running fetch survives even if the originating
 * tab closes. Two entry points:
 *
 *   1. chrome.runtime.sendMessage({ type:"registerAndOpen", sessionId,
 *      markdown, settings }) — originating tab stages a session and asks
 *      the worker to open a viewer tab. Worker stores the session keyed
 *      by id and calls chrome.tabs.create(viewer.html?session=id).
 *
 *   2. chrome.runtime.connect({ name:"translator-session" }) → postMessage
 *      { type:"subscribe", sessionId } — viewer tab subscribes. Worker
 *      pops the session (one-shot), starts the translation, and pushes
 *        { type:"chunk", text }   — partial translated markdown (cumulative)
 *        { type:"done",  text }   — final translated markdown (tokens restored)
 *        { type:"error", message } — fatal; port disconnects.
 *
 * Why a service worker (vs. fetching from the page):
 *   - In MV3, page-context fetches hit CORS preflight on
 *     generativelanguage.googleapis.com / api.openai.com, which the
 *     streaming SSE endpoints reject.
 *   - Service worker fetches use the extension origin + declared
 *     host_permissions, so no preflight, and the response body is a real
 *     ReadableStream we can chunk-decode.
 *
 * Port lifecycle: closing the port (viewer side) signals cancellation —
 * we set a flag and abort the in-flight fetch so the user isn't billed
 * for tokens they no longer want.
 */

importScripts("/src/translator-core.js");

const Core = self.BaselineTranslatorCore;

// ── Session map: bridges the originating tab and the viewer tab ────
//
// Translation now lives in a separate viewer tab. The originating tab
// can't postMessage long-running streams to a tab that doesn't exist yet,
// so we stage {markdown, settings} here keyed by a session id. The viewer
// tab subscribes by id once it loads; we delete the entry on subscribe
// (one-shot) so a reload of the viewer URL is a no-op rather than an
// accidental re-translation.
const sessions = new Map();
const SESSION_TTL_MS = 5 * 60 * 1000;

function pruneSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(id);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "loadMermaid") {
    // Content-script renderers can't reach window.mermaid by injecting a
    // <script> (the bundle would land in the page's main world, not the
    // isolated world). Use chrome.scripting.executeScript with `files` —
    // default world is ISOLATED, matching the content script's context.
    if (!sender || !sender.tab) {
      sendResponse({ ok: false, error: "No tab context" });
      return; // sync response — no `return true` needed
    }
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
      files: ["vendor/mermaid.min.js"]
    }).then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({
        ok: false,
        error: (err && err.message) || String(err)
      }));
    return true; // async sendResponse
  }
  if (!msg || msg.type !== "registerAndOpen") return;
  pruneSessions();
  sessions.set(msg.sessionId, {
    markdown: msg.markdown,
    settings: msg.settings,
    createdAt: Date.now()
  });
  // Open the viewer tab as part of the same round-trip so the content
  // script doesn't need its own chrome.tabs permission (content scripts
  // can't call chrome.tabs.create anyway). Source name + language ride
  // along on the URL so the viewer's Edit button can name its download.
  const params = new URLSearchParams();
  params.set("session", msg.sessionId);
  if (msg.sourceName) params.set("name", msg.sourceName);
  if (msg.targetLanguage) params.set("lang", msg.targetLanguage);
  chrome.tabs.create({
    url: chrome.runtime.getURL("viewer.html?" + params.toString())
  }).then(() => sendResponse({ ok: true }))
    .catch((err) => {
      sessions.delete(msg.sessionId);
      sendResponse({ ok: false, error: err && err.message || String(err) });
    });
  return true; // async sendResponse
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "translator-session") handleSessionPort(port);
});

function handleSessionPort(port) {
  let cancelled = false;
  let aborter = null;

  port.onDisconnect.addListener(() => {
    cancelled = true;
    if (aborter) {
      try { aborter.abort(); } catch (_) {}
    }
  });

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "subscribe") return;
    const sess = sessions.get(msg.sessionId);
    if (!sess) {
      safePost(port, {
        type: "error",
        message: "翻译会话已过期或不存在，请重新点击翻译。"
      });
      try { port.disconnect(); } catch (_) {}
      return;
    }
    sessions.delete(msg.sessionId); // one-shot — viewer reload won't re-fire
    // Hand the viewer the original markdown so its bilingual mode can
    // render a left column without re-fetching the source. Cheap (one
    // postMessage); viewers that don't care about bilingual ignore it.
    safePost(port, { type: "original", text: sess.markdown });
    runTranslate(
      { markdown: sess.markdown, settings: sess.settings },
      port,
      {
        isCancelled: () => cancelled,
        registerAborter: (a) => { aborter = a; }
      }
    ).catch((err) => {
      if (cancelled) return;
      safePost(port, { type: "error", message: errorMessage(err) });
      try { port.disconnect(); } catch (_) {}
    });
  });
}

// ── Top-level translation pipeline ─────────────────────────────────

async function runTranslate({ markdown, settings }, port, ctx) {
  const opts = settings || {};

  // Cache check first — same source + same settings → identical output,
  // so we can skip the API round-trip entirely (zero tokens billed) and
  // serve the cached final text. Cache hits look like a single-shot
  // stream from the viewer's perspective (one "done" message), so the
  // bilingual scaffold / Edit button / etc. all light up immediately.
  const key = await cacheKey(markdown, opts);
  if (key) {
    const cached = await readCache(key).catch(() => null);
    if (cached && !ctx.isCancelled()) {
      safePost(port, { type: "done", text: cached });
      touchCache(key).catch(() => {}); // bump LRU; fire-and-forget
      try { port.disconnect(); } catch (_) {}
      return;
    }
  }

  const { text: protectedText, tokens } =
    Core.protectMarkdown(markdown, opts.preserveBlockquotes !== false);

  // Skip the round-trip entirely when there's nothing to translate
  // (e.g. a file that's all code blocks and links). Saves a token bill
  // and avoids odd model behavior on prompts with empty input.
  if (!Core.hasTranslatableContent(protectedText)) {
    safePost(port, { type: "done", text: String(markdown == null ? "" : markdown) });
    try { port.disconnect(); } catch (_) {}
    return;
  }

  const prompt = Core.buildTranslationPrompt(protectedText, opts);
  const provider = opts.provider === "openai" ? "openai" : "google";

  // For Google we cycle through the official model list; for OpenAI-compat
  // we trust the user's choice (they may be pointing at Ollama, OpenRouter,
  // Azure, etc., where our model catalog wouldn't be valid).
  const models = provider === "google"
    ? Core.orderSelectedFirst(Core.GOOGLE_MODEL_OPTIONS, opts.model)
    : [opts.model || Core.OPENAI_DEFAULT_MODEL];

  let lastError = null;
  let modelOutput = "";
  let success = false;
  let usedModel = null;

  for (let i = 0; i < models.length; i++) {
    if (ctx.isCancelled()) return;

    const model = models[i];
    modelOutput = "";

    const aborter = new AbortController();
    ctx.registerAborter(aborter);

    const onChunk = (delta) => {
      if (ctx.isCancelled()) return;
      modelOutput += delta;
      // Restore tokens on EVERY emitted chunk so the user sees the
      // protected segments (code, links, etc.) in their original form
      // as the translation streams in. Cleaning fences here too — the
      // model occasionally opens a ```markdown wrapper mid-stream.
      const partial = Core.restoreProtectedMarkdown(
        Core.cleanModelOutput(modelOutput),
        tokens
      );
      safePost(port, { type: "chunk", text: partial });
    };

    try {
      if (provider === "google") {
        await streamGoogleAiStudio({
          prompt, model, apiKey: opts.apiKey,
          signal: aborter.signal, onChunk
        });
      } else {
        await streamOpenAiCompatible({
          prompt, model, apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
          signal: aborter.signal, onChunk
        });
      }
      success = true;
      usedModel = model;
      break;
    } catch (err) {
      if (ctx.isCancelled()) return;
      lastError = err;
      // Last model in the list — no point continuing.
      if (i === models.length - 1) break;
      // shouldTryFallback bails on auth errors (which would fail identically
      // on every model). Transient/rate-limit/404s do retry the next model.
      if (!Core.shouldTryFallback(err)) break;
    }
  }

  if (ctx.isCancelled()) return;

  if (!success) {
    safePost(port, {
      type: "error",
      message: errorMessage(lastError) || "Translation failed"
    });
    try { port.disconnect(); } catch (_) {}
    return;
  }

  const finalText = Core.restoreProtectedMarkdown(
    Core.cleanModelOutput(modelOutput),
    tokens
  );
  safePost(port, { type: "done", text: finalText });
  // Persist for next time. Fire-and-forget — a storage failure here must
  // never delay or break the viewer's "done" path, and a future cache
  // miss is the worst that can happen.
  if (key) {
    writeCache(key, finalText, {
      provider,
      model: usedModel || "",
      requestedModel: opts.model || ""
    }).catch(() => {});
  }
  try { port.disconnect(); } catch (_) {}
}

// ── Translation cache (chrome.storage.local) ───────────────────────
// Same source markdown + same generation knobs ⇒ identical output. So
// we hash the request shape and serve cached final text on repeat opens
// (e.g. user reloads the viewer tab, or re-translates the same .md a
// week later). Bounded by both entry count and total byte size so we
// don't crowd out other extensions' storage; eviction is LRU.

const CACHE_STORAGE_KEY = "translatorCache";
const CACHE_MAX_ENTRIES = 30;
const CACHE_MAX_BYTES = 5 * 1024 * 1024;

async function cacheKey(markdown, opts) {
  if (!markdown) return "";
  const provider = opts.provider === "openai" ? "openai" : "google";
  const model = opts.model || "";
  const target = opts.targetLanguage || "";
  const preserve = opts.preserveBlockquotes !== false ? "1" : "0";
  // baseUrl matters for OpenAI-compat because users may point at very
  // different model endpoints (Ollama, OpenRouter, Azure) that produce
  // different outputs; for Google it's a fixed endpoint, so omit it.
  const baseUrl = provider === "openai" ? (opts.baseUrl || "") : "";
  //   separator so a value containing a literal newline can't
  // collide with a different shape (e.g. model="foo\nbar" colliding
  // with model="foo" + target="bar").
  const input = [provider, model, target, preserve, baseUrl, markdown]
    .join("\n \n");
  try {
    const buf = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    const bytes = new Uint8Array(hash);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
  } catch (_) {
    return ""; // cache becomes a no-op if SubtleCrypto is unavailable
  }
}

async function readCache(key) {
  if (!key) return null;
  const out = await chrome.storage.local.get(CACHE_STORAGE_KEY);
  const cache = out[CACHE_STORAGE_KEY];
  const entry = cache && cache.entries && cache.entries[key];
  return entry && typeof entry.text === "string" ? entry.text : null;
}

async function touchCache(key) {
  if (!key) return;
  const out = await chrome.storage.local.get(CACHE_STORAGE_KEY);
  const cache = out[CACHE_STORAGE_KEY];
  if (!cache || !Array.isArray(cache.order)) return;
  const idx = cache.order.indexOf(key);
  if (idx < 0) return;
  // Already most-recent — skip the write.
  if (idx === cache.order.length - 1) return;
  cache.order.splice(idx, 1);
  cache.order.push(key);
  await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: cache });
}

async function writeCache(key, text, meta) {
  if (!key || typeof text !== "string") return;
  const out = await chrome.storage.local.get(CACHE_STORAGE_KEY);
  const cache = (out[CACHE_STORAGE_KEY] && typeof out[CACHE_STORAGE_KEY] === "object")
    ? out[CACHE_STORAGE_KEY]
    : { entries: {}, order: [] };
  if (!cache.entries) cache.entries = {};
  if (!Array.isArray(cache.order)) cache.order = [];

  const bytes = byteLength(text);
  cache.entries[key] = {
    text,
    bytes,
    ts: Date.now(),
    provider: meta && meta.provider || "",
    model: meta && meta.model || "",
    requestedModel: meta && meta.requestedModel || ""
  };
  // Re-insert at the tail of the LRU.
  const existing = cache.order.indexOf(key);
  if (existing >= 0) cache.order.splice(existing, 1);
  cache.order.push(key);

  // Evict from the head until within both bounds.
  let totalBytes = 0;
  for (const k of cache.order) {
    const e = cache.entries[k];
    if (e && typeof e.bytes === "number") totalBytes += e.bytes;
  }
  while (
    cache.order.length > CACHE_MAX_ENTRIES ||
    totalBytes > CACHE_MAX_BYTES
  ) {
    if (cache.order.length <= 1) break; // never evict the entry we just wrote
    const oldest = cache.order.shift();
    const e = cache.entries[oldest];
    if (e && typeof e.bytes === "number") totalBytes -= e.bytes;
    delete cache.entries[oldest];
  }

  await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: cache });
}

function byteLength(s) {
  try { return new TextEncoder().encode(s).length; }
  catch (_) { return s.length * 2; } // pessimistic fallback (UTF-16 cap)
}

// ── Google AI Studio (streamGenerateContent) ───────────────────────

async function streamGoogleAiStudio({ prompt, model, apiKey, signal, onChunk }) {
  if (!apiKey) throw new Error("Missing Google AI Studio API key");

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":streamGenerateContent?alt=sse&key=" + encodeURIComponent(apiKey);

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    // Low temperature keeps the translator faithful to wording rather than
    // creative; matches the upstream Obsidian plugin's default.
    generationConfig: { temperature: 0.2 }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const detail = await safeReadText(res);
    throw new Error(
      "Google AI " + res.status + " " + res.statusText +
      (detail ? " — " + detail.slice(0, 400) : "")
    );
  }

  await readSse(res, (data) => {
    if (data === "[DONE]") return;
    let json;
    try { json = JSON.parse(data); } catch (_) { return; }
    const parts = (json && json.candidates && json.candidates[0]
                   && json.candidates[0].content
                   && json.candidates[0].content.parts) || [];
    for (const p of parts) {
      if (typeof p.text === "string" && p.text.length) onChunk(p.text);
    }
  });
}

// ── OpenAI-compatible chat.completions ─────────────────────────────

async function streamOpenAiCompatible({ prompt, model, apiKey, baseUrl, signal, onChunk }) {
  if (!apiKey) throw new Error("Missing API key");

  const url = Core.buildOpenAiChatCompletionsUrl(
    baseUrl || Core.OPENAI_DEFAULT_BASE_URL
  );

  const body = {
    model: model || Core.OPENAI_DEFAULT_MODEL,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    temperature: 0.2
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const detail = await safeReadText(res);
    throw new Error(
      "API " + res.status + " " + res.statusText +
      (detail ? " — " + detail.slice(0, 400) : "")
    );
  }

  await readSse(res, (data) => {
    if (data === "[DONE]") return;
    let json;
    try { json = JSON.parse(data); } catch (_) { return; }
    // Standard OpenAI chunk: choices[0].delta.content
    const delta = json && json.choices && json.choices[0]
                  && json.choices[0].delta && json.choices[0].delta.content;
    if (typeof delta === "string" && delta.length) onChunk(delta);
  });
}

// ── SSE reader ─────────────────────────────────────────────────────
// Both Google AI and OpenAI-compatible endpoints use the SSE wire format:
// events separated by a blank line, each event composed of one or more
// "data: ..." lines whose payloads we join with a newline.

async function readSse(res, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Drain every complete event in the buffer. Event boundary is
      // \n\n (or \r\n\r\n on stricter servers).
      for (;;) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const idx = match.index;
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + match[0].length);
        emitEvent(event, onData);
      }
    }
    // Flush any trailing event without a terminator (some servers cut off
    // the last \n\n on stream close).
    if (buffer.trim()) emitEvent(buffer, onData);
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
}

function emitEvent(event, onData) {
  const dataLines = [];
  for (const line of event.split(/\r?\n/)) {
    // Per SSE spec, "data: foo" — strip the prefix and a single optional space.
    if (line.startsWith("data:")) {
      const v = line.slice(5);
      dataLines.push(v.startsWith(" ") ? v.slice(1) : v);
    }
  }
  if (dataLines.length) onData(dataLines.join("\n"));
}

// ── Misc helpers ───────────────────────────────────────────────────

function safePost(port, msg) {
  try { port.postMessage(msg); } catch (_) { /* port already closed */ }
}

function errorMessage(err) {
  if (!err) return "";
  if (err.name === "AbortError") return "Translation cancelled";
  return err.message ? err.message : String(err);
}

async function safeReadText(res) {
  try { return await res.text(); } catch (_) { return ""; }
}
