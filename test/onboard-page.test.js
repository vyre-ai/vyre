// @ts-check
// The onboarding page itself in headless Chrome, not only its tools: a real vyred in a temp home
// with no vyre.run zone token (every box that has not set one), the one-time link, and the page
// driven over the DevTools protocol. test/onboard.test.js and test/journey.test.js call the tools
// directly, which is how a Continue button that could never turn on went unnoticed.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import * as config from "../core/config/index.js";
import { tempHome } from "./helpers.js";
import { CHROME_SAFE } from "../lib/chrome-flags/index.js";

// This test drives the Deck through its sample data (?fixtures=1), which a box serves only to dev worlds.
process.env.VYRE_DECK_FIXTURES = "1";

// An explicit override, then a real Chrome for local Mac use, then testbox's own
// chrome-headless-shell (deck/test's own default path, e.g. deck/test/settings-browser.js):
// without this second fallback these tests silently skip on testbox, which has no Chrome.app, so
// they never actually ran there (caught only once CI ran them for real on a Mac runner).
const CHROME_CANDIDATES = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  path.join(os.homedir(), "vyre-ci/pwa-chrome/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell")].filter(Boolean);
const CHROME_BIN = CHROME_CANDIDATES.find(p => fs.existsSync(p)) || CHROME_CANDIDATES[0];
const HAVE_CHROME = fs.existsSync(CHROME_BIN);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A fake executable that prints `out` for any arguments. */
function fakeBin(dir, name, out) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\ncat <<'EOF'\n${out}\nEOF\n`, { mode: 0o755 });
  return p;
}

/** Headless Chrome with its own profile, and one page driven over CDP. chrome-headless-shell
 * (testbox's own binary) is already headless with no window to make invisible, and rejects
 * --no-default-browser-check; --headless=new and --no-sandbox are both needed for a real
 * Chrome.app under CI/no display, and harmless either way for headless-shell. */
async function chrome(t, dir) {
  const isShell = /headless-shell/.test(CHROME_BIN);
  const profile = fs.mkdtempSync(path.join(dir, "chrome-"));
  const args = [...(isShell ? [] : ["--headless=new"]), "--remote-debugging-port=0", ...CHROME_SAFE, `--user-data-dir=${profile}`, "--no-first-run", "--no-sandbox",
    ...(isShell ? [] : ["--no-default-browser-check"]), "--window-size=1280,900", "about:blank"];
  const child = spawn(CHROME_BIN, args, { stdio: "ignore", detached: true });
  // Chrome writes its profile until it exits, and tempHome's own cleanup may already have run:
  // wait for the exit, then remove the profile, or a late write brings the home back.
  t.after(async () => {
    // The whole group: Chrome's helpers outlive the browser and keep writing the profile.
    const gone = child.exitCode === null ? Promise.race([new Promise(r => child.once("exit", r)), sleep(3000)]) : null;
    try { process.kill(-(/** @type {number} */ (child.pid)), "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
    await gone;
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    try { fs.rmdirSync(dir); } catch {} // only when tempHome already removed the rest
  });
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    try { port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {}
  }
  assert.ok(port, "Chrome did not start");
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(x => x.type === "page"); } catch {}
    if (!target) await sleep(100);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  t.after(() => ws.close());
  let id = 0;
  const pending = new Map();
  ws.onmessage = m => { const d = JSON.parse(String(m.data)); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  /** @param {string} js the body of an async function run in the page */
  const run = async js => {
    const r = await send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => { ${js} })()` });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  /** Wait until the page expression is truthy. */
  const until = async (js, what, ms = 10_000) => {
    for (let t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) { const v = await run(`return ${js}`).catch(() => null); if (v) return v; }
    throw new Error(`the page never showed ${what}`);
  };
  return { send, run, until };
}

/** ?fixtures=1 goes before the #fragment, not after (a real query param, read by location.search
 * in deck/js/api.js), and never onto the one-time ?t=<token> link itself (a second query param
 * there would not survive its own redirect) — always call this on the settled URL. */
const withFixtures = url => {
  const hashAt = url.indexOf("#");
  const base = hashAt < 0 ? url : url.slice(0, hashAt);
  const frag = hashAt < 0 ? "" : url.slice(hashAt);
  return base + (base.includes("?") ? "&" : "?") + "fixtures=1" + frag;
};

