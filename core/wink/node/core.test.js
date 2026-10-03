// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../../test/helpers.js";
import { createCore, prefsDrift, shapeState, statusFindings, isTailnetIp, WinkCoreError } from "./core.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_D = path.join(HERE, "testing", "fake-tailscaled.js");
const FAKE_C = path.join(HERE, "testing", "fake-tailscale.js");
const PIN = "sha256/" + Buffer.alloc(32, 1).toString("base64");
const SECRET = "hskey-auth-NOTAREALKEY123456";

/** A world: a home, a fake binary pair, a 0600 key file, and a core manager that reports events. */
function world(t, { hostile, failUp, detect } = /** @type {any} */ ({})) {
  const dir = tempHome(t);
  const home = path.join(dir, "wink");
  fs.mkdirSync(path.join(home, "run"), { recursive: true, mode: 0o700 });
  if (hostile || failUp) fs.writeFileSync(path.join(home, "run", "fake.json"), JSON.stringify({ hostile, failUp }));
  const keyFile = path.join(dir, "join.key");
  fs.writeFileSync(keyFile, SECRET + "\n", { mode: 0o600 });
  const events = /** @type {any[]} */ ([]);
  const core = createCore({ env: { VYRE_WINK_CORE_BIN: FAKE_D, VYRE_WINK_CLI_BIN: FAKE_C }, onEvent: e => events.push(e), detect: detect || (() => ({ systemTailscale: false, why: null })) });
  t.after(() => core.stop());
  const opts = { home, controlUrl: "https://127.0.0.1:9", pinnedKeyPin: PIN, authKeyFile: keyFile, hostname: "alex-laptop" };
  const fake = () => JSON.parse(fs.readFileSync(path.join(home, "run", "fake.json"), "utf8"));
  return { home, keyFile, events, core, opts, fake };
}

