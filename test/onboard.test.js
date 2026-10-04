// @ts-check
// 0.3 order (ruling, 4 Oct): a server takes only pairing before it has an owner; sign-ins and names are set up from the owner's signed-in app session. The cases that reached the old loopback
// first-run page with its cookie were removed (the page is gone from the server install); the guard that replaces them is core/onboard/owner-write.test.js.
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
  const d = await start({ root, presence: present, log: () => {} });
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

