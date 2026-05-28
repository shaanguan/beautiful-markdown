/**
 * Translator core — pure, environment-agnostic helpers.
 *
 * Lives in both contexts:
 *   - content scripts: loaded via <script> (manifest content_scripts.js)
 *   - service worker:  loaded via importScripts() in translator-bg.js
 *
 * Therefore no DOM, no chrome.* APIs, no window-only globals.
 * Ported (largely verbatim) from obsidian-ai-translator-main/main.ts,
 * which validated the regex pipeline + prompt + fallback heuristics
 * against real notes. Re-deriving these would be wasted work.
 *
 * Exports under `globalThis.BaselineTranslatorCore` so both contexts
 * see the same object regardless of how they loaded the file.
 */

(function (root) {
  "use strict";

  const TOKEN_PREFIX = "@@BSW_AI_TOKEN_";
  const AUTO_LANGUAGE = "自动判断";
  const LANGUAGE_OPTIONS = [
    AUTO_LANGUAGE, "中文", "English", "Español", "Français",
    "Deutsch", "日本語", "한국어", "Português", "Русский"
  ];

  // Google AI Studio model lineup. The default is held in `PRIMARY_MODEL`;
  // the rest are tried in order on transient failure. Keep this list small —
  // a long list means many fallback attempts on a misconfigured key.
  const PRIMARY_MODEL = "gemini-3.5-flash";
  const GOOGLE_MODEL_OPTIONS = [
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite"
  ];

  // OpenAI-compatible default. The user always overrides this from settings;
  // we just need something non-empty so the picker has an initial value.
  const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";
  const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

  // ── Markdown protection / restoration ──────────────────────────────
  //
  // Replace each protected span with `@@BSW_AI_TOKEN_NNNNNN@@`. The model
  // is instructed (via the prompt) to copy these verbatim; we then swap
  // them back. This is more reliable than asking the model to "preserve
  // code blocks" because the prompt-level instruction doesn't always hold,
  // especially on smaller models or RTL languages.
  function protectMarkdown(markdown, preserveBlockquotes) {
    const tokens = {};
    let index = 0;
    let text = String(markdown == null ? "" : markdown);

    const protect = (pattern) => {
      text = text.replace(pattern, (match) => {
        const token = `${TOKEN_PREFIX}${String(index).padStart(6, "0")}@@`;
        tokens[token] = match;
        index += 1;
        return token;
      });
    };

    // Order matters: bigger structural blocks first, so a code fence isn't
    // chewed up by the inline-code regex.
    protect(/^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/);
    protect(/(^|\r?\n)(```|~~~)[\s\S]*?(?:\r?\n\2[^\r\n]*|$)/g);
    protect(/<!--[\s\S]*?-->/g);
    protect(/\$\$[\s\S]*?\$\$/g);

    if (preserveBlockquotes) {
      protect(/(^|\r?\n)(?:[ \t]*>[^\r\n]*(?:\r?\n|$))+/g);
    }

    protect(/!\[\[[^\]\r\n]+\]\]/g);
    protect(/\[\[[^\]\r\n]+\]\]/g);
    protect(/!\[[^\]\r\n]*\]\([^) \r\n]+(?:\s+"[^"]*")?\)/g);
    protect(/\[[^\]\r\n]+\]\([^) \r\n]+(?:\s+"[^"]*")?\)/g);
    protect(/^\s*\[[^\]\r\n]+\]:\s+\S+.*$/gm);
    protect(/\[\^[^\]\r\n]+\]/g);
    protect(/`[^`\r\n]+`/g);
    protect(/\$[^$\r\n]+\$/g);
    protect(/<(?:https?:\/\/|mailto:)[^>\s]+>/g);
    protect(/\bhttps?:\/\/[^\s<>()]+/g);
    protect(/<\/?[A-Za-z][^>\r\n]*>/g);
    // Hashtags (#foo, #中文-tag). Anchored on whitespace or open bracket so
    // we don't eat `#` inside URLs.
    protect(/(^|[\s([{])#[\p{L}\p{N}_/-]+/gu);

    return { text, tokens };
  }

  function restoreProtectedMarkdown(markdown, tokens) {
    let restored = String(markdown == null ? "" : markdown);
    // split/join is correct here (literal string match, no regex escaping).
    for (const token in tokens) {
      restored = restored.split(token).join(tokens[token]);
    }
    return restored;
  }

  function hasTranslatableContent(markdown) {
    const withoutTokens = String(markdown || "")
      .replace(new RegExp(`${TOKEN_PREFIX}\\d{6}@@`, "g"), "");
    return /[\p{L}\p{N}]/u.test(withoutTokens);
  }

  // Strip a stray ```markdown … ``` fence if the model wrapped the answer.
  // We only unwrap when the entire output is one fence — half-wrapped
  // responses would lose content if we tried to be clever.
  function cleanModelOutput(output) {
    const trimmed = String(output || "").trim();
    const fenced = trimmed.match(/^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
    return fenced ? fenced[1] : output;
  }

  // ── Prompt ─────────────────────────────────────────────────────────

  function buildTranslationPrompt(markdown, settings) {
    const sourceLanguage =
      !settings.sourceLanguage || settings.sourceLanguage === AUTO_LANGUAGE
        ? "auto-detect"
        : settings.sourceLanguage;
    const targetLanguage =
      !settings.targetLanguage || settings.targetLanguage === AUTO_LANGUAGE
        ? "a natural target language different from the source language"
        : settings.targetLanguage;

    return [
      "You are a precise Markdown translation engine.",
      `Translate natural-language prose from ${sourceLanguage} to ${targetLanguage}.`,
      "Return only the translated Markdown. Do not add explanations, code fences, titles, or notes.",
      "Preserve the original structure, spacing, line breaks, Markdown syntax, indentation, tables, task lists, headings, and list markers.",
      `Copy placeholder tokens exactly, character for character, whenever they appear. Tokens look like ${TOKEN_PREFIX}000001@@.`,
      "Do not translate code, URLs, file names, wiki links, Markdown links, images, tags, YAML/frontmatter, math, HTML, footnote markers, or protected quoted blocks.",
      "Only translate human-readable prose that is not protected by a placeholder token.",
      "If text is already in the target language, keep it natural and avoid unnecessary rewriting.",
      "",
      "Input:",
      markdown
    ].join("\n");
  }

  // ── Model fallback ─────────────────────────────────────────────────

  function orderSelectedFirst(options, selected) {
    const normalized = String(selected || "").trim();
    if (!normalized || !options.includes(normalized)) return options.slice();
    return [normalized, ...options.filter((o) => o !== normalized)];
  }

  function buildOpenAiChatCompletionsUrl(baseUrl) {
    const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
    return `${trimmed}/chat/completions`;
  }

  // Decide whether the next model in the fallback list should be tried.
  // Don't waste a retry on auth errors — those will fail identically on
  // every model since they're keyed to the API key, not the model name.
  function shouldTryFallback(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/api key|permission_denied|unauthenticated|invalid api key|401|403/i.test(message)) {
      return false;
    }
    return /400|404|429|500|502|503|504|quota|rate|limit|resource_exhausted|unavailable|overload|timeout|deadline|not found|not supported|not available/i.test(message);
  }

  root.BaselineTranslatorCore = {
    TOKEN_PREFIX,
    AUTO_LANGUAGE,
    LANGUAGE_OPTIONS,
    PRIMARY_MODEL,
    GOOGLE_MODEL_OPTIONS,
    OPENAI_DEFAULT_MODEL,
    OPENAI_DEFAULT_BASE_URL,
    protectMarkdown,
    restoreProtectedMarkdown,
    hasTranslatableContent,
    cleanModelOutput,
    buildTranslationPrompt,
    orderSelectedFirst,
    buildOpenAiChatCompletionsUrl,
    shouldTryFallback
  };
})(typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : self));
