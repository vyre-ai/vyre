// @ts-check
// The onboarding as a browser meets it: a real vyred in a temp home, the one-time link from the
// socket, the loopback listener, the cookie, and only the onboarding tools behind it. Tailscale
// and claude are fake binaries; nothing here reaches the real ones.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { tempHome, present } from "./helpers.js";
import { bindAddress } from "../core/onboard/loopback.js";
import { execFileSync } from "node:child_process";
import { ptyCommand } from "../core/onboard/setup-token.js";
import { canRelayJoin, defaultOnboardPort } from "../core/onboard/index.js";

/** A fake executable that prints `out` for any arguments. */
function fakeBin(dir, name, out) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\ncat <<'EOF'\n${out}\nEOF\n`, { mode: 0o755 });
  return p;
}

async function box(t, extra = {}, presence = undefined) {
  const root = tempHome(t);
  const bins = fs.mkdtempSync(path.join(root, "bin-"));
  const env = { VYRE_TAILSCALE_BIN: process.env.VYRE_TAILSCALE_BIN, VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, CLOUDFLARE_VYRE_TOKEN: process.env.CLOUDFLARE_VYRE_TOKEN, VYRE_NAMES_DEV_CLOUDFLARE: process.env.VYRE_NAMES_DEV_CLOUDFLARE };
  // These tests serve a vyre.run name through a fake Cloudflare zone: the development path (core/names), not the hosted directory.
  process.env.VYRE_NAMES_DEV_CLOUDFLARE = "1";
  process.env.VYRE_TAILSCALE_BIN = fakeBin(bins, "tailscale", JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/fake", TUN: true,
    // Also the answer to `debug prefs`, which Linux asks for the operator.
    OperatorUser: os.userInfo().username }));
  process.env.VYRE_CLAUDE_BIN = fakeBin(bins, "claude", "2.1.0 (Claude Code)");
  delete process.env.CLOUDFLARE_VYRE_TOKEN;
  // Port 0: the first free port, so parallel test files never collide on 7300.
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], network: { onboardPort: 0 }, ...extra }));
  const d = await start({ root, ...(presence ? { presence } : {}), log: () => {} });
  t.after(async () => {
    await d.stop();
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  return { root, d };
}

/** Exchange the one-time link for the session, the way the page does: from the redirect's fragment. */
// Every request closes its connection: a test that restarts vyred on the same port would
// otherwise send its next request down a kept-alive socket the old vyred already closed.
async function redeem(url) {
  const r = await fetch(url, { redirect: "manual", headers: { connection: "close" } });
  const location = r.headers.get("location") || "";
  return { status: r.status, location, session: (location.match(/#s=([A-Za-z0-9_-]+)$/) || [])[1] || "", cookie: r.headers.get("set-cookie") };
}

const tool = (base, session, name, input = {}, headers = {}) => fetch(`${base}/v1/tools/${name}`, {
  method: "POST", headers: { "content-type": "application/json", "x-vyre-onboard": session, connection: "close", ...headers }, body: JSON.stringify(input) });

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
  // The page's own look is served before any session: the theme, the fonts, the stylesheets.
  for (const p of ["/theme.css", "/fonts/instrument-sans-latin.woff2", "/css/deck.css"]) assert.equal((await fetch(base + p)).status, 200, p);
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

test("onboard: the loopback listener checks a WebSocket's Host and session, and opens no stream", async t => {
  const { root } = await box(t);
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const { session } = await redeem(url);
  /** An upgrade by hand (fetch cannot send one); resolves to the status code. */
  const up = (host, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/v1/streams/computers/glass?ticket=x",
      headers: { host, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } });
    req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on("response", res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
  assert.equal(await up(`evil.example:${port}`, { "x-vyre-onboard": session }), 421, "a rebinding page's Host is refused");
  assert.equal(await up(`127.0.0.1:${port}`), 403, "no session");
  assert.equal(await up(`127.0.0.1:${port}`, { "x-vyre-onboard": session }), 404, "the onboarding page has no streams");
});

test("onboard: skipping and a bad token say why, a good token goes to the vault, and no zone token means the ts.net address", async t => {
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
  assert.deepEqual(item.grants ?? [], [], "no module is granted the sign-in: launchers read it through the credentials port");
  const check = await (await tool(base, cookie, "onboard.name", { name: "alex" })).json();
  // No zone token: the address is the ts.net one, so there is nothing on vyre.run to check.
  assert.equal(check.data.valid, true);
  assert.equal(check.data.available, true);
  assert.equal(check.data.via, "ts.net");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).name, undefined, "a check answers and saves nothing");
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

/** A free port that is not 7300, for a test that restarts vyred and needs the link's port again. */
async function freePort() {
  const s = http.createServer();
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (s.address()).port;
  await new Promise(r => s.close(() => r(undefined)));
  return port;
}

test("onboard: vyre update's report mints nothing, and the unused link and an open page survive vyred restarting", async t => {
  const port = await freePort();
  const { root, d } = await box(t, { network: { onboardPort: port } });
  const a = (await call("onboard.link", {}, { root })).data;
  const opened = (await call("onboard.link", {}, { root })).data;
  const { session } = await redeem(opened.url);
  const unused = (await call("onboard.link", {}, { root })).data;
  const report = (await call("onboard.link", { mint: false }, { root })).data;
  assert.deepEqual([report.url, report.pending, report.expires], [null, true, unused.expires], "a report, not a link");
  assert.equal(fs.statSync(path.join(root, "onboard-link.json")).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(root, "onboard-link.json"), "utf8").includes(new URL(unused.url).searchParams.get("t")), "only the hash is kept");
  // vyre update: the container is recreated, so vyred stops and starts.
  await d.stop();
  const d2 = await start({ root, log: () => {} });
  t.after(() => d2.stop());
  assert.equal((await tool(`http://127.0.0.1:${port}`, session, "onboard.status")).status, 200, "the open page keeps working");
  assert.equal((await call("onboard.link", { mint: false }, { root })).data.pending, true);
  assert.equal((await redeem(unused.url)).status, 302, "the link the user was sent still works");
  assert.equal((await redeem(a.url)).status, 403, "a voided one stays void");
  assert.equal((await call("onboard.link", { mint: false }, { root })).data.pending, false);
  d2.events.emit("names", "owner.seen", {});
  await new Promise(r => setTimeout(r, 100));
  assert.equal(fs.existsSync(path.join(root, "onboard-link.json")), false, "the owner arriving forgets it for good");
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

