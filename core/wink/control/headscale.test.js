// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { SCRATCH } from "../../../test/scratch.mjs";
import { createHeadscale, buildConfig, pickPrefix, redact, headscaleBin } from "./headscale.js";
import { compilePolicy } from "./policy.js";

const FAKE = path.join(import.meta.dirname, "testing", "fake-headscale.js");

/** @param {import("node:test").TestContext} t */
function dirFor(t) {
  const d = mkdtempSync(path.join(SCRATCH, "w-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** @param {import("node:test").TestContext} t @param {object} [extra] */
function make(t, extra = {}) {
  const d = path.join(dirFor(t), "hs");
  const lines = [], events = [];
  const hs = createHeadscale({ dir: d, bin: FAKE, serverUrl: "https://home.example", healthMs: 1000, onLog: l => lines.push(l), onEvent: e => events.push(e), ...extra });
  t.after(() => hs.stop());
  return { hs, d, lines, events };
}

test("headscaleBin: the env wins; under node --test there is none otherwise", () => {
  const prev = { b: process.env.VYRE_HEADSCALE_BIN, r: process.env.VYRE_WINK_REAL };
  try {
    delete process.env.VYRE_HEADSCALE_BIN; delete process.env.VYRE_WINK_REAL;
    assert.equal(headscaleBin(), null);
    process.env.VYRE_HEADSCALE_BIN = "/x/hs";
    assert.equal(headscaleBin(), "/x/hs");
  } finally { for (const [k, v] of [["VYRE_HEADSCALE_BIN", prev.b], ["VYRE_WINK_REAL", prev.r]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test("pickPrefix: a /24 inside 100.64.0.0/10 that avoids what is used", () => {
  for (let i = 0; i < 300; i++) {
    const p = pickPrefix(["100.64.0.0/11", "100.96.0.0/12"]);
    const m = /^100\.(\d+)\.(\d+)\.0\/24$/.exec(p);
    assert.ok(m, p);
    const second = Number(m[1]);
    assert.ok(second >= 64 && second <= 127, p);
    assert.ok(second >= 108, `${p} overlaps a used range`); // 64-95 and 96-111 are taken
  }
  assert.throws(() => pickPrefix(["100.64.0.0/10"]), /no free/);
  assert.notEqual(pickPrefix([]), pickPrefix([]).replace(/^/, "") === "x");
});

test("buildConfig: everything pinned, nothing open", () => {
  const c = buildConfig({ dir: "/s", serverUrl: "https://h.example", prefix: "100.97.143.0/24", listenPort: 18080, metricsPort: 19090, grpcPort: 50443 });
  for (const needle of [
    'listen_addr: "127.0.0.1:18080"', 'metrics_listen_addr: "127.0.0.1:19090"', 'trusted_proxies: ["127.0.0.1/32"]', 'v4: "100.97.143.0/24"',
    "mode: file", "magic_dns: false", "urls: []", 'unix_socket_permission: "0600"', "logtail:\n  enabled: false", "taildrop:\n  enabled: false",
    "disable_check_updates: true", "verify_clients: true", "write_ahead_log: true", "enabled: false\n    region_id", 'paths: ["/s/derp-dummy.yaml"]',
  ]) assert.ok(c.includes(needle), needle);
  assert.ok(!/\bv6:/.test(c) && !/oidc/i.test(c) && !c.includes("tailscale.com"));
  assert.throws(() => buildConfig({ dir: "/s", serverUrl: "x", prefix: "10.0.0.0/24", listenPort: 1, metricsPort: 2, grpcPort: 3 }), /100\.64/);
  assert.throws(() => buildConfig({ dir: "/s", serverUrl: "x", prefix: "100.97.143.0/24", listenPort: 1, metricsPort: 2, grpcPort: 3, derp: { enabled: true } }), /TLS/);
  const d = buildConfig({ dir: "/s", serverUrl: "x", prefix: "100.97.143.0/24", listenPort: 1, metricsPort: 2, grpcPort: 3, derp: { enabled: true, tlsCert: "/c", tlsKey: "/k" } });
  assert.ok(d.includes("enabled: true\n    region_id") && d.includes("paths: []") && d.includes('tls_cert_path: "/c"'));
});

test("redact: keys never survive", () => {
  assert.equal(redact("key hskey-auth-abc123DEF456 end"), "key [redacted-key] end");
  assert.equal(redact("nodekey:0123456789abcdef"), "[redacted-key]");
});

test("supervisor: start, health, admin socket 0600, stop", async t => {
  const { hs, d } = make(t, { usedPrefixes: ["100.64.0.0/10"].slice(1) });
  const s = await hs.start();
  assert.equal(s.state, "running"); assert.equal(s.healthy, true); assert.ok(s.pid);
  assert.match(/** @type {string} */ (s.prefix), /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.0\/24$/);
  assert.equal(fs.statSync(hs.socketPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(d).mode & 0o777, 0o700);
  for (const f of ["config.yaml", "policy.hujson", "wink.json"]) assert.equal(fs.statSync(path.join(d, f)).mode & 0o777, 0o600, f);
  assert.deepEqual(JSON.parse(fs.readFileSync(hs.policyPath, "utf8")).acls, [], "starts deny-all");
  await hs.stop();
  assert.equal((await hs.status()).state, "stopped");
  assert.equal(await hs.healthy(), false);
});

test("supervisor: the prefix survives a restart", async t => {
  const { hs } = make(t);
  const a = await hs.start();
  const b = await hs.restart();
  assert.equal(a.prefix, b.prefix);
  assert.equal(b.state, "running");
});

test("supervisor: a crash is restarted with backoff, and says so", async t => {
  const { hs, events } = make(t);
  await hs.start();
  const pid = hs.pid;
  execFileSync(FAKE, ["-c", hs.configPath, "fake-crash"]);
  await new Promise(r => setTimeout(r, 300));
  assert.ok(events.some(e => e.type === "exited"));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !((await hs.status()).state === "running" && hs.pid !== pid)) await new Promise(r => setTimeout(r, 200));
  const s = await hs.status();
  assert.equal(s.state, "running"); assert.notEqual(hs.pid, pid); assert.equal(s.restarts, 1);
});

test("createPreauthKey: single use, minutes, tags need the policy, key only in memory or a 0600 file", async t => {
  const argvLog = path.join(dirFor(t), "argv.log");
  const { hs, lines, events } = make(t, { env: { FAKE_HS_ARGV_LOG: argvLog } });
  await hs.start();
  const k = await hs.createPreauthKey({ ttlMs: 120_000 });
  assert.match(/** @type {string} */ (k.key), /^hskey-auth-/);
  assert.ok(k.expiresAt > Date.now() && k.expiresAt <= Date.now() + 120_000);
  // tags are refused until the policy defines them
  await assert.rejects(hs.createPreauthKey({ tags: ["tag:wink-device"] }), /tagOwners/);
  hs.setPolicy(compilePolicy({ rows: [], hubPort: 1, jobPort: 1, tags: ["tag:wink-device"] }).text);
  const t2 = await hs.createPreauthKey({ tags: ["tag:wink-device"], ttlMs: 60_000 });
  assert.deepEqual(t2.tags, ["tag:wink-device"]);
  await assert.rejects(hs.createPreauthKey({ tags: ["admin"] }), /bad tag/);
  // to a file: 0600, and the answer carries no key
  const f = path.join(dirFor(t), "k");
  const t3 = await hs.createPreauthKey({ file: f });
  assert.equal(t3.key, undefined); assert.equal(t3.file, f);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(f, "utf8"), /^hskey-auth-/);
  await assert.rejects(hs.createPreauthKey({ file: f }), /EEXIST/, "never overwrites a file");
  // nothing leaked: not in argv, logs, events
  const secrets = [k.key, t2.key, fs.readFileSync(f, "utf8")].filter(Boolean);
  const hay = fs.readFileSync(argvLog, "utf8") + lines.join("\n") + JSON.stringify(events);
  for (const s of secrets) assert.ok(!hay.includes(/** @type {string} */ (s)));
  assert.ok(!/--reusable/.test(fs.readFileSync(argvLog, "utf8")));
});

test("nodes: list is parsed, delete removes", async t => {
  const { hs, d } = make(t);
  await hs.start();
  assert.deepEqual(await hs.listNodes(), []);
  execFileSync(FAKE, ["-c", hs.configPath, "fake-add-node", "phone", "100.97.143.2", "tag:wink-device"]);
  const [n] = await hs.listNodes();
  assert.equal(n.name, "phone"); assert.deepEqual(n.ips, ["100.97.143.2"]); assert.deepEqual(n.tags, ["tag:wink-device"]);
  assert.equal(n.stableId, String(n.id)); assert.ok(n.nodeKey.startsWith("nodekey:"));
  await assert.rejects(hs.deleteNode("nope"), /bad node id/);
  await hs.deleteNode(n.id);
  assert.deepEqual(await hs.listNodes(), []);
  void d;
});

test("CLI without a running daemon fails with a plain error", async t => {
  const { hs } = make(t);
  await assert.rejects(hs.listNodes(), /failed/);
});

test("setPolicy: writes and signals the daemon, which logs the reload", async t => {
  const { hs, lines } = make(t);
  await hs.start();
  const r = hs.setPolicy(compilePolicy({ rows: [], hubPort: 1, jobPort: 1, tags: ["tag:x"] }).text);
  assert.deepEqual([r.changed, r.signalled], [true, true]);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !lines.some(l => /policy reloaded/.test(l))) await new Promise(r => setTimeout(r, 50));
  assert.ok(lines.some(l => /policy reloaded/.test(l)));
});
