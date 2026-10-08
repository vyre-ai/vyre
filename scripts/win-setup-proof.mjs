#!/usr/bin/env node
// win-setup-proof: the Windows app's first run, on a real Windows machine (GitHub's windows-latest), against a STAND-IN names directory. TEST ONLY.
//
//   node scripts/win-setup-proof.mjs --exe <Vyre.exe> --web <web export> --names http://127.0.0.1:8787 --out <dir> [--cdp 9222]
//
// It starts the real Windows app (VYRE_APP_WEB_DIR points it at an export built with EXPO_PUBLIC_VYRE_NAMES_DIRECTORY at the stand-in; WebView2 listens for the DevTools protocol on --cdp),
// then drives the window the way a person would and checks, in order:
//   1. the window's origin (reported, it is the string the real directory's APP_ORIGINS must list);
//   2. first run: Get started, paste a reservation code the stand-in gave, Create my name; the recovery code shows; the stand-in resolves the name to THIS computer's key;
//   3. the identity bridge: has, public, sign (verified here with node's crypto), public again (same key), the TPM and agreement keys (a runner has no TPM: the reason must be real words, not nothing);
//   4. the log %LOCALAPPDATA%\Vyre\logs\app.log exists and names every failure;
//   5. restart: the app is stopped and started again; the key is still the same, and the relay key store (IndexedDB vyre-relay) written before the restart is still there after it.
// Exit 0 only when all hold. Needs playwright-core (CDP only, no browser download).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createPublicKey, verify as nodeVerify, randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const EXE = path.resolve(flag("--exe", ""));
const WEB = path.resolve(flag("--web", ""));
const NAMES = flag("--names", "http://127.0.0.1:8787").replace(/\/+$/, "");
const OUT = path.resolve(flag("--out", "win-proof-out"));
const CDP = Number(flag("--cdp", "9222"));
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.join(process.cwd(), "x"));
const { chromium } = require("playwright-core");

const results = [];
const note = (s) => console.log(s);
let page = null;
const shot = async (n) => { if (page) await page.screenshot({ path: path.join(OUT, n.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".png") }).catch(() => {}); };
const check = async (name, fn) => {
  let ok = false, said = "";
  try { said = (await fn()) || ""; ok = true; } catch (e) { said = String(e && e.message || e).split("\n")[0].slice(0, 300); }
  await shot(name);
  results.push({ name, ok, note: said });
  note(`${ok ? "PASS" : "FAIL"}   ${name}${said ? ": " + said : ""}`);
  return ok;
};
const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logFile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "Vyre", "logs", "app.log");

let proc = null;
function launch() {
  const env = { ...process.env, VYRE_APP_WEB_DIR: WEB, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP}` };
  proc = spawn(EXE, [], { env, stdio: "ignore", windowsHide: false });
  proc.on("exit", (c) => note(`  (app exited ${c})`));
}
function stop() {
  if (!proc) return;
  // Only this process (and its WebView2 children, which exit with it); never by image name.
  try { spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ }
  proc = null;
}
async function attach() {
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`); } catch { await sleep(1000); }
  }
  if (!browser) throw new Error("the app's window never listened for the DevTools protocol");
  for (let i = 0; i < 60; i++) {
    for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith("http://vyreapp.localhost/")) return { browser, page: p };
    await sleep(500);
  }
  throw new Error("no window of the app's own origin opened; pages: " + browser.contexts().flatMap((c) => c.pages().map((p) => p.url())).join(", "));
}
const call = (expr) => page.evaluate(expr);

