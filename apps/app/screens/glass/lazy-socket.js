// @ts-check
// The app's box layer answers `socket(path)` with a promise (it waits for the channel), and the page bridge (relay/client/wsbridge.js) wants a WebSocket-shaped object at once. This is that object: it forwards
// to the real socket when it arrives, holds what the page sends meanwhile, and says close when the real socket cannot be had. Pure: node tests it with a fake.

/**
 * @param {(path: string) => Promise<any>} open the box layer's socket @param {string} path
 */
export function lazySocket(open, path) {
  /** @type {any} */ let real = null;
  let closed = false;
  /** @type {any[]} */ const held = [];
  const s = /** @type {any} */ ({
    readyState: 0, binaryType: "arraybuffer", onopen: null, onmessage: null, onerror: null, onclose: null,
    send(/** @type {any} */ data) { if (real) real.send(data); else if (!closed) held.push(data); },
    close(/** @type {number} */ code, /** @type {string} */ reason) { closed = true; held.length = 0; if (real) real.close(code, reason); else s.readyState = 3; },
  });
  Promise.resolve().then(() => open(path)).then(ws => {
    if (closed) { try { ws.close(1000, "closed before it opened"); } catch { /* gone */ } return; }
    real = ws;
    real.binaryType = "arraybuffer";
    real.onopen = (/** @type {any} */ e) => { s.readyState = 1; for (const d of held.splice(0)) real.send(d); if (s.onopen) s.onopen(e); };
    real.onmessage = (/** @type {any} */ e) => { if (s.onmessage) s.onmessage(e); };
    real.onerror = (/** @type {any} */ e) => { if (s.onerror) s.onerror(e); };
    real.onclose = (/** @type {any} */ e) => { s.readyState = 3; if (s.onclose) s.onclose(e); };
    if (real.readyState === 1) real.onopen({});
  }, () => { s.readyState = 3; if (s.onerror) s.onerror({}); if (s.onclose) s.onclose({ code: 1006, reason: "connection lost" }); });
  return s;
}
