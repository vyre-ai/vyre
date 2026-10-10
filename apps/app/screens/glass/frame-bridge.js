// @ts-check
// The phone's half of the Glass frame's wire (src/glass/frame.js): the page runs in a WebView, so what the app tells it travels as a script the WebView runs, and what the page says comes back as a string.
// Pure: node tests both ends against a fake window.

/** The script that delivers one message from the app to the frame page: a `message` event carrying the data, marked as the host's. @param {Record<string, unknown>} m */
export function toPage(m) {
  return `(function(){var e=new Event("message");Object.defineProperty(e,"data",{value:${JSON.stringify({ ...m, __host: true })}});window.dispatchEvent(e);})();true;`;
}

/** What the page said, from the WebView's string, or null when it is not a message of ours. @param {unknown} raw */
export function fromPage(raw) {
  try {
    const m = JSON.parse(String(raw));
    return m && typeof m === "object" && !Array.isArray(m) && typeof m.t === "string" ? m : null;
  } catch { return null; }
}
