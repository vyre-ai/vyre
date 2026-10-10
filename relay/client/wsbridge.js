// @ts-check
// A page in a native WebView reaches a stream on the box (R031-88: the live screen of an agent's computer on a phone). The page is noVNC and opens a WebSocket; a WebView has no route to the box except
// through the app's relay channel, so the page's WebSocket is replaced by a shim that talks to the app, and the app opens the stream on the channel (Connection.socket) and carries the bytes both ways.
//
//   page (shim)  --postMessage-->  app (createWsBridge)  --RelaySocket-->  channel  -->  the box
//
// The page chooses nothing: it names a URL, the app keeps only its path and query (a ticket), refuses any path that is not one of the allowed streams, caps how many sockets a page holds open and how big
// a message is, and never gives the page a header. Bytes cross as base64 in JSON because a WebView message is a string. Plain JavaScript, no dependencies; Node-tested with a fake WebView and a fake socket.

/** The streams a WebView page may open: Glass's screen. Anything else is refused with a close code the page sees. */
export const ALLOWED = Object.freeze([/^\/v1\/streams\/computers\/glass(\?[^\s\0#]*)?$/]);
export const MAX_SOCKETS = 2;
/** A relay frame is 1 MiB with its framing; a message that would not fit is refused before it is sent. */
export const MAX_MESSAGE = (1 << 20) - 64;

const b64 = (/** @type {Uint8Array} */ b) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (/** @type {string} */ s) => { const r = atob(s), b = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) b[i] = r.charCodeAt(i); return b; };

/**
 * The app's side. `open(path)` returns a WebSocket-shaped object (a RelaySocket from `connection.socket(path)`), `post(message)` hands a message to the page.
 * @param {{ open: (path: string) => any, post: (message: any) => void, allowed?: readonly RegExp[], maxSockets?: number }} o
 */
export function createWsBridge(o) {
  const allowed = o.allowed || ALLOWED, maxSockets = o.maxSockets ?? MAX_SOCKETS;
  /** @type {Map<number, any>} */ const socks = new Map();
  const shut = (/** @type {number} */ id, /** @type {number} */ code, /** @type {string} */ reason) => { if (socks.delete(id)) o.post({ t: "close", id, code, reason, wasClean: code === 1000 }); };
  /** The path and query of the page's URL, or null when it is not a stream this page may open. @param {unknown} url */
  const pathOf = url => {
    let u; try { u = new URL(String(url), "http://page.invalid"); } catch { return null; }
    const p = u.pathname + u.search;
    return allowed.some(re => re.test(p)) ? p : null;
  };
  return {
    /** A message from the page (a string from postMessage). @param {unknown} raw */
    fromPage(raw) {
      /** @type {any} */ let m;
      try { m = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return; }
      if (!m || typeof m !== "object" || !Number.isInteger(m.id) || m.id < 1) return;
      const id = m.id;
      if (m.t === "open") {
        if (socks.has(id) || socks.size >= maxSockets) { o.post({ t: "close", id, code: 1013, reason: "too many streams", wasClean: false }); return; }
        const path = pathOf(m.url);
        if (!path) { o.post({ t: "close", id, code: 1008, reason: "that stream is not for a page", wasClean: false }); return; }
        let s;
        try { s = o.open(path); } catch { o.post({ t: "close", id, code: 1006, reason: "connection lost", wasClean: false }); return; }
        socks.set(id, s);
        s.onopen = () => { if (socks.get(id) === s) o.post({ t: "open", id }); };
        s.onmessage = (/** @type {{ data: string | ArrayBuffer }} */ e) => { if (socks.get(id) === s) o.post(typeof e.data === "string" ? { t: "message", id, text: e.data } : { t: "message", id, b64: b64(new Uint8Array(e.data)) }); };
        s.onerror = () => { if (socks.get(id) === s) o.post({ t: "error", id }); };
        s.onclose = (/** @type {{ code: number, reason: string }} */ e) => { if (socks.get(id) === s) shut(id, e.code || 1006, e.reason || ""); };
      } else if (m.t === "send") {
        const s = socks.get(id); if (!s) return;
        /** @type {string | Uint8Array | null} */ let data = null;
        try { data = typeof m.text === "string" ? m.text : typeof m.b64 === "string" ? unb64(m.b64) : null; } catch { data = null; }   // a page that sends bad base64 sends nothing
        if (data === null) return;
        if ((typeof data === "string" ? data.length * 3 : data.length) > MAX_MESSAGE) { try { s.close(1009, "message too big"); } catch { /* closed */ } shut(id, 1009, "message too big"); return; }
        try { s.send(data); } catch { shut(id, 1006, "connection lost"); }
      } else if (m.t === "close") {
        const s = socks.get(id); if (!s) return;
        socks.delete(id);
        try { s.close(Number.isInteger(m.code) ? m.code : 1000, typeof m.reason === "string" ? m.reason.slice(0, 120) : ""); } catch { /* closed */ }
        o.post({ t: "close", id, code: Number.isInteger(m.code) ? m.code : 1000, reason: "", wasClean: true });
      }
    },
    /** The page is gone (the WebView unmounted): close everything it held. */
    closeAll() { for (const [id, s] of [...socks]) { socks.delete(id); try { s.close(1001, "page closed"); } catch { /* closed */ } } },
    get open() { return socks.size; },
  };
}

/**
 * The page's side, as the source of a script to run before the page's own: it replaces WebSocket with a class that talks to the app through window.ReactNativeWebView.postMessage, and defines
 * window.__vyreWs, which the app calls with each message for the page (webview.injectJavaScript(`window.__vyreWs(${JSON.stringify(message)});true;`)).
 */
export function webviewShim() {
  return `(function () {
  if (window.__vyreWs) return;
  var post = function (m) { window.ReactNativeWebView.postMessage(JSON.stringify(m)); };
  var socks = {}, next = 1;
  var toB64 = function (buf) { var b = new Uint8Array(buf), s = ""; for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  var fromB64 = function (s) { var r = atob(s), b = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) b[i] = r.charCodeAt(i); return b.buffer; };
  function VyreWebSocket(url, protocols) {
    this.url = String(url); this.protocol = ""; this.extensions = ""; this.readyState = 0; this.bufferedAmount = 0; this.binaryType = "arraybuffer";
    this.onopen = this.onmessage = this.onclose = this.onerror = null; this._l = {}; this._id = next++;
    socks[this._id] = this;
    post({ t: "open", id: this._id, url: this.url, protocols: protocols });
  }
  VyreWebSocket.CONNECTING = 0; VyreWebSocket.OPEN = 1; VyreWebSocket.CLOSING = 2; VyreWebSocket.CLOSED = 3;
  VyreWebSocket.prototype.CONNECTING = 0; VyreWebSocket.prototype.OPEN = 1; VyreWebSocket.prototype.CLOSING = 2; VyreWebSocket.prototype.CLOSED = 3;
  VyreWebSocket.prototype.send = function (data) {
    if (this.readyState !== 1) throw new Error("InvalidStateError: the socket is not open");
    if (typeof data === "string") post({ t: "send", id: this._id, text: data });
    else if (data instanceof ArrayBuffer) post({ t: "send", id: this._id, b64: toB64(data) });
    else if (ArrayBuffer.isView(data)) post({ t: "send", id: this._id, b64: toB64(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) });
  };
  VyreWebSocket.prototype.close = function (code, reason) {
    if (this.readyState >= 2) return;
    this.readyState = 2; post({ t: "close", id: this._id, code: code, reason: reason });
  };
  VyreWebSocket.prototype.addEventListener = function (type, fn) { (this._l[type] = this._l[type] || []).push(fn); };
  VyreWebSocket.prototype.removeEventListener = function (type, fn) { this._l[type] = (this._l[type] || []).filter(function (f) { return f !== fn; }); };
  VyreWebSocket.prototype.dispatchEvent = function (e) { this._fire(e.type, e); return true; };
  VyreWebSocket.prototype._fire = function (type, e) {
    var h = this["on" + type]; if (typeof h === "function") h.call(this, e);
    (this._l[type] || []).slice().forEach(function (f) { f.call(this, e); }, this);
  };
  window.__vyreWs = function (m) {
    var s = socks[m.id]; if (!s) return;
    if (m.t === "open") { s.readyState = 1; s._fire("open", { type: "open", target: s }); }
    else if (m.t === "message") { if (s.readyState === 1) s._fire("message", { type: "message", target: s, data: typeof m.text === "string" ? m.text : fromB64(m.b64) }); }
    else if (m.t === "error") { s._fire("error", { type: "error", target: s }); }
    else if (m.t === "close") { delete socks[m.id]; s.readyState = 3; s._fire("close", { type: "close", target: s, code: m.code, reason: m.reason || "", wasClean: !!m.wasClean }); }
  };
  window.__NativeWebSocket = window.WebSocket;
  window.WebSocket = VyreWebSocket;
})();`;
}
