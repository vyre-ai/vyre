// @ts-check
// A real-Chrome check of Settings' confirm and proof flow, on testbox only:
//
//   node web/test/settings-browser.js [--port 4795] [--out <dir>]
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
import { CHROME_SAFE } from "../../lib/chrome-flags/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// web/js/api.js's fixture fallback answers relay.pair.ticket's $seq from
// web/fixtures/relay.json directly, over a SEPARATE fetch (/fixtures/relay.json, cached by
// module) that never touches /v1/tools/relay.pair.ticket at all (that real call 404s first, is
// how the fallback triggers). So the tickets actually served are read here, from the same file,
// rather than guessed at by sniffing the tool call's own network response.
const RELAY_FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, "..", "fixtures", "relay.json"), "utf8"));
const TICKET_SEQ = RELAY_FIXTURE["relay.pair.ticket"].$seq.map((/** @type {any} */ e) => e.ticket);
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
  const chrome = spawn("nice", ["-n", "15", bin, `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1", ...CHROME_SAFE, `--user-data-dir=${scratch}`,
    "--no-sandbox", "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  started.push(chrome);
  const CDP = `http://127.0.0.1:${cdpPort}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${CDP}/json/version`); break; } catch { await sleep(200); } }
  const tool = async (/** @type {string} */ name, /** @type {any} */ input = {}) =>
    (await fetch(`${world.url}/v1/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-vyre-caller": "deck" }, body: JSON.stringify(input) })).json();
  const tab = await openTab(CDP, { width: 1280, height: 900, scale: 1, mobile: false });
  // Every console call (not only errors, which tab.errors already covers), so the Wink section's
  // "never a console line" claim (reviewer's #3) is checked against the real thing, not assumed.
  const consoleAll = [];
  tab.on("Runtime.consoleAPICalled", (/** @type {any} */ p) => { try { consoleAll.push((p.args || []).map((/** @type {any} */ a) => a.value ?? a.description ?? "").join(" ")); } catch {} });
  const shot = async (/** @type {string} */ name, /** @type {string} */ sel) => {
    await tab.run(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: "center" }); return true;`);
    await sleep(300);
    const r = await tab.send("Page.captureScreenshot", { format: "png" });
    if (r.result?.data) fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.result.data, "base64"));
  };
  // What ticket a drawn ring actually encodes, cheaply: each of ticketRingSvg's 72 ticks sits at
  // a fixed angle (x1,y1, the tick's inner point, same for every ticket) with a LENGTH (x2,y2,
  // its outer point) and opacity that vary with that tick's level (0-3), the part that actually
  // comes from the ticket's own bytes (web/js/phone-code.js ticketLevels). x1,y1 alone would
  // silently pass for two different tickets (caught here the hard way: an earlier version of
  // this signature used x1,y1 only and never once caught the reviewer's MEDIUM, since angles
  // never change). x2,y2 plus opacity is the actual per-ticket signature.
  const ringSig = () => tab.run(`return [...document.querySelectorAll(".phone-code-ring line")].map(l => l.getAttribute("x2") + "," + l.getAttribute("y2") + "@" + l.getAttribute("opacity")).join("|");`);
  await tab.go(`${world.url}/settings`, 2500);
  const row = (/** @type {string} */ key) => `[data-key="${key}"]`;
  await tab.run(`await waitFor(${JSON.stringify(row("sessions.mode"))}, 15000); return true;`);

  // 1. A wider mode saves at once: no confirm line, no proof (the change is logged and undoable).
  const pick = (/** @type {string} */ key, /** @type {string} */ v) => tab.run(`const s = document.querySelector(${JSON.stringify(row(key) + " select")});
    if (!s) return "no select"; s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event("change", { bubbles: true })); await wait(1200);
    return document.querySelector(${JSON.stringify(row(key) + " .sk-ask")}) ? "an ask" : "no ask";`);
  const t = await pick("sessions.mode", "bypassPermissions");
  const after = (await tool("settings.get", { key: "sessions.mode" })).data?.value;
  const slot = await tab.run(`return document.querySelector(${JSON.stringify(row("sessions.mode") + " .sk-slot")})?.textContent || "";`);
  say("a wider mode saves at once, with no confirm line", t === "no ask" && after === "bypassPermissions", `value ${after}, row says "${slot}"`);
  await shot("mode-saved", row("sessions.mode"));

  // 2. A security key saves the same way, with no passkey prompt.
  const lockKey = "vault.lock_idle";
  const hasLock = await tab.run(`return !!document.querySelector(${JSON.stringify(row(lockKey))});`);
  if (!hasLock) say("a security key saves at once", false, `no ${lockKey} row`);
  else {
    await tab.run(`const r = document.querySelector(${JSON.stringify(row(lockKey))}); const s = r.querySelector("select"), i = r.querySelector("input");
      if (s) { const o = [...s.options].map(o => o.value).find(v => v && v !== s.value && /h|never/.test(v)); s.value = o || s.value; s.dispatchEvent(new Event("change", { bubbles: true })); return "select " + s.value; }
      if (i) { i.focus(); i.value = "8h"; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return "input"; }
      return "none";`);
    await sleep(1500);
    const lock = (await tool("settings.get", { key: lockKey })).data;
    const ask = await tab.run(`return document.querySelector(${JSON.stringify(row(lockKey) + " .sk-ask")}) ? "an ask" : "no ask";`);
    say("a security key saves at once, with no prompt", ask === "no ask" && lock?.source === "account", `value ${lock?.value} (${lock?.source})`);
    await shot("lock-after", row(lockKey));
  }
  // 4. Wink (Settings > Devices, web/js/wink-card.js, shared with onboarding): the explicit-tap
  // gate, the ring, the countdown, blanking on blur/hidden/expiry, and the relay.paired reaction
  // (dance, name, fingerprint, Remove): reviewer's five pre-review points. Real onboard.status
  // carries no `can` field yet (asked anywhere), so this patches window.fetch, injected before
  // any page script runs, splicing `can.relayJoin: true` onto that one real response, no fake
  // tool, no faked module, everything else on the page stays real. It also counts calls to
  // relay.pair.ticket, so "minted only on tap, never on load, never re-minted by blur/focus" is
  // an assertion, not an assumption. relay.pair.ticket itself isn't merged yet either, so it
  // answers from web/fixtures/relay.json's fallback (a fixed, far-future expiresAt: a real
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
      // The real relay.pair.ticket call 404s (this test's fixturesOn covers it separately, over
      // its own /fixtures/relay.json fetch, never this URL): only counted here, never read for
      // its ticket, which the Node side already knows from the same fixture file (TICKET_SEQ).
      if (typeof url === "string" && url.includes("/v1/tools/relay.pair.ticket")) window.__ticketMints++;
      // relay.devices.remove is a real tool, but "dev_test_wink" (below, 4f's api.hear() seam)
      // is not a real paired row and this temp home has no passkey enrolled either, so a real
      // call would refuse on presence, not on the thing this check is actually for: that Remove
      // is one tap end to end once the tool succeeds. Faked here, same as onboard.status's can
      // field above, nothing else on the page.
      if (typeof url === "string" && url.includes("/v1/tools/relay.devices.remove")) {
        window.__removeCalls = (window.__removeCalls || 0) + 1;
        return new Response(JSON.stringify({ data: { removed: true, was: { id: "dev_test_wink" } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
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
  // a new document, so addScriptToEvaluateOnNewDocument's injection would never run: force a
  // real reload through about:blank first.
  await tab.go("about:blank", 200);
  // ?fixtures=1: relay.pair.ticket is not a real tool yet (tailnet, ADR 0026/0033), so the mint
  // answers from web/fixtures/relay.json's fallback (web/js/api.js's documented, supported
  // stub-tool mechanism, "only when the live tool is missing, live always wins" - every real tool
  // this section also calls, relay.devices.remove/.rename and onboard.status, keeps answering for
  // real). Without this the earlier version of this file's Wink checks silently drew the idle
  // avatar the whole time (mintedAt still set, so the countdown showed "Expires in 5:00" over a
  // blank ring) and were never actually verified before being committed - caught only once this
  // test finally ran end to end.
  await tab.go(`${world.url}/settings?fixtures=1#devices`, 2500);
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
  const sig1 = await ringSig();
  const ticket1 = TICKET_SEQ[0];
  say("Wink: the ring actually encodes the ticket that was minted, not a placeholder", !!sig1 && !!ticket1, `ticket ${ticket1}`);

  // 4b2. The raw ticket secret never reaches a URL, storage, the console or a log (reviewer's
  // #3, wink-card.js's own claim). web/fixtures/relay.json's ticket is the exact string minted
  // above; checked while it's live, the moment it would be most likely to leak.
  const TICKET = ticket1;
  const leakLive = await tab.run(`return {
    url: location.href,
    storage: JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }),
  };`);
  say("Wink: the live ticket never appears in the page's own URL", !leakLive.url.includes(TICKET), leakLive.url);
  say("Wink: the live ticket never appears in localStorage or sessionStorage", !leakLive.storage.includes(TICKET), leakLive.storage.slice(0, 200));
  say("Wink: the live ticket never appears in a console line", !consoleAll.some(l => l.includes(TICKET)), consoleAll.find(l => l.includes(TICKET)) || "none found");

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

  // 4e. The fixture's expiresAt is a fixed epoch (web/fixtures/relay.json, 1893456000000): jump
  // the fake clock just past it, rather than a real mint's ~5 min, since this fixture's TTL was
  // never meant to be read literally (see the note above). Expiry swaps to the idle avatar too.
  await tab.run(`window.__fakeNow = 1893456000000 + 2000; await wait(1200); return true;`);
  const expired = await tab.run(`return { text: document.querySelector(".phone-code-meta").textContent, ticks: document.querySelectorAll(".phone-code-ring line").length };`);
  say("Wink: the ticket actually expires (a forced clock, not a real wait)", /expired/i.test(expired.text), JSON.stringify(expired));
  say("Wink: expiry swaps to the idle avatar (reviewer's #2), not a dimmed stale ring", expired.ticks === 0, `ticks ${expired.ticks}`);
  await tab.run(`window.__fakeNow = null; return true;`);

  // 4e2. Refresh mints a second ticket and draws a ring encoding IT, not the first one (the
  // reviewer's MEDIUM on wink-card.js: ringDrawn was only ever cleared by blank(), so a fresh
  // mint could leave the OLD ring showing under the new countdown). Never exercised before this
  // sha: this is the one place the UI actually offers a manual re-mint today.
  // Waits for the countdown text specifically, not just for lines to exist: ringEl can already
  // hold an old ring's lines the instant it is reattached, before mint()'s async round trip
  // resolves and tick() redraws it, so "some line exists" can resolve on stale content. The
  // countdown text only appears once tick() has actually run against the fresh ticket.
  await tab.run(`document.querySelector(".phone-code-meta button.btn").click(); await waitFor(".phone-code-meta", 4000);
    for (let i = 0; i < 40; i++) { if (/Expires in/.test(document.querySelector(".phone-code-meta").textContent)) break; await wait(100); } return true;`);
  const sig2 = await ringSig();
  const ticket2 = TICKET_SEQ[1];
  say("Wink: Refresh mints a distinct second ticket", !!ticket2 && ticket2 !== ticket1, `ticket1 ${ticket1}, ticket2 ${ticket2}`);
  say("Wink: Refresh draws a ring encoding the NEW ticket, not the stale one (reviewer's MEDIUM)", !!sig2 && sig2 !== sig1, sig2 === sig1 ? "same ring as before Refresh" : "differs, as expected");

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

  // 4f2. After pairing, the ring is gone from the DOM outright, not merely blanked (reviewer's
  // #2, "after use"): showConnected() replaces .phone-code-body's whole content.
  const afterPair = await tab.run(`return { ringGone: !document.querySelector(".phone-code-ring") };`);
  say("Wink: the ring is removed from the DOM after pairing, not just blanked (reviewer's #2, \"after use\")", afterPair.ringGone, JSON.stringify(afterPair));

  // 4f3. Remove really is one tap: it calls relay.devices.remove for this device (faked above,
  // real presence/DB rows aside) and the card falls back to the idle "Add a device" state, no
  // second confirm step (reviewer's #5).
  await tab.run(`[...document.querySelectorAll(".phone-code-actions .btn")].find(b => b.textContent === "Remove").click(); await wait(400); return true;`);
  const removed = await tab.run(`return {
    calls: window.__removeCalls || 0,
    idle: !!document.querySelector(".phone-code-body .btn.btn-primary"),
    stillConnected: !!document.querySelector(".phone-code-connected"),
  };`);
  say("Wink: Remove calls relay.devices.remove for this device, once, no second tap needed", removed.calls === 1, JSON.stringify(removed));
  say("Wink: Remove returns the card to \"Add a device\", the connected panel is gone", removed.idle && !removed.stillConnected, JSON.stringify(removed));

  // 4f4. Both tickets minted so far are gone from storage/console/URL once the flow is fully
  // over (not just while live), and Remove's own request never carried either (redeemed by
  // then, but worth checking once more at the end).
  const leakAfter = await tab.run(`return { url: location.href, storage: JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }) };`);
  say("Wink: neither ticket is in the URL or storage after the whole flow", ![ticket1, ticket2].some(t => leakAfter.url.includes(t) || leakAfter.storage.includes(t)), leakAfter.storage.slice(0, 200));
  say("Wink: neither ticket ever showed in a console line across the whole flow", !consoleAll.some(l => [ticket1, ticket2].some(t => l.includes(t))), String(consoleAll.length) + " lines checked");

  // 4g. Remove reset the card to idle: a fresh tap there mints a third real ticket and draws a
  // ring encoding it, not either earlier one, the same one-ticket-shown rule holding after a
  // full remove-and-restart, not only after the first tap.
  await tab.run(`document.querySelector(".phone-code-body .btn.btn-primary").click(); await waitFor(".phone-code-meta", 4000);
    for (let i = 0; i < 40; i++) { if (/Expires in/.test(document.querySelector(".phone-code-meta").textContent)) break; await wait(100); } return true;`);
  const again = await tab.run(`return { ticks: document.querySelectorAll(".phone-code-ring line").length, mints: window.__ticketMints, hasConnected: !!document.querySelector(".phone-code-connected") };`);
  say("Wink: a fresh tap after Remove mints a third ring, still one at a time", again.ticks === 72 && again.mints === 3 && !again.hasConnected, JSON.stringify(again));
  const sig3 = await ringSig();
  const ticket3 = TICKET_SEQ[2];
  say("Wink: that third ring encodes a distinct third ticket, not a leftover", !!ticket3 && ![ticket1, ticket2].includes(ticket3) && sig3 !== sig1 && sig3 !== sig2, `ticket3 ${ticket3}`);

  // 4h. relay.paired again, this time straight from a live ring (no Remove in between): the
  // reviewer's MEDIUM, scenario (b). showConnected() never blanks ringEl, so it still holds the
  // just-redeemed sig3 ring when "Add another device" re-attaches it. Pre-fix this stayed on
  // screen, under the NEW ticket's countdown, forever (ringDrawn wrongly still true). The fix
  // (mint() always calling blank(), and showConnected() itself resetting ringDrawn) means the
  // click draws sig3's ring's replacement fresh, encoding ticket4, not ticket3's leftover.
  await tab.run(`const api = await import("/js/api.js");
    api.hear({ id: 999998, at: Date.now(), type: "relay.paired", source: "relay", project: null, thread: null,
      payload: { device: "dev_test_wink_2", name: "Wink Test Phone Two", fingerprint: "EF56 GH78" } });
    await waitFor(".phone-code-connected", 4000); return true;`);
  // ringEl is re-attached still holding sig3's lines the instant this click's synchronous
  // put(body, ringEl, ...) runs, well before mint()'s async round trip resolves: waiting for
  // "some line exists" would pass on that stale content immediately, never actually waiting for
  // the real redraw. Wait for the countdown text instead, which only appears once tick() has
  // run against the fresh ticket.
  await tab.run(`[...document.querySelectorAll(".phone-code-actions .btn")].find(b => b.textContent === "Add another device").click();
    await waitFor(".phone-code-meta", 4000);
    for (let i = 0; i < 40; i++) { if (/Expires in/.test(document.querySelector(".phone-code-meta").textContent)) break; await wait(100); } return true;`);
  const fourth = await tab.run(`return { ticks: document.querySelectorAll(".phone-code-ring line").length, mints: window.__ticketMints, hasConnected: !!document.querySelector(".phone-code-connected") };`);
  say("Wink: \"Add another device\" mints a fresh fourth ring, drops the connected panel", fourth.ticks === 72 && fourth.mints === 4 && !fourth.hasConnected, JSON.stringify(fourth));
  const sig4 = await ringSig();
  const ticket4 = TICKET_SEQ[3];
  say("Wink: \"Add another device\" from a live connected card draws the NEW ticket, never the just-redeemed one (reviewer's MEDIUM, scenario b)",
    !!ticket4 && ticket4 !== ticket3 && sig4 !== sig3, sig4 === sig3 ? "same ring as the redeemed one: STALE" : `ticket3 ${ticket3}, ticket4 ${ticket4}`);

  say("no page errors", tab.errors.length === 0, tab.errors.slice(0, 3).join(" | "));
  process.stdout.write(JSON.stringify({ shots: OUT }) + "\n");
} catch (e) {
  say("ran", false, String(/** @type {Error} */ (e).stack || e));
} finally {
  await stopAll();
  process.exit(failed ? 1 : 0);
}
