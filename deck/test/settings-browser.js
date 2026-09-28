// @ts-check
// A real-Chrome check of Settings' confirm and proof flow, on testbox only:
//
//   node deck/test/settings-browser.js [--port 4795] [--out <dir>]
//
// It starts the native bar's world (temp home, this tree's vyred, fake claude and tailscale,
// VYRE_NO_DIALOGS=1) and one headless Chrome, opens /settings, and checks three things: a mode that
// widens what Claude may do asks first and lands only on Confirm; Cancel changes nothing; a key
// that loosens security asks for a proof and, with no way to prove it here, is not saved. It prints
// one JSON line per check and saves a screenshot of each ask. A test helper, not part of the product.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openTab } from "./cdp.js";
import { SCRATCH } from "../../test/scratch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (/** @type {string} */ n, /** @type {string} */ d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg("--port", "4795"));
const OUT = path.resolve(arg("--out", fs.mkdtempSync(path.join(SCRATCH, "settings-shots-"))));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
/** @type {import("node:child_process").ChildProcess[]} */ const started = [];
const scratch = fs.mkdtempSync(path.join(SCRATCH, "settings-chrome-"));
let failed = 0;
const say = (/** @type {string} */ check, /** @type {boolean} */ pass, detail = "") => { if (!pass) failed++; process.stdout.write(JSON.stringify({ check, pass, ...(detail ? { detail } : {}) }) + "\n"); };
async function stopAll() {
  for (const p of started.reverse()) { try { p.kill("SIGTERM"); } catch {} }
  await sleep(1500);
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}

