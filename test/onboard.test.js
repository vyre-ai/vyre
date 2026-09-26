// @ts-check
// The onboarding as a browser meets it: a real vyred in a temp home, the one-time link from the
// socket, the loopback listener, the cookie, and only the onboarding tools behind it. Tailscale
// and claude are fake binaries; nothing here reaches the real ones.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { tempHome, writeModule } from "./helpers.js";
import { bindAddress } from "../core/onboard/loopback.js";
import { execFileSync } from "node:child_process";
import { ptyCommand } from "../core/onboard/setup-token.js";

/** A fake executable that prints `out` for any arguments. */
function fakeBin(dir, name, out) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\ncat <<'EOF'\n${out}\nEOF\n`, { mode: 0o755 });
  return p;
}

async function box(t, extra = {}) {
  const root = tempHome(t);
  const bins = fs.mkdtempSync(path.join(root, "bin-"));
  const env = { VYRE_TAILSCALE_BIN: process.env.VYRE_TAILSCALE_BIN, VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, CLOUDFLARE_VYRE_TOKEN: process.env.CLOUDFLARE_VYRE_TOKEN };
  process.env.VYRE_TAILSCALE_BIN = fakeBin(bins, "tailscale", JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/fake", TUN: true,
    // Also the answer to `debug prefs`, which Linux asks for the operator.
    OperatorUser: os.userInfo().username }));
  process.env.VYRE_CLAUDE_BIN = fakeBin(bins, "claude", "2.1.0 (Claude Code)");
  delete process.env.CLOUDFLARE_VYRE_TOKEN;
  // Port 0: the first free port, so parallel test files never collide on 7300.
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], network: { onboardPort: 0 }, ...extra }));
  const d = await start({ root, log: () => {} });
  t.after(async () => {
    await d.stop();
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  return { root, d };
}

/** Exchange the one-time link for the session, the way the page does: from the redirect's fragment. */
async function redeem(url) {
  const r = await fetch(url, { redirect: "manual" });
  const location = r.headers.get("location") || "";
  return { status: r.status, location, session: (location.match(/#s=([A-Za-z0-9_-]+)$/) || [])[1] || "", cookie: r.headers.get("set-cookie") };
}

const tool = (base, session, name, input = {}, headers = {}) => fetch(`${base}/v1/tools/${name}`, {
  method: "POST", headers: { "content-type": "application/json", "x-vyre-onboard": session, ...headers }, body: JSON.stringify(input) });

test("onboard: the link works once, becomes a session, and the session reaches only the onboarding", async t => {
  const { root } = await box(t);
  const link = await call("onboard.link", {}, { root });
  assert.ok(link.data, JSON.stringify(link.error));
  const { url, port } = link.data;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/onboard\?t=[A-Za-z0-9_-]{40,}$/);
  const base = `http://127.0.0.1:${port}`;

  assert.equal((await tool(base, "", "onboard.status")).status, 403, "no tool answers without the token or session");
  const first = await redeem(url);
  assert.equal(first.status, 302);
  assert.match(first.location, /^\/onboard#s=/, "the token leaves the address bar; the session rides in the fragment");
  assert.equal(first.cookie, null, "no cookie: browsers share cookies with every other port on 127.0.0.1");
  assert.equal((await redeem(url)).status, 403, "the link is single use");
  assert.equal((await tool(base, "forged", "onboard.status")).status, 403);

  const s = await (await tool(base, first.session, "onboard.status")).json();
  assert.equal(s.data.mode, "loopback");
  assert.equal(s.data.current, "you");
  assert.deepEqual(s.data.steps, { you: "todo", claude: "todo", tailscale: "todo", name: "todo", history: "done", devices: "todo" }, "no sessions here, so history has nothing to do");
  assert.equal(s.data.detail.history.why, "Your Mac's sessions appear here when you connect your Mac");
  assert.equal(s.data.detail.name.via, "ts.net", "no zone token and no domain: the ts.net name");
  assert.ok(s.data.host);
  assert.equal(s.data.detail.claude.installed, true);
  assert.equal(s.data.detail.claude.version, "2.1.0 (Claude Code)");
  assert.equal(s.data.detail.claude.signedIn, false);
  assert.equal(s.data.detail.tailscale.state, "working");
  assert.equal(s.data.detail.tailscale.loginUrl, "https://login.tailscale.com/a/fake");
  assert.equal(s.data.detail.name.state, "blocked");
  const ts = await (await tool(base, first.session, "onboard.tailscale", { action: "detect" })).json();
  assert.equal(ts.data.state, "needs-login", "the page reads Tailscale's own state; the step's is `step`");
  assert.equal(ts.data.step, "working");

  // Everything that is not the onboarding is closed, even with the session.
  const h = { "x-vyre-onboard": first.session };
  assert.equal((await tool(base, first.session, "onboard.link")).status, 404, "only the socket mints links");
  assert.equal((await tool(base, first.session, "system.echo", { text: "x" })).status, 404);
  assert.equal((await tool(base, first.session, "onboard.status/../../system.echo", { text: "x" })).status, 404);
  assert.equal((await fetch(`${base}/v1/events`, { headers: h })).status, 404);
  assert.equal((await fetch(`${base}/v1/health`, { headers: h })).status, 404);
  const listed = await (await fetch(`${base}/v1/tools`, { headers: h })).json();
  assert.ok(listed.error || listed.data.every(x => x.name.startsWith("onboard.") || ["projects.catalog", "projects.create", "projects.list", "recall.status"].includes(x.name)));
});

