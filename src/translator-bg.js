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
const editSessions = new Map();
// Keyed by `${sourceTabId}:${column}` so each (source page, column) pair owns
// at most one editor window. Repeated edit triggers refocus + reposition the
// caret in the existing window instead of spawning duplicates.
const openEditWindows = new Map();
const SESSION_TTL_MS = 5 * 60 * 1000;

function editWindowKey(sourceTabId, column) {
  const tab = sourceTabId == null ? "anon" : String(sourceTabId);
  const col = column == null ? "main" : String(column);
  return tab + ":" + col;
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [key, info] of openEditWindows) {
    if (info && info.windowId === windowId) {
      openEditWindows.delete(key);
      if (info.sessionId) editSessions.delete(info.sessionId);
    }
  }
});

function pruneSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(id);
  }
}

function pruneEditSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of editSessions) {
    if (s.createdAt < cutoff) editSessions.delete(id);
  }
}

// Toolbar icon → open a blank Beautiful Markdown tab. No default_popup is
// set in the manifest, so onClicked fires. The page (open.html) lets the
// user open a local .md or paste markdown and renders it with the same
// theme as a .md file tab.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("open.html") });
});

// ── Right-click「粘贴 Markdown」menu item ──────────────────────────
//
// Restricted to our own pages (.md files via content script, plus the
// extension's open.html and viewer.html tabs). Excludes the "editable"
// context so it doesn't double up with Chrome's native Paste when the
// user right-clicks an actual editable element (e.g. an <input>).
//
// Page side listens for "baselinePasteRequest" and resolves the target
// column from the last contextmenu coordinates (see baseline-shared.js).
const PASTE_MENU_ID = "bsw-paste-here";
const PASTE_MENU_PATTERNS = [
  "file://*/*.md",   "file://*/*.markdown",   "file://*/*.mdown",   "file://*/*.mkd",
  "http://*/*.md",   "http://*/*.markdown",   "http://*/*.mdown",   "http://*/*.mkd",
  "https://*/*.md",  "https://*/*.markdown",  "https://*/*.mdown",  "https://*/*.mkd",
  chrome.runtime.getURL("open.html"),
  chrome.runtime.getURL("viewer.html")
];

function registerPasteMenu() {
  try {
    chrome.contextMenus.remove(PASTE_MENU_ID, () => {
      // Swallow lastError — first run there's nothing to remove.
      void chrome.runtime.lastError;
      chrome.contextMenus.create({
        id: PASTE_MENU_ID,
        title: "Paste Markdown",
        // Include "editable" because the Open/Viewer pages mark their hero as
        // contenteditable (so Chrome offers Paste + ⌘V fires a paste event),
        // which would otherwise hide this menu item there. The page-side
        // handler (toc.js pasteFromClipboard) bails when the right-click
        // target is a real <input>/<textarea>, so we don't stomp on form
        // controls that have their own paste semantics.
        contexts: ["page", "selection", "link", "image", "video", "audio", "frame", "editable"],
        documentUrlPatterns: PASTE_MENU_PATTERNS
      });
    });
  } catch (err) {
    console.warn("[Baseline] registerPasteMenu failed:", err);
  }
}

