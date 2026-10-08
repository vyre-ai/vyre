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
// Exit 0 only when all hold. It speaks the DevTools protocol itself (Node's WebSocket): Playwright's connectOverCDP, and anything that asks WebView2 to close its "browser", ends the app (run 37729563740: exit 0 one second after the page loaded).
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createPublicKey, verify as nodeVerify, randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const EXE = path.resolve(flag("--exe", ""));
const WEB = path.resolve(flag("--web", ""));
const NAMES = flag("--names", "http://127.0.0.1:8787").replace(/\/+$/, "");
const OUT = path.resolve(flag("--out", "win-proof-out"));
const CDP = Number(flag("--cdp", "9222"));
fs.mkdirSync(OUT, { recursive: true });

// ---- a small DevTools client: one page target, evaluate, real mouse and text input, screenshots. It never sends Browser.close or anything that disposes of the browser.
class Cdp {
  constructor(ws, url) { this.ws = ws; this.url = url; this.id = 0; this.waiting = new Map(); this.handlers = []; ws.onmessage = (m) => { const d = JSON.parse(String(m.data)); if (d.id && this.waiting.has(d.id)) { const w = this.waiting.get(d.id); this.waiting.delete(d.id); d.error ? w.rej(new Error(d.error.message)) : w.res(d.result); } else if (d.method) for (const h of this.handlers) h(d.method, d.params); }; }
  send(method, params = {}) { return new Promise((res, rej) => { const id = ++this.id; this.waiting.set(id, { res, rej: (e) => rej(new Error(`${method}: ${e.message}`)) }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  on(fn) { this.handlers.push(fn); }
  async evaluate(what, arg) {
    const expression = typeof what === "function" ? `(${what.toString()})(${JSON.stringify(arg ?? null)})` : what;
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  }
  async screenshot({ path: file }) { const r = await this.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(file, Buffer.from(r.data, "base64")); }
  // The element whose own text is `text` (exactly, or as a prefix of a longer line when not exact), as a point on screen.
  async find(kind, text, exact = true, timeout = 30000) {
    const end = Date.now() + timeout;
    for (;;) {
      const pt = await this.evaluate(({ kind, text, exact }) => {
        const all = [...document.querySelectorAll("*")];
        let el = null;
        if (kind === "placeholder") el = all.find((e) => e.getAttribute("placeholder") === text) || null;
        else {
          const hit = all.filter((e) => { const t = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim(); return exact ? t === text : t.includes(text); });
          el = hit[0] || null;
        }
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      }, { kind, text, exact });
      if (pt) return pt;
      if (Date.now() > end) throw new Error(`no ${kind} "${text}" on the page within ${timeout} ms`);
      await sleep(400);
    }
  }
  async clickAt({ x, y }) { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }); }
  getByText(text, o = {}) { const self = this; const l = { first: () => l, click: async ({ timeout } = {}) => self.clickAt(await self.find("text", text, o.exact !== false, timeout)), waitFor: async ({ timeout } = {}) => { await self.find("text", text, o.exact !== false, timeout); } }; return l; }
  getByPlaceholder(text) { const self = this; return { fill: async (value, { timeout } = {}) => { await self.clickAt(await self.find("placeholder", text, true, timeout)); for (const ch of value) { await self.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch }); await self.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }); } } }; }
  locator(sel) { const self = this; return { innerText: () => self.evaluate((s) => document.querySelector(s).innerText, sel) }; }
}

const results = [];
const note = (s) => console.log(s);
let page = null;
const shot = async (n) => { if (page) await page.screenshot({ path: path.join(OUT, n.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".png") }).catch(() => {}); };
const check = async (name, fn) => {
  let ok = false, said = "";
  try { said = (await fn()) || ""; ok = true; } catch (e) { said = String(e && e.message || e).split("\n")[0].slice(0, 300); }
  if (!ok && page) { try { const t = await page.evaluate(() => document.body.innerText); said += " | page says: " + String(t).replace(/\s+/g, " ").slice(0, 300); } catch { /* the page is gone */ } }
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
  const env = { ...process.env, VYRE_APP_WEB_DIR: WEB };
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
  let seen = "";
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
      const t = list.find((x) => x.type === "page" && String(x.url).startsWith("https://vyreapp.localhost/"));
      seen = list.map((x) => `${x.type} ${x.url}`).join(" | ");
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("the page's DevTools socket would not open")); });
        const page = new Cdp(ws, t.url);
        await page.send("Runtime.enable"); await page.send("Page.enable");
        return { browser: { close: async () => { try { ws.close(); } catch { /* gone */ } } }, page };
      }
    } catch (e) { seen = seen || "DevTools not reachable yet: " + String(e.message || e).slice(0, 100); }
    if (proc && proc.exitCode !== null) break;
    await sleep(1000);
  }
  let log = "(no app.log)";
  try { log = fs.readFileSync(logFile, "utf8").slice(-1500); } catch { /* none */ }
  let ports = "";
  try { ports = String(spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" }).stdout).split("\n").filter((l) => /LISTENING/.test(l)).join(" ; ").replace(/\s+/g, " ").slice(0, 700); } catch { /* none */ }
  throw new Error(`no window of the app's own origin on the DevTools port (listening: ${ports}); targets: ${seen}; app alive: ${proc ? proc.exitCode === null : "stopped"}, exit code ${proc ? proc.exitCode : "?"}; app.log: ${log}`);
}
const call = (fn, arg) => page.evaluate(fn, arg);


// The shell's own yes or no (a native message box the page cannot draw over or click): find it, read what it says, and answer it the way a person would. "Yes" is IDYES (6), "No" is IDNO (7).
const PS = `
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public class W { 
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, int w, StringBuilder l);
}
"@
$h = [W]::FindWindow("#32770", "Vyre")
if ($h -eq [IntPtr]::Zero) { Write-Output "NODIALOG"; exit 0 }
$text = ""; $c = [IntPtr]::Zero
while ($true) { $c = [W]::FindWindowEx($h, $c, "Static", $null); if ($c -eq [IntPtr]::Zero) { break }; $sb = New-Object System.Text.StringBuilder 1024; [void][W]::SendMessage($c, 0x000D, 1024, $sb); if ($sb.Length -gt 0) { $text += $sb.ToString() } }
if ($text -eq "") {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  $all = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($e in $all) { $n = $e.Current.Name; if ($n) { $text += $n + " " } }
}
Write-Output ("TEXT:" + ($text -replace "[\r\n]+", " | "))
[void][W]::SendMessage($h, 0x111, [IntPtr]::new($env:ANSWER), [IntPtr]::Zero)
Write-Output "ANSWERED"
`;
async function answerDialog(idButton) {
  for (let i = 0; i < 40; i++) {
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS], { env: { ...process.env, ANSWER: String(idButton) }, encoding: "utf8" });
    const out = String(r.stdout || "");
    if (out.includes("ANSWERED")) return /TEXT:(.*)/.exec(out)?.[1]?.trim() || "";
    await sleep(500);
  }
  throw new Error("the shell's confirmation never appeared");
}

