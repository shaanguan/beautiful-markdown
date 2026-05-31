#!/usr/bin/env node
/**
 * Regression checks for markdown inline extensions + images.
 * Usage: node scripts/verify-renderer.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");

function load(rel, ctx) {
  vm.runInNewContext(fs.readFileSync(path.join(root, rel), "utf8"), ctx, {
    filename: rel
  });
}

const ctx = { window: {}, console };
ctx.window = ctx;
load("vendor/marked.min.js", ctx);
load("vendor/purify.min.js", ctx);
ctx.DOMPurify = ctx.DOMPurify || ctx.window.DOMPurify;
ctx.hljs = {
  getLanguage: () => false,
  highlight: () => ({ value: "" }),
  highlightAuto: () => ({ value: "" })
};
ctx.renderMathInElement = () => {};
load("src/obsidian-syntax.js", ctx);
load("src/renderer.js", ctx);

const fixture = fs.readFileSync(
  path.join(root, "fixtures/markdown-renderer-test.md"),
  "utf8"
);

const html = ctx.BaselineRenderer
  ? (() => {
    const mount = { innerHTML: "", querySelectorAll: () => [] };
    return ctx.marked.parse(fixture);
  })()
  : ctx.marked.parse(fixture);

const checks = [
  ["image https", /<img[^>]+src="https:\/\/picsum\.photos/i],
  ["highlight", /<mark>highlighted text<\/mark>/],
  ["highlight equals", /<mark>with=equals inside<\/mark>/],
  ["subscript", /H<sub>2<\/sub>O/],
  ["superscript", /x<sup>2<\/sup>/],
  ["strikethrough", /<del>deleted<\/del>/],
  ["emoji rocket", /\u{1F680}/u],
  ["emoji check", /\u2705/],
  ["emoji warning", /\u26A0/u],
  ["no raw shortcode", () => !/:rocket:/.test(html)],
  ["mark html", /<mark>mark tag<\/mark>/]
];

let failed = 0;
for (const [name, pred] of checks) {
  const ok = typeof pred === "function" ? pred(html) : pred.test(html);
  if (!ok) {
    failed++;
    console.error("FAIL:", name);
  } else {
    console.log("ok:", name);
  }
}

if (failed) {
  console.error("\n" + failed + " check(s) failed");
  process.exit(1);
}
console.log("\nAll renderer checks passed.");