chrome.runtime.onInstalled.addListener(registerPasteMenu);
chrome.runtime.onStartup.addListener(registerPasteMenu);
// Service-worker first-run after browser load may have neither event yet
// (Chrome lazy-wakes the worker on first message). Idempotent register on
// top-level eval covers that path.
registerPasteMenu();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== PASTE_MENU_ID || !tab || tab.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: "baselinePasteRequest" })
    .catch((err) => console.warn("[Baseline] paste request failed:", err));
});

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
  if (msg && msg.type === "downloadMarkdown") {
    downloadMarkdownToDisk(msg.text, msg.filename)
      .then((path) => sendResponse({ ok: true, path }))
      .catch((err) => sendResponse({
        ok: false,
        error: (err && err.message) || String(err)
      }));
    return true;
  }
  if (msg && msg.type === "openEditTab") {
    pruneEditSessions();
    const selStart = Number.isFinite(msg.selectionStart)
      ? Math.max(0, Math.floor(msg.selectionStart))
      : null;
    const selEnd = selStart != null && Number.isFinite(msg.selectionEnd)
      ? Math.max(selStart, Math.floor(msg.selectionEnd))
      : selStart;
    const sourceTabId = msg.sourceTabId != null
      ? msg.sourceTabId
      : (sender && sender.tab ? sender.tab.id : null);
    const column = msg.column == null ? "main" : String(msg.column);
    const dedupeKey = editWindowKey(sourceTabId, column);
    const scrollRatio = Number(msg.scrollRatio) || 0;
    const scrollOffset = Number(msg.scrollOffset) || 0;
    const scrollOffsetMatched = Boolean(msg.scrollOffsetMatched);

    // If an editor window already exists for this (source tab, column),
    // refocus it and tell the existing editor where to put the caret.
    // Markdown handling: if the source content / filename changed (user
    // navigated to a different .md, or pasted new content), push the new
    // text down so the editor follows. If they match, leave markdown alone
    // so unsaved typing in the textarea survives the re-trigger.
    const existing = openEditWindows.get(dedupeKey);
    if (existing) {
      const newMarkdown = msg.markdown == null ? "" : String(msg.markdown);
      const newName = msg.name == null ? "" : String(msg.name);
      chrome.windows.get(existing.windowId).then((win) => {
        const s = editSessions.get(existing.sessionId);
        const documentChanged = !s
          || s.markdown !== newMarkdown
          || s.name !== newName;
        if (s) {
          if (documentChanged) {
            s.markdown = newMarkdown;
            s.name = newName;
          }
          s.scrollRatio = scrollRatio;
          s.scrollOffset = scrollOffset;
          s.scrollOffsetMatched = scrollOffsetMatched;
          s.selectionStart = selStart;
          s.selectionEnd = selEnd;
          s.createdAt = Date.now();
        }
        chrome.windows.update(existing.windowId, {
          focused: true,
          drawAttention: true
        }).catch(() => {});
        if (existing.tabId != null) {
          const payload = {
            type: "baselineEditReposition",
            sessionId: existing.sessionId,
            selectionStart: selStart,
            selectionEnd: selEnd,
            scrollRatio,
            scrollOffset,
            scrollOffsetMatched
          };
          if (documentChanged) {
            payload.markdown = newMarkdown;
            payload.name = newName;
          }
          chrome.tabs.sendMessage(existing.tabId, payload).catch(() => {});
        }
        sendResponse({ ok: true, sessionId: existing.sessionId, reused: true });
      }).catch(() => {
        // Window vanished between map and lookup (race with onRemoved) —
        // drop the stale entry and fall through by re-dispatching the open.
        openEditWindows.delete(dedupeKey);
        if (existing.sessionId) editSessions.delete(existing.sessionId);
        chrome.runtime.sendMessage(msg).catch(() => {});
        sendResponse({ ok: false, error: "stale window, retrying" });
      });
      return true;
    }

    const sessionId = crypto.randomUUID();
    editSessions.set(sessionId, {
      markdown: msg.markdown == null ? "" : String(msg.markdown),
      name: msg.name == null ? "" : String(msg.name),
      column,
      scrollRatio,
      scrollOffset,
      scrollOffsetMatched,
      selectionStart: selStart,
      selectionEnd: selEnd,
      sourceTabId,
      createdAt: Date.now()
    });
    const params = new URLSearchParams({ session: sessionId });
    if (msg.name) params.set("name", String(msg.name));
    // Popup window (no tab strip, no address bar) — the editor is a tool,
    // not a navigable page, and it should feel like a floating panel.
    // Chrome auto-centers popup windows when left/top are omitted.
    chrome.windows.create({
      url: chrome.runtime.getURL("edit.html?" + params.toString()),
      type: "popup",
      width: 920,
      height: 720,
      focused: true
    }).then((win) => {
      const tabId = win && win.tabs && win.tabs[0] ? win.tabs[0].id : null;
      openEditWindows.set(dedupeKey, {
        windowId: win.id,
        tabId,
        sessionId
      });
      sendResponse({ ok: true, sessionId });
    }).catch((err) => {
      editSessions.delete(sessionId);
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    });
    return true;
  }
  if (msg && msg.type === "getEditSession") {
    const s = editSessions.get(msg.sessionId);
    if (!s) {
      sendResponse({ ok: false, error: "session not found" });
      return;
    }
    sendResponse({
      ok: true,
      markdown: s.markdown,
      name: s.name,
      scrollRatio: s.scrollRatio,
      scrollOffset: s.scrollOffset,
      scrollOffsetMatched: s.scrollOffsetMatched,
      selectionStart: s.selectionStart == null ? null : s.selectionStart,
      selectionEnd: s.selectionEnd == null ? null : s.selectionEnd
    });
    return;
  }
  if (msg && msg.type === "applyEdit") {
    const s = editSessions.get(msg.sessionId);
    if (!s) {
      sendResponse({ ok: false, error: "session not found" });
      return;
    }
    const nextText = msg.text == null ? "" : String(msg.text);
    s.markdown = nextText;
    s.createdAt = Date.now();
    const payload = {
      type: "baselineEditApplied",
      text: nextText,
      name: s.name || "",
      column: s.column || "main",
      targetTabId: s.sourceTabId == null ? null : s.sourceTabId
    };
    // tabs.sendMessage only reaches content scripts (file:// .md). Extension
    // pages (open.html) need runtime.sendMessage; listeners filter targetTabId.
    if (s.sourceTabId != null) {
      chrome.tabs.sendMessage(s.sourceTabId, payload).catch(() => {});
    }
    chrome.runtime.sendMessage(payload).catch(() => {});
    sendResponse({ ok: true });
    return;
  }
  if (msg && msg.type === "openCachedEditorial") {
    var filePath = msg.path;
    var fileUrl = "file://" + filePath;
    if (msg.mode === "slides") {
      fetch(fileUrl).then(r => r.text()).then(text => {
        chrome.storage.session.set({ slidesHtml: text }, () => {
          chrome.tabs.create({ url: chrome.runtime.getURL("slides-player.html") });
        });
        sendResponse({ ok: true });
      }).catch(() => {
        sendResponse({ ok: false });
      });
    } else {
      chrome.tabs.create({ url: fileUrl });
      sendResponse({ ok: true });
    }
    return true;
  }
  if (msg && msg.type === "fetchUrl") {
    fetch(msg.url)
      .then(function (res) { return res.text(); })
      .then(function (text) { sendResponse({ ok: true, text: text }); })
      .catch(function (err) { sendResponse({ ok: false, error: String(err) }); });
    return true;
  }
  if (msg && msg.type === "openExtensionPage") {
    var pageUrl = (msg.page || "").startsWith("file://")
      ? msg.page
      : chrome.runtime.getURL(msg.page);
    chrome.tabs.create({ url: pageUrl });
    return;
  }
  if (msg && msg.type === "downloadEditorial") {
    var dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(msg.html || "");
    chrome.downloads.download({
      url: dataUrl,
      filename: msg.filename || "editorial.html",
      saveAs: false,
      conflictAction: "overwrite"
    }, function (downloadId) {
      if (!downloadId || !msg.cacheKey) return;
      function onDone(delta) {
        if (delta.id !== downloadId) return;
        if (delta.state && delta.state.current === "complete") {
          chrome.downloads.onChanged.removeListener(onDone);
          chrome.downloads.search({ id: downloadId }, function (items) {
            if (items && items[0] && items[0].filename && msg.cacheKey) {
              var obj = {};
              obj[msg.cacheKey] = items[0].filename;
              chrome.storage.local.set(obj);
            }
          });
        }
        if (delta.state && delta.state.current === "interrupted") {
          chrome.downloads.onChanged.removeListener(onDone);
        }
      }
      chrome.downloads.onChanged.addListener(onDone);
    });
    return;
  }
  if (msg && msg.type === "registerAndOpenEditorial") {
    pruneSessions();
    sessions.set(msg.sessionId, {
      markdown: msg.markdown,
      settings: msg.settings,
      mode: "editorial",
      editorialMode: msg.editorialMode || "slides",
      createdAt: Date.now()
    });
    const url = (typeof window !== "undefined" && window.ViewerLaunch && window.ViewerLaunch.buildViewerTabUrl)
    ? window.ViewerLaunch.buildViewerTabUrl(msg)
    : (chrome.runtime.getURL("viewer.html?session=" + msg.sessionId + (msg.preset ? "&preset=" + msg.preset : "")));
  chrome.tabs.create({ url }).then(() => sendResponse({ ok: true }))
    .catch((err) => {
      sessions.delete(msg.sessionId);
      sendResponse({ ok: false, error: err && err.message || String(err) });
    });
  return true;
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
  const url = (typeof window !== "undefined" && window.ViewerLaunch && window.ViewerLaunch.buildViewerTabUrl)
    ? window.ViewerLaunch.buildViewerTabUrl(msg)
    : (chrome.runtime.getURL("viewer.html?session=" + msg.sessionId + (msg.preset ? "&preset=" + msg.preset : "")));
  chrome.tabs.create({ url }).then(() => sendResponse({ ok: true }))
    .catch((err) => {
      sessions.delete(msg.sessionId);
      sendResponse({ ok: false, error: err && err.message || String(err) });
    });
  return true; // async sendResponse
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "translator-session") handleSessionPort(port);
  if (port.name === "editorial-direct") handleEditorialPort(port);
});