test("onboard: step 1 saves your name and the assistant's; the address is never taken from the name (#50)", async t => {
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
  assert.equal(long.data.name, null, "the box's own address name is not the person's");
  assert.equal(saved().name, undefined);

  const you = await (await tool(base, session, "onboard.you", { name: "Alex", assistant: " juno " })).json();
  assert.equal(you.data.person, "Alex");
  assert.equal(you.data.name, null, "a name that would fit as an address is still not one");
  assert.equal(saved().name, undefined, "nothing was saved as the address");
  assert.equal(you.data.assistant, "juno");
  assert.equal(saved().onboard.person, "Alex");
  await tool(base, session, "onboard.you", { name: "Sam" });
  assert.equal(saved().name, undefined, "a new name never becomes the address");
  const s = (await (await tool(base, session, "onboard.status")).json()).data;
  assert.equal(s.steps.you, "done");
  assert.equal(s.name, "Sam", "status name is the person");
  assert.equal(s.person, "Sam");
  assert.equal(s.assistant, "juno");
  assert.equal(s.current, "claude");
});

// ADR 0039: onboard.machine records the person's own solo/server choice; device is never sent
// directly (it's set by onboard.join once a connection to another server is confirmed).
test("onboard: onboard.machine records solo or server, rejects a bad value, and onboard.status reports it", async t => {
  const { root } = await box(t);
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { session } = await redeem(url);
  const saved = () => JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));

  const bad = await (await tool(base, session, "onboard.machine", { machine: "container" })).json();
  assert.match(bad.error.message, /solo.*server.*device|enum/i);

  const solo = await (await tool(base, session, "onboard.machine", { machine: "solo" })).json();
  assert.equal(solo.data.machine, "solo");
  assert.equal(saved().machine, "solo");

  const server = await (await tool(base, session, "onboard.machine", { machine: "server" })).json();
  assert.equal(server.data.machine, "server");
  assert.equal(saved().machine, "server", "the later choice replaces the earlier one");

  const s = (await (await tool(base, session, "onboard.status")).json()).data;
  assert.equal(s.machine, "server");
  assert.equal(s.role, "box", "role is untouched by this tool");
  assert.equal(s.platform, process.platform, "status reports the real os.platform()");
  assert.deepEqual(s.can, canRelayJoin(process.platform), "status.can matches the pure helper");
});

// relay.join is not shippable on a Mac until vyre-core exists (reviewer/team-lead, 28 Sep); launch
// reads onboard.status.can.relayJoin to hide the code-pairing card rather than offer a dead path.
test("onboard: canRelayJoin is false with a reason on darwin, true elsewhere", () => {
  assert.deepEqual(canRelayJoin("darwin"), { relayJoin: false, reason: canRelayJoin("darwin").reason });
  assert.match(canRelayJoin("darwin").reason, /vyre-core/);
  assert.deepEqual(canRelayJoin("linux"), { relayJoin: true, reason: null });
  assert.deepEqual(canRelayJoin("win32"), { relayJoin: true, reason: null });
});

// Reviewer's LOW, 28 Sep round 2: a Mac chosen as server must never even attempt port 7300,
// which a real Mac's own onboarding tunnel binds -- not "next free port if taken" (ADR 0002),
// an outright different default.
test("onboard: defaultOnboardPort is 7301 on darwin (never 7300), 7300 (ADR 0002) elsewhere", () => {
  assert.equal(defaultOnboardPort("darwin"), 7301);
  assert.equal(defaultOnboardPort("linux"), 7300);
  assert.equal(defaultOnboardPort("win32"), 7300);
});

// Reviewer, 28 Sep: onboard.machine changes which modules load, so it must be the person's own
// action, never an agent's, and moving TO server (once an owner exists) needs a presence proof.
test("onboard: onboard.machine refuses an agent caller outright", async t => {
  const { root, d } = await box(t);
  const r = await d.registry.call("onboard.machine", { machine: "server" }, "mcp:agent:kit");
  assert.equal(r.error.code, "denied");
  assert.match(r.error.message, /not available to mcp callers/);
});

test("onboard: moving to server needs no proof during first-time setup (no owner yet)", async t => {
  const { d } = await box(t);
  // Matches onboarding's own passkey-enrollment exemption -- there is no passkey to prove
  // presence with yet either, and the caller is already proven by the one-time link.
  const r = await d.registry.call("onboard.machine", { machine: "server" }, "cli");
  assert.equal(r.data.machine, "server");
});

test("onboard: moving to server needs a presence proof once an owner already exists", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [],
    network: { onboardPort: 0, ownerSeen: new Date().toISOString(), owner: "alex@example.com" }, machine: "solo" }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const later = await d.registry.call("onboard.machine", { machine: "server" }, "cli");
  assert.equal(later.error.code, "presence_required");
  // solo never needs it, even with an owner established.
  const solo = await d.registry.call("onboard.machine", { machine: "solo" }, "cli");
  assert.equal(solo.data.machine, "solo");
});

