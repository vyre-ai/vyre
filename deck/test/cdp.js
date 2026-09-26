// @ts-check
// A small DevTools-protocol client for the phone shots: attach to a Chrome that is already
// running (CDP=http://127.0.0.1:9422, e.g. a chromedp/headless-shell container on the test box) and
// open one tab per page. A test helper, not part of the product. Needs Node 22+ (global WebSocket).

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/** iOS Safari 18 on an iPhone, so the Deck takes its phone and iOS paths. */
export const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

/**
 * Open a new tab in the Chrome at `cdp`, sized and dressed as a phone.
 * @param {string} cdp e.g. http://127.0.0.1:9422
 * @param {{ width: number, height: number, scale?: number, mobile?: boolean, ua?: string, standalone?: boolean, dark?: boolean }} dev
 */
export async function openTab(cdp, dev) {
  const t = await (await fetch(`${cdp}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  /** @type {string[]} */ const errors = [];
  ws.onmessage = m => {
    const d = JSON.parse(String(m.data));
    if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map((/** @type {any} */ a) => a.value ?? a.description).join(" "));
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  /** @param {string} method @param {any} [params] @returns {Promise<any>} */
  const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const mobile = dev.mobile !== false;
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: dev.width, height: dev.height, deviceScaleFactor: dev.scale ?? 3, mobile });
  if (mobile) {
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
    await send("Emulation.setUserAgentOverride", { userAgent: dev.ua || IPHONE_UA, platform: "iPhone" });
  }
  const features = [{ name: "prefers-color-scheme", value: dev.dark === false ? "light" : "dark" }];
  if (dev.standalone) features.push({ name: "display-mode", value: "standalone" });
  await send("Emulation.setEmulatedMedia", { features });
  // Launched from the home screen, the way iOS Safari says so (this Chrome may not emulate display-mode).
  if (dev.standalone) await send("Page.addScriptToEvaluateOnNewDocument", { source: "Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });" });
  return {
    send, errors,
    /** @param {string} url */
    async go(url, settle = 2000) { await send("Page.navigate", { url }); await sleep(settle); },
    /** Run JS in the page; `wait(ms)`, `click(sel)` and `type(sel, text)` are defined. */
    async run(/** @type {string} */ script) {
      const r = await send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const click = sel => { const el = document.querySelector(sel); if (!el) throw new Error("no " + sel); el.click(); };
        const type = (sel, text) => { const el = document.querySelector(sel); if (!el) throw new Error("no " + sel); el.focus(); el.value = text; el.dispatchEvent(new Event("input", { bubbles: true })); };
        ${script}
      })()` });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
      return r.result?.result?.value;
    },
    /** A real touch drag, as a finger would: start, moves, end. */
    async drag(/** @type {number} */ x, /** @type {number} */ y0, /** @type {number} */ y1, steps = 8) {
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
      for (let i = 1; i <= steps; i++) { await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + (y1 - y0) * i / steps }] }); await sleep(16); }
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    },
    /** @returns {Promise<Buffer>} a PNG of the viewport */
    async shot() { const r = await send("Page.captureScreenshot", { format: "png" }); return Buffer.from(r.result.data, "base64"); },
    async close() { try { await fetch(`${cdp}/json/close/${t.id}`); } catch {} ws.close(); },
  };
}