test("onboard: the loopback listener refuses other hosts, forms and other origins", async t => {
  const { root } = await box(t);
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { session } = await redeem(url);
  // fetch will not send a forged Host, so this one goes by hand.
  const rebound = await new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port, path: "/onboard", headers: { host: `evil.example:${port}` } },
    res => { res.resume(); resolve(res.statusCode); }).on("error", reject));
  assert.equal(rebound, 421, "a rebinding page's Host is refused");
  const form = await fetch(`${base}/v1/tools/onboard.skip`, { method: "POST", headers: { "x-vyre-onboard": session, "content-type": "application/x-www-form-urlencoded" }, body: "step=you" });
  assert.equal(form.status, 415);
  const cross = await tool(base, session, "onboard.skip", { step: "you" }, { origin: "https://evil.example" });
  assert.equal(cross.status, 403);
});

test("onboard: skipping, a bad token and a missing Cloudflare token all say why; a good token goes to the vault", async t => {
  const { root } = await box(t, { vault: { keystore: "file" } });
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { session: cookie } = await redeem(url);
  const skipped = await (await tool(base, cookie, "onboard.skip", { step: "you" })).json();
  assert.equal(skipped.data.steps.you, "skipped");
  assert.equal(skipped.data.current, "claude");
  const bad = await (await tool(base, cookie, "onboard.claude", { kind: "api-key", token: "nope" })).json();
  assert.match(bad.error.message, /does not look like/);
  const fine = "sk-ant-api" + "0".repeat(40);
  const stored = await (await tool(base, cookie, "onboard.claude", { mode: "api-key", key: fine })).json();
  assert.equal(stored.data.state, "done");
  assert.equal(stored.data.signedIn, true);
  assert.equal(stored.data.via, "api-key");
  assert.ok(!JSON.stringify(stored).includes(fine), "the token never comes back");
  const item = (await call("vault.list", {}, { root, caller: "cli" })).data.items.find(i => i.name === "anthropic-api-key");
  assert.equal(item.origin, "module:onboard");
  assert.ok(JSON.stringify(item.grants).includes("agents"), "the agents module may read it");
  const check = await (await tool(base, cookie, "onboard.name", { name: "alex" })).json();
  assert.equal(check.data.valid, true);
  assert.equal(check.data.available, false);
  assert.match(check.data.why, /CLOUDFLARE_VYRE_TOKEN/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).name, undefined, "an unchecked name is not saved");
});