// Reviewer's HIGH, round 2: the first version exempted "no owner seen", which is permanently
// true for every Solo Mac (role is never "box"), so a Mac was proof-free forever -- the opposite
// of the fix. A Mac must always prove presence to become a server, with or without an owner.
test("onboard: a Solo Mac always needs a presence proof to become a server, even with no owner ever seen", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local", transcripts: [],
    network: { onboardPort: 0 }, machine: "solo" }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const r = await d.registry.call("onboard.machine", { machine: "server" }, "cli");
  assert.equal(r.error.code, "presence_required");
});

// Reviewer, round 2: "device" is set internally, once onboard.join/relay.join have already
// confirmed a real connection; a person, an agent, or any other module must never set it, and no
// module may set solo/server on someone's behalf either.
test("onboard: device is set only by module:onboard or module:relay; nobody else may set it, and no module may choose solo or server", async t => {
  const { d } = await box(t);
  const asDevice = raw => d.registry.call("onboard.machine", { machine: "device" }, raw);
  assert.equal((await asDevice("module:onboard")).data.machine, "device");
  assert.equal((await asDevice("module:relay")).data.machine, "device");
  assert.equal((await asDevice("cli")).error.code, "denied");
  assert.equal((await asDevice("module:notes")).error.code, "denied");
  assert.equal((await asDevice("mcp:agent:kit")).error.code, "denied");
  const asServer = await d.registry.call("onboard.machine", { machine: "server" }, "module:onboard");
  assert.equal(asServer.error.code, "denied");
});

// Reviewer's HIGH, round 2: onboard now loads on Solo too, so start() can no longer resume the
// loopback listener unconditionally -- on a Mac that would bind the setup listener, which
// RULES.md forbids outright on port 7300 (the user's real onboarding tunnel to the box), with
// nothing to onboard into.
test("onboard: the setup listener never binds on a machine that is not a server", async t => {
  const root = tempHome(t);
  const port = 17300 + Math.floor(Math.random() * 1000);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local", transcripts: [],
    network: { onboardPort: port }, machine: "solo" }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`), /fetch failed|ECONNREFUSED/);
});

// Reviewer, 28 Sep: onboard now loads on a Solo machine too (so onboard.machine can), but its old
// box wizard tools must stay refused there -- only onboard.machine (and, separately, tailnet's
// onboard.join) are exempt.
test("onboard: the box wizard's tools refuse on a machine that isn't a server", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ machine: "solo", transcripts: [], network: { onboardPort: 0 } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  for (const [tool, input] of [["onboard.you", { name: "alex" }], ["onboard.name", { name: "alex" }], ["onboard.claude", {}],
    ["onboard.tailscale", {}], ["onboard.history", {}], ["onboard.skip", { step: "you" }], ["onboard.passkey", {}],
    ["onboard.finish", {}], ["onboard.link", {}]]) {
    const r = await d.registry.call(tool, input, "cli");
    assert.equal(r.error?.code, "not_a_server", `${tool} should refuse on solo`);
  }
  // status and machine, the two exceptions, still work.
  assert.equal((await d.registry.call("onboard.status", {}, "cli")).data.machine, "solo");
  assert.equal((await d.registry.call("onboard.machine", { machine: "solo" }, "cli")).data.machine, "solo");
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

  // Step 1 skipped, though "kit" was typed (and checked) there first: a public name is never
  // claimed until the person confirms it.
  assert.equal((await (await tool(base, session, "onboard.name", { name: "kit", action: "check" })).json()).data.valid, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).name, undefined, "the check saved nothing");
  const unasked = await (await tool(base, session, "onboard.name", { name: "kit", action: "reserve" })).json();
  assert.match(unasked.error.message, /kit\.vyre\.run is a public name: confirm it first/);
  assert.match((await (await tool(base, session, "onboard.name", { action: "reserve" })).json()).error.message, /pick a name first/);
  const yes = await (await tool(base, session, "onboard.name", { name: "kit", action: "reserve", confirm: true })).json();
  assert.ok(!yes.error, JSON.stringify(yes.error));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).name, "kit", "confirmed, so it is the name");
  // The claim runs on in the background and saves config.json when it ends. The temp home is
  // removed before vyred stops, so let it end first or its late write leaks the home.
  for (let i = 0; i < 250; i++) {
    const { phase } = (await call("names.status", {}, { root })).data || {};
    if (phase !== "dns" && phase !== "certificate") break;
    await new Promise(res => setTimeout(res, 20));
  }
});

test("onboard: when tailscale cert itself refuses because HTTPS is off, the address step says so with the admin console link", async t => {
  const { root } = await box(t);
  const bins = fs.mkdtempSync(path.join(root, "ts-"));
  const st = JSON.stringify({ BackendState: "Running", TUN: true, CertDomains: ["box.tail0000.ts.net"], OperatorUser: os.userInfo().username,
    Self: { HostName: "box", DNSName: "box.tail0000.ts.net.", TailscaleIPs: ["100.64.0.9"], ID: "n1", UserID: 1 }, User: {} });
  // The status lists the cert domain, so the check before `tailscale cert` passes; the cert call is what refuses.
  const bin = path.join(bins, "tailscale");
  fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = cert ]; then echo "500 Internal Server Error: your Tailscale account does not support getting TLS certs" >&2; exit 1; fi\ncat <<'EOF'\n${st}\nEOF\n`, { mode: 0o755 });
  process.env.VYRE_TAILSCALE_BIN = bin;
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { session } = await redeem(url);

  let r = (await (await tool(base, session, "onboard.name", { action: "reserve" })).json()).data;
  for (let i = 0; i < 50 && r.state !== "blocked"; i++) {
    await new Promise(res => setTimeout(res, 20));
    r = (await (await tool(base, session, "onboard.name", { action: "status" })).json()).data;
  }
  assert.equal(r.state, "blocked");
  assert.equal(r.code, "https_off", r.why);
  assert.equal(r.adminUrl, "https://login.tailscale.com/admin/dns");
});

