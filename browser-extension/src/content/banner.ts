// Content script. Renders a friendly overlay over Chrome's yellow
// "this extension is debugging" banner, plus a Stop button. The script
// performs no capture — CDP does it all from the SW.

const BANNER_ID = "__specialist_capture_banner__";

(function inject() {
  if (document.getElementById(BANNER_ID)) return;
  const root = document.createElement("div");
  root.id = BANNER_ID;
  root.setAttribute(
    "style",
    [
      "position:fixed",
      "top:0",
      "left:0",
      "right:0",
      "z-index:2147483647",
      "padding:6px 12px",
      "background:#1f2937",
      "color:#fff",
      "font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "display:flex",
      "justify-content:space-between",
      "align-items:center",
      "box-shadow:0 1px 4px rgba(0,0,0,.3)",
    ].join(";"),
  );

  const label = document.createElement("span");
  label.textContent = "Specialist Capture is recording this tab.";
  root.appendChild(label);

  const btn = document.createElement("button");
  btn.textContent = "Stop";
  btn.setAttribute(
    "style",
    [
      "background:#ef4444",
      "border:0",
      "color:#fff",
      "padding:4px 10px",
      "border-radius:4px",
      "cursor:pointer",
    ].join(";"),
  );
  btn.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "POPUP_TO_BG_STOP_RECORDING" });
    root.remove();
  });
  root.appendChild(btn);

  document.documentElement.appendChild(root);

  chrome.runtime.onMessage.addListener((msg: { type?: string; state?: string }) => {
    if (msg?.type === "BG_TO_CONTENT_SHOW_BANNER" && msg.state === "stopped") {
      root.remove();
    }
  });
})();
