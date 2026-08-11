/**
 * Paper preset surface — @paper-design/shaders PaperTexture.
 * https://github.com/paper-design/shaders
 *
 * Renders offscreen (preserveDrawingBuffer), then applies a PNG as CSS
 * background. Avoids live-WebGL stacking issues inside the reading view.
 */
(function (root) {
  "use strict";

  const cache = new Map();
  let noiseReady = null;

  function api() {
    return root.PaperShaders || null;
  }

  // Lazy-load vendor/paper-shaders.js — only the Paper preset needs it, so
  // it's no longer shipped eagerly with every page. Same dual path as the
  // renderer's vendor loader: direct <script> on extension pages,
  // background executeScript on content pages.
  let shadersPromise = null;
  function ensureShaders() {
    if (api()) return Promise.resolve();
    if (shadersPromise) return shadersPromise;
    const load = location.protocol === "chrome-extension:"
      ? new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = chrome.runtime.getURL("vendor/paper-shaders.js");
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("Failed to load vendor/paper-shaders.js"));
        document.head.appendChild(s);
      })
      : new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage({ type: "loadVendor", name: "paperShaders" }, (resp) => {
            const err = chrome.runtime.lastError;
            if (err) { reject(new Error(err.message)); return; }
            if (!resp || !resp.ok) {
              reject(new Error((resp && resp.error) || "paper-shaders load failed"));
              return;
            }
            resolve();
          });
        } catch (e) { reject(e); }
      });
    shadersPromise = load.then(() => {
      if (!api()) throw new Error("paper-shaders loaded but PaperShaders is undefined");
    }).catch((err) => {
      shadersPromise = null; // allow retry
      throw err;
    });
    return shadersPromise;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image load failed"));
      img.src = src;
    });
  }

  function getNoiseTexture() {
    const P = api();
    if (!P) return Promise.reject(new Error("PaperShaders missing"));
    if (noiseReady) return noiseReady;
    const raw = P.getShaderNoiseTexture();
    noiseReady = (raw.decode ? raw.decode() : Promise.resolve())
      .then(() => raw)
      .catch(() => loadImage(raw.src));
    return noiseReady;
  }

  function waitFrames(n) {
    return new Promise((resolve) => {
      let left = n;
      const step = () => {
        left -= 1;
        if (left <= 0) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  /**
   * PaperTexture mechanics follow the official defaults; colors match Paper
   * preset 米白微黄 (presets/paper.json) instead of the demo's cool #9fadbc.
   */
  function uniformsFor(dark, imageEl, noiseEl) {
    const P = api();
    // Back = brighter warm sheet; Front = soft warm relief tint.
    const colorBack = dark ? "#2E2923" : "#FFFEFA";
    const colorFront = dark ? "#524536" : "#F5EBDA";
    return {
      u_image: imageEl,
      u_noiseTexture: noiseEl,
      u_colorFront: P.getShaderColorFromString(colorFront),
      u_colorBack: P.getShaderColorFromString(colorBack),
      u_contrast: 0.45,
      u_roughness: 0.55,
      u_fiber: 0.52,
      u_fiberSize: 0.16,
      u_crumples: 0.42,
      u_crumpleSize: 0.3,
      u_folds: 0.8,
      u_foldCount: 6,
      u_fade: 0,
      u_drops: 0.14,
      u_seed: 5.8,
      u_fit: P.ShaderFitOptions.cover,
      u_scale: 0.5,
      u_rotation: 0,
      u_offsetX: 0,
      u_offsetY: 0,
      u_originX: 0.5,
      u_originY: 0.5,
      u_worldWidth: 0,
      u_worldHeight: 0
    };
  }

  /**
   * Bake PaperTexture to a PNG data URL.
   * @param {number} cssW
   * @param {number} cssH
   * @param {boolean} dark
   * @returns {Promise<string>}
   */
  async function bakePaperTextureUrl(cssW, cssH, dark) {
    const P = api();
    if (!P) throw new Error("PaperShaders missing");

    // Match docs example size (1280×720); stretch via CSS to the reading view.
    const w = 1280;
    const h = Math.max(720, Math.min(1600, Math.round((cssH || 720) * (1280 / Math.max(cssW || 1280, 1)))));
    const key = (dark ? "d" : "l") + ":" + w + "x" + h + ":v8-bright";
    if (cache.has(key)) return cache.get(key);

    // Standalone texture (no flowers.webp filter) — same uniforms as the React demo.
    const [imageEl, noiseEl] = await Promise.all([
      loadImage(P.emptyPixel),
      getNoiseTexture()
    ]);

    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    // Keep in-viewport (opacity 0) so layout/ResizeObserver can measure.
    host.style.cssText =
      "position:fixed;left:0;top:0;width:" +
      w +
      "px;height:" +
      h +
      "px;opacity:0;pointer-events:none;overflow:hidden;z-index:-1;";
    document.documentElement.appendChild(host);

    let mount = null;
    try {
      mount = new P.ShaderMount(
        host,
        P.paperTextureFragmentShader,
        uniformsFor(dark, imageEl, noiseEl),
        { alpha: false, antialias: true, preserveDrawingBuffer: true },
        0,
        0
      );

      // ResizeObserver is unreliable for offscreen hosts (and in some
      // extension/file:// timings). Force layout size + a draw.
      mount.parentWidth = w;
      mount.parentHeight = h;
      mount.devicePixelsSupported = false;
      if (typeof mount.setMinPixelRatio === "function") {
        mount.setMinPixelRatio(1.5);
      } else if (typeof mount.handleResize === "function") {
        mount.handleResize();
      }
      if (typeof mount.setFrame === "function") mount.setFrame(0);
      await waitFrames(1);

      const canvas = mount.canvasElement;
      if (!canvas || canvas.width < 2 || canvas.height < 2) {
        throw new Error("PaperTexture canvas has no size (" + (canvas && canvas.width) + "x" + (canvas && canvas.height) + ")");
      }
      const url = canvas.toDataURL("image/png");
      if (!url || url.length < 100) throw new Error("empty paper texture data URL");

      if (cache.size > 4) {
        const first = cache.keys().next().value;
        cache.delete(first);
      }
      cache.set(key, url);
      return url;
    } finally {
      try {
        if (mount) mount.dispose();
      } catch (_) { /* ignore */ }
      try {
        host.remove();
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * Apply baked paper texture onto the reading-view layer.
   * @param {HTMLElement} layer
   * @param {HTMLElement} view
   * @param {{ dark?: boolean }} [opts]
   * @returns {Promise<boolean>}
   */
  async function mountPaperTexture(layer, opts) {
    const view = opts && opts.view;
    const dark = !!(opts && opts.dark);
    if (!layer) return false;
    const token = String(Date.now()) + Math.random();
    layer.dataset.bswPaperMountToken = token;

    try {
      await ensureShaders();
      const cssW = Math.max(
        (view && (view.clientWidth || view.offsetWidth)) || 0,
        layer.clientWidth || 0,
        800
      );
      const cssH = Math.max(
        (view && (view.scrollHeight || view.clientHeight)) || 0,
        layer.clientHeight || 0,
        1200
      );

      const url = await bakePaperTextureUrl(cssW, cssH, dark);
      if (!layer.isConnected || layer.dataset.bswPaperMountToken !== token) {
        return false;
      }

      const cssUrl = 'url("' + url + '")';
      layer.style.backgroundImage = cssUrl;
      layer.style.backgroundRepeat = "no-repeat";
      layer.style.backgroundSize = "100% 100%";
      layer.style.backgroundPosition = "top center";
      // Mark as ready (no live WebGL mount).
      layer.dataset.bswPaperReady = "1";
      if (view) {
        view.style.backgroundImage = cssUrl;
        view.style.backgroundRepeat = "no-repeat";
        view.style.backgroundSize = "100% 100%";
        view.style.backgroundPosition = "top center";
      }
      return true;
    } catch (e) {
      console.warn("[Baseline] PaperTexture bake failed:", e);
      return false;
    }
  }

  function unmountPaperTexture(layer) {
    if (!layer) return;
    try {
      layer.style.removeProperty("background-image");
      layer.style.removeProperty("background-size");
      layer.style.removeProperty("background-repeat");
      layer.style.removeProperty("background-position");
      delete layer.dataset.bswPaperMountToken;
      delete layer.dataset.bswPaperReady;
      layer.querySelectorAll("canvas").forEach((c) => c.remove());
      layer.removeAttribute("data-paper-shader");
    } catch (_) { /* ignore */ }
  }

  root.BaselinePaperTexture = {
    mountPaperTexture,
    unmountPaperTexture,
    bakePaperTextureUrl
  };
})(typeof window !== "undefined" ? window : globalThis);
