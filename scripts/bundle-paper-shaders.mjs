/**
 * Bundle @paper-design/shaders (paper texture bits) into a classic IIFE
 * for the Chrome extension (no ESM in content_scripts).
 *
 * Run: node scripts/bundle-paper-shaders.mjs
 */
import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import path from "path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await esbuild.build({
  entryPoints: [path.join(root, "scripts/paper-shaders-entry.mjs")],
  bundle: true,
  format: "iife",
  globalName: "PaperShaders",
  outfile: path.join(root, "vendor/paper-shaders.js"),
  platform: "browser",
  target: ["chrome90"],
  minify: true,
  legalComments: "inline",
});

console.log("Wrote vendor/paper-shaders.js");