// A server has no first-run page since b3ef6ad78 (onboard.link refuses on a box). These four walk that page on a role "box" home, so they wait for the Solo Deck loopback design (docs/design/anywhere.md), which reuses the link.
const PAGE_GONE = "a server has no setup page (b3ef6ad78); these return with the Solo Deck loopback link";

test("onboard page: step 1 takes a name on a box with no vyre.run token, and says it goes on the tailnet",
  { skip: PAGE_GONE }, async t => {
    const root = tempHome(t);
    const bins = fs.mkdtempSync(path.join(root, "bin-"));
    const env = { VYRE_TAILSCALE_BIN: process.env.VYRE_TAILSCALE_BIN, VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, CLOUDFLARE_VYRE_TOKEN: process.env.CLOUDFLARE_VYRE_TOKEN };
    process.env.VYRE_TAILSCALE_BIN = fakeBin(bins, "tailscale", JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/fake", TUN: true,
      OperatorUser: os.userInfo().username }));
    process.env.VYRE_CLAUDE_BIN = fakeBin(bins, "claude", "2.1.0 (Claude Code)");
    delete process.env.CLOUDFLARE_VYRE_TOKEN;
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], network: { onboardPort: 0 } }));
    const d = await start({ root, log: () => {} });
    t.after(async () => {
      await d.stop();
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    });

    const link = await call("onboard.link", {}, { root });
    assert.ok(link.data, JSON.stringify(link.error));
    const page = await chrome(t, root);
    // Last, after vyred's stop and Chrome's exit: tempHome's own cleanup runs first (after-hooks
    // run in the order they were added), and the late writes of both brought the home back.
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    await page.send("Page.enable");
    await page.send("Page.navigate", { url: link.data.url });
    await page.until(`document.querySelector("#name")`, "the name field");

    await page.run(`document.querySelector("#name").focus()`);
    await page.send("Input.insertText", { text: "alex" });
    const note = await page.until(`!document.querySelector("#primary").disabled && document.querySelector("#name-status").innerText`, "Continue turn on");
    assert.match(note, /tailnet/, "the note says where the address will be");
    assert.doesNotMatch(note, /not free|could not check/);

    await page.run(`document.querySelector("#primary").click()`);
    // "How will Vyre run?" (28 Sep, docs/design/anywhere.md, ADR 0039) now sits between step 1
    // and pairing. This test picks Device: unlike Solo/Server, a device DOES still need to join
    // Tailscale (tailnet: "the Tailscale path... your 'Connect' button is onboard.join{action:
    // 'tailscale', step:'connect'}... no code exchanged"), so it reaches the same "tailscale"
    // screen a fresh Server setup would, once it has the server's tailnet name. This fake
    // tailscale reports NeedsLogin, so it stops there, same as any first-run sign-in would.
    await page.until(`location.hash === "#live"`, "the how-will-vyre-run step");
    await page.run(`document.querySelector('input[name="live"][value="device"]').click()`);
    // On this platform (never darwin here: testbox and CI are both Linux) canRelayJoin reads
    // true, so "Pair with a code" (relay) is the device-via default and the manual tailnet-name
    // field lives under the "Use my own Tailscale setup" advanced fallback: open it and pick
    // tailscale explicitly, same as a person who already runs their own Tailscale would.
    await page.until(`document.querySelector('input[name="device-via"][value="tailscale"]')`, "the \"Use my own Tailscale setup\" fallback");
    await page.run(`document.querySelector(".ob-collapse").open = true; document.querySelector('input[name="device-via"][value="tailscale"]').click()`);
    await page.until(`document.querySelector("#server-node")`, "the tailnet-name field");
    await page.run(`document.querySelector("#server-node").value = "kit"; document.querySelector("#server-node").dispatchEvent(new Event("input", { bubbles: true }))`);
    await page.run(`document.querySelector("#primary").click()`);
    await page.until(`location.hash === "#tailscale"`, "still needs to join Tailscale, even as a device");
    const saved = config.load(root);
    // The name typed in step 1 is the person's, never the address (#50): it saves the person only.
    assert.equal(saved.onboard.person, "alex");
    assert.notEqual(saved.name, "alex");
    assert.equal(saved.name, undefined, "the person's name is never config.name");
    // Where onboard.status reads it: the person's name, from the person's own surface.
    const status = await call("onboard.status", {}, { root, caller: "cli" });
    assert.equal(status.data && status.data.name, "alex", JSON.stringify(status.error));
    assert.equal(status.data.person, "alex");
  });