function wrapSlidesAsStandalone(raw) {
  var escapedData = JSON.stringify(raw).replace(/<\//g, '<\\/');
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="UTF-8"/>\n<meta name="viewport" content="width=device-width,initial-scale=1"/>\n' +
    '<title>Slides</title>\n<style>\n' +
    ':root{color-scheme:dark}*{box-sizing:border-box}' +
    'html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#fff}' +
    '#stage-wrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}' +
    '#stage{width:1280px;height:720px;transform-origin:center center;background:#000;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.6);position:relative}' +
    '#stage iframe{width:100%;height:100%;border:0;background:#000;display:block}' +
    '#event-shield{position:absolute;inset:0;background:transparent;z-index:5;cursor:default}' +
    '#controls{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);display:flex;' +
    'align-items:center;gap:12px;padding:8px 14px;background:rgba(20,20,20,.78);' +
    'border:1px solid rgba(255,255,255,.12);border-radius:999px;backdrop-filter:blur(12px);' +
    'transition:opacity .25s;opacity:1;z-index:10}' +
    '#controls.fade{opacity:0;pointer-events:none}' +
    '#controls button{width:30px;height:30px;border-radius:50%;border:0;background:rgba(255,255,255,.1);' +
    'color:#fff;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;' +
    'font-size:14px;line-height:1;padding:0}' +
    '#controls button:hover:not(:disabled){background:rgba(255,255,255,.2)}' +
    '#controls button:disabled{opacity:.35;cursor:default}' +
    '#controls button.active{background:rgba(255,255,255,.32)}' +
    '#controls button svg{display:block}' +
    '#counter{font-variant-numeric:tabular-nums;font-size:13px;min-width:64px;text-align:center;user-select:none}' +
    '#hint{position:fixed;right:16px;bottom:16px;font-size:11px;color:rgba(255,255,255,.45);user-select:none;pointer-events:none}' +
    '#hint.fade{opacity:0}' +
    '\n</style>\n</head>\n<body>\n' +
    '<div id="stage-wrap"><div id="stage">' +
    '<iframe id="frame" allow="fullscreen"></iframe>' +
    '<div id="event-shield" aria-hidden="true"></div>' +
    '</div></div>\n' +
    '<div id="controls" role="toolbar">' +
    '<button id="prev" type="button" aria-label="Previous"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 3L5 7L9 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
    '<span id="counter">- / -</span>' +
    '<button id="next" type="button" aria-label="Next"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
    '<button id="fs" type="button" aria-label="Fullscreen"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 5V2H5 M9 2H12V5 M12 9V12H9 M5 12H2V9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
    '</div>\n' +
    '<div id="hint">&larr; &rarr; Space &middot; F fullscreen &middot; Esc exit</div>\n' +
    '<script>\n(function(){\n' +
    'var W=1280,H=720,idx=0,urls=[];\n' +
    'var stage=document.getElementById("stage"),wrap=document.getElementById("stage-wrap"),' +
    'frame=document.getElementById("frame"),counter=document.getElementById("counter"),' +
    'prev=document.getElementById("prev"),next=document.getElementById("next"),' +
    'fs=document.getElementById("fs"),ctrl=document.getElementById("controls"),' +
    'hint=document.getElementById("hint"),ft=null;\n' +
    'function fit(){var r=wrap.getBoundingClientRect();if(!r.width||!r.height)return;' +
    'stage.style.transform="scale("+Math.min(r.width/W,r.height/H)+")"}\n' +
    'function show(){if(!urls.length){counter.textContent="0 / 0";prev.disabled=next.disabled=true;return}' +
    'if(idx<0)idx=0;if(idx>urls.length-1)idx=urls.length-1;' +
    'frame.src=urls[idx];counter.textContent=(idx+1)+" / "+urls.length;' +
    'prev.disabled=idx<=0;next.disabled=idx>=urls.length-1}\n' +
    'function go(d){var n=idx+d;if(n<0||n>=urls.length)return false;idx=n;show();return true}\n' +
    'function jump(n){if(n<1||n>urls.length)return false;idx=n-1;show();return true}\n' +
    'function tfs(){if(document.fullscreenElement){if(document.exitFullscreen)document.exitFullscreen()}' +
    'else{var r=document.documentElement;if(r&&r.requestFullscreen){var p=r.requestFullscreen();' +
    'if(p&&typeof p.catch==="function")p.catch(function(){})}}}\n' +
    'function sc(){ctrl.classList.remove("fade");hint.classList.remove("fade");' +
    'if(ft)clearTimeout(ft);ft=setTimeout(function(){ctrl.classList.add("fade");hint.classList.add("fade")},2000)}\n' +
    'prev.addEventListener("click",function(){go(-1)});\n' +
    'next.addEventListener("click",function(){go(1)});\n' +
    'fs.addEventListener("click",tfs);\n' +
    'document.addEventListener("fullscreenchange",function(){fs.classList.toggle("active",!!document.fullscreenElement)});\n' +
    'function kd(e){if(e.key==="ArrowLeft"||e.key==="PageUp"){if(go(-1))e.preventDefault()}' +
    'else if(e.key==="ArrowRight"||e.key==="PageDown"||e.key===" "){if(go(1))e.preventDefault()}' +
    'else if(e.key==="Home"){if(jump(1))e.preventDefault()}' +
    'else if(e.key==="End"){if(jump(urls.length))e.preventDefault()}' +
    'else if(e.key==="f"||e.key==="F"){tfs();e.preventDefault()}' +
    'else if(e.key==="Escape"){if(document.fullscreenElement&&document.exitFullscreen)document.exitFullscreen()}' +
    'else if(/^[0-9]$/.test(e.key)){var n=parseInt(e.key,10);if(n>=1&&jump(n))e.preventDefault()}}\n' +
    'document.addEventListener("keydown",kd);\n' +
    'document.addEventListener("mousemove",function(e){if(e.clientY>window.innerHeight-200)sc()});\n' +
    'var sh=document.getElementById("event-shield");if(sh)sh.addEventListener("mousemove",function(e){' +
    'var r=frame.getBoundingClientRect();if(r.top+e.clientY>window.innerHeight-200)sc()});\n' +
    'frame.addEventListener("load",function(){try{var d=frame.contentDocument;if(!d)return;' +
    'd.addEventListener("mousemove",function(e){var r=frame.getBoundingClientRect();' +
    'if(r.top+e.clientY>window.innerHeight-200)sc()});d.addEventListener("keydown",kd)}catch(e){}});\n' +
    'if(typeof ResizeObserver!=="undefined")new ResizeObserver(fit).observe(wrap);' +
    'else window.addEventListener("resize",fit);\n' +
    'var raw=' + escapedData + ';\n' +
    'var slides=raw.split(/\\n?=== SLIDE \\d+ ===\\n?/).filter(Boolean);\n' +
    'urls=slides.map(function(h){return URL.createObjectURL(new Blob([h],{type:"text/html"}))});\n' +
    'idx=0;show();fit();sc();\n' +
    '})();\n</script>\n</body>\n</html>';
}

function handleEditorialPort(port) {
  let cancelled = false;
  let aborter = null;

  port.onDisconnect.addListener(() => {
    cancelled = true;
    if (aborter) { try { aborter.abort(); } catch (_) {} }
  });

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "startEditorial") return;
    const ctx = {
      isCancelled: () => cancelled,
      registerAborter: (a) => { aborter = a; }
    };
    runEditorial(
      { markdown: msg.markdown, settings: msg.settings, editorialMode: msg.editorialMode },
      {
        postMessage: (m) => {
          if (cancelled) return;
          if (m.type === "chunk") {
            safePost(port, { type: "chunk", tokens: (m.text || "").length });
          } else if (m.type === "done") {
            var html = m.text || "";
            var isSlides = /=== SLIDE 1 ===/.test(html);
            var sKey = isSlides ? "slidesHtml" : "editorialHtml";
            var page = isSlides ? "slides-player.html" : "editorial.html";
            var sData = {};
            sData[sKey] = html;
            chrome.storage.session.set(sData, () => {
              chrome.tabs.create({ url: chrome.runtime.getURL(page) });
            });
            // Download — wrap in standalone player if slides
            var folders = { slides: "AI Slides", report: "AI Report", dashboard: "AI Dashboard" };
            var folder = folders[msg.editorialMode] || "AI Slides";
            var base = (msg.sourceName || "document").replace(/\.[^.]+$/, "");
            var dlFilename = "Beautiful Markdown/" + folder + "/" + base + ".html";
            var dlHtml = isSlides ? wrapSlidesAsStandalone(html) : html;
            var dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(dlHtml);
            chrome.downloads.download({
              url: dataUrl, filename: dlFilename,
              saveAs: false, conflictAction: "overwrite"
            }, function (downloadId) {
              if (!downloadId || !msg.cacheKey) return;
              function onDl(delta) {
                if (delta.id !== downloadId) return;
                if (delta.state && delta.state.current === "complete") {
                  chrome.downloads.onChanged.removeListener(onDl);
                  chrome.downloads.search({ id: downloadId }, function (items) {
                    if (items && items[0] && items[0].filename && msg.cacheKey) {
                      var obj = {};
                      obj[msg.cacheKey] = items[0].filename;
                      chrome.storage.local.set(obj);
                    }
                  });
                }
                if (delta.state && delta.state.current === "interrupted") {
                  chrome.downloads.onChanged.removeListener(onDl);
                }
              }
              chrome.downloads.onChanged.addListener(onDl);
            });
            safePost(port, { type: "done" });
          } else if (m.type === "heartbeat") {
            // skip
          } else {
            safePost(port, m);
          }
        },
        disconnect: () => {}
      },
      ctx
    ).catch((err) => {
      if (cancelled) return;
      safePost(port, { type: "error", message: errorMessage(err) });
      try { port.disconnect(); } catch (_) {}
    });
  });
}

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
        message: "会话已过期或不存在，请重试。"
      });
      try { port.disconnect(); } catch (_) {}
      return;
    }
    sessions.delete(msg.sessionId); // one-shot — viewer reload won't re-fire
    const ctx = {
      isCancelled: () => cancelled,
      registerAborter: (a) => { aborter = a; }
    };
    if (sess.mode === "editorial") {
      runEditorial(
        { markdown: sess.markdown, settings: sess.settings, editorialMode: sess.editorialMode },
        port, ctx
      ).catch((err) => {
        if (cancelled) return;
        safePost(port, { type: "error", message: errorMessage(err) });
        try { port.disconnect(); } catch (_) {}
      });
    } else {
      safePost(port, { type: "original", text: sess.markdown });
      runTranslate(
        { markdown: sess.markdown, settings: sess.settings },
        port, ctx
      ).catch((err) => {
        if (cancelled) return;
        safePost(port, { type: "error", message: errorMessage(err) });
        try { port.disconnect(); } catch (_) {}
      });
    }
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

  const result = await streamWithModel({
    prompt,
    opts,
    ctx,
    onChunk: (_delta, accum) => {
      // Restore tokens on EVERY emitted chunk so the user sees the
      // protected segments (code, links, etc.) in their original form
      // as the translation streams in. Cleaning fences here too — the
      // model occasionally opens a ```markdown wrapper mid-stream.
      const partial = Core.restoreProtectedMarkdown(
        Core.cleanModelOutput(accum),
        tokens
      );
      safePost(port, { type: "chunk", text: partial });
    }
  });

  if (ctx.isCancelled()) return;

  if (!result.success) {
    safePost(port, {
      type: "error",
      message: errorMessage(result.error) || "Translation failed"
    });
    try { port.disconnect(); } catch (_) {}
    return;
  }

  const finalText = Core.restoreProtectedMarkdown(
    Core.cleanModelOutput(result.output),
    tokens
  );
  safePost(port, { type: "done", text: finalText });
  // Persist for next time. Fire-and-forget — a storage failure here must
  // never delay or break the viewer's "done" path, and a future cache
  // miss is the worst that can happen.
  if (key) {
    const provider = opts.provider === "openai" ? "openai" : "google";
    writeCache(key, finalText, {
      provider,
      model: result.model || "",
      requestedModel: opts.model || ""
    }).catch(() => {});
  }
  try { port.disconnect(); } catch (_) {}
}