test("onboard: a zone token that appears after a blocked ts.net attempt is offered again; one that already serves is not (e2e review)", async t => {
  // Not yet committed: an earlier attempt left "ts.net" as the last thing via() computed, but
  // nothing ever actually served (no address on record) — a token that shows up afterward is
  // offered, exactly like a box that never tried at all.
  const blocked = await box(t, { network: { onboardPort: 0, via: "ts.net" } });
  {
    const { url, port } = (await call("onboard.link", {}, { root: blocked.root })).data;
    const before = (await (await tool(`http://127.0.0.1:${port}`, (await redeem(url)).session, "onboard.status")).json()).data;
    assert.equal(before.detail.name.via, "ts.net", "no token yet: still ts.net");
  }
  await freeZone(t);
  {
    const { url, port } = (await call("onboard.link", {}, { root: blocked.root })).data;
    const after = (await (await tool(`http://127.0.0.1:${port}`, (await redeem(url)).session, "onboard.status")).json()).data;
    assert.equal(after.detail.name.via, "vyre.run", "a token that shows up now is offered, not stuck behind an old blocked attempt");
  }
});

test("onboard: a box already serving on ts.net keeps saying so once a zone token appears (e2e review)", async t => {
  // Committed: this box has an address on record, so it already serves under ts.net for real.
  // A zone token appearing later does not pull the rug out from under a working address.
  const serving = await box(t, { network: { onboardPort: 0, via: "ts.net", address: "https://box.tail1.ts.net" } });
  await freeZone(t);
  const { url, port } = (await call("onboard.link", {}, { root: serving.root })).data;
  const status = (await (await tool(`http://127.0.0.1:${port}`, (await redeem(url)).session, "onboard.status")).json()).data;
  assert.equal(status.detail.name.via, "ts.net", "already serving: a later token does not change what is live");
  assert.equal(status.detail.name.address, "https://box.tail1.ts.net");
});

/** Can this machine run claude under a pty the way onboard.claude does? */
const ptyMissing = (() => { try { execFileSync(ptyCommand("true")[0] === "script" ? "script" : "python3", ["--version"], { stdio: "ignore" }); return false; } catch { return "no pty helper (script or python3) here"; } })();

test("onboard: the subscription sign-in runs `claude setup-token` under a pty; the code goes in, the token goes to the vault", { skip: ptyMissing }, async t => {
  const { root } = await box(t, { vault: { keystore: "file" } });
  const token = "sk-ant-oat01-" + "Zx9_".repeat(12);
  // A fake claude that reads its prompt the way Claude Code's (Ink) does: the terminal in raw mode,
  // a chunk of several characters is pasted text, Enter included, and only an Enter on its own
  // submits. A refused code does not exit: it says "OAuth error" and waits for Enter to retry.
  const bins = fs.mkdtempSync(path.join(root, "claude-"));
  const fake = path.join(bins, "claude");
  fs.writeFileSync(fake, `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("2.1.283 (Claude Code)"); process.exit(0); }
process.stdout.write("\\x1b]8;id=a1;https://claude.com/cai/oauth/authorize?code=true&client_id=c1&state=s1\\x1b\\\\Sign in\\x1b]8;;\\x1b\\\\\\n");
process.stdout.write("Paste code here if prompted > ");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let typed = "";
process.stdin.on("data", d => {
  const s = String(d);
  if (s !== "\\r") { typed += s; return; }
  if (typed === "good-code#s1") { process.stdout.write("\\nYour token: ${token}\\n"); process.exit(0); }
  process.stdout.write("\\r\\nOAuth error: Request failed with status code 400\\r\\n Press Enter to retry.");
  typed = "";
});
`, { mode: 0o755 });
  process.env.VYRE_CLAUDE_BIN = fake;
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { session } = await redeem(url);

  const started = await (await tool(base, session, "onboard.claude", { mode: "setup-token" })).json();
  assert.equal(started.data.url, "https://claude.com/cai/oauth/authorize?code=true&client_id=c1&state=s1", JSON.stringify(started.error));
  assert.equal(started.data.needsCode, true);
  assert.equal(started.data.signedIn, false);
  const asked = Date.now();
  const wrong = await (await tool(base, session, "onboard.claude", { mode: "setup-token", code: "bad-code#s1" })).json();
  assert.match(wrong.error.message, /did not accept that code \(OAuth error: Request failed with status code 400\)/);
  assert.ok(Date.now() - asked < 10_000, "a refused code is said at once, not after the minute's wait");
  assert.match((await (await tool(base, session, "onboard.claude", { mode: "setup-token", code: "good-code#s1" })).json()).error.message, /start it again/, "a used sign-in is gone");

  await tool(base, session, "onboard.claude", { mode: "setup-token" });
  // The code as Claude's callback page shows it, <code>#<state>, pasted whole.
  const done = await (await tool(base, session, "onboard.claude", { mode: "setup-token", code: "good-code#s1" })).json();
  assert.equal(done.data.signedIn, true, JSON.stringify(done.error));
  assert.equal(done.data.via, "setup-token");
  assert.equal(done.data.needsCode, false);
  assert.ok(!JSON.stringify(done).includes(token), "the token never comes back");
  const item = (await call("vault.list", {}, { root, caller: "cli" })).data.items.find(i => i.name === "claude-setup-token");
  assert.ok(item, "the token is in the vault");
  assert.deepEqual(item.grants ?? [], [], "the stored sign-in carries no module grant: launchers read it through the credentials port");
  const events = fs.readdirSync(root, { recursive: true }).filter(f => /\.(jsonl|log|db)$/.test(String(f)));
  for (const f of events) assert.ok(!fs.readFileSync(path.join(root, String(f))).includes(token), `${f} holds the token`);
});