test("onboard page: Device, already on the same Tailscale network, verifies the server's name before proceeding (reviewer-2's caught bug)",
  { skip: PAGE_GONE }, async t => {
    // Regression for a real bug: the Device branch checked only the call's error, never
    // whether onboard.join actually said the server was reachable (link.health's real shape
    // is `online`, not `ok`/`reachable`), so a wrong node proceeded to Claude sign-in exactly
    // like a right one. No real onboard.join exists yet to answer this for real, so this test
    // drives it through the Deck's own fixtures (?fixtures=1, deck/js/api.js), whose
    // onboard.join `verify` case answers `online: false` for node "wrong-node" specifically
    // and `online: true` for anything else (deck/fixtures/onboard.json).
    const root = tempHome(t);
    const bins = fs.mkdtempSync(path.join(root, "bin-"));
    const env = { VYRE_TAILSCALE_BIN: process.env.VYRE_TAILSCALE_BIN, VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, CLOUDFLARE_VYRE_TOKEN: process.env.CLOUDFLARE_VYRE_TOKEN };
    // Already connected (BackendState: Running), same shape test/onboard.test.js's own
    // reserve/cert tests use: this device is on the tailnet already, so the "tailscale" screen
    // (which Device still runs, unlike Solo/Server) reaches its `signed` state at once, no
    // sign-in click to simulate.
    process.env.VYRE_TAILSCALE_BIN = fakeBin(bins, "tailscale", JSON.stringify({ BackendState: "Running", TUN: true,
      Self: { HostName: "alex-box", DNSName: "alex-box.tail1.ts.net.", TailscaleIPs: ["100.64.0.9"], ID: "n1", UserID: 1 }, User: {}, CertDomains: [], OperatorUser: os.userInfo().username }));
    process.env.VYRE_CLAUDE_BIN = fakeBin(bins, "claude", "2.1.0 (Claude Code)");
    delete process.env.CLOUDFLARE_VYRE_TOKEN;
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], network: { onboardPort: 0 } }));
    const d = await start({ root, log: () => {} });
    t.after(async () => {
      await d.stop();
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    });

    const link = await call("onboard.link", {}, { root });
    assert.ok(link.data, JSON.stringify(link.error));
    const page = await chrome(t, root);
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    await page.send("Page.enable");
    // link.data.url is the one-time ?t=<token> link, which the server redeems itself and
    // redirects to the stable /onboard#s=<session> address, stored in this tab's
    // sessionStorage (onboard.js's `ss.setItem("vyre.onboard", sid)`). Turning fixtures on
    // (?fixtures=1, deck/js/api.js) is a second, same-tab navigation once that's settled, not
    // appended to the one-time link itself (which already has its own ?t= query and a
    // redirect that would not carry a second query param through).
    await page.send("Page.navigate", { url: link.data.url });
    await page.until(`document.querySelector("#name")`, "the name field");
    const settled = await page.run(`return location.href;`);
    await page.send("Page.navigate", { url: withFixtures(settled) });
    await page.until(`document.querySelector("#name")`, "the name field, back after turning fixtures on");
    await page.run(`document.querySelector("#name").focus()`);
    await page.send("Input.insertText", { text: "juno" });
    await page.until(`!document.querySelector("#primary").disabled`, "Continue turn on");

    await page.run(`document.querySelector("#primary").click()`);
    await page.until(`location.hash === "#live"`, "the how-will-vyre-run step");
    await page.run(`document.querySelector('input[name="live"][value="device"]').click()`);
    // Same fallback as the other test: canRelayJoin reads true here (never darwin), so the
    // manual tailnet-name field is under "Use my own Tailscale setup", not the device-via
    // default (relay/"Pair with a code").
    await page.until(`document.querySelector('input[name="device-via"][value="tailscale"]')`, "the \"Use my own Tailscale setup\" fallback");
    await page.run(`document.querySelector(".ob-collapse").open = true; document.querySelector('input[name="device-via"][value="tailscale"]').click()`);
    await page.until(`document.querySelector("#server-node")`, "the tailnet-name field");
    await page.run(`document.querySelector("#server-node").value = "wrong-node"; document.querySelector("#server-node").dispatchEvent(new Event("input", { bubbles: true }))`);
    await page.run(`document.querySelector("#primary").click()`);
    await page.until(`location.hash === "#tailscale"`, "already on the tailnet, straight through");

    // Already signed in: "Continue" runs verify at once, no login click needed.
    await page.until(`!document.querySelector("#primary").disabled && document.querySelector("#primary").textContent === "Continue"`, "signed in already");
    await page.run(`document.querySelector("#primary").click()`);
    const said = await page.until(
      `/could not reach|offline/i.test(document.querySelector("#ob .check-line")?.innerText || "") && document.querySelector("#ob .check-line").innerText`,
      "an error line for the wrong node");
    assert.match(said, /could not reach|offline/i);
    assert.equal(await page.run(`return location.hash;`), "#tailscale", "stays on this step, never Claude sign-in, on a wrong node");

    // Fix the node (there is no field on this screen itself, only on "live"; Back and forward
    // again, already-connected Tailscale needs no re-signing-in) and try again: this proceeds.
    await page.run(`[...document.querySelectorAll(".ob-foot button")].find(b => b.textContent === "Back").click()`);
    await page.until(`location.hash === "#live"`, "back to fix the node");
    // deviceVia stayed "tailscale" (client state persists across Back/forward within the page),
    // so the field exists again without re-clicking the via radio; the <details> element's own
    // open/closed attribute is not state and always renders closed, but that only hides it
    // visually, not from the DOM or from a direct value assignment.
    await page.until(`document.querySelector("#server-node")`, "the tailnet-name field, still there");
    await page.run(`document.querySelector("#server-node").value = "kit"; document.querySelector("#server-node").dispatchEvent(new Event("input", { bubbles: true }))`);
    await page.run(`document.querySelector("#primary").click()`);
    await page.until(`location.hash === "#tailscale"`, "still connected, straight through again");
    await page.until(`!document.querySelector("#primary").disabled && document.querySelector("#primary").textContent === "Continue"`, "signed in still");
    await page.run(`document.querySelector("#primary").click()`);
    await page.until(`location.hash === "#claude"`, "the right node proceeds to Claude sign-in");
    const st = await call("onboard.status", {}, { root });
    assert.equal(st.data.steps.tailscale, "done", "tailscale itself really did connect");
    assert.equal(st.data.steps.name, "skipped", "a device never reserves its own address");
  });

