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
const keyValue = `sk-ant-api03-${crypto.randomBytes(24).toString("base64url")}`;
function servePage() {
  const html = `<!doctype html><html><body>
    <form><input id="u" name="username" autocomplete="username"><input id="p" name="password" type="password" autocomplete="current-password"></form>
  </body></html>`;
  const keyHtml = `<!doctype html><html><body><main><p>Your new API key</p><code id="k">${keyValue}</code></main></body></html>`;
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(req.url === "/keys" ? keyHtml : html); });
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
  const teardown = async () => { for (const fn of cleanup.reverse()) { try { await fn(); } catch {} } await sleep(500); try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {} };
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
    const unlockPass = `fixture-unlock-${crypto.randomBytes(8).toString("hex")}`;
    await fill.setUnlockPassphrase({ passphrase: unlockPass });

    log(`fill listener at ${srv.url}, page at ${pageUrl}`);
    log("starting Chromium with the extension loaded");
    const profile = fs.mkdtempSync(path.join(tmp, "chrome-"));
    const child = spawn(CHROME, [...(process.env.VYRE_HEADED ? [] : ["--headless=new"]), ...CHROME_SAFE, ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(" ").filter(Boolean) : []), "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--load-extension=${distDir}`,
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
    if (/not from the popup/.test(String(paired))) {
      // Headless Chrome cannot open the real toolbar popup: an extension page opened as a tab carries sender.tab, and the worker refuses
      // pairing from it on purpose (only the popup pairs). That refusal is the first thing this run proves. The pairing itself then
      // runs through the worker's own `route` (the same code the popup's message reaches, with the real chrome.storage and fetch), called
      // from DevTools inside the service worker. Only the toolbar click and its sender check are skipped; they stay the user's 6.6b.
      log("a popup opened as a tab is refused when it tries to pair, as designed");
      popup.close();
      await fetch(`${base}/json/close/${popupTarget.id}`).catch(() => {});
      if (process.env.VYRE_HEADED) {
        // A headed Chrome (under xvfb) can open the REAL toolbar popup: chrome.action.openPopup() from the worker. That popup has no tab, so
        // the worker's sender check admits it, and pairing runs through the popup's own button, exactly as a person's click does.
        const l0 = await (await fetch(`${base}/json/list`)).json();
        const sw0 = l0.find((/** @type {any} */ t) => t.type === "service_worker" && t.url === `chrome-extension://${extId}/background.js`);
        const w0 = await attach(sw0.webSocketDebuggerUrl);
        cleanup.push(() => w0.close());
        const opened = await w0.run(`try { await chrome.action.openPopup(); return "opened"; } catch (e) { return "openPopup: " + e.message; }`);
        if (opened !== "opened") throw new Error(String(opened));
        const real = await until(async () => (await (await fetch(`${base}/json/list`)).json()).find((/** @type {any} */ t) => t.type === "page" && t.url === `chrome-extension://${extId}/popup.html`), 10000);
        const rp = await attach(real.webSocketDebuggerUrl);
        cleanup.push(() => rp.close());
        await until(() => rp.run(`return !!document.getElementById("pair")`));
        const realPaired = await rp.run(`
          const set = (id, v) => { const el = document.getElementById(id); el.value = v; };
          set("url", ${JSON.stringify(srv.url)});
          set("code", ${JSON.stringify(display)});
          document.getElementById("pair").click();
          await new Promise(r => setTimeout(r, 600));
          return document.getElementById("msg").textContent;
        `);
        if (!/^Paired as/.test(String(realPaired))) throw new Error(`the real popup did not pair: ${JSON.stringify(realPaired)}`);
        log(`real toolbar popup: ${realPaired}`);
        rp.close();
        const sw1 = (await (await fetch(`${base}/json/list`)).json()).find((/** @type {any} */ t) => t.type === "service_worker" && t.url === `chrome-extension://${extId}/background.js`);
        const w1 = await attach(sw1.webSocketDebuggerUrl);
        cleanup.push(() => w1.close());
        const unlocked = await w1.run(`const c = await route({ type: "unlock", passphrase: ${JSON.stringify(unlockPass)} }); return c.error ? "unlock: " + JSON.stringify(c.error) : "ok";`);
        if (unlocked !== "ok") throw new Error(String(unlocked));
        log("unlocked through the worker after the real popup paired");
        w1.close();
      } else {
      const listNow = await (await fetch(`${base}/json/list`)).json();
      const swt = listNow.find((/** @type {any} */ t) => t.type === "service_worker" && t.url === `chrome-extension://${extId}/background.js`);
      if (!swt) throw new Error("no background service worker target");
      const w = await attach(swt.webSocketDebuggerUrl);
      cleanup.push(() => w.close());
      const viaWorker = await w.run(`
        const a = await route({ type: "save-url", url: ${JSON.stringify(srv.url)} });
        if (a.error) return "save-url: " + JSON.stringify(a.error);
        const b = await route({ type: "pair", code: ${JSON.stringify(display)}, name: "browser-check" });
        if (b.error) return "pair: " + JSON.stringify(b.error);
        const c = await route({ type: "unlock", passphrase: ${JSON.stringify(unlockPass)} });
        if (c.error) return "unlock: " + JSON.stringify(c.error);
        return "Paired as " + b.data.name;
      `);
      if (!/^Paired as/.test(String(viaWorker))) throw new Error(`pairing through the worker did not confirm: ${viaWorker}`);
      log(`worker: ${viaWorker}, and unlocked`);
      w.close();
      }
    } else if (!/^Paired as/.test(String(paired))) throw new Error(`pairing did not confirm: ${JSON.stringify(paired)}`);
    else log(`popup: ${paired}`);
    if (popup.errors.length && !/not from the popup/.test(String(paired))) throw new Error(`console errors in the popup: ${popup.errors.join(" | ")}`);
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


    // Phase E: an API key a page shows is offered by the real chip, and one trusted tap stores it in the vault. The content scripts are
    // registered by the real worker (syncKeyChip), the tap is a DevTools input event (isTrusted), and the vault is checked by hash.
    const sw2 = list.find((/** @type {any} */ t) => t.type === "service_worker" && t.url === `chrome-extension://${extId}/background.js`);
    const bg2 = await attach(sw2.webSocketDebuggerUrl);
    cleanup.push(() => bg2.close());
    // The worker registers the chip only where the person granted "all sites" in the popup, which needs a real click. A DevTools-driven run
    // cannot answer that prompt, so the answer is given here (the grant check only); the browser still injects only where it really holds host
    // access, and 127.0.0.1 is one of those. A person's own install is not touched.
    const synced = await bg2.run(`try { ext.permissions.contains = async () => true; const r = await syncKeyChip(); return r.keychip ? "ok" : "the chip scripts did not register"; } catch (e) { return "syncKeyChip: " + e.message; }`);
    if (synced !== "ok") throw new Error(String(synced));
    const keyTarget = await (await fetch(`${base}/json/new?${encodeURIComponent(pageUrl + "keys")}`, { method: "PUT" })).json();
    const keyPage = await attach(keyTarget.webSocketDebuggerUrl);
    cleanup.push(() => fetch(`${base}/json/close/${keyTarget.id}`).catch(() => {}));
    await keyPage.send("DOM.enable");
    await until(() => keyPage.run(`return !!document.querySelector("vyre-vault-key")`), 15000);
    await sleep(700);
    const { root } = await keyPage.send("DOM.getDocument", { depth: -1, pierce: true });
    /** @type {any} */ let saveBtn = null;
    const walk = (/** @type {any} */ n, inChip) => {
      if (saveBtn) return;
      const here = inChip || n.nodeName === "VYRE-VAULT-KEY";
      if (here && n.nodeName === "BUTTON" && JSON.stringify(n.children || []).includes('"Save"')) saveBtn = n;
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c, here);
    };
    walk(root, false);
    if (!saveBtn) throw new Error("the chip has no Save button");
    const { model } = await keyPage.send("DOM.getBoxModel", { backendNodeId: saveBtn.backendNodeId });
    const q = model.content, x = (q[0] + q[2] + q[4] + q[6]) / 4, y = (q[1] + q[3] + q[5] + q[7]) / 4;
    for (const type of ["mousePressed", "mouseReleased"]) await keyPage.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    const saved = await until(async () => {
      for (const it of vault.list().items) {
        if (it.kind === "login" || it.name === "browser-check-login") continue;
        const row = vault.row(it.name);
        if (!row) continue;
        const f = await vault.fields(row);
        if (Object.values(f).some(v => sha(String(v)) === sha(keyValue))) return { name: it.name, origin: row.origin };
      }
      return null;
    }, 8000);
    if (!saved.origin || !String(saved.origin).startsWith("http://127.0.0.1:")) throw new Error(`the saved key's origin is wrong: ${saved.origin}`);
    log(`chip: one trusted tap stored the page's key as ${saved.name}, from ${saved.origin} (compared by hash only)`);
    log("PASS: the packaged extension loads, pairs through its worker and fills in a real Chromium, and the chip stores a page's key on one trusted tap.");
  } finally {
    await teardown();
  }
}

main().catch(async e => { const t = /** @type {any} */ (globalThis).__dump ? await /** @type {any} */ (globalThis).__dump() : ""; process.stderr.write(`FAIL: ${e.message}${t ? ` targets=${t}` : ""}\n${e.stack ? e.stack.split("\n").slice(1, 4).join("\n") : ""}\n`); process.exitCode = 1; });
