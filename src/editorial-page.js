(function () {
  function extractTitle(html) {
    var m = typeof html === "string" && html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return (m && m[1].trim()) || "Editorial";
  }

  function renderHtml(html) {
    document.title = extractTitle(html);
    var empty = document.getElementById("editorial-empty");
    if (empty) empty.remove();
    var iframe = document.querySelector("iframe");
    if (iframe) {
      iframe.srcdoc = html;
    } else {
      iframe = document.createElement("iframe");
      iframe.sandbox = "allow-scripts";
      iframe.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;border:none;margin:0;padding:0";
      iframe.srcdoc = html;
      document.body.style.margin = "0";
      document.body.appendChild(iframe);
    }
  }

  function renderEmpty() {
    document.title = "Editorial";
    if (document.querySelector("iframe") || document.getElementById("editorial-empty")) return;
    document.body.style.cssText = "margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#666;background:#fafafa;";
    var msg = document.createElement("div");
    msg.id = "editorial-empty";
    msg.style.cssText = "text-align:center;padding:24px;font-size:14px;line-height:1.6;";
    msg.textContent = "This editorial preview has expired. Return to the document and generate it again.";
    document.body.appendChild(msg);
  }

  chrome.storage.session.get("editorialHtml", function (result) {
    if (result && typeof result.editorialHtml === "string" && result.editorialHtml) {
      chrome.storage.session.remove("editorialHtml");
      renderHtml(result.editorialHtml);
    } else {
      renderEmpty();
    }
  });

  window.addEventListener("message", function (e) {
    if (e.origin !== location.origin) return;
    if (e.data && e.data.type === "editorial-html" && typeof e.data.html === "string") {
      renderHtml(e.data.html);
    }
  });
})();
