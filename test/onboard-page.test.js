// @ts-check
// The onboarding page itself in headless Chrome, not only its tools: a real vyred in a temp home
// with no vyre.run zone token (every box that has not set one), the one-time link, and the page
// driven over the DevTools protocol. test/onboard.test.js and test/journey.test.js call the tools
// directly, which is how a Continue button that could never turn on went unnoticed.

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

const CHROME_BIN = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HAVE_CHROME = fs.existsSync(CHROME_BIN);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A fake executable that prints `out` for any arguments. */
function fakeBin(dir, name, out) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\ncat <<'EOF'\n${out}\nEOF\n`, { mode: 0o755 });
  return p;
}

/** Headless Chrome with its own profile, and one page driven over CDP. */
async function chrome(t, dir) {
  const profile = fs.mkdtempSync(path.join(dir, "chrome-"));
  const child = spawn(CHROME_BIN, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
    "--no-default-browser-check", "--window-size=1280,900", "about:blank"], { stdio: "ignore", detached: true });
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

test("onboard page: step 1 takes a name on a box with no vyre.run token, and says it goes on the tailnet",
  { skip: !HAVE_CHROME && "no Chrome binary at " + CHROME_BIN }, async t => {
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
    // and Claude sign-in. Unified per the lead: every choice here (Solo, Server, or Device, this
    // test picks Device) skips the old tailscale/name screens outright — they only run later,
    // when a second device actually joins (Settings > Your devices > Add a device), not during
    // this step. onboard.join isn't a real server tool yet (core/join folded into onboard.join,
    // work/tailnet 5807096d, not on main), so typing any code and continuing degrades gracefully
    // straight through to Claude sign-in, same as a stub step — the "missing tool" path, not the
    // "the tool answered and said no" path the next test below covers.
    await page.until(`location.hash === "#live"`, "the how-will-vyre-run step");
    await page.run(`document.querySelector('input[name="live"][value="device"]').click()`);
    await page.run(`document.querySelector("#join-code").value = "test-code"; document.querySelector("#join-code").dispatchEvent(new Event("input", { bubbles: true }))`);
    await page.run(`document.querySelector("#primary").click()`);
    await page.until(`location.hash === "#claude"`, "Claude sign-in, straight through");
    const saved = config.load(root);
    assert.equal(saved.name, "alex");
    assert.equal(saved.onboard.person, "alex");
    assert.deepEqual([...(saved.onboard.skipped || [])].sort(), ["name", "tailscale"],
      "the old pairing screens are skipped, not shown, for the Device choice too");
  });

  test("onboard page: \"How will Vyre run?\" Device with a wrong code stays on the step and says so (reviewer-2's caught bug)",
    { skip: !HAVE_CHROME && "no Chrome binary at " + CHROME_BIN }, async t => {
      // Regression for a real bug: the Device branch checked only the call's error, never
      // whether onboard.join actually said the server was reachable (link.health's real shape
      // is `online`, not `ok`/`reachable`), so a wrong code proceeded to Claude sign-in exactly
      // like a right one. No real onboard.join exists yet to answer this for real, so this test
      // drives it through the Deck's own fixtures (?fixtures=1, deck/js/api.js), whose
      // onboard.join `verify` case answers `online: false` for node "wrong-code" specifically.
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
      // link.data.url is the one-time ?t=<token> link, which the server redeems itself and
      // redirects to the stable /onboard#s=<session> address, stored in this tab's
      // sessionStorage (onboard.js's `ss.setItem("vyre.onboard", sid)`). Turning fixtures on
      // (?fixtures=1, deck/js/api.js) is a second, same-tab navigation once that's settled, not
      // appended to the one-time link itself (which already has its own ?t= query and a
      // redirect that would not carry a second query param through).
      await page.send("Page.navigate", { url: link.data.url });
      await page.until(`document.querySelector("#name")`, "the name field");
      const settled = await page.run(`return location.href;`);
      const hashAt = settled.indexOf("#");
      const base = hashAt < 0 ? settled : settled.slice(0, hashAt);
      const frag = hashAt < 0 ? "" : settled.slice(hashAt);
      const withFixtures = base + (base.includes("?") ? "&" : "?") + "fixtures=1" + frag;
      await page.send("Page.navigate", { url: withFixtures });
      await page.until(`document.querySelector("#name")`, "the name field, back after turning fixtures on");
      await page.run(`document.querySelector("#name").focus()`);
      await page.send("Input.insertText", { text: "juno" });
      await page.until(`!document.querySelector("#primary").disabled`, "Continue turn on");

      await page.run(`document.querySelector("#primary").click()`);
      await page.until(`location.hash === "#live"`, "the how-will-vyre-run step");
      await page.run(`document.querySelector('input[name="live"][value="device"]').click()`);
      await page.run(`document.querySelector("#join-code").value = "wrong-code"; document.querySelector("#join-code").dispatchEvent(new Event("input", { bubbles: true }))`);
      await page.run(`document.querySelector("#primary").click()`);
      const said = await page.until(
        `/did not reach a server|offline/i.test(document.querySelector("#ob .check-line")?.innerText || "") && document.querySelector("#ob .check-line").innerText`,
        "an error line for the wrong code");
      assert.match(said, /did not reach a server|offline/i);
      assert.equal(await page.run(`return location.hash;`), "#live", "stays on the step, never Claude sign-in on a wrong code");
    });

test("onboard page: \"How will Vyre run?\" Solo skips Tailscale and the address, landing on Claude sign-in",
  { skip: !HAVE_CHROME && "no Chrome binary at " + CHROME_BIN }, async t => {
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
