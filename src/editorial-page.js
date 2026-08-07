(function () {
  chrome.storage.session.get("editorialHtml", function (result) {
    if (result && result.editorialHtml) {
      chrome.storage.session.remove("editorialHtml");
      var iframe = document.createElement("iframe");
      iframe.sandbox = "allow-scripts";
      iframe.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;border:none;margin:0;padding:0";
      iframe.srcdoc = result.editorialHtml;
      document.body.style.margin = "0";
      document.body.appendChild(iframe);
    }
  });

  window.addEventListener("message", function (e) {
    if (e.data && e.data.type === "editorial-html") {
      var iframe = document.querySelector("iframe");
      if (iframe) {
        iframe.srcdoc = e.data.html;
      } else {
        iframe = document.createElement("iframe");
        iframe.sandbox = "allow-scripts";
        iframe.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;border:none;margin:0;padding:0";
        iframe.srcdoc = e.data.html;
        document.body.style.margin = "0";
        document.body.appendChild(iframe);
      }
    }
  });
})();
