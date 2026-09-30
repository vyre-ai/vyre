// The matrix's browser driver: one page over the Chrome DevTools Protocol. The same code drives
// desktop Chrome (any OS) and Chrome on Android (adb forward to chrome_devtools_remote). Node 22's
// own WebSocket and fetch, no dependency.

/**
 * @param {string} base the DevTools HTTP endpoint, for example http://127.0.0.1:9222
 * @param {{ width?: number, height?: number, mobile?: boolean, scale?: number }} [view]
 */
export async function connect(base, view = {}) {
  const version = await (await fetch(base + "/json/version")).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const wait = new Map(), logs = [], listeners = new Set();
  ws.onmessage = m => {
    const d = JSON.parse(String(m.data));
    if (d.id && wait.has(d.id)) {
      const w = wait.get(d.id); wait.delete(d.id);
      d.error ? w.reject(new Error(`${w.method}: ${JSON.stringify(d.error)}`)) : w.resolve(d.result);
      return;
    }
    if (d.method === "Runtime.exceptionThrown") logs.push("exception: " + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    else if (d.method === "Log.entryAdded") logs.push(`${d.params.entry.level}: ${d.params.entry.text} ${d.params.entry.url || ""}`.trim());
    else if (d.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(d.params.type)) logs.push(`console.${d.params.type}: ` + d.params.args.map(a => a.value ?? a.description).join(" "));
    for (const l of listeners) l(d);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id;
    wait.set(i, { resolve, reject, method });
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method, params) => send(method, params, sessionId);
  await s("Page.enable"); await s("Runtime.enable"); await s("Log.enable");
  if (view.width) await s("Emulation.setDeviceMetricsOverride", { width: view.width, height: view.height || 900, deviceScaleFactor: view.scale || 1, mobile: Boolean(view.mobile) });

  const evaluate = async expr => {
    const r = await s("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return {
    logs,
    send: s,
    evaluate,
    /** Open a URL; resolve with the main document's HTTP status once it has loaded. */
    async open(url, timeoutMs = 30000) {
      let status = 0;
      const seen = d => { if (d.method === "Network.responseReceived" && d.sessionId === sessionId && d.params.type === "Document") status = d.params.response.status; };
      listeners.add(seen);
      await s("Network.enable");
      const loaded = new Promise(resolve => {
        const l = d => { if (d.method === "Page.loadEventFired" && d.sessionId === sessionId) { listeners.delete(l); resolve(undefined); } };
        listeners.add(l);
      });
      await s("Page.navigate", { url });
      await Promise.race([loaded, new Promise(r => setTimeout(r, timeoutMs))]);
      listeners.delete(seen);
      return status;
    },
    /** Wait until the page's text matches, or time out; returns the text either way. */
    async waitText(re, timeoutMs = 20000) {
      const until = Date.now() + timeoutMs;
      let text = "";
      while (Date.now() < until) {
        text = String(await evaluate("document.body ? document.body.innerText : ''"));
        if (re.test(text)) break;
        await new Promise(r => setTimeout(r, 250));
      }
      return text;
    },
    /** A PNG of the viewport, as a Buffer. */
    async shot() { return Buffer.from((await s("Page.captureScreenshot", { format: "png" })).data, "base64"); },
    async close() { try { await send("Target.closeTarget", { targetId }); } catch {} ws.close(); },
  };
}