// ── Editorial layout pipeline ─────────────────────────────────────
const editorialPromptCache = {};
const EDITORIAL_PROMPT_FILES = {
  slides: "prompts/editorial-layout.md",
  report: "prompts/editorial-report.md",
  dashboard: "prompts/editorial-dashboard.md"
};

async function loadEditorialPrompt(mode) {
  const key = mode || "slides";
  if (editorialPromptCache[key]) return editorialPromptCache[key];
  const file = EDITORIAL_PROMPT_FILES[key] || EDITORIAL_PROMPT_FILES.slides;
  const url = chrome.runtime.getURL(file);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load editorial prompt: " + file);
  editorialPromptCache[key] = await res.text();
  return editorialPromptCache[key];
}

async function runEditorial({ markdown, settings, editorialMode }, port, ctx) {
  const opts = settings || {};
  const systemPrompt = await loadEditorialPrompt(editorialMode);
  const userPrompt =
    "这是自动化调用，跳过方案描述，直接输出完整 HTML。不要用 markdown 代码块包裹，直接输出 HTML 源码。\n\n" +
    "---\n\n" + markdown;

  const result = await streamWithModel({
    prompt: userPrompt,
    systemPrompt,
    opts,
    ctx,
    onChunk: (_delta, accum) => {
      safePost(port, { type: "chunk", text: accum });
    },
    onActivity: () => {
      safePost(port, { type: "heartbeat" });
    }
  });

  if (ctx.isCancelled()) return;

  if (!result.success) {
    safePost(port, {
      type: "error",
      message: errorMessage(result.error) || "Editorial layout failed"
    });
    try { port.disconnect(); } catch (_) {}
    return;
  }

  let html = result.output;
  const fence = html.match(/```(?:html)?\s*\n([\s\S]*?)\n```/);
  if (fence) html = fence[1];

  safePost(port, { type: "done", text: html });
  try { port.disconnect(); } catch (_) {}
}