test("core: starts a userspace core, joins with the key file, deletes the key, holds every enforced pref", async t => {
  const w = world(t);
  const s = await w.core.start(w.opts);
  assert.equal(s.state, "connected");
  assert.equal(s.self?.stableId, "7");
  // the key was used as a file reference only and the file is gone (EC-4)
  assert.equal(fs.existsSync(w.keyFile), false);
  const calls = JSON.stringify(w.fake().calls);
  assert.ok(calls.includes("--auth-key=file:" + w.keyFile));
  assert.equal(calls.includes(SECRET), false);
  // the daemon: userspace, a state FILE and no state directory (no Taildrop storage), a short-lived scrubbed child
  const argv = JSON.parse(fs.readFileSync(path.join(w.home, "run", "daemon-argv.json"), "utf8"));
  assert.ok(argv.includes("--tun=userspace-networking"));
  assert.ok(argv.some((/** @type {string} */ a) => a.startsWith("--state=") && a.endsWith("tailscaled.state")));
  assert.equal(argv.some((/** @type {string} */ a) => a.startsWith("--statedir")), false);
  assert.ok(argv.includes("--no-logs-no-support"));
  // private modes
  if (process.platform !== "win32") {
    for (const d of ["", "state", "run", "log"]) assert.equal(fs.statSync(path.join(w.home, d)).mode & 0o777, 0o700, d);
    assert.equal(fs.statSync(path.join(w.home, "run", "ts.sock")).mode & 0o777, 0o600);
  }
  // the exact prefs
  const prefs = w.fake().prefs;
  const shimUrl = prefs.ControlURL;
  assert.match(shimUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(prefsDrift(prefs, { controlUrl: shimUrl, hostname: "alex-laptop", tags: [] }), []);
  assert.equal(prefs.RouteAll, false); assert.equal(prefs.CorpDNS, false); assert.equal(prefs.RunSSH, false);
  assert.equal(prefs.ExitNodeIP, ""); assert.equal(prefs.AutoUpdate.Check, false);
  await w.core.stop();
  assert.equal((await w.core.status()).state, "offline");
});

test("core: a key file open to others, a missing binary, a missing key and bad input are refused", async t => {
  const w = world(t);
  fs.chmodSync(w.keyFile, 0o644);
  await assert.rejects(w.core.start(w.opts), /0600/);
  fs.chmodSync(w.keyFile, 0o600);
  const bare = createCore({ env: {}, detect: () => ({ systemTailscale: false, why: null }) });
  await assert.rejects(bare.start(w.opts), (/** @type {any} */ e) => e instanceof WinkCoreError && e.code === "no-binary");
  await assert.rejects(w.core.start({ ...w.opts, authKeyFile: undefined }), (/** @type {any} */ e) => e.code === "no-key");
  await assert.rejects(w.core.start({ ...w.opts, hostname: "Bad Name" }), (/** @type {any} */ e) => e.code === "bad-input");
  await assert.rejects(w.core.start({ ...w.opts, tags: ["tag:ok", "nope"] }), (/** @type {any} */ e) => e.code === "bad-input");
  await assert.rejects(w.core.start({ ...w.opts, home: "relative/home" }), (/** @type {any} */ e) => e.code === "bad-input");
});

test("core: never looks for the person's own Tailscale (no PATH search, no default binary)", async t => {
  const w = world(t);
  const bare = createCore({ env: { PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" }, detect: () => ({ systemTailscale: false, why: null }) });
  await assert.rejects(bare.start(w.opts), /no Wink core binary/);
});

test("core: a Tailscale already running forces userspace; system mode is refused with the reason (EC-10)", async t => {
  const w = world(t, { detect: () => ({ systemTailscale: true, why: "an interface with a 100.64/10 address" }) });
  await assert.rejects(w.core.start({ ...w.opts, mode: "system" }), (/** @type {any} */ e) => e.code === "existing-tailscale" && /100\.64\/10/.test(e.message));
  const s = await w.core.start(w.opts); // userspace is the default and is allowed
  assert.equal(s.state, "connected");
});

test("core: hostile control, push during up: routes, exit node, DNS and SSH never stay (EC-9)", async t => {
  const w = world(t, { hostile: "push-on-up" });
  await w.core.start(w.opts);
  const prefs = w.fake().prefs;
  assert.deepEqual([prefs.RouteAll, prefs.CorpDNS, prefs.RunSSH, prefs.ExitNodeIP, prefs.AdvertiseRoutes], [false, false, false, "", null]);
  // the pushed login URL is reported as an error and never opened
  assert.ok(w.events.some(e => e.type === "error" && e.code === "login-url"));
});

test("core: hostile control, a push after our settings is reported as drift, repaired, and the result is clean", async t => {
  const w = world(t, { hostile: "push-after-set" });
  await w.core.start(w.opts);
  const drift = w.events.find(e => e.type === "error" && e.code === "prefs-drift");
  assert.ok(drift, "drift is an error event");
  const names = drift.drift.map((/** @type {any} */ d) => d.pref);
  for (const n of ["RouteAll", "CorpDNS", "RunSSH", "ExitNodeIP", "AdvertiseRoutes"]) assert.ok(names.includes(n), n);
  assert.ok(w.events.some(e => e.code === "exit-node"));
  const p = w.fake().prefs;
  assert.deepEqual([p.RouteAll, p.CorpDNS, p.RunSSH, p.ExitNodeIP, p.AdvertiseRoutes], [false, false, false, "", null]);
});

test("core: hostile control that undoes our settings every time stops the core (fail closed)", async t => {
  const w = world(t, { hostile: "sticky" });
  await assert.rejects(w.core.start(w.opts), (/** @type {any} */ e) => e.code === "drift");
  assert.ok(w.events.some(e => e.code === "prefs-drift-persistent"));
  assert.equal((await w.core.status()).state, "offline");
  const pid = fs.existsSync(path.join(w.home, "run", "core.pid"));
  assert.equal(pid, false, "the daemon is stopped and its pid file removed");
});

test("core: a failed join reports the reason and leaves the key file for a retry", async t => {
  const w = world(t, { failUp: true });
  await assert.rejects(w.core.start(w.opts), (/** @type {any} */ e) => e.code === "up-failed" && /bad key/.test(e.message));
  assert.equal(fs.existsSync(w.keyFile), true);
});

test("core: a restart rejoins from the enrolment on disk with no key; leave deletes the state", async t => {
  const w = world(t);
  await w.core.start(w.opts);
  await w.core.stop();
  const again = await w.core.start({ ...w.opts, authKeyFile: undefined });
  assert.equal(again.state, "connected");
  await w.core.leave();
  assert.equal(fs.existsSync(path.join(w.home, "state")), false);
  assert.equal(fs.existsSync(path.join(w.home, "run")), false);
});

test("core: status shapes peers and states; whois returns the node key and id, never the name", async t => {
  const w = world(t);
  const NK = "nodekey:" + "cd".repeat(32);
  fs.writeFileSync(path.join(w.home, "run", "fake.json"), JSON.stringify({
    peers: { [NK]: { ID: "12", PublicKey: NK, TailscaleIPs: ["100.97.143.12"], Tags: ["tag:hub"], Online: true, CurAddr: "" } },
    whois: { "100.97.143.12": { Node: { Key: NK, StableID: "12", Name: "root.attacker.example.", Tags: ["tag:hub"] }, UserProfile: { LoginName: "tagged-devices" } } },
  }));
  await w.core.start(w.opts);
  const s = await w.core.status();
  assert.equal(s.state, "relayed");
  assert.deepEqual(s.peers.map(p => [p.nodeKey, p.stableId, p.direct]), [[NK, "12", false]]);
  const who = await w.core.whois("100.97.143.12");
  assert.deepEqual(who, { nodeKey: NK, stableId: "12", tags: ["tag:hub"], tagged: true });
  assert.equal(JSON.stringify(who).includes("attacker"), false);
  assert.equal(await w.core.whois("100.97.143.99"), null);
  await assert.rejects(w.core.whois("--json"), (/** @type {any} */ e) => e.code === "bad-input");
  await assert.rejects(w.core.whois("8.8.8.8"), (/** @type {any} */ e) => e.code === "bad-input");
});

test("core: pure helpers", () => {
  assert.deepEqual(shapeState({ BackendState: "Running", Peer: {} }), { state: "connected", why: null });
  assert.equal(shapeState({ BackendState: "Running", Peer: { a: { Online: true, CurAddr: "1.2.3.4:5" } } }).state, "connected");
  assert.equal(shapeState({ BackendState: "Running", Peer: { a: { Online: true, CurAddr: "" } } }).state, "relayed");
  assert.equal(shapeState({ BackendState: "Starting" }).state, "joining");
  assert.equal(shapeState({ BackendState: "NeedsLogin" }).state, "joining");
  assert.equal(shapeState({ BackendState: "Stopped" }).state, "offline");
  assert.equal(shapeState(null).state, "offline");
  assert.deepEqual(statusFindings({ Peer: { a: { AllowedIPs: ["100.97.143.2/32", "0.0.0.0/0"] } } }).map(f => f.code), ["peer-routes-ignored"]);
  assert.equal(isTailnetIp("100.64.0.1"), true);
  assert.equal(isTailnetIp("100.128.0.1"), false);
  assert.equal(isTailnetIp("127.0.0.1"), false);
  assert.equal(isTailnetIp("fd7a:115c:a1e0::1"), true);
  const d = prefsDrift({ ControlURL: "https://evil", RouteAll: true, AutoUpdate: { Check: true } }, { controlUrl: "http://127.0.0.1:1", hostname: "h", tags: [] });
  assert.ok(d.some(x => x.pref === "ControlURL") && d.some(x => x.pref === "RouteAll") && d.some(x => x.pref === "AutoUpdate.Check"));
});