test("onboard page: \"How will Vyre run?\" Solo skips Tailscale and the address, landing on Claude sign-in",
  { skip: PAGE_GONE }, async t => {
    const root = tempHome(t);
    const bins = fs.mkdtempSync(path.join(root, "bin-"));
    const env = { VYRE_TAILSCALE_BIN: process.env.VYRE_TAILSCALE_BIN, VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, CLOUDFLARE_VYRE_TOKEN: process.env.CLOUDFLARE_VYRE_TOKEN };
    process.env.VYRE_TAILSCALE_BIN = fakeBin(bins, "tailscale", JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/fake", TUN: true,
      OperatorUser: os.userInfo().username }));
    process.env.VYRE_CLAUDE_BIN = fakeBin(bins, "claude", "2.1.0 (Claude Code)");
    delete process.env.CLOUDFLARE_VYRE_TOKEN;
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], network: { onboardPort: 0 } }));
    const d = await start({ root, log: () => {} });
    t.after(async () => {
      await d.stop();
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    });

    const link = await call("onboard.link", {}, { root });
    assert.ok(link.data, JSON.stringify(link.error));
    const page = await chrome(t, root);
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    await page.send("Page.enable");
    await page.send("Page.navigate", { url: link.data.url });
    await page.until(`document.querySelector("#name")`, "the name field");
    await page.run(`document.querySelector("#name").focus()`);
    await page.send("Input.insertText", { text: "kit" });
    await page.until(`!document.querySelector("#primary").disabled`, "Continue turn on");

    await page.run(`document.querySelector("#primary").click()`);
    await page.until(`location.hash === "#live"`, "the how-will-vyre-run step");
    await page.run(`document.querySelector('input[name="live"][value="solo"]').click()`);
    await page.run(`document.querySelector("#primary").click()`);
    await page.until(`location.hash === "#claude"`, "Claude sign-in, straight through, no pairing at all");

    const st = await call("onboard.status", {}, { root });
    assert.equal(st.data.steps.tailscale, "skipped", "Solo never shows Tailscale");
    assert.equal(st.data.steps.name, "skipped", "Solo never shows the address step");
  });