// ── Generic streaming runner ───────────────────────────────────────
// Both translation (runTranslate) and rewrite (runRewrite) need the
// same provider routing + model fallback + abort plumbing. The only
// per-caller variation is what to do with each accumulated chunk
// (translate restores tokens; rewrite emits the raw partial text).
// onChunk receives both the raw delta and the running accumulator so
// the caller can choose. Returns { success, output, model, error }.
async function streamWithModel({ prompt, systemPrompt, opts, ctx, onChunk, onActivity }) {
  const provider = opts.provider === "openai" ? "openai" : "google";
  const models = provider === "google"
    ? Core.orderSelectedFirst(Core.GOOGLE_MODEL_OPTIONS, opts.model)
    : [opts.model || Core.OPENAI_DEFAULT_MODEL];

  // MV3 service worker keepalive — prevent Chrome from killing the worker
  // during long AI generation pauses (thinking time before first chunk).
  const keepalive = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);

  let lastError = null;
  let output = "";
  let success = false;
  let usedModel = null;

  for (let i = 0; i < models.length; i++) {
    if (ctx.isCancelled()) {
      return { success: false, output: "", model: null, error: null };
    }
    const model = models[i];
    output = "";

    const aborter = new AbortController();
    ctx.registerAborter(aborter);

    const wrappedOnChunk = (delta) => {
      if (ctx.isCancelled()) return;
      output += delta;
      try { onChunk(delta, output); }
      catch (e) { console.warn("[Baseline] onChunk threw:", e); }
    };

    try {
      if (provider === "google") {
        await streamGoogleAiStudio({
          prompt, systemPrompt, model, apiKey: opts.apiKey,
          signal: aborter.signal, onChunk: wrappedOnChunk
        });
      } else {
        await streamOpenAiCompatible({
          prompt, systemPrompt, model, apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
          signal: aborter.signal, onChunk: wrappedOnChunk,
          onActivity: onActivity || null
        });
      }
      success = true;
      usedModel = model;
      break;
    } catch (err) {
      if (ctx.isCancelled()) {
        return { success: false, output: "", model: null, error: null };
      }
      lastError = err;
      // Last model in the list — no point continuing.
      if (i === models.length - 1) break;
      // shouldTryFallback bails on auth errors (which would fail identically
      // on every model). Transient/rate-limit/404s do retry the next model.
      if (!Core.shouldTryFallback(err)) break;
    }
  }

  clearInterval(keepalive);
  if (ctx.isCancelled()) {
    return { success: false, output: "", model: null, error: null };
  }
  return { success, output, model: usedModel, error: lastError };
}

