/**
 * Bundle @mozilla/readability + turndown (+ GFM plugin) into a classic IIFE
 * for chrome.scripting.executeScript injection (no ESM there).
 *
 * Run: node scripts/bundle-clipper.mjs
 */
import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import path from "path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await esbuild.build({
  entryPoints: [path.join(root, "scripts/clipper-entry.mjs")],
  bundle: true,
  format: "iife",
  globalName: "BaselineClipperLibs",
  outfile: path.join(root, "vendor/clipper.js"),
  platform: "browser",
  target: ["chrome90"],
  minify: true,
  legalComments: "inline",
});

console.log("Wrote vendor/clipper.js");