test("onboard page: \"How will Vyre run?\" Device shows \"Pair with a code\" as the default once anywhere ships can.relayJoin (every non-darwin platform, including this one)",
  { skip: PAGE_GONE }, async t => {
    // Was written when the real onboard.status returned no `can` field at all, so "Pair with a
    // code" stayed unconditionally hidden. can.relayJoin is real now (core/onboard/index.js's
    // canRelayJoin: false only on darwin, true everywhere else, including testbox/CI's Linux),
    // and relay.pair.ticket/relay.join are real and reviewer-cleared, so this platform now gets
    // the real, current design: relay ("Pair with a code") is the device-via default, and the
    // manual tailnet-name field moves under "Use my own Tailscale setup," an advanced fallback
    // (the user's pivot, 28 Sep, docs/work/launch-surfaces.md). Rewritten to assert that.
    const root = tempHome(t);
    const bins = fs.mkdtempSync(path.join(root, "bin-"));
    const env = { VYRE_TAILSCALE_BIN: process.env.VYRE_TAILSCALE_BIN, VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, CLOUDFLARE_VYRE_TOKEN: process.env.CLOUDFLARE_VYRE_TOKEN };
    process.env.VYRE_TAILSCALE_BIN = fakeBin(bins, "tailscale", JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/fake", TUN: true,
      OperatorUser: os.userInfo().username }));
    process.env.VYRE_CLAUDE_BIN = fakeBin(bins, "claude", "2.1.0 (Claude Code)");
    delete process.env.CLOUDFLARE_VYRE_TOKEN;
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], network: { onboardPort: 0 } }));
    const d = await start({ root, log: () => {} });
    t.after(async () => {
      await d.stop();
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    });

    const link = await call("onboard.link", {}, { root });
    assert.ok(link.data, JSON.stringify(link.error));
    const page = await chrome(t, root);
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    await page.send("Page.enable");
    await page.send("Page.navigate", { url: link.data.url });
    await page.until(`document.querySelector("#name")`, "the name field");
    await page.run(`document.querySelector("#name").focus()`);
    await page.send("Input.insertText", { text: "kit" });
    await page.until(`!document.querySelector("#primary").disabled`, "Continue turn on");

    await page.run(`document.querySelector("#primary").click()`);
    await page.until(`location.hash === "#live"`, "the how-will-vyre-run step");
    await page.run(`document.querySelector('input[name="live"][value="device"]').click()`);
    await page.until(`document.querySelector('input[name="device-via"][value="relay"]')`, "the code-pairing option");
    const relayChecked = await page.run(`return document.querySelector('input[name="device-via"][value="relay"]').checked;`);
    assert.equal(relayChecked, true, "relay (\"Pair with a code\") is the device-via default now that can.relayJoin is real and true here");
    assert.equal(await page.run(`return !!document.querySelector("#pair-code");`), true, "its own pairing-code field shows");
    assert.equal(await page.run(`return !!document.querySelector("#server-node");`), false, "the tailnet-name field is not rendered until the advanced fallback is picked");
    const btnLabel = await page.run(`return document.querySelector("#primary").textContent;`);
    assert.equal(btnLabel, "Pair", "the primary action matches the relay default");

    // The advanced fallback still works: picking it reveals the tailnet-name field and changes
    // the primary action, same manual path the earlier tests in this file exercise end to end.
    await page.run(`document.querySelector(".ob-collapse").open = true; document.querySelector('input[name="device-via"][value="tailscale"]').click()`);
    await page.until(`document.querySelector("#server-node")`, "the tailnet-name field, once the fallback is picked");
    assert.equal(await page.run(`return document.querySelector("#primary").textContent;`), "Connect", "the primary action switches to the Tailscale one");

    // Input.insertText (CDP's real-keystroke path, used above for the name field) does not reach
    // #server-node here: it sits inside a <details> this test just forced open with a direct
    // property assignment, not a real click on its own <summary>, and apparently that is not
    // enough for the renderer to treat the field as a real focus/typing target yet. Assigning
    // .value and dispatching input (tests 1 and 2's own pattern for this same field) works
    // regardless, so used here too rather than chasing that CDP/<details> interaction further.
    await page.run(`document.querySelector("#server-node").value = "kit"; document.querySelector("#server-node").dispatchEvent(new Event("input", { bubbles: true }))`);
    await page.run(`document.querySelector("#primary").click()`);
    await page.until(`location.hash === "#tailscale"`, "the advanced fallback still falls through to the Tailscale screen");
  });
