#!/usr/bin/env node
// @ts-check
// browser-check: loads the packaged extension into a real Chromium (testbox, headless=new;
// never the Mac someone is using) and drives it over the DevTools protocol: the popup renders
// against real chrome.* APIs (not the vm-and-fake-chrome stubs extension.test.js uses), pairs
// against a real fill listener, and fills a real login into a real page. What the manifest-only
// and HTTP-contract tests cannot see (docs/work/vault.md "Next" #4 / 0.1.1 #9).
//
// Everything lives under a temp folder and is torn down on the way out, Ctrl-C included: a
// static page server, the Fill HTTP listener, a temp Vault, and Chrome's own profile. No value
// is printed; the login's password is only ever compared as a SHA-256.
//
//   node modules/vault-extension/testing/browser-check.mjs
//
// Runs on testbox at $CHROME (default /usr/local/bin/vyre-chrome), one Chrome at a time (RULES).

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open, migrate } from "../../../core/store/index.js";
import { CHROME_SAFE } from "../../../lib/chrome-flags/index.js";
import { Vault, MIGRATIONS } from "../../../core/vault/vault.js";
import { Fill, serveFill } from "../../../core/vault/fill.js";
import { build } from "../build.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const CHROME = process.env.CHROME || "/usr/local/bin/vyre-chrome";
const canary = () => `fixture-canary-${crypto.randomBytes(12).toString("hex")}`;
const sha = v => crypto.createHash("sha256").update(v).digest("hex");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => process.stdout.write(`  ${m}\n`);

/** A one-page static site: a login form, nothing else. */
function servePage() {
  const html = `<!doctype html><html><body>
    <form><input id="u" name="username" autocomplete="username"><input id="p" name="password" type="password" autocomplete="current-password"></form>
  </body></html>`;
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = /** @type {any} */ (server.address()); resolve({ server, port, url: `http://127.0.0.1:${port}/` }); });
  });
}