let browser = null;
try {
  await check("the stand-in directory answers", async () => { const r = await fetch(`${NAMES}/v1/names/check?name=winproof`); if (!r.ok) throw new Error("status " + r.status); return `status ${r.status}`; });
  launch();
  ({ browser, page } = await attach());
  page.on((method, p) => { if (method === "Runtime.exceptionThrown") note("  pageerror: " + JSON.stringify(p.exceptionDetails && (p.exceptionDetails.exception?.description || p.exceptionDetails.text)).slice(0, 240)); if (method === "Runtime.consoleAPICalled" && p.type === "error") note("  console error: " + JSON.stringify((p.args || []).map((a) => a.value ?? a.description)).slice(0, 240)); });

  let origin = "";
  await check("origin: the window runs at one fixed origin (the string APP_ORIGINS must list)", async () => { origin = await call(() => location.origin); if (origin !== "https://vyreapp.localhost") throw new Error("origin is " + origin); return origin; });
  await check("WebAuthn probe (no credential made, no prompt): what this WebView2 page exposes", async () => {
    const out = await page.evaluate(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "app", "scripts", "webauthn-probe.js"), "utf8"));
    fs.writeFileSync(path.join(OUT, "webauthn-probe.json"), typeof out === "string" ? out : JSON.stringify(out));
    return String(typeof out === "string" ? out : JSON.stringify(out)).slice(0, 400);
  });
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
  await check("first run: Start, paste the code, Continue, the recovery code shows", async () => {
    await page.getByText("Start", { exact: true }).first().click({ timeout: 30000 });
    await page.getByPlaceholder("VYRE-XXXX-XXXX-XXXX-XXXX").fill(reserved.code, { timeout: 30000 });
    await page.getByText("Continue", { exact: true }).first().click({ timeout: 15000 });
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

  // The shell's own yes (KP-3): a list change signed by the computer's enclave (TPM) key is confirmed in a native box the shell writes from the bytes, so a page cannot approve its own change. This is what lets a Windows
  // computer with a TPM key be a full device; one without a TPM key is a held (web) key, as before.
  const chain = (e) => new TextEncoder().encode("vyre-chain-v1\n" + JSON.stringify({ type: "add", entry: e }));
  const signAsk = (bytes) => call(async (m) => { try { return { ok: await window.__vyreShell.identity.enclaveSign(m, "Approve") }; } catch (e) { return { err: String((e && e.message) || e) }; } }, b64u(bytes));
  await check("native yes/no: answering No refuses, and the box says what would be signed in the shell's own words", async () => {
    const pending = signAsk(chain({ kind: "device", label: "Proof phone" }));
    const said = await answerDialog(7);
    const r = await pending;
    if (!r.err || !/Not approved/.test(r.err) || /status/.test(r.err)) throw new Error("No did not refuse cleanly: " + JSON.stringify(r).slice(0, 200));
    if (!/Add a device: Proof phone/.test(said)) throw new Error("the box does not name the change: " + said);
    return said.slice(0, 100);
  });
  await check("native yes/no: answering Yes reaches the key (a signature, or the TPM's own refusal), never the page's own approval", async () => {
    const pending = signAsk(chain({ kind: "device", label: "Proof phone" }));
    await answerDialog(6);
    const r = await pending;
    if (r.ok) return "signed (a TPM key answered)";
    if (!r.err || r.err === "Not approved. Nothing was changed.") throw new Error("Yes was treated as No: " + JSON.stringify(r));
    return "past the box; the key said: " + r.err.slice(0, 160);
  });
  await check("native yes/no: bytes the shell cannot read are refused with no box at all", async () => {
    const r = await signAsk(new TextEncoder().encode("anything the page likes"));
    if (!r.err || !/cannot tell what this would sign/.test(r.err)) throw new Error(JSON.stringify(r));
    const p = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS], { env: { ...process.env, ANSWER: "7" }, encoding: "utf8" });
    if (!String(p.stdout).includes("NODIALOG")) throw new Error("a box appeared for unreadable bytes");
    return "refused, no box";
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