let browser = null;
try {
  await check("the stand-in directory answers", async () => { const r = await fetch(`${NAMES}/v1/names/check?name=winproof`); if (!r.ok) throw new Error("status " + r.status); return `status ${r.status}`; });
  launch();
  ({ browser, page } = await attach());
  page.on("console", (m) => { if (m.type() === "error") note("  console error: " + m.text().slice(0, 200)); });
  page.on("pageerror", (e) => note("  pageerror: " + String(e).slice(0, 200)));

  let origin = "";
  await check("origin: the window runs at one fixed origin (the string APP_ORIGINS must list)", async () => { origin = await call(() => location.origin); if (origin !== "http://vyreapp.localhost") throw new Error("origin is " + origin); return origin; });
  await check("the shell is the Windows app's, boxless, with the identity calls", async () => {
    const s = await call(() => { const x = window.__vyreShell; return x ? { kind: x.kind, boxless: x.boxless, calls: Object.keys(x.identity || {}).sort() } : null; });
    if (!s || s.kind !== "windows" || s.boxless !== true) throw new Error(JSON.stringify(s));
    for (const c of ["public", "sign", "has", "forget", "enclavePublic", "enclaveSign", "agreePublic", "agree"]) if (!s.calls.includes(c)) throw new Error("missing " + c);
    return s.calls.join(",");
  });
  await check("before the claim there is no key on this computer", async () => { if (await call(() => window.__vyreShell.identity.has())) throw new Error("a key already exists"); });

  // The stand-in gives the reservation code the web page would have.
  const name = "winproof" + Math.floor(Math.random() * 90000 + 10000);
  const reserved = await (await fetch(`${NAMES}/v1/ids/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })).json();
  note(`  reserved ${name}: ${reserved.code ? "a code" : JSON.stringify(reserved)}`);
  let recovery = "";
  await check("first run: Get started, paste the reservation code, Create my name, the recovery code shows", async () => {
    await page.getByText("Get started", { exact: true }).first().click({ timeout: 30000 });
    await page.getByPlaceholder("VYRE-XXXX-XXXX-XXXX-XXXX").fill(reserved.code, { timeout: 30000 });
    await page.getByText("Create my name", { exact: true }).first().click({ timeout: 15000 });
    await page.getByText("Save your recovery code").first().waitFor({ timeout: 60000 });
    recovery = "shown";
  });
  let pub = "";
  await check("the stand-in resolves the name to this computer's own key (not a browser passkey)", async () => {
    pub = await call(() => window.__vyreShell.identity.public(false));
    const r = await (await fetch(`${NAMES}/v1/ids/resolve?name=${name}`)).json();
    const text = JSON.stringify(r);
    if (!text.includes(name)) throw new Error("not resolved: " + text.slice(0, 200));
    if (/passkey|webauthn/i.test(text) && !text.includes(pub)) throw new Error("the record looks like a passkey claim");
    return "resolved";
  });
  await check("after I saved it: the first-run choices (Join a team, Add a server) show", async () => {
    await page.getByText("I saved it", { exact: true }).first().click({ timeout: 15000 });
    await sleep(1500);
    const text = await page.locator("body").innerText();
    fs.writeFileSync(path.join(OUT, "after-identity.txt"), text);
    if (!/join/i.test(text) || !/server/i.test(text)) throw new Error("page says: " + text.replace(/\s+/g, " ").slice(0, 200));
    return text.replace(/\s+/g, " ").slice(0, 120);
  });

  await check("bridge: has, public, sign verifies, public again is the same key", async () => {
    if (!(await call(() => window.__vyreShell.identity.has()))) throw new Error("has() is false after the claim");
    const msg = randomBytes(40);
    const sig = await call((m) => window.__vyreShell.identity.sign(m), b64u(msg));
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), unb64u(pub)]), format: "der", type: "spki" });
    if (!nodeVerify(null, msg, key, unb64u(sig))) throw new Error("the signature does not verify");
    const again = await call(() => window.__vyreShell.identity.public(false));
    if (again !== pub) throw new Error("the key changed between calls");
    return "ed25519 key " + pub.slice(0, 8);
  });
  let enclave = "";
  await check("bridge: the TPM and agreement keys answer, or say a real reason", async () => {
    const r = await call(async () => {
      const id = window.__vyreShell.identity, o = {};
      try { o.enclave = await id.enclavePublic(true); } catch (e) { o.enclaveErr = String((e && e.message) || e); }
      try { o.agree = await id.agreePublic(true); } catch (e) { o.agreeErr = String((e && e.message) || e); }
      return o;
    });
    if (r.enclaveErr !== undefined && r.enclaveErr.length < 8) throw new Error("the TPM failure has no real reason: " + JSON.stringify(r.enclaveErr));
    if (r.agreeErr !== undefined && r.agreeErr.length < 8) throw new Error("the agreement failure has no real reason: " + JSON.stringify(r.agreeErr));
    enclave = r.enclave || "";
    return JSON.stringify({ enclave: r.enclave ? "key" : r.enclaveErr, agree: r.agree ? "key" : r.agreeErr });
  });
  await check("the log exists and holds the TPM failure (or the app made a TPM key)", async () => {
    if (!fs.existsSync(logFile)) { if (enclave) return "no failures to log (a TPM key was made)"; throw new Error("no log at " + logFile); }
    const text = fs.readFileSync(logFile, "utf8");
    fs.copyFileSync(logFile, path.join(OUT, "app.log"));
    if (!enclave && !/enclave_public/.test(text)) throw new Error("the TPM failure is not in the log:\n" + text.slice(-400));
    if (/seed|BEGIN|private/i.test(text)) throw new Error("the log mentions a secret word");
    return `${text.split("\n").filter(Boolean).length} lines`;
  });

  // The relay key store: the app keeps its relay key as a non-extractable CryptoKey in IndexedDB "vyre-relay" at the window's origin. Write one the way the client does, before the restart.
  let relayPub = "";
  await check("relay key: written to the page's IndexedDB (vyre-relay/keys/device) the way the client stores it", async () => {
    relayPub = await call(async () => {
      const kp = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
      const pub = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      await new Promise((res, rej) => {
        const req = indexedDB.open("vyre-relay", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("keys");
        req.onsuccess = () => { const tx = req.result.transaction("keys", "readwrite"); tx.objectStore("keys").put({ privateKey: kp.privateKey, publicKey: pub }, "proof"); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); };
        req.onerror = () => rej(req.error);
      });
      return pub;
    });
    return "key " + relayPub.slice(0, 8);
  });

  // Restart the app: stop this process, start it again, and read everything back.
  await browser.close().catch(() => {});
  stop();
  await sleep(4000);
  launch();
  ({ browser, page } = await attach());
  await check("restart: the identity key is the same one", async () => {
    if (!(await call(() => window.__vyreShell.identity.has()))) throw new Error("has() is false after a restart");
    const again = await call(() => window.__vyreShell.identity.public(false));
    if (again !== pub) throw new Error("a different key after a restart");
    return "same key";
  });
  await check("restart: the relay key is still in the page's IndexedDB and still cannot be exported", async () => {
    const r = await call(async () => new Promise((res, rej) => {
      const req = indexedDB.open("vyre-relay", 1);
      req.onsuccess = () => { const g = req.result.transaction("keys").objectStore("keys").get("proof"); g.onsuccess = () => res(g.result ? { pub: g.result.publicKey, extractable: g.result.privateKey.extractable } : null); g.onerror = () => rej(g.error); };
      req.onerror = () => rej(req.error);
    }));
    if (!r) throw new Error("the relay key is gone after a restart");
    if (r.pub !== relayPub) throw new Error("a different relay key");
    if (r.extractable) throw new Error("the relay key is extractable");
    return "kept";
  });
} catch (e) {
  results.push({ name: "the proof ran", ok: false, note: String(e && e.stack || e).slice(0, 600) });
  note("FAIL   the proof ran: " + String(e && e.message || e));
} finally {
  try { fs.copyFileSync(logFile, path.join(OUT, "app.log")); } catch { /* none */ }
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  await browser?.close().catch(() => {});
  stop();
}
const failed = results.filter((r) => !r.ok);
note(`\n${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