// Read the translator settings blob (mirrors translator-client.js's
// loadSettings shape so the worker doesn't depend on it directly).
const TRANSLATOR_STORAGE_KEY = "translator";
function loadTranslatorSettings() {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get({ [TRANSLATOR_STORAGE_KEY]: {} }, (items) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const stored = items[TRANSLATOR_STORAGE_KEY] || {};
        resolve(stored);
      });
    } catch (e) { reject(e); }
  });
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

async function streamGoogleAiStudio({ prompt, systemPrompt, model, apiKey, signal, onChunk }) {
  if (!apiKey) throw new Error("Missing Google AI Studio API key");

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":streamGenerateContent?alt=sse&key=" + encodeURIComponent(apiKey);

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2 }
  };
  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

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

async function streamOpenAiCompatible({ prompt, systemPrompt, model, apiKey, baseUrl, signal, onChunk, onActivity }) {
  if (!apiKey) throw new Error("Missing API key");

  const url = Core.buildOpenAiChatCompletionsUrl(
    baseUrl || Core.OPENAI_DEFAULT_BASE_URL
  );

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const body = {
    model: model || Core.OPENAI_DEFAULT_MODEL,
    messages,
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
    if (onActivity) { try { onActivity(); } catch (_) {} }
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

function downloadMarkdownToDisk(text, filename) {
  const safeName = String(filename || "document.md")
    .replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, "")
    .replace(/^\.+/, "")
    .trim() || "document.md";
  const dataUrl =
    "data:text/markdown;charset=utf-8," + encodeURIComponent(text == null ? "" : text);

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename: safeName, saveAs: false, conflictAction: "uniquify" },
      (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          reject(new Error(
            (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
            "Could not start download"
          ));
          return;
        }

        const onChanged = (delta) => {
          if (delta.id !== downloadId) return;
          if (delta.state && delta.state.current === "complete") {
            chrome.downloads.onChanged.removeListener(onChanged);
            chrome.downloads.search({ id: downloadId }, (items) => {
              const item = items && items[0];
              if (!item || !item.filename) {
                reject(new Error("Could not resolve downloaded file path"));
                return;
              }
              resolve(item.filename.replace(/\\/g, "/"));
            });
          } else if (delta.state && delta.state.current === "interrupted") {
            chrome.downloads.onChanged.removeListener(onChanged);
            reject(new Error("Download interrupted"));
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);
      }
    );
  });
}
