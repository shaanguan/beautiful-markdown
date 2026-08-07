(function () {
  var DESIGN_W = 1280;
  var DESIGN_H = 720;
  var idx = 0;
  var blobUrls = [];
  var fadeTimer = null;

  var stage = document.getElementById("stage");
  var stageWrap = document.getElementById("stage-wrap");
  var frame = document.getElementById("frame");
  var counter = document.getElementById("counter");
  var prevBtn = document.getElementById("prev");
  var nextBtn = document.getElementById("next");
  var fsBtn = document.getElementById("fs");
  var controls = document.getElementById("controls");
  var hint = document.getElementById("hint");
  var loading = document.getElementById("loading");

  function fitStage() {
    var rect = stageWrap.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    var scale = Math.min(rect.width / DESIGN_W, rect.height / DESIGN_H);
    var left = (rect.width - DESIGN_W * scale) / 2;
    var top = (rect.height - DESIGN_H * scale) / 2;
    stage.style.transform = "translate(" + left + "px," + top + "px) scale(" + scale + ")";
  }

  function renderSlide() {
    if (blobUrls.length === 0) {
      counter.textContent = "0 / 0";
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      return;
    }
    if (idx < 0) idx = 0;
    if (idx > blobUrls.length - 1) idx = blobUrls.length - 1;
    frame.src = blobUrls[idx];
    counter.textContent = (idx + 1) + " / " + blobUrls.length;
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx >= blobUrls.length - 1;
    if (loading) loading.hidden = true;
  }

  function go(delta) {
    var next = idx + delta;
    if (next < 0 || next >= blobUrls.length) return false;
    idx = next;
    renderSlide();
    return true;
  }

  function jumpTo(n) {
    if (n < 1 || n > blobUrls.length) return false;
    idx = n - 1;
    renderSlide();
    return true;
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
    } else {
      var root = document.documentElement;
      if (root && root.requestFullscreen) {
        var p = root.requestFullscreen();
        if (p && typeof p.catch === "function") p.catch(function () {});
      }
    }
  }

  function showControls() {
    controls.classList.remove("fade");
    hint.classList.remove("fade");
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(function () {
      controls.classList.add("fade");
      hint.classList.add("fade");
    }, 2000);
  }

  prevBtn.addEventListener("click", function () { go(-1); });
  nextBtn.addEventListener("click", function () { go(1); });
  fsBtn.addEventListener("click", function () { toggleFullscreen(); });

  document.addEventListener("fullscreenchange", function () {
    fsBtn.classList.toggle("active", !!document.fullscreenElement);
  });

  function handleKeydown(e) {
    if (e.key === "ArrowLeft" || e.key === "PageUp") { if (go(-1)) e.preventDefault(); }
    else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { if (go(1)) e.preventDefault(); }
    else if (e.key === "Home") { if (jumpTo(1)) e.preventDefault(); }
    else if (e.key === "End") { if (jumpTo(blobUrls.length)) e.preventDefault(); }
    else if (e.key === "f" || e.key === "F") { toggleFullscreen(); e.preventDefault(); }
    else if (e.key === "Escape") { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); }
    else if (/^[0-9]$/.test(e.key)) {
      var n = parseInt(e.key, 10);
      if (n >= 1 && jumpTo(n)) e.preventDefault();
    }
  }
  document.addEventListener("keydown", handleKeydown);

  function maybeWakeControls(e) {
    if (!e || typeof e.clientY !== "number") return;
    if (e.clientY > window.innerHeight - 200) showControls();
  }
  document.addEventListener("mousemove", maybeWakeControls);

  var shield = document.getElementById("event-shield");
  if (shield) shield.addEventListener("mousemove", maybeWakeControls);

  function bindIframeListeners() {
    try {
      var doc = frame.contentDocument;
      if (!doc) return;
      doc.addEventListener("mousemove", function (e) {
        var rect = frame.getBoundingClientRect();
        if (rect.top + e.clientY > window.innerHeight - 200) showControls();
      });
      doc.addEventListener("keydown", handleKeydown);
    } catch (_) {}
  }
  frame.addEventListener("load", bindIframeListeners);

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(fitStage).observe(stageWrap);
  } else {
    window.addEventListener("resize", fitStage);
  }

  function loadSlides(raw) {
    var slides = raw.split(/\n?=== SLIDE \d+ ===\n?/).filter(Boolean);
    if (slides.length === 0) return;

    var fontBaseUrl = chrome.runtime.getURL("fonts/");
    slides = slides.map(function (html) {
      return html.replace(/\.\.\/fonts\//g, fontBaseUrl);
    });

    blobUrls = slides.map(function (html) {
      return URL.createObjectURL(new Blob([html], { type: "text/html" }));
    });

    idx = 0;
    renderSlide();
  }

  // Read slides data from session storage (written by background)
  chrome.storage.session.get("slidesHtml", function (result) {
    if (result && result.slidesHtml) {
      loadSlides(result.slidesHtml);
      chrome.storage.session.remove("slidesHtml");
    }
    if (loading && blobUrls.length === 0) {
      loading.textContent = "No slides found";
    }
    if (loading && blobUrls.length > 0) {
      loading.hidden = true;
    }
  });

  fitStage();
  showControls();
})();
