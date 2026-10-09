#!/usr/bin/env node
// @ts-check
// chip-check: the key chip (keyfind.js and keychip.js) in a real Chrome, on a page we serve, with
// TRUSTED input from the DevTools protocol (Input.dispatchMouseEvent). The vm tests in
// keychip.test.js have no layout, so they cannot see what this does: page CSS fighting the chip,
// a page covering it, a tap before it was visible, and a page printing keys without limit
// (reviewer-2 H-K2, L-K3). The content scripts run as page scripts here with a stub chrome.runtime
// that records what the worker would have been sent; the worker itself is not involved.
//
//   CHROME=/path/to/chrome node modules/vault-extension/testing/chip-check.mjs
//
// Headless, a temp profile, the mock-keychain flags, a local page; nothing leaves the machine.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHROME_SAFE } from "../../../lib/chrome-flags/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, "..");
const CHROME = process.env.CHROME || "/usr/local/bin/vyre-chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => process.stdout.write(`  ${m}\n`);
const keyText = () => `sk-ant-api03-${crypto.randomBytes(24).toString("base64url")}`;

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = m => { const d = JSON.parse(String(m.data)); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (/** @type {string} */ method, /** @type {any} */ params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (/** @type {any} */ d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send("Runtime.enable"); await send("Page.enable"); await send("DOM.enable");
  const run = async (/** @type {string} */ body) => {
    const r = await send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => { ${body} })()` });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, run, close: () => ws.close() };
}

/** The Save or Not now button inside the chip's closed shadow root, found through a pierced DOM walk. */
async function buttonBox(page, label) {
  const { root } = await page.send("DOM.getDocument", { depth: -1, pierce: true });
  /** @type {any} */ let found = null;
  const walk = (/** @type {any} */ n, inChip) => {
    if (found) return;
    const here = inChip || n.nodeName === "VYRE-VAULT-KEY";
    if (here && n.nodeName === "BUTTON" && JSON.stringify(n.children || []).includes(`"${label}"`)) found = n;
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c, here);
  };
  walk(root, false);
  if (!found) return null;
  const { model } = await page.send("DOM.getBoxModel", { backendNodeId: found.backendNodeId });
  const q = model.content;
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

async function tap(page, box) {
  for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-chip-check-"));
  const cleanup = [];
  const teardown = async () => { for (const fn of cleanup.reverse()) { try { await fn(); } catch {} } await sleep(500); try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {} };
  process.on("SIGINT", async () => { await teardown(); process.exit(130); });
  try {
    const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><html><body><main id=m><p>API keys</p></main></body></html>"); });
    await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
    cleanup.push(() => server.close());
    const url = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/`;
    const profile = fs.mkdtempSync(path.join(tmp, "chrome-"));
    const child = spawn(CHROME, ["--headless=new", ...CHROME_SAFE, ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(" ").filter(Boolean) : []),
      "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
    cleanup.push(() => child.kill());
    let port = 0;
    for (let i = 0; i < 150 && !port; i++) { await sleep(100); try { port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {} }
    if (!port) throw new Error(`Chrome did not start (${CHROME})`);
    const base = `http://127.0.0.1:${port}`;
    const keyfind = fs.readFileSync(path.join(DIR, "keyfind.js"), "utf8");
    const keychip = fs.readFileSync(path.join(DIR, "keychip.js"), "utf8");

    /** A fresh page with the content scripts running against a recording stub worker. */
    async function fresh(before = "") {
      const t = await (await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
      const page = await attach(t.webSocketDebuggerUrl);
      cleanup.push(() => { page.close(); return fetch(`${base}/json/close/${t.id}`).catch(() => {}); });
      // A new target starts on about:blank, whose readyState is already "complete": waiting on that alone let the script run before the test page
      // had loaded (#14, document.getElementById("m") was null). Wait for the test page's own element.
      // The wait itself can start on about:blank and have its context destroyed when the navigation commits (v0.2.13 failed there: "Execution context was destroyed"): ask again in the new page.
      for (let attempt = 0; ; attempt++) {
        try {
          await page.run(`await new Promise((r, j) => { const end = Date.now() + 15000; const tick = () => { if (document.readyState === "complete" && document.getElementById("m")) r(); else if (Date.now() > end) j(new Error("the test page never loaded")); else setTimeout(tick, 20); }; tick(); });`);
          break;
        } catch (e) {
          if (attempt >= 5 || !/context was destroyed|Cannot find context|Inspected target navigated/i.test(String(e && e.message))) throw e;
          await sleep(100);
        }
      }
      await page.run(`
        window.__sent = [];
        window.chrome = { runtime: { id: "chip-check", lastError: undefined, sendMessage: (m, cb) => { window.__sent.push(JSON.parse(JSON.stringify(m)));
          setTimeout(() => cb({ "key-raise": { data: { raise: true } }, "key-save": { data: { name: "saved-key", created: true } }, "key-undo": { data: { removed: true } }, "key-dismiss": { data: { dismissed: true } } }[m.type]), 0); } } };
        ${before}
      `);
      await page.run(keyfind);
      await page.run(keychip);
      return page;
    }
    const show = (value, id = "k") => `const c = document.createElement("code"); c.id = "${id}"; c.textContent = "${value}"; (document.getElementById("m") || document.body).append(c);`;
    const sent = page => page.run("return window.__sent.map(m => m.type)");
    const chipUp = page => page.run(`return !!document.querySelector("vyre-vault-key")`);
    const waitChip = async page => { for (let i = 0; i < 200; i++) { if (await chipUp(page)) return; await sleep(10); } throw new Error("the chip never appeared"); };
    const check = (ok, what) => { if (!ok) throw new Error(`FAILED: ${what}`); log(`ok: ${what}`); };

    // A. A tap before the chip has been on screen long enough saves nothing.
    {
      const page = await fresh();
      await page.run(show(keyText()));
      await waitChip(page);
      const box = await buttonBox(page, "Save");
      check(box, "the Save button is found in the closed shadow root");
      await tap(page, box);
      await sleep(300);
      check(!(await sent(page)).includes("key-save"), "A: a tap at once, before the chip was visible long enough, saves nothing");
    }
    // B. Page CSS with !important cannot hide or move the chip, and a normal tap then saves.
    {
      const page = await fresh(`const s = document.createElement("style"); s.textContent = "vyre-vault-key{opacity:0!important;pointer-events:none!important;transform:translateX(-9999px)!important;visibility:hidden!important}"; document.head.append(s);`);
      await page.run(show(keyText()));
      await waitChip(page);
      await sleep(600);
      const cs = await page.run(`const h = document.querySelector("vyre-vault-key"); const c = getComputedStyle(h); return [c.opacity, c.pointerEvents, c.transform, c.visibility];`);
      check(cs[0] === "1" && cs[1] === "auto" && cs[2] === "none" && cs[3] === "visible", `B: page CSS with !important loses to the chip's own (computed ${JSON.stringify(cs)})`);
      const box = await buttonBox(page, "Save");
      await tap(page, box);
      for (let i = 0; i < 30 && !(await sent(page)).includes("key-save"); i++) await sleep(50);
      check((await sent(page)).includes("key-save"), "B: a trusted tap on a chip the page tried to hide still saves");
    }
    // C. A page that covers the chip with its own element makes the tap save nothing.
    {
      const page = await fresh();
      await page.run(show(keyText()));
      await waitChip(page);
      await sleep(600);
      await page.run(`const d = document.createElement("div"); d.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:transparent"; document.documentElement.append(d);`);
      const box = await buttonBox(page, "Save");
      await tap(page, box);
      await sleep(300);
      check(!(await sent(page)).includes("key-save"), "C: a tap on a chip the page covered saves nothing");
      // The click lands on the page's cover, never on the chip: nothing is saved and nothing reaches the worker.
      check(!(await page.run("return JSON.stringify(window.__sent)")).includes("value"), "C: no key went anywhere");
    }
    // D. No tricks: a tap after a beat saves, carrying the key.
    {
      const page = await fresh();
      const value = keyText();
      await page.run(show(value));
      await waitChip(page);
      await sleep(600);
      const box = await buttonBox(page, "Save");
      await tap(page, box);
      for (let i = 0; i < 30 && !(await sent(page)).includes("key-save"); i++) await sleep(50);
      const msgs = await page.run("return window.__sent");
      const saved = msgs.find((/** @type {any} */ m) => m.type === "key-save");
      check(saved && saved.value === value, "D: an ordinary trusted tap saves the key");
      check(!JSON.stringify(msgs.filter((/** @type {any} */ m) => m.type === "key-raise")).includes(value), "D: the key itself was in nothing sent before the tap");
    }
    // E. A page that prints key after key raises a few chips a minute, not one per key.
    {
      const page = await fresh();
      for (let i = 0; i < 8; i++) {
        await page.run(show(keyText(), `k${i}`));
        await sleep(150);
        // The person dismisses each one, so the queue does not hide the cap.
        const no = await buttonBox(page, "Not now");
        if (no) { await sleep(450); await tap(page, no); }
      }
      const raises = (await sent(page)).filter(t => t === "key-raise").length;
      check(raises <= 3, `E: eight keys printed, at most three chips raised (${raises})`);
    }
    log("PASS: the chip resists page CSS, covering, an early tap and a flood, in a real Chrome.");
  } finally {
    await teardown();
  }
}

main().catch(e => { process.stderr.write(`FAIL: ${e.message}\n`); process.exitCode = 1; });