test("onboard: a new link voids the old unredeemed one; the owner arriving on the tailnet closes the door", async t => {
  const { root, d } = await box(t);
  const a = (await call("onboard.link", {}, { root })).data;
  const b = (await call("onboard.link", {}, { root })).data;
  assert.equal(a.port, b.port);
  assert.equal((await redeem(a.url)).status, 403);
  const { session } = await redeem(b.url);
  assert.equal((await tool(`http://127.0.0.1:${b.port}`, session, "onboard.status")).status, 200);
  d.events.emit("names", "owner.seen", {});
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await fetch(`http://127.0.0.1:${b.port}/onboard`).then(() => "open", () => "closed"), "closed");
});

test("onboard: on a host the listener binds loopback; in the box's container, the name the compose gives it", () => {
  assert.equal(bindAddress({}), "127.0.0.1");
  assert.equal(bindAddress({ VYRE_ONBOARD_HOST: "vyred" }), "vyred");
});

/** A fake Cloudflare API with the vyre.run zone and no records, so every name is free. */
async function freeZone(t) {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url || "/", "http://x").pathname.replace(/^\/client\/v4/, "");
    const result = p === "/zones" ? [{ id: "z1", name: "vyre.run" }] : [];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, errors: [], result }));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const env = { CLOUDFLARE_VYRE_TOKEN: process.env.CLOUDFLARE_VYRE_TOKEN, VYRE_CLOUDFLARE_API: process.env.VYRE_CLOUDFLARE_API };
  process.env.CLOUDFLARE_VYRE_TOKEN = "fake-cf-token-0123456789";
  process.env.VYRE_CLOUDFLARE_API = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/client/v4`;
  t.after(() => {
    server.close();
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
}

test("onboard: step 1 saves your name and the assistant's; a name that fits becomes the vyre.run candidate", async t => {
  const { root } = await box(t);
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { session } = await redeem(url);
  const saved = () => JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));

  assert.match((await (await tool(base, session, "onboard.you", { name: "alex", assistant: "a\nb" })).json()).error.message, /one line/);
  assert.match((await (await tool(base, session, "onboard.you", { name: "x".repeat(61) })).json()).error.message, /60 characters/);
  assert.equal(saved().onboard?.person, undefined);

  const long = await (await tool(base, session, "onboard.you", { name: "Alex Smith", assistant: "juno" })).json();
  assert.equal(long.data.state, "done", JSON.stringify(long.error));
  assert.equal(long.data.person, "Alex Smith");
  assert.equal(long.data.name, null, "no Cloudflare token needed, and a name with a space is no candidate");
  assert.equal(saved().name, undefined);

  const you = await (await tool(base, session, "onboard.you", { name: "Alex", assistant: " juno " })).json();
  assert.equal(you.data.person, "Alex");
  assert.equal(you.data.name, "alex", "the typed name, lowercased, is the default candidate");
  assert.equal(you.data.assistant, "juno");
  assert.equal(saved().onboard.person, "Alex");
  await tool(base, session, "onboard.you", { name: "Sam" });
  assert.equal(saved().name, "alex", "a candidate already there stays");
  const s = (await (await tool(base, session, "onboard.status")).json()).data;
  assert.equal(s.steps.you, "done");
  assert.equal(s.name, "alex");
  assert.equal(s.person, "Sam");
  assert.equal(s.assistant, "juno");
  assert.equal(s.current, "claude");
});

test("onboard: reserve goes to ts.net without a zone token and says so when the tailnet has HTTPS off; with a token it is vyre.run", async t => {
  const { root } = await box(t);
  process.env.VYRE_TAILSCALE_BIN = fakeBin(fs.mkdtempSync(path.join(root, "ts-")), "tailscale", JSON.stringify({ BackendState: "Running", TUN: true,
    Self: { HostName: "box", DNSName: "box.tail1.ts.net.", TailscaleIPs: ["100.64.0.9"], ID: "n1", UserID: 1 }, User: {}, CertDomains: [], OperatorUser: os.userInfo().username }));
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { session } = await redeem(url);

  let r = (await (await tool(base, session, "onboard.name", { action: "reserve" })).json()).data;
  assert.equal(r.via, "ts.net");
  for (let i = 0; i < 50 && r.state !== "blocked"; i++) {
    await new Promise(res => setTimeout(res, 20));
    r = (await (await tool(base, session, "onboard.name", { action: "status" })).json()).data;
  }
  assert.equal(r.state, "blocked");
  assert.equal(r.code, "https_off");
  assert.equal(r.adminUrl, "https://login.tailscale.com/admin/dns");
  assert.match(r.why, /^HTTPS certificates are turned off.*\.$/);
  const again = (await (await tool(base, session, "onboard.name", { action: "reserve" })).json()).data;
  assert.equal(again.via, "ts.net", "check again is reserve again");

  await freeZone(t);
  assert.equal((await (await tool(base, session, "onboard.status")).json()).data.detail.name.via, "vyre.run");
});

/** Can this machine run claude under a pty the way onboard.claude does? */
const ptyMissing = (() => { try { execFileSync(ptyCommand("true")[0] === "script" ? "script" : "python3", ["--version"], { stdio: "ignore" }); return false; } catch { return "no pty helper (script or python3) here"; } })();

test("onboard: the subscription sign-in runs `claude setup-token` under a pty; the code goes in, the token goes to the vault", { skip: ptyMissing }, async t => {
  const { root } = await box(t, { vault: { keystore: "file" } });
  const token = "sk-ant-oat01-" + "Zx9_".repeat(12);
  // A fake claude that behaves like setup-token: an OSC 8 link, a prompt, a code in, a token out.
  const bins = fs.mkdtempSync(path.join(root, "claude-"));
  const fake = path.join(bins, "claude");
  fs.writeFileSync(fake, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.283 (Claude Code)"; exit 0; fi
printf '\\033]8;id=a1;https://claude.com/cai/oauth/authorize?code=true&client_id=c1&state=s1\\033\\\\Sign in\\033]8;;\\033\\\\\\n'
printf 'Paste code here if prompted > '
read code
if [ "$code" = "good-code" ]; then printf '\\nYour token: ${token}\\n'; else printf '\\nInvalid code\\n'; exit 1; fi
`, { mode: 0o755 });
  process.env.VYRE_CLAUDE_BIN = fake;
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { session } = await redeem(url);

  const started = await (await tool(base, session, "onboard.claude", { mode: "setup-token" })).json();
  assert.equal(started.data.url, "https://claude.com/cai/oauth/authorize?code=true&client_id=c1&state=s1", JSON.stringify(started.error));
  assert.equal(started.data.needsCode, true);
  assert.equal(started.data.signedIn, false);
  const wrong = await (await tool(base, session, "onboard.claude", { mode: "setup-token", code: "bad-code" })).json();
  assert.match(wrong.error.message, /did not accept that code/);
  assert.match((await (await tool(base, session, "onboard.claude", { mode: "setup-token", code: "good-code" })).json()).error.message, /start it again/, "a used sign-in is gone");

  await tool(base, session, "onboard.claude", { mode: "setup-token" });
  const done = await (await tool(base, session, "onboard.claude", { mode: "setup-token", code: "good-code" })).json();
  assert.equal(done.data.signedIn, true, JSON.stringify(done.error));
  assert.equal(done.data.via, "setup-token");
  assert.equal(done.data.needsCode, false);
  assert.ok(!JSON.stringify(done).includes(token), "the token never comes back");
  const item = (await call("vault.list", {}, { root, caller: "cli" })).data.items.find(i => i.name === "claude-setup-token");
  assert.ok(item, "the token is in the vault");
  assert.ok(JSON.stringify(item.grants).includes("agents"));
  const events = fs.readdirSync(root, { recursive: true }).filter(f => /\.(jsonl|log|db)$/.test(String(f)));
  for (const f of events) assert.ok(!fs.readFileSync(path.join(root, String(f))).includes(token), `${f} holds the token`);
});