test("onboard: finishing makes the assistant once, on every project, signed in with the Claude step's item", async t => {
  const { root } = await box(t, { vault: { keystore: "file" } });
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { session } = await redeem(url);
  await tool(base, session, "onboard.you", { name: "Alex", assistant: "Mira Two" });
  // The assistant exists from the moment it was named, with no Claude sign-in yet: no greeting, but it is there for the Agents page and Lumen.
  const early = (await call("agents.list", {}, { root, caller: "cli" })).data.find(x => x.kind === "assistant");
  assert.equal(early.name, "mira-two", "made at the You step, with no second click");
  assert.equal(early.auth, "ambient", "no credentials yet: the machine's own Claude Code login");
  const before = await (await tool(base, session, "onboard.finish")).json();
  assert.equal(before.data.assistant.name, "mira-two");
  assert.equal(before.data.assistant.thread, null, "no Claude sign-in yet, so nothing greets");
  await tool(base, session, "onboard.claude", { mode: "api-key", key: "sk-ant-api" + "0".repeat(40) });
  const done = await (await tool(base, session, "onboard.finish")).json();
  assert.equal(done.data.ready, "Vyre is ready.");
  assert.equal(done.data.assistant.name, "mira-two");
  assert.equal(done.data.assistant.display, "Mira Two");
  const agents = (await call("agents.list", {}, { root, caller: "cli" })).data;
  const a = agents.find(x => x.kind === "assistant");
  assert.equal(a.name, "mira-two");
  assert.equal(a.projects, "*");
  assert.equal(a.auth, "api-key", "an API key is the agent's API key, not read as a subscription token");
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
  // The core presence module answers: no keys yet, and a fresh one-time code on request.
  const link = /^https:\/\/alex\.vyre\.run\/onboard\/passkey#e=[A-Z0-9]{8}$/;
  const cfg = path.join(root, "config.json");
  const bins = fs.mkdtempSync(path.join(root, "bin-"));
  const saved = process.env.VYRE_TAILSCALE_BIN;
  process.env.VYRE_TAILSCALE_BIN = fakeBin(bins, "tailscale", "{}");
  fs.writeFileSync(cfg, JSON.stringify({ role: "box", transcripts: [], network: { onboardPort: 0, address: "https://alex.vyre.run" } }));
  const { start: boot } = await import("../core/daemon/index.js");
  const d = await boot({ root, log: () => {} });
  t.after(async () => { await d.stop(); if (saved === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = saved; });
  assert.match((await call("onboard.passkey", {}, { root })).data.passkeyUrl, link, "before finishing too, without finishing");
  assert.equal((await d.registry.call("onboard.status", {}, "cli")).data.finished, false);
  assert.equal((await d.registry.call("onboard.passkey", {}, "tailnet:alex@example.com")).data.passkeyUrl, null);
  const tailnet = await d.registry.call("onboard.finish", {}, "tailnet:alex@example.com");
  assert.equal(tailnet.data.passkeyUrl, null, "never to a tailnet caller: a model on the Mac is one");
  const r = await call("onboard.finish", {}, { root });
  assert.ok(r.data, JSON.stringify(r.error));
  assert.match(r.data.passkeyUrl, link);
  // The code expired unused: `vyre up` on the box offers a fresh one, for as long as there is no passkey.
  const again = (await call("onboard.link", {}, { root })).data;
  assert.equal(again.url, null);
  assert.match(again.passkeyUrl, link);
});

test("onboard: tailscale lock reads Tailnet Lock and hands back this box's key and the commands, running only lock status", async t => {
  const { root } = await box(t);
  const dir = fs.mkdtempSync(path.join(root, "ts-"));
  const bin = path.join(dir, "tailscale"), log = path.join(dir, "args.log");
  const key = "tlpub:" + "b0".repeat(32);
  fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nif [ "$1" = lock ]; then echo '${JSON.stringify({ Enabled: false, PublicKey: key, NodeKeySigned: false })}'; else echo '{"BackendState":"Running","TUN":true}'; fi\n`, { mode: 0o755 });
  process.env.VYRE_TAILSCALE_BIN = bin;
  const r = await call("onboard.tailscale", { action: "lock" }, { root });
  assert.ok(r.data, JSON.stringify(r.error));
  assert.deepEqual({ ...r.data, commands: undefined }, { enabled: false, nodeKey: key, key, trusted: null, signed: null, why: null, commands: undefined });
  assert.equal(r.data.commands.mac, "tailscale lock");
  assert.equal(r.data.commands.init, `tailscale lock init --gen-disablements 2 --gen-disablement-for-support <mac key> ${key}`);
  const lockCalls = fs.readFileSync(log, "utf8").split("\n").filter(l => l.startsWith("lock"));
  assert.deepEqual([...new Set(lockCalls)], ["lock status --json"], "Vyre never runs lock init or sign");
});

test("onboard: tailscale policy merges Taildrive, Taildrop and SSH into one snippet, using real names it already knows", async t => {
  // The paired-desktop join (tag:vyre-device) is the Linux box's today; a Mac server gets the same block once relay.tailnet.status
  // says available on darwin (tailnet, with vyre-core's keys). Until then this machine poses as Linux, as site/setup/box.test.js does.
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", /** @type {any} */ (realPlatform)));
  const { root } = await box(t, { network: { onboardPort: 0, owner: "alex@example.com" } });
  const dir = fs.mkdtempSync(path.join(root, "ts-"));
  const bin = path.join(dir, "tailscale");
  const self = { HostName: "alex-box", DNSName: "alex-box.tail0000.ts.net.", TailscaleIPs: ["100.64.0.5", "fd7a::5"], ID: "n1", Tags: [] };
  // OperatorUser: on Linux, operator() (core/names/tailscale.js) actually checks `debug prefs`'s
  // answer against the real OS user; darwin skips the check entirely, which is why this fixture's
  // missing field went unnoticed until it ran on testbox (Linux) and ready came back false.
  fs.writeFileSync(bin, `#!/bin/sh\necho '${JSON.stringify({ BackendState: "Running", TUN: true, Self: self, User: {}, OperatorUser: os.userInfo().username })}'\n`, { mode: 0o755 });
  process.env.VYRE_TAILSCALE_BIN = bin;
  const r = await call("onboard.tailscale", { action: "policy" }, { root });
  assert.ok(r.data, JSON.stringify(r.error));
  assert.equal(r.data.ready, true);
  assert.deepEqual(r.data.policy.hosts, { "alex-box": "100.64.0.5" });
  assert.deepEqual(r.data.policy.nodeAttrs, [
    { target: ["alex-box"], attr: ["drive:share"] },
    { target: ["alex@example.com"], attr: ["drive:access"] },
  ]);
  const [drive, taildrop] = r.data.policy.grants;
  assert.deepEqual(drive, { src: ["[your Mac's name]"], dst: ["alex-box"], app: { "tailscale.com/cap/drive": [{ shares: ["projects"], access: "ro" }] } });
  assert.deepEqual(taildrop, { src: ["alex@example.com"], dst: ["alex-box"], app: { "https://tailscale.com/cap/file-sharing-target": [{}] } });
  assert.deepEqual(r.data.policy.ssh, [{ action: "check", src: ["alex@example.com"], dst: ["alex-box"], users: ["[the admin account you set up this server with]"] }]);
  assert.equal(r.data.policy.tagOwners?.["tag:vyre-egress"], undefined, "egress is off by default, so no tag:vyre-egress block");
  // ADR 0046: a Linux box hands paired desktops tag:vyre-device keys, which reach its port and nothing else. A Mac
  // server gets the same block (anywhere, 30 Sep); on a Mac this needs relay.tailnet.status to report available on darwin
  // (tailnet, with vyre-core's keys), so it is red on a Mac until then and green on the Linux runners.
  assert.deepEqual(r.data.policy.tagOwners, { "tag:vyre-device": ["alex@example.com"] });
  assert.deepEqual(r.data.policy.grants.filter(g => g.src.includes("tag:vyre-device")), [{ src: ["tag:vyre-device"], dst: ["alex-box"], ip: ["tcp:443"] }]);
  assert.ok(!r.data.policy.grants.some(g => g.dst.includes("tag:vyre-device")), "no grant ever lets anything reach a paired desktop's node");
  assert.ok(r.data.notes.some(n => /tailscale-mint-oauth/.test(n)));
});

test("onboard: tailscale policy refuses before Tailscale is connected", async t => {
  const { root } = await box(t);
  const r = await call("onboard.tailscale", { action: "policy" }, { root });
  assert.ok(r.data, JSON.stringify(r.error));
  assert.equal(r.data.ready, false);
  assert.equal(r.data.policy, null);
  assert.match(r.data.why, /connect Tailscale/);
});

// ---- onboard.join: a second device or a server joining, not the first-run wizard (28 Sep 2026) ----

test("onboard: join status merges Tailscale's own state with whether the relay is ready to pair", async t => {
  const { root } = await box(t, { relay: { url: "ws://127.0.0.1:1" } });
  const s = await call("onboard.join", { action: "status" }, { root });
  assert.equal(s.error, undefined, JSON.stringify(s.error));
  assert.equal(s.data.tailscale.state, "needs-login");
  assert.equal(s.data.tailscale.loginUrl, "https://login.tailscale.com/a/fake");
  assert.deepEqual(s.data.relay, { available: true, enabled: false, connected: false, pairing: null });
});

test("onboard: join tailscale is onboard.tailscale's own logic, callable any time", async t => {
  const { root } = await box(t, {}, present);
  const status = await call("onboard.join", { action: "tailscale", step: "status" }, { root });
  assert.equal(status.data.state, "needs-login");
  const connect = await call("onboard.join", { action: "tailscale", step: "connect" }, { root });
  assert.equal(connect.error, undefined, JSON.stringify(connect.error));
  assert.ok(connect.data.loginUrl, "the sign-in link is still handed back");
});

test("onboard: join verify forwards to link.health, unknown without a node to name, and never flips machine unless asked", async t => {
  const { root } = await box(t);
  const v = await call("onboard.join", { action: "verify" }, { root });
  assert.equal(v.error, undefined, JSON.stringify(v.error));
  assert.equal(v.data.online, false);
  assert.match(v.data.why, /say which node/);
  // becomeDevice is a no-op here: link.health said not online, and onboard.machine is not even
  // running in this test world, so nothing throws either way.
  const notOnline = await call("onboard.join", { action: "verify", becomeDevice: true }, { root });
  assert.equal(notOnline.error, undefined, JSON.stringify(notOnline.error));
});

test("onboard: join relay mints a pairing code without needing to reach the relay first", async t => {
  const { root } = await box(t, { relay: { url: "ws://127.0.0.1:1" } }, present);
  const r = await call("onboard.join", { action: "relay" }, { root });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.match(r.data.url, /^https:\/\/vyre\.run\/pair#/);
  assert.equal(r.data.connected, false, "the dead-port relay never answers, and mint() says so rather than hanging");
  assert.ok(r.data.expiresAt > Date.now());
});

test("onboard: join is the owner's alone — an agent with a valid presence proof is still refused, not just ungated", async t => {
  const { root } = await box(t, { relay: { url: "ws://127.0.0.1:1" } }, present);
  // `present` satisfies presence for anyone; onboard.join must refuse the agent itself, the same
  // way relay.pair.start already does, whatever proof rides along (reviewer's HOLD on af604cf8).
  for (const caller of ["mcp:agent:kit", "harness:agent:kit", "tailnet-guest:sam@example.com", "hook", "anonymous"]) {
    const relay = await call("onboard.join", { action: "relay" }, { root, caller });
    assert.equal(relay.error?.code, "denied", `relay via ${caller}`);
    const connect = await call("onboard.join", { action: "tailscale", step: "connect" }, { root, caller });
    assert.equal(connect.error?.code, "denied", `tailscale connect via ${caller}`);
  }
  // The owner's own surfaces still work.
  assert.equal((await call("onboard.join", { action: "relay" }, { root, caller: "deck" })).error, undefined);
});

test("onboard: join status and verify never need presence; tailscale connect and relay always do", async t => {
  // The registry's own decision (core/presence's `required(tool, def, input)`), pure — no daemon,
  // dialog or fake tailscale needed.
  const { Presence } = await import("../core/presence/index.js");
  const { open } = await import("../core/store/index.js");
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const p = new Presence({ db, platform: "linux", touchid: null, webauthn: null, who: async () => [], statTty: () => null, writeTty: () => {} });
  const def = { presence: { when: i => i && (i.action === "relay" || (i.action === "tailscale" && i.step === "connect")) } };
  assert.equal(p.required("onboard.join", def, { action: "status" }), false);
  assert.equal(p.required("onboard.join", def, { action: "verify" }), false);
  assert.equal(p.required("onboard.join", def, { action: "tailscale", step: "status" }), false, "reading Tailscale's state needs no proof");
  assert.equal(p.required("onboard.join", def, { action: "tailscale", step: "policy" }), false, "the paste-only policy snippet needs no proof either");
  assert.equal(p.required("onboard.join", def, { action: "tailscale", step: "connect" }), true, "starting tailscale up does");
  assert.equal(p.required("onboard.join", def, { action: "relay" }), true, "pairing a new device always does");
});

test("onboard: the named assistant is made at the You step, takes the Claude step's credentials later, and a failure is kept with a retry", async t => {
  const { root } = await box(t, { vault: { keystore: "file" } });
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { session } = await redeem(url);
  const agents = async () => (await call("agents.list", {}, { root, caller: "cli" })).data;
  // Somebody already holds the name: the step still succeeds, says why, and a retry makes it once the name is free.
  assert.equal((await call("agents.create", { name: "kit", projects: [] }, { root, caller: "cli" })).error, undefined);
  const you = await (await tool(base, session, "onboard.you", { name: "Alex", assistant: "Kit" })).json();
  assert.equal(you.error, undefined, JSON.stringify(you));
  assert.equal((await agents()).some(x => x.kind === "assistant"), false);
  const status = (await (await tool(base, session, "onboard.status")).json()).data;
  assert.equal(status.assistantState && status.assistantState.state, "failed", JSON.stringify({ you, status: Object.keys(status) }));
  assert.match(status.assistantState.why, /already an agent kit/);
  assert.equal((await call("agents.delete", { agent: "kit" }, { root, caller: "cli" })).error, undefined);
  const retry = await (await tool(base, session, "onboard.assistant")).json();
  assert.deepEqual([retry.data.state, retry.data.name, retry.data.why], ["made", "kit", null], JSON.stringify(retry));
  assert.equal((await (await tool(base, session, "onboard.status")).json()).data.assistantState, null, "the failure is cleared");
  // Once made, the Claude step hands it the Vault items; asking again makes nothing twice.
  await tool(base, session, "onboard.claude", { mode: "api-key", key: "sk-ant-api" + "0".repeat(40) });
  const made = (await agents()).filter(x => x.kind === "assistant");
  assert.equal(made.length, 1);
  assert.equal(made[0].auth, "api-key", "it took the Claude step's Vault item");
  assert.equal((await (await tool(base, session, "onboard.assistant")).json()).data.state, "made");
  assert.equal((await agents()).filter(x => x.kind === "assistant").length, 1);
});

test("onboard: the box holds the setup step list: skips and passes are kept, the name is the person and never the address, and the assistant retry is the same tool", async t => {
  const { root } = await box(t, { vault: { keystore: "file" } });
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { session } = await redeem(url);
  const setup = async (input = {}) => (await (await tool(base, session, "onboard.setup", input)).json());
  const fresh = (await setup()).data;
  assert.deepEqual(fresh.steps.map(s => s.id), ["install", "words", "address", "tailscale", "ai", "phone", "passkey", "assistant", "computers", "history"]);
  assert.equal(fresh.steps[0].status, "done", "the box is installed if it answers");
  assert.ok(fresh.current && fresh.finished === false);
  assert.equal(fresh.name, null, "no name yet");
  // Skipping keeps the step listed; only ai, phone, computers and history can be skipped; history is passed by the person.
  const skipped = (await setup({ skip: "phone" })).data;
  assert.equal(skipped.steps.find(s => s.id === "phone").status, "skipped");
  assert.deepEqual(skipped.skipped, ["phone"]);
  assert.ok((await (await tool(base, session, "onboard.setup", { skip: "passkey" })).json()).error, "passkey cannot be skipped");
  assert.equal((await setup({ skip: "ai" })).data.steps.find(s => s.id === "ai").status, "skipped");
  assert.equal((await setup({ unskip: "ai" })).data.steps.find(s => s.id === "ai").status !== "skipped", true);
  assert.equal((await setup({ pass: "history" })).data.steps.find(s => s.id === "history").status, "done");
  // The setup list survives a restart of the page: it is the box's own.
  assert.deepEqual((await setup()).data.skipped, ["phone"]);
  // The name is the person's, any letters up to 60, and is never taken for the address (#50).
  const before = (await call("system.info", {}, { root, caller: "cli" })).data;
  const bad = await (await tool(base, session, "onboard.you", { name: "12345", assistant: "Kit" })).json();
  assert.ok(bad.error, "a name needs a letter");
  const you = await (await tool(base, session, "onboard.you", { name: "  Álex Müller  ", assistant: "Kit" })).json();
  assert.equal(you.error, undefined, JSON.stringify(you));
  const after = (await setup()).data;
  assert.equal(after.name, "Álex Müller", "trimmed");
  assert.equal(after.steps.find(s => s.id === "assistant").status, "done");
  const status = (await (await tool(base, session, "onboard.status")).json()).data;
  assert.equal(status.name, "Álex Müller");
  assert.equal(status.accountName, null, "no signed-in AI account says a name");
  assert.equal((await call("system.info", {}, { root, caller: "cli" })).data.name, before.name, "saving the person never changes the box's own name");
  // The assistant retry the setup module calls: the same tool, {retry: true}.
  const retry = (await (await tool(base, session, "onboard.assistant", { retry: true })).json()).data;
  assert.equal(retry.state, "made");
  assert.equal((await setup()).data.assistant.display, "Kit");
});

test("onboard: only the person (their own surface or the setup page) changes the name, skips and the assistant, and only they are told the person's name", async t => {
  const { root } = await box(t, { vault: { keystore: "file" } });
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { session } = await redeem(url);
  assert.equal((await (await tool(base, session, "onboard.you", { name: "Alex Smith", assistant: "Kit" })).json()).error, undefined);
  for (const caller of ["mcp", "harness", "module:planner"]) {
    for (const [name, input] of [["onboard.you", { name: "Mallory" }], ["onboard.skip", { step: "history" }], ["onboard.assistant", {}], ["onboard.setup", { skip: "ai" }], ["onboard.setup", { pass: "history" }]]) {
      const r = await call(name, input, { root, caller });
      assert.equal(r.error && r.error.code, "denied", `${caller} ${name}: ${JSON.stringify(r)}`);
    }
    // Reading the list is fine, but it does not hand over who the person is.
    const stR = await call("onboard.status", {}, { root, caller });
    const st = stR.data;
    assert.ok(st, `${caller}: ${JSON.stringify(stR)}`);
    assert.deepEqual([st.name, st.person, st.accountName], [null, null, null], `${caller} is not told the person's name`);
    const sl = (await call("onboard.setup", {}, { root, caller })).data;
    assert.deepEqual([sl.name, sl.accountName], [null, null]);
  }
  // The person's own surface, and the setup page, are told and may change them.
  const mine = (await call("onboard.status", {}, { root, caller: "cli" })).data;
  assert.deepEqual([mine.name, mine.person], ["Alex Smith", "Alex Smith"]);
  assert.equal((await call("onboard.setup", { skip: "phone" }, { root, caller: "cli" })).error, undefined);
  assert.equal((await (await tool(base, session, "onboard.setup", { skip: "computers" })).json()).error, undefined);
  assert.equal((await (await tool(base, session, "onboard.status")).json()).data.name, "Alex Smith");
  assert.equal((await call("onboard.you", { name: "Alex Smith", assistant: "Kit" }, { root, caller: "cli" })).error, undefined);
});

test("onboard: an address the setup page already claimed is never replaced by the person's name, and step 4 reads it instead of claiming again (#50)", async t => {
  const { root } = await box(t, { name: "acme-lab", network: { onboardPort: 0, via: "vyre.run" } });
  const { url, port } = (await call("onboard.link", {}, { root })).data;
  const base = `http://127.0.0.1:${port}`;
  const { session } = await redeem(url);
  const saved = () => JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  const before = (await (await tool(base, session, "onboard.status")).json()).data;
  assert.equal(before.name, null, "step 1 is not prefilled with the address");
  const you = await (await tool(base, session, "onboard.you", { name: "Robin" })).json();
  assert.equal(you.data.person, "Robin");
  assert.equal(saved().name, "acme-lab", "the person's name did not overwrite the address");
  const s = (await (await tool(base, session, "onboard.status")).json()).data;
  assert.equal(s.name, "Robin", "the greeting uses the person");
  assert.equal(s.detail.name.name, "acme-lab", "the address step still says which address is held");
  // reserving with the person's name does not try to claim it, and does not fail
  const r = await (await tool(base, session, "onboard.name", { name: "Robin", action: "reserve", confirm: true })).json();
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(saved().name, "acme-lab");
});