try {
  const w = spawn("nice", ["-n", "15", process.execPath, path.join(HERE, "native-bar", "world.js"), "--port", String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
  started.push(w);
  /** @type {{ url: string }} */
  const world = await new Promise((resolve, reject) => {
    let buf = "";
    w.stdout?.on("data", d => { buf += d; const l = buf.split("\n").find(x => x.startsWith("{")); if (l) resolve(JSON.parse(l)); });
    w.once("exit", c => reject(new Error(`world exited ${c}`)));
    setTimeout(() => reject(new Error("world did not come up in 120 s")), 120_000);
  });
  const bin = process.env.CHROME || path.join(os.homedir(), "vyre-ci/pwa-chrome/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell");
  const cdpPort = 9431 + Math.floor(Math.random() * 400);
  const chrome = spawn("nice", ["-n", "15", bin, `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${scratch}`,
    "--no-sandbox", "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  started.push(chrome);
  const CDP = `http://127.0.0.1:${cdpPort}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${CDP}/json/version`); break; } catch { await sleep(200); } }
  const tool = async (/** @type {string} */ name, /** @type {any} */ input = {}) =>
    (await fetch(`${world.url}/v1/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-vyre-caller": "deck" }, body: JSON.stringify(input) })).json();
  const tab = await openTab(CDP, { width: 1280, height: 900, scale: 1, mobile: false });
  const shot = async (/** @type {string} */ name, /** @type {string} */ sel) => {
    await tab.run(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: "center" }); return true;`);
    await sleep(300);
    const r = await tab.send("Page.captureScreenshot", { format: "png" });
    if (r.result?.data) fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.result.data, "base64"));
  };
  await tab.go(`${world.url}/settings`, 2500);
  const row = (/** @type {string} */ key) => `[data-key="${key}"]`;
  await tab.run(`await waitFor(${JSON.stringify(row("sessions.mode"))}, 15000); return true;`);

  // 1. A wider mode asks first; Cancel changes nothing.
  const pick = (/** @type {string} */ key, /** @type {string} */ v) => tab.run(`const s = document.querySelector(${JSON.stringify(row(key) + " select")});
    if (!s) return "no select"; s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event("change", { bubbles: true })); await wait(800);
    const ask = document.querySelector(${JSON.stringify(row(key) + " .sk-ask")}); return ask && !ask.hidden ? ask.textContent : "no ask";`);
  let t = await pick("sessions.mode", "bypassPermissions");
  say("a wider mode asks before it lands", /Claude|ask/i.test(String(t)) && t !== "no ask", String(t).slice(0, 160));
  await shot("mode-ask", row("sessions.mode"));
  const before = (await tool("settings.get", { key: "sessions.mode" })).data?.value;
  say("nothing is saved while it asks", before !== "bypassPermissions", `value ${before}`);
  await tab.run(`document.querySelector(${JSON.stringify(row("sessions.mode") + " .sk-no")})?.click(); await wait(600); return true;`);
  const shown = await tab.run(`return document.querySelector(${JSON.stringify(row("sessions.mode") + " select")}).value;`);
  say("Cancel puts the old value back and saves nothing", shown !== "bypassPermissions" && (await tool("settings.get", { key: "sessions.mode" })).data?.value === before, `shown ${shown}`);

  // 2. Confirm lands it, and the row says Saved.
  await pick("sessions.mode", "bypassPermissions");
  await tab.run(`document.querySelector(${JSON.stringify(row("sessions.mode") + " .sk-yes")})?.click(); await wait(1200); return true;`);
  const after = (await tool("settings.get", { key: "sessions.mode" })).data?.value;
  const slot = await tab.run(`return document.querySelector(${JSON.stringify(row("sessions.mode") + " .sk-slot")})?.textContent || "";`);
  say("Confirm saves it", after === "bypassPermissions", `value ${after}, row says "${slot}"`);
  await shot("mode-saved", row("sessions.mode"));

  // 3. A key that loosens security needs a proof; with no dialogs here, it is not saved.
  const lockKey = "vault.lock_idle";
  const hasLock = await tab.run(`return !!document.querySelector(${JSON.stringify(row(lockKey))});`);
  if (!hasLock) say("a loosening key asks for a proof", false, `no ${lockKey} row`);
  else {
    const kind = await tab.run(`const r = document.querySelector(${JSON.stringify(row(lockKey))}); const s = r.querySelector("select"), i = r.querySelector("input");
      if (s) { const o = [...s.options].map(o => o.value).find(v => v && v !== s.value && /h|never/.test(v)); s.value = o || s.value; s.dispatchEvent(new Event("change", { bubbles: true })); return "select " + s.value; }
      if (i) { i.focus(); i.value = "8h"; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return "input"; }
      return "none";`);
    await sleep(900);
    const ask = await tab.run(`const a = document.querySelector(${JSON.stringify(row(lockKey) + " .sk-ask")}); return a && !a.hidden ? a.textContent : "no ask";`);
    say("a loosening key asks before it lands", ask !== "no ask", `${kind}: ${String(ask).slice(0, 160)}`);
    await shot("lock-ask", row(lockKey));
    await tab.run(`document.querySelector(${JSON.stringify(row(lockKey) + " .sk-yes")})?.click(); await wait(2500); return true;`);
    const lock = (await tool("settings.get", { key: lockKey })).data;
    const note = await tab.run(`const r = document.querySelector(${JSON.stringify(row(lockKey))}); return (r.querySelector(".sk-err")?.textContent || r.querySelector(".sk-slot")?.textContent || "").trim();`);
    say("with no proof it is not saved, and the row says why in plain words", (lock?.source !== "account" || lock?.value !== "8h") && /Add one in Settings/.test(note) && !/presence\./.test(note), `value ${lock?.value} (${lock?.source}); row: "${note}"`);
    await shot("lock-after", row(lockKey));
  }
  // 4. Wink (Settings > Devices, deck/js/wink-card.js, shared with onboarding): the explicit-tap
  // gate, the ring, the countdown, blanking on blur/hidden/expiry, and the relay.paired reaction
  // (dance, name, fingerprint, Remove) — reviewer's five pre-review points. Real onboard.status
  // carries no `can` field yet (asked anywhere), so this patches window.fetch, injected before
  // any page script runs, splicing `can.relayJoin: true` onto that one real response — no fake
  // tool, no faked module, everything else on the page stays real. It also counts calls to
  // relay.pair.ticket, so "minted only on tap, never on load, never re-minted by blur/focus" is
  // an assertion, not an assumption. relay.pair.ticket itself isn't merged yet either, so it
  // answers from deck/fixtures/relay.json's fallback (a fixed, far-future expiresAt — a real
  // mint's TTL is ~5 min, but this fixture's isn't meant to be read literally, just to prove the
  // ring/countdown/dance mechanics without a real network call). Date.now is patched the same
  // way so the forced-expiry check can jump straight past that fixed date instead of waiting on
  // it for real. relay.paired itself is delivered with api.js's own `hear()` test seam (pwa's
  // contract, used the same way by chat/session.test.js) rather than a genuine relay handshake,
  // which this box was never asked to run.
  await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__fakeNow = null;
    window.__ticketMints = 0;
    const _now = Date.now.bind(Date);
    Date.now = () => window.__fakeNow ?? _now();
    const _fetch = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      if (typeof url === "string" && url.includes("/v1/tools/relay.pair.ticket")) window.__ticketMints++;
      const res = await _fetch(url, init);
      if (typeof url === "string" && url.includes("/v1/tools/onboard.status")) {
        const body = await res.clone().json();
        if (body && body.data) body.data.can = { relayJoin: true };
        return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
      }
      return res;
    };
  ` });
  // A same-document hash change (this tab is already on /settings from checks 1-3) never fires
  // a new document, so addScriptToEvaluateOnNewDocument's injection would never run — force a
  // real reload through about:blank first.
  await tab.go("about:blank", 200);
  await tab.go(`${world.url}/settings#devices`, 2500);
  await tab.run(`await waitFor("#wink-h", 8000); return true;`);

  // 4a. Never minted on load: the idle avatar shows (no ticks), "Add a device" is offered, and
  // relay.pair.ticket was never called.
  const idle = await tab.run(`return {
    mints: window.__ticketMints,
    hasIdleSvg: !!document.querySelector(".phone-code-ring svg"),
    hasTicks: document.querySelectorAll(".phone-code-ring line").length,
    hasStart: !!document.querySelector(".phone-code-body .btn.btn-primary"),
  };`);
  say("Wink: no ticket minted on load (reviewer's #1)", idle.mints === 0 && idle.hasTicks === 0 && idle.hasIdleSvg, JSON.stringify(idle));
  say("Wink: \"Add a device\" is offered before any tap", idle.hasStart);
  await shot("wink-idle", ".phone-code-ring");

  // 4b. The explicit tap mints exactly once and draws the real ring.
  await tab.run(`document.querySelector(".phone-code-body .btn.btn-primary").click(); return true;`);
  await sleep(500);
  const dbgTap = await tab.run(`return { vis: document.visibilityState, hasFocus: document.hasFocus(), metaText: document.querySelector(".phone-code-meta")?.textContent };`);
  say("DEBUG after tap", true, JSON.stringify(dbgTap));
  await tab.run(`await waitFor(".phone-code-ring line", 4000); return true;`);
  const afterTap = await tab.run(`return { mints: window.__ticketMints, ticks: document.querySelectorAll(".phone-code-ring line").length };`);
  say("Wink: the ring renders (72 ticksSunburst marks) after the tap", afterTap.ticks === 72, JSON.stringify(afterTap));
  say("Wink: exactly one mint for the one tap", afterTap.mints === 1, JSON.stringify(afterTap));
  await shot("wink-ring", ".phone-code-ring");
  const before5 = await tab.run(`return document.querySelector(".phone-code-meta").textContent;`);
  say("Wink: the countdown shows a live m:ss", /Expires in \d+:\d\d/.test(String(before5)), String(before5));

  // 4c. Blur blanks the ring at once, without minting again; focus redraws the SAME ticket.
  await tab.run(`window.dispatchEvent(new Event("blur")); await wait(50); return true;`);
  const blurred = await tab.run(`return { ticks: document.querySelectorAll(".phone-code-ring line").length, mints: window.__ticketMints };`);
  say("Wink: window blur blanks the ring (reviewer's #2), no re-mint", blurred.ticks === 0 && blurred.mints === 1, JSON.stringify(blurred));
  await tab.run(`window.dispatchEvent(new Event("focus")); await wait(50); return true;`);
  const refocused = await tab.run(`return { ticks: document.querySelectorAll(".phone-code-ring line").length, mints: window.__ticketMints };`);
  say("Wink: focus redraws the still-live ticket, no re-mint", refocused.ticks === 72 && refocused.mints === 1, JSON.stringify(refocused));

  // 4d. document hidden blanks it too (a real tab-hide can't be simulated headlessly, so
  // visibilityState is stubbed for this one check, same technique as the fake clock above).
  await tab.run(`Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange")); await wait(50); return true;`);
  const hidden = await tab.run(`return document.querySelectorAll(".phone-code-ring line").length;`);
  say("Wink: document hidden blanks the ring too (reviewer's #2)", hidden === 0, `ticks ${hidden}`);
  await tab.run(`Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange")); await wait(50); return true;`);

  // 4e. The fixture's expiresAt is a fixed epoch (deck/fixtures/relay.json, 1893456000000): jump
  // the fake clock just past it, rather than a real mint's ~5 min, since this fixture's TTL was
  // never meant to be read literally (see the note above). Expiry swaps to the idle avatar too.
  await tab.run(`window.__fakeNow = 1893456000000 + 2000; await wait(1200); return true;`);
  const expired = await tab.run(`return { text: document.querySelector(".phone-code-meta").textContent, ticks: document.querySelectorAll(".phone-code-ring line").length };`);
  say("Wink: the ticket actually expires (a forced clock, not a real wait)", /expired/i.test(expired.text), JSON.stringify(expired));
  say("Wink: expiry swaps to the idle avatar (reviewer's #2), not a dimmed stale ring", expired.ticks === 0, `ticks ${expired.ticks}`);
  await tab.run(`window.__fakeNow = null; return true;`);

  // 4f. relay.paired: the dance, then name + fingerprint + Remove (reviewer's #5).
  await tab.run(`const api = await import("/js/api.js");
    api.hear({ id: 999999, at: Date.now(), type: "relay.paired", source: "relay", project: null, thread: null,
      payload: { device: "dev_test_wink", name: "Wink Test Phone", fingerprint: "AB12 CD34" } });
    return true;`);
  await tab.run(`await waitFor(".phone-code-connected", 4000); return true;`);
  const connected = await tab.run(`return {
    text: document.querySelector(".phone-code-connected .h3")?.textContent || "",
    name: document.querySelector(".phone-code-connected input")?.value || "",
    fingerprint: document.querySelector(".phone-code-connected .mono")?.textContent || "",
    actionLabels: [...document.querySelectorAll(".phone-code-actions .btn")].map(b => b.textContent),
    leftoverDance: document.querySelectorAll(".phone-code-ms-done, .phone-code-confetti-bit").length,
  };`);
  say("Wink: relay.paired shows the connected state with the device's own name", /connected/i.test(connected.text) && connected.name === "Wink Test Phone", JSON.stringify(connected));
  say("Wink: the device's key fingerprint shows too", connected.fingerprint === "AB12 CD34", JSON.stringify(connected));
  say("Wink: the dance's classes/confetti clean up after themselves", connected.leftoverDance === 0, `left ${connected.leftoverDance}`);
  say("Wink: \"Add another device\" and Remove are both offered", connected.actionLabels.includes("Add another device") && connected.actionLabels.includes("Remove"), JSON.stringify(connected.actionLabels));
  await shot("wink-connected", ".phone-code-body");

  // 4g. "Add another device" is itself an explicit tap: mints again (a second real call, not a
  // leftover from 4b), same one-ticket-shown rule.
  await tab.run(`[...document.querySelectorAll(".phone-code-actions .btn")].find(b => b.textContent === "Add another device").click();
    await waitFor(".phone-code-ring line", 4000); return true;`);
  const again = await tab.run(`return { ticks: document.querySelectorAll(".phone-code-ring line").length, mints: window.__ticketMints, hasConnected: !!document.querySelector(".phone-code-connected") };`);
  say("Wink: \"Add another device\" mints a fresh ring", again.ticks === 72 && again.mints === 2 && !again.hasConnected, JSON.stringify(again));

  say("no page errors", tab.errors.length === 0, tab.errors.slice(0, 3).join(" | "));
  process.stdout.write(JSON.stringify({ shots: OUT }) + "\n");
} catch (e) {
  say("ran", false, String(/** @type {Error} */ (e).stack || e));
} finally {
  await stopAll();
  process.exit(failed ? 1 : 0);
}