test("onboard: finishing makes the assistant once, on every project, signed in with the Claude step's item", async t => {
  const { root } = await box(t, { vault: { keystore: "file" } });
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { session } = await redeem(url);
  await tool(base, session, "onboard.you", { name: "Alex", assistant: "Mira Two" });
  const before = await (await tool(base, session, "onboard.finish")).json();
  assert.equal(before.data.assistant, null, "no Claude sign-in yet, so no assistant to run");
  await tool(base, session, "onboard.claude", { mode: "api-key", key: "sk-ant-api" + "0".repeat(40) });
  const done = await (await tool(base, session, "onboard.finish")).json();
  assert.equal(done.data.ready, "Vyre is ready.");
  assert.equal(done.data.assistant.name, "mira-two");
  assert.equal(done.data.assistant.display, "Mira Two");
  const agents = (await call("agents.list", {}, { root, caller: "cli" })).data;
  const a = agents.find(x => x.kind === "assistant");
  assert.equal(a.name, "mira-two");
  assert.equal(a.projects, "*");
  await tool(base, session, "onboard.finish");
  assert.equal((await call("agents.list", {}, { root, caller: "cli" })).data.filter(x => x.kind === "assistant").length, 1, "finishing again makes no second assistant");
});

test("onboard: once finished with an address, vyre up gets the address, not another link", async t => {
  const { root } = await box(t, { vault: { keystore: "file" }, network: { onboardPort: 0, address: "https://alex.vyre.run" } });
  const first = (await call("onboard.link", {}, { root })).data;
  assert.ok(first.url, "not finished yet: a link");
  const { session } = await redeem(first.url);
  const done = await (await tool(`http://127.0.0.1:${first.port}`, session, "onboard.finish")).json();
  assert.equal(done.data.detail.devices.mac.connected, false);
  const after = (await call("onboard.link", {}, { root })).data;
  assert.equal(after.url, null);
  assert.equal(after.address, "https://alex.vyre.run");
});

