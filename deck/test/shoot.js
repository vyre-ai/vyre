// @ts-check
// Screenshots of the Deck with headless Chrome, driven over the DevTools protocol so a shot can
// click through a flow first. A test helper, not part of the product.
//
//   node deck/test/shoot.js <out.png> <url> [width] [height] [script]
//
// script is JavaScript run in the page before the shot; `await wait(ms)` and `click(selector)`
// are defined for it. The page gets 2.5s to settle first. Needs Node 22+ (global WebSocket).
// DUMP=<file> also saves the rendered body markup (for building a board from the real page).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [out, url, w = "1440", hgt = "900", script = ""] = process.argv.slice(2);
if (!out || !url) { console.error("usage: shoot.js out.png url [width] [height] [script]"); process.exit(2); }
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vy-deck-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--use-mock-keychain", "--password-store=basic", "--hide-scrollbars",
  "--no-first-run", "--no-default-browser-check", `--window-size=${w},${hgt}`, "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === "page"); } catch {}
  }
  if (!target) throw new Error("chrome did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = m => {
    const d = JSON.parse(String(m.data));
    if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map(a => a.value ?? a.description).join(" "));
    if (d.method === "Log.entryAdded" && d.params.entry.level === "error") errors.push(d.params.entry.text + " " + (d.params.entry.url || ""));
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const mobile = Number(w) < 700;
  await send("Emulation.setDeviceMetricsOverride", { width: Number(w), height: Number(hgt), deviceScaleFactor: mobile ? 2 : 1, mobile });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.navigate", { url });
  await sleep(2500);
  if (script) {
    const r = await send("Runtime.evaluate", { awaitPromise: true, expression: `(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const click = sel => { const el = document.querySelector(sel); if (!el) throw new Error("no " + sel); el.click(); };
      ${script}
    })()` });
    if (r.result?.exceptionDetails) console.error("script:", r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    await sleep(500);
  }
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  if (process.env.DUMP) {
    const d = await send("Runtime.evaluate", { expression: "document.querySelectorAll('input').forEach(i => { i.setAttribute('value', i.value); if (i.checked) i.setAttribute('checked', ''); }), document.body.innerHTML", returnByValue: true });
    fs.writeFileSync(process.env.DUMP, d.result.result.value);
  }
  for (const e of errors) console.error("page:", e);
  console.log(out);
  ws.close();
} finally {
  chrome.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
