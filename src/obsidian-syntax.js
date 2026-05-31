/**
 * Obsidian-flavored markdown extensions for marked.js.
 *
 * Adds:
 *   - [[wikilink]] and [[wikilink|alias]]
 *   - ![[embed.png]] and ![[note]]
 *   - #tag (inline tag)
 *   - ==highlight== (theme default yellow)
 *   - {c:#0089FF}text{/c}  text color
 *   - {bg:#fff59d}text{/bg} background / custom highlight
 *   - {c:red;bg:#fff59d}text{/c} combined; close tag matches the opener prefix
 *     (so combined always closes with {/c} because the opener starts with c:)
 *   - KaTeX color shim: $\color{X}{Y}\color{X}{Y}...$ chains that exist only
 *     to colorize plain text (no real math inside) are rewritten to spans so
 *     they render as colored text instead of dollar-sign noise in preview.
 *     Bare \color{X}{Y} outside math is also handled.
 *
 * Note: Math ($...$, $$...$$) is intentionally NOT pre-processed here —
 * it's left as plain text so KaTeX auto-render can handle it after the DOM
 * is in place. This avoids fighting with marked's own escaping rules.
 */

(function (root) {
  "use strict";

  // Common `:name:` shortcodes (no extra dependency).
  const EMOJI_SHORTCODES = {
    rocket: "\u{1F680}",
    white_check_mark: "\u2705",
    warning: "\u26A0\uFE0F",
    smile: "\u{1F604}",
    heart: "\u2764\uFE0F",
    thumbsup: "\u{1F44D}",
    thumbsdown: "\u{1F44E}",
    fire: "\u{1F525}",
    star: "\u2B50",
    tada: "\u{1F389}",
    bulb: "\u{1F4A1}",
    memo: "\u{1F4DD}",
    link: "\u{1F517}",
    x: "\u274C",
    heavy_check_mark: "\u2714\uFE0F",
    exclamation: "\u2757",
    question: "\u2753",
    info: "\u2139\uFE0F",
    zap: "\u26A1",
    eyes: "\u{1F440}",
    thinking: "\u{1F914}",
    party: "\u{1F973}",
    sob: "\u{1F62D}",
    joy: "\u{1F602}",
    wink: "\u{1F609}",
    clap: "\u{1F44F}",
    pray: "\u{1F64F}",
    ok_hand: "\u{1F44C}",
    point_right: "\u{1F449}",
    arrow_right: "\u27A1\uFE0F",
    arrow_left: "\u2B05\uFE0F",
    hourglass: "\u231B",
    calendar: "\u{1F4C5}",
    chart_with_upwards_trend: "\u{1F4C8}",
    bug: "\u{1F41B}",
    wrench: "\u{1F527}",
    lock: "\u{1F512}",
    unlock: "\u{1F513}",
    key: "\u{1F511}",
    book: "\u{1F4D6}",
    books: "\u{1F4DA}",
    computer: "\u{1F4BB}",
    email: "\u{1F4E7}",
    phone: "\u{1F4F1}",
    globe: "\u{1F30D}",
    sun: "\u2600\uFE0F",
    moon: "\u{1F319}",
    cloud: "\u2601\uFE0F",
    umbrella: "\u2614",
    snowflake: "\u2744\uFE0F",
    coffee: "\u2615",
    pizza: "\u{1F355}",
    apple: "\u{1F34E}",
    dog: "\u{1F436}",
    cat: "\u{1F431}",
    bird: "\u{1F426}"
  };

  function inlineInner(token) {
    return token.tokens && this.parser && this.parser.parseInline
      ? this.parser.parseInline(token.tokens)
      : escapeHTML(token.text || "");
  }

  /** @type {import('marked').MarkedExtension} */
  const obsidianExtensions = {
    extensions: [
      {
        name: "wikilinkEmbed",
        level: "inline",
        start(src) {
          const i = src.indexOf("![[");
          return i < 0 ? undefined : i;
        },
        tokenizer(src) {
          const m = /^!\[\[([^\]\n]+?)\]\]/.exec(src);
          if (!m) return;
          const [target, ...aliasParts] = m[1].split("|");
          const alias = aliasParts.join("|") || target;
          return {
            type: "wikilinkEmbed",
            raw: m[0],
            target: target.trim(),
            alias: alias.trim()
          };
        },
        renderer(token) {
          const t = escapeAttr(token.target);
          const a = escapeHTML(token.alias);
          // Image-style embeds: keep the look of an inline image placeholder.
          if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(token.target)) {
            return `<span class="internal-embed image-embed" data-href="${t}" data-alt="${a}">📎 ${a}</span>`;
          }
          return `<span class="internal-embed" data-href="${t}">📄 ${a}</span>`;
        }
      },
      {
        name: "wikilink",
        level: "inline",
        start(src) {
          const i = src.indexOf("[[");
          return i < 0 ? undefined : i;
        },
        tokenizer(src) {
          const m = /^\[\[([^\]\n]+?)\]\]/.exec(src);
          if (!m) return;
          const [target, ...aliasParts] = m[1].split("|");
          const alias = aliasParts.join("|") || target;
          return {
            type: "wikilink",
            raw: m[0],
            target: target.trim(),
            alias: alias.trim()
          };
        },
        renderer(token) {
          const t = escapeAttr(token.target);
          const a = escapeHTML(token.alias);
          return `<a class="internal-link" data-href="${t}" href="#${encodeURIComponent(token.target)}">${a}</a>`;
        }
      },
      {
        name: "highlight",
        level: "inline",
        priority: 100,
        start(src) {
          const i = src.indexOf("==");
          return i < 0 ? undefined : i;
        },
        tokenizer(src) {
          // Allow `=` inside the span; closing delimiter must be `==`.
          const m = /^==((?:[^=]|=(?!=))+?)==/.exec(src);
          if (!m) return;
          const text = m[1];
          return {
            type: "highlight",
            raw: m[0],
            text,
            tokens: this.lexer.inlineTokens(text)
          };
        },
        renderer(token) {
          return `<mark>${inlineInner.call(this, token)}</mark>`;
        }
      },
      {
        // GFM in this marked build treats single `~` as strikethrough, which
        // breaks Obsidian-style subscripts. Claim `~~…~~` here (double only).
        name: "strike",
        level: "inline",
        priority: 999,
        start(src) {
          const i = src.indexOf("~~");
          return i < 0 ? undefined : i;
        },
        tokenizer(src) {
          const m = /^~~([^~\n]+?)~~/.exec(src);
          if (!m) return;
          return {
            type: "strike",
            raw: m[0],
            text: m[1],
            tokens: this.lexer.inlineTokens(m[1])
          };
        },
        renderer(token) {
          return `<del>${inlineInner.call(this, token)}</del>`;
        }
      },
      {
        name: "subscript",
        level: "inline",
        priority: 1000,
        start(src) {
          const m = src.match(/~([^~\s][^~]*?)~/);
          if (!m) return undefined;
          const idx = src.indexOf(m[0]);
          if (idx >= 0 && src.slice(idx).startsWith("~~")) return undefined;
          return idx;
        },
        tokenizer(src) {
          if (src.startsWith("~~")) return;
          const m = /^~([^~\s\n][^~]*?)~/.exec(src);
          if (!m) return;
          return {
            type: "subscript",
            raw: m[0],
            text: m[1],
            tokens: this.lexer.inlineTokens(m[1])
          };
        },
        renderer(token) {
          return `<sub>${inlineInner.call(this, token)}</sub>`;
        }
      },
      {
        name: "superscript",
        level: "inline",
        priority: 1000,
        start(src) {
          const m = src.match(/\^([^\s^][^^]*?)\^/);
          return m ? src.indexOf(m[0]) : undefined;
        },
        tokenizer(src) {
          const m = /^\^([^\s\n^][^^]*?)\^/.exec(src);
          if (!m) return;
          return {
            type: "superscript",
            raw: m[0],
            text: m[1],
            tokens: this.lexer.inlineTokens(m[1])
          };
        },
        renderer(token) {
          return `<sup>${inlineInner.call(this, token)}</sup>`;
        }
      },
      {
        name: "emoji",
        level: "inline",
        priority: 90,
        start(src) {
          const m = src.match(/(?:^|[\s([{>"]):([a-z0-9_+-]{2,}):/i);
          if (!m) return undefined;
          const needle = ":" + m[1] + ":";
          return src.indexOf(needle);
        },
        tokenizer(src) {
          const m = /^:([a-z0-9_+-]{2,}):/i.exec(src);
          if (!m) return;
          const glyph = EMOJI_SHORTCODES[m[1].toLowerCase()];
          if (!glyph) return;
          return { type: "emoji", raw: m[0], glyph };
        },
        renderer(token) {
          return token.glyph;
        }
      },
      {
        name: "tag",
        level: "inline",
        // Unicode-aware so CJK / accented tags (#中文标签, #café) render too.
        // Mirrors the hashtag pattern in translator-core's protectMarkdown —
        // previously the tag here was ASCII-only, so a #中文 tag was protected
        // during translation but rendered as raw text in the page.
        start(src) {
          const m = /(^|\s)#[\p{L}\p{N}_/-]/u.exec(src);
          return m ? m.index + (m[1] ? 1 : 0) : undefined;
        },
        tokenizer(src) {
          // Must be at start of input or preceded by whitespace (handled by start()).
          const m = /^#([\p{L}\p{N}_/-]+)/u.exec(src);
          if (!m) return;
          return { type: "tag", raw: m[0], tagName: m[1] };
        },
        renderer(token) {
          const tn = escapeHTML(token.tagName);
          return `<a href="#tag-${tn}" class="tag" data-tag="${tn}">#${tn}</a>`;
        }
      },
      {
        // KaTeX color shim. Many existing docs colorize @mentions/headings
        // by abusing math mode with \color, e.g.
        //   $\color{#0089FF}{@Alice}\color{#0089FF}{@Bob}$
        // KaTeX renders this as math-styled glyphs (wrong font, wrong
        // spacing, parentheses get butchered) and Obsidian falls back to
        // showing the raw source. Intercept the pattern when the entire
        // $...$ contains ONLY \color macros (no actual math) and emit
        // spans. Bare \color{X}{Y} outside math is handled too.
        //
        // Whitelisted via isSafeColor — if any color value is rejected,
        // the token is skipped and the text falls through to KaTeX
        // (or pass-through literal), so a typo never injects CSS.
        name: "katexColorShim",
        level: "inline",
        start(src) {
          const a = src.indexOf("$\\color");
          const b = src.indexOf("\\color");
          if (a < 0 && b < 0) return undefined;
          if (a < 0) return b;
          if (b < 0) return a;
          return a < b ? a : b;
        },
        tokenizer(src) {
          // Case A: $...$ wrapper containing one or more \color{X}{Y}
          // macros and nothing else (whitespace allowed between them).
          // Anything else inside the $...$ → leave it for KaTeX.
          let m = /^\$\s*((?:\\color\s*\{\s*[^{}\n]+?\s*\}\s*\{\s*[^{}\n]+?\s*\}\s*)+)\$/.exec(src);
          if (m) {
            const parts = collectColorParts(m[1]);
            if (!parts) return; // bad color → don't claim, let KaTeX try
            return { type: "katexColorShim", raw: m[0], parts };
          }
          // Case B: bare \color{X}{Y} sitting in regular prose. Only one
          // pair — chains in prose are rare and would already render fine
          // as spans repeated by the user.
          m = /^\\color\s*\{\s*([^{}\n]+?)\s*\}\s*\{\s*([^{}\n]+?)\s*\}/.exec(src);
          if (m) {
            const color = m[1].trim();
            if (!isSafeColor(color)) return;
            return {
              type: "katexColorShim",
              raw: m[0],
              parts: [{ color, text: m[2].trim() }]
            };
          }
        },
        renderer(token) {
          return token.parts.map((p) =>
            `<span style="color:${p.color}">${escapeHTML(p.text)}</span>`
          ).join("");
        }
      },
      {
        // Color / background shorthand: {c:VAL}…{/c}, {bg:VAL}…{/bg},
        // combined {c:VAL;bg:VAL}…{/c}. Close tag matches the OPENER kind,
        // so combined always closes with {/c} (opener starts with c:).
        //
        // Color values are sanitised in parseColorProps() — only #hex,
        // CSS named colors, and rgb()/rgba()/hsl()/hsla() with safe inner
        // chars are accepted. Invalid values cause the token to be rejected
        // (passes through as literal text), so a typo never injects CSS.
        name: "colormark",
        level: "inline",
        start(src) {
          const i = src.indexOf("{c:");
          const j = src.indexOf("{bg:");
          if (i < 0 && j < 0) return undefined;
          if (i < 0) return j;
          if (j < 0) return i;
          return i < j ? i : j;
        },
        tokenizer(src) {
          const m = /^\{(c|bg):([^{}\n]+?)\}/.exec(src);
          if (!m) return;
          const kind = m[1]; // "c" or "bg"
          const props = parseColorProps(m[2], kind);
          if (!props) return; // bad/empty values → not our token
          const closeTag = "{/" + kind + "}";
          // First matching close — nested same-kind pairs aren't supported
          // (rare in practice; users can switch to <span style=…> if needed).
          const closeIdx = src.indexOf(closeTag, m[0].length);
          if (closeIdx < 0) return;
          const inner = src.slice(m[0].length, closeIdx);
          if (!inner) return;
          return {
            type: "colormark",
            raw: src.slice(0, closeIdx + closeTag.length),
            css: props.css,
            // Pre-tokenise inner so the renderer (which has `this.parser`,
            // not `this.lexer`) can just parseInline — matches the highlight
            // extension's pattern above.
            tokens: this.lexer.inlineTokens(inner)
          };
        },
        renderer(token) {
          const inner = this.parser && this.parser.parseInline
            ? this.parser.parseInline(token.tokens)
            : "";
          // Always <span> (not <mark>) so the existing ==highlight== rule
          // keeps owning the theme-yellow look, and combined fg+bg here
          // stay fully under user control with no UA default bleed-through.
          return `<span style="${token.css}">${inner}</span>`;
        }
      }
    ]
  };

  // Allow #abc / #abcd / #aabbcc / #aabbccdd, CSS named colors (letters,
  // optional whitespace), and rgb/rgba/hsl/hsla with digits + commas + %.
  // Anything else is rejected — including `url(...)` and `expression(...)`,
  // which DOMPurify would also strip but we'd rather not produce in the
  // first place.
  function isSafeColor(s) {
    if (typeof s !== "string") return false;
    const v = s.trim();
    if (!v || v.length > 40) return false;
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return true;
    if (/^[a-zA-Z]+$/.test(v)) return true;
    if (/^(?:rgb|hsl)a?\(\s*[\d.,%\s/]+\s*\)$/.test(v)) return true;
    return false;
  }

  // Pull every \color{X}{Y} pair out of an inner blob; return null if any
  // color value is unsafe so the tokenizer can refuse the match entirely
  // (better to render as KaTeX/raw text than to silently drop content).
  function collectColorParts(inner) {
    const re = /\\color\s*\{\s*([^{}\n]+?)\s*\}\s*\{\s*([^{}\n]+?)\s*\}/g;
    const parts = [];
    let m;
    while ((m = re.exec(inner)) !== null) {
      const color = m[1].trim();
      if (!isSafeColor(color)) return null;
      parts.push({ color, text: m[2].trim() });
    }
    return parts.length ? parts : null;
  }

  function parseColorProps(raw, openerKind) {
    let color = null;
    let bg = null;
    const parts = raw.split(";");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      let kind, value;
      const m = /^\s*(c|bg)\s*:\s*(.+?)\s*$/.exec(part);
      if (m) {
        kind = m[1];
        value = m[2];
      } else if (i === 0) {
        // First segment inherits the opener's kind, so the natural form
        // {c:red;bg:#fff59d} reads "color = red, bg = #fff59d" without
        // forcing the user to repeat the prefix.
        const v = part.trim();
        if (!v) continue;
        kind = openerKind;
        value = v;
      } else {
        continue;
      }
      if (!isSafeColor(value)) continue;
      if (kind === "c") color = value.trim();
      else bg = value.trim();
    }
    if (!color && !bg) return null;
    const css = [];
    if (color) css.push("color:" + color);
    if (bg) css.push("background-color:" + bg);
    return { color, background: bg, css: css.join(";") };
  }

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(str) {
    return escapeHTML(str).replace(/'/g, "&#39;");
  }

  root.BaselineObsidianSyntax = { obsidianExtensions };
})(typeof window !== "undefined" ? window : globalThis);