test("onboard: finishing with an address hands over a one-time link to make the first passkey there", async t => {
  const root = tempHome(t);
  // A stand-in presence module: no keys yet, and a code on request.
  writeModule(path.join(root, "modules"), "presence", { roles: ["box"], does: { tools: ["presence.keys", "presence.code"] } }, `let made = 0; export default { async start(ctx) {
    ctx.tool("presence.keys", { input: { type: "object" }, run: async () => [] });
    ctx.tool("presence.code", { input: { type: "object" }, run: async () => ({ code: "AB12CD34", expires: Date.now() + 600000, made: ++made }) });
    return { async stop() {} };
  } };`);
  const cfg = path.join(root, "config.json");
  const bins = fs.mkdtempSync(path.join(root, "bin-"));
  const saved = process.env.VYRE_TAILSCALE_BIN;
  process.env.VYRE_TAILSCALE_BIN = fakeBin(bins, "tailscale", "{}");
  fs.writeFileSync(cfg, JSON.stringify({ role: "box", transcripts: [], network: { onboardPort: 0, address: "https://alex.vyre.run" } }));
  const { start: boot } = await import("../core/daemon/index.js");
  const d = await boot({ root, log: () => {} });
  t.after(async () => { await d.stop(); if (saved === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = saved; });
  const r = await call("onboard.finish", {}, { root });
  assert.ok(r.data, JSON.stringify(r.error));
  assert.equal(r.data.passkeyUrl, "https://alex.vyre.run/onboard/passkey#e=AB12CD34");
});