/** Minimal CDP over one target's own devtools websocket, enough to navigate, evaluate and wait. */
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  /** @type {string[]} */ const errors = [];
  ws.onmessage = m => {
    const d = JSON.parse(String(m.data));
    if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map((/** @type {any} */ a) => a.value ?? a.description).join(" "));
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (/** @type {string} */ method, /** @type {any} */ params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (/** @type {any} */ d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send("Runtime.enable");
  await send("Page.enable").catch(() => {}); // only page-like targets have Page
  return {
    errors,
    send,
    close: () => ws.close(),
    /** Run the body of an async function in this target; its return value comes back by value. */
    async run(body) {
      const r = await send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => { ${body} })()` });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
  };
}

async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(100); }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-ext-check-"));
  /** @type {(() => Promise<void>|void)[]} */
  const cleanup = [];
  const teardown = async () => { for (const fn of cleanup.reverse()) { try { await fn(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true }); };
  process.on("SIGINT", async () => { await teardown(); process.exit(130); });

  try {
    log("building the extension");
    build();
    const distDir = path.join(REPO, "modules", "vault-extension", "dist", "chrome");
    if (!fs.existsSync(distDir)) throw new Error(`no ${distDir}; build.mjs did not write it`);

    const { server: pageServer, url: pageUrl } = /** @type {any} */ (await servePage());
    cleanup.push(() => pageServer.close());

    const db = open(path.join(tmp, "vyre.db"));
    migrate(db, "vault", MIGRATIONS);
    cleanup.push(() => db.close());
    const vault = new Vault({ db, dir: path.join(tmp, "vault"), config: { vault: { keystore: "file" } }, emit: () => {} });
    const pw = canary();
    await vault.put({ name: "browser-check-login", kind: "login", url: pageUrl, fields: { username: "alex", password: pw } }, "cli");
    const fill = new Fill({ vault });
    const srv = await serveFill({ host: "127.0.0.1", port: 0, fill });
    cleanup.push(() => srv.close());
    const { display } = fill.code({ name: "browser-check" });

    log(`fill listener at ${srv.url}, page at ${pageUrl}`);
    log("starting Chromium with the extension loaded");
    const profile = fs.mkdtempSync(path.join(tmp, "chrome-"));
    const child = spawn(CHROME, ["--headless=new", ...CHROME_SAFE, ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(" ").filter(Boolean) : []), "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--load-extension=${distDir}`,
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--force-color-profile=srgb",
      "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
    cleanup.push(() => { child.kill(); });
    let port = 0;
    for (let i = 0; i < 150 && !port; i++) { await sleep(100); try { port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {} }
    if (!port) throw new Error(`Chrome did not start (${CHROME})`);
    const base = `http://127.0.0.1:${port}`;

    const extId = await until(async () => {
      const list = await (await fetch(`${base}/json/list`)).json();
      const sw = list.find((/** @type {any} */ t) => t.type === "service_worker" && /^chrome-extension:\/\//.test(t.url));
      return sw ? new URL(sw.url).hostname : null;
    }, 10000);
    log(`extension loaded: ${extId}`);

    // Phase A + B: the popup, against real chrome.storage/chrome.runtime, pairs for real.
    globalThis.__dump = async () => { try { return JSON.stringify((await (await fetch(`${base}/json/list`)).json()).map((/** @type {any} */ t) => [t.type, t.url.slice(0, 80), t.title])); } catch { return "(no target list)"; } };
    const popupTarget = await (await fetch(`${base}/json/new?chrome-extension://${extId}/popup.html`, { method: "PUT" })).json();
    const popup = await attach(popupTarget.webSocketDebuggerUrl);
    cleanup.push(() => fetch(`${base}/json/close/${popupTarget.id}`).catch(() => {}));
    try { await until(() => popup.run(`return typeof document !== "undefined" && !!document.getElementById("pair")`).catch((/** @type {any} */ e) => { log(`popup probe: ${String(e.message).slice(0, 160)}`); return false; }), 30000); }
    catch (e) {
      log(`popup targets: ${await /** @type {any} */ (globalThis).__dump()}`);
      log(`popup html: ${await popup.run(`return (document.documentElement ? document.documentElement.outerHTML : "no document").slice(0, 1200)`).catch((/** @type {any} */ x) => "eval failed: " + x.message)}`);
      throw e;
    }
    const paired = await popup.run(`
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; };
      set("url", ${JSON.stringify(srv.url)});
      set("code", ${JSON.stringify(display)});
      document.getElementById("pair").click();
      await new Promise(r => setTimeout(r, 400));
      return document.getElementById("msg").textContent;
    `);
    if (!/^Paired as/.test(String(paired))) throw new Error(`pairing did not confirm: ${JSON.stringify(paired)}`);
    log(`popup: ${paired}`);
    if (popup.errors.length) throw new Error(`console errors in the popup: ${popup.errors.join(" | ")}`);
    popup.close();

    // Phase C: fill. Called on the background worker directly (127.0.0.1 is a permanent host
    // permission, so this needs no activeTab-granting user gesture to script the page).
    const pageTarget = await (await fetch(`${base}/json/new?${encodeURIComponent(pageUrl)}`, { method: "PUT" })).json();
    const pageConn = await attach(pageTarget.webSocketDebuggerUrl);
    cleanup.push(() => fetch(`${base}/json/close/${pageTarget.id}`).catch(() => {}));
    await until(() => pageConn.run(`return !!document.getElementById("p")`));

    const list = await (await fetch(`${base}/json/list`)).json();
    const sw = list.find((/** @type {any} */ t) => t.type === "service_worker" && t.url === `chrome-extension://${extId}/background.js`);
    if (!sw) throw new Error("no background service worker target");
    const bg = await attach(sw.webSocketDebuggerUrl);
    cleanup.push(() => bg.close());
    const filled = await bg.run(`
      const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pageUrl + "*")} });
      if (!tabs.length) return { error: "no matching tab" };
      return await fill("browser-check-login");
    `);
    if (filled && filled.error) throw new Error(`fill refused: ${JSON.stringify(filled.error)}`);
    if (bg.errors.length) throw new Error(`console errors in the background worker: ${bg.errors.join(" | ")}`);

    const got = await until(() => pageConn.run(`const v = document.getElementById("p").value; return v ? v : null;`), 5000);
    if (sha(String(got)) !== sha(pw)) throw new Error("the page's password field does not hold the vault's value");
    log("fill: the real Chromium field now holds the vault's password (compared by hash only)");

    log("PASS: the packaged extension loads, pairs and fills in a real Chromium, not a stub.");
  } finally {
    await teardown();
  }
}

main().catch(async e => { const t = /** @type {any} */ (globalThis).__dump ? await /** @type {any} */ (globalThis).__dump() : ""; process.stderr.write(`FAIL: ${e.message}${t ? ` targets=${t}` : ""}\n${e.stack ? e.stack.split("\n").slice(1, 4).join("\n") : ""}\n`); process.exitCode = 1; });
