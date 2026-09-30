// @ts-check
// chrome: one headless Chrome, driven over the DevTools protocol, for scripts/docs-shots. Its
// profile lives in a folder the caller gives (under the test SCRATCH folder) and goes with it.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Start Chrome. `args` are extra flags (a host-resolver rule, say).
 * @param {{ bin: string, dir: string, args?: string[] }} o
 */
export async function launch({ bin, dir, args = [] }) {
  const profile = fs.mkdtempSync(path.join(dir, "chrome-"));
  const child = spawn(bin, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--use-mock-keychain", "--password-store=basic", "--hide-scrollbars", "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-features=HttpsUpgrades,Translate",
    "--force-color-profile=srgb", "--window-size=1280,900", ...args, "about:blank"], { stdio: "ignore" });
  let port = 0;
  for (let i = 0; i < 150 && !port; i++) {
    await sleep(100);
    try { port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {}
  }
  if (!port) { child.kill(); throw new Error(`Chrome did not start (${bin})`); }
  const base = `http://127.0.0.1:${port}`;
  return {
    /** A fresh tab. */
    async page() {
      const t = await (await fetch(`${base}/json/new?about:blank`, { method: "PUT" })).json();
      return open(t.webSocketDebuggerUrl, () => fetch(`${base}/json/close/${t.id}`).catch(() => {}));
    },
    async close() {
      child.kill();
      await new Promise(r => { if (child.exitCode !== null) r(undefined); else { child.once("exit", r); setTimeout(r, 3000); } });
    },
  };
}

/** @param {string} url @param {() => any} closeTab */
async function open(url, closeTab) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  /** @type {string[]} */ const errors = [];
  /** @type {Map<string, (p: any) => void>} */ const handlers = new Map();
  ws.onmessage = m => {
    const d = JSON.parse(String(m.data));
    if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map(a => a.value ?? a.description).join(" "));
    if (d.method === "Log.entryAdded" && d.params.entry.level === "error") errors.push(d.params.entry.text + " " + (d.params.entry.url || ""));
    if (d.method && handlers.has(d.method)) handlers.get(d.method)?.(d.params);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  /** @returns {Promise<any>} */
  const send = (method, params = {}) => new Promise((r, j) => {
    const n = ++id;
    pending.set(n, d => (d.error ? j(new Error(`${method}: ${d.error.message}`)) : r(d.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  // until() evaluates its expression with eval, which a page's own CSP (the onboarding's, the
  // Capsule's) would refuse.
  await send("Page.setBypassCSP", { enabled: true });

  // The helpers every shot script gets.
  const HELPERS = `const wait = ms => new Promise(r => setTimeout(r, ms));
    const until = async (expr, ms = 10000) => { const t0 = Date.now(); for (;;) { let v = false; try { v = eval(expr); } catch {} if (v) return v; if (Date.now() - t0 > ms) throw new Error("never true: " + expr); await wait(100); } };
    const click = sel => { const el = document.querySelector(sel); if (!el) throw new Error("no " + sel); el.click(); };
    const type = (sel, text) => { const el = document.querySelector(sel); if (!el) throw new Error("no " + sel); el.focus(); el.value = text; el.dispatchEvent(new Event("input", { bubbles: true })); };
    const go = p => { history.pushState(null, "", p); window.dispatchEvent(new Event("deck:navigate")); };`;

  const page = {
    errors,
    send,
    on: (method, fn) => handlers.set(method, fn),
    /** Run the body of an async function in the page; its return value comes back. */
    async run(body) {
      const r = await send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => { ${HELPERS}\n${body}\n})()` });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    /** Viewport: CSS size, device scale 2, and a phone's touch and mobile layout when asked. */
    async viewport(width, height, phone = false) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: phone, screenWidth: width, screenHeight: height });
      await send("Emulation.setTouchEmulationEnabled", { enabled: phone, maxTouchPoints: phone ? 5 : 1 });
    },
    async goto(url, settle = 2000) {
      await send("Page.navigate", { url });
      await sleep(settle);
    },
    /** PNG of the viewport, or of a clip in CSS pixels. */
    async png(clip) {
      const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      return Buffer.from(r.data, "base64");
    },
    async close() { try { ws.close(); } catch {} await closeTab(); },
  };
  return page;
}
