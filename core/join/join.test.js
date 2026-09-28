// @ts-check
// join against a real vyred (role box): onboard, names, relay and link are the real modules, not
// fakes — join is a thin pass-through over their own tested tools, so this checks the wiring
// (status merges both, tailscale/relay/verify forward with the right presence gate), not their
// own logic again. A fake tailscale binary, never the real one; relay's url points at a dead
// local port, never the real internet relay.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { Presence } from "../presence/index.js";
import { open } from "../store/index.js";
import { tempHome, present } from "../../test/helpers.js";

function fakeBin(dir, name, out) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\ncat <<'EOF2'\n${out}\nEOF2\n`, { mode: 0o755 });
  return p;
}

/** A box with a fake tailscale (needs-login) and relay pointed at a dead local port. */
async function box(t) {
  const root = tempHome(t);
  const bins = fs.mkdtempSync(path.join(root, "bin-"));
  const prev = process.env.VYRE_TAILSCALE_BIN;
  process.env.VYRE_TAILSCALE_BIN = fakeBin(bins, "tailscale", JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/fake", TUN: true, OperatorUser: os.userInfo().username }));
  t.after(() => { if (prev === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = prev; });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], vault: { keystore: "file" },
    relay: { url: "ws://127.0.0.1:1" }, modules: { disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  return { root, tool: (name, input = {}, caller = "cli") => call(name, input, { root, caller, timeout: 20_000 }) };
}

test("join: status merges Tailscale's own state with whether the relay is ready to pair", async t => {
  const { tool } = await box(t);
  const s = await tool("join.status");
  assert.equal(s.error, undefined, JSON.stringify(s.error));
  assert.equal(s.data.tailscale.state, "needs-login");
  assert.equal(s.data.tailscale.loginUrl, "https://login.tailscale.com/a/fake");
  assert.deepEqual(s.data.relay, { available: true, enabled: false, connected: false, pairing: null });
});

test("join: tailscale forwards to onboard.tailscale, callable outside the first-run wizard", async t => {
  const { tool } = await box(t);
  const status = await tool("join.tailscale", { action: "status" });
  assert.equal(status.data.state, "needs-login");
  // connect is presence-gated (pairing a device to the tailnet); the test's `present` verifier
  // never checks, so it reaches onboard.tailscale's own connect logic, which still refuses since
  // the operator is fine but the fake tailscale never actually signs in.
  const connect = await tool("join.tailscale", { action: "connect" });
  assert.equal(connect.error, undefined, JSON.stringify(connect.error));
  assert.ok(connect.data.loginUrl, "the sign-in link is still handed back");
});

test("join: verify forwards to link.health, unknown without a node to name", async t => {
  const { tool } = await box(t);
  const v = await tool("join.verify");
  assert.equal(v.error, undefined, JSON.stringify(v.error));
  assert.equal(v.data.online, false);
  assert.match(v.data.why, /say which node/);
});

test("join: relay mints a pairing code without needing to reach the relay first", async t => {
  const { tool } = await box(t);
  const r = await tool("join.relay");
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.match(r.data.url, /^https:\/\/vyre\.run\/pair#/);
  assert.equal(r.data.connected, false, "the dead-port relay never answers, and mint() says so rather than hanging");
  assert.ok(r.data.expiresAt > Date.now());
});

test("join: status and verify never need presence; tailscale.connect and relay always do", t => {
  // The registry's own decision (core/presence's `required(tool, def, input)`), the same check
  // the daemon runs before a tool goes near the touchid/webauthn prompt. Pure, so no daemon,
  // dialog or fake tailscale is needed here.
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const p = new Presence({ db, platform: "linux", touchid: null, webauthn: null, who: async () => [], statTty: () => null, writeTty: () => {} });
  const statusDef = { presence: undefined }, verifyDef = { presence: undefined };
  const tailscaleDef = { presence: { when: i => i && i.action === "connect" } };
  const relayDef = { presence: { summary: async () => "Pair a new device with this box, without Tailscale" } };
  assert.equal(p.required("join.status", statusDef, {}), false);
  assert.equal(p.required("join.verify", verifyDef, {}), false);
  assert.equal(p.required("join.tailscale", tailscaleDef, { action: "status" }), false, "reading Tailscale's state needs no proof");
  assert.equal(p.required("join.tailscale", tailscaleDef, { action: "policy" }), false, "the paste-only policy snippet needs no proof either");
  assert.equal(p.required("join.tailscale", tailscaleDef, { action: "connect" }), true, "starting tailscale up does");
  assert.equal(p.required("join.relay", relayDef, {}), true, "pairing a new device always does");
});
