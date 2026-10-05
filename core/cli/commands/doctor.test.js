// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { diagnose, lines, item, IDS, BUDGET_MS } from "./doctor.js";
import { stripAnsi } from "../screen/width.js";
import { tempHome } from "../../../test/helpers.js";

const BOX = "https://vyre.harlow.vyre.run";

/** What network.wink.status answers on a Mac whose link to its server works, over the relay path or direct. */
const wink = (o = {}) => ({
  at: 1, otherVpn: false,
  identity: { signedIn: true, name: "alex.vyre.run", devices: 3 },
  spaces: [{ id: "personal", name: "Personal", state: "connected", node: "up", path: "direct", latencyMs: 12, peers: 2, peerList: [], door: { listening: false, refused: false } }],
  relay: { enabled: true, reachable: true, latencyMs: 38 },
  storage: [{ id: "s1", name: "nas-1", state: "online", reachable: true, capacity: 500e9, used: 88e9, free: 412e9 }],
  clock: { skewMs: 800 },
  ...o,
});

/** Tools as a paired Mac's vyred answers them; `box` answers what link.call carries. */
function tools({ link = {}, box = {}, status = {} } = {}) {
  const remote = {
    "presence.keys": () => ({ data: [{ id: "k1", kind: "passkey", rp_id: "vyre.harlow.vyre.run" }] }),
    "onboard.status": () => ({ data: { detail: { claude: { installed: true, signedIn: true, via: "setup-token" } } } }),
    ...box,
  };
  return async (name, input) => {
    if (name === "network.wink.status") return { data: wink(status) };
    if (name === "link.status") return { data: { role: "local", linked: true, reachable: true, box: { address: BOX, name: "vyre" }, pending: null, ...link } };
    if (name === "recall.status") return { data: { sessions: 5678, turns: 40000, indexing: true, progress: { sessions: { done: 1234, total: 5678 }, paused: null, priority: "low" }, vectors: { on: true, ready: false, embedded: 0, pending: 40000, why: "not loaded yet" } } };
    if (name === "link.call") return remote[input.tool] ? remote[input.tool]() : { error: { code: "no_such_tool", message: input.tool } };
    return { error: { code: "no_such_tool", message: name } };
  };
}

const deps = (o = {}) => ({
  role: "local", health: async () => ({ version: "0.0.1", commit: "1a2b3c4d5e", dirty: false }),
  tool: tools(), capsuleApps: [], size: () => ({ bytes: 5_900_000, files: 450 }), path: () => ({ ours: true, others: [] }),
  modules: async () => ({ data: [{ name: "settings", state: "running" }, { name: "recall", state: "running" }] }),
  ...o,
});
const byId = r => Object.fromEntries(r.checks.map(c => [c.id, c]));

test("doctor: a Mac where everything works is all ticks, with what it found, in the plain words", async () => {
  const r = await diagnose(deps());
  const c = byId(r);
  for (const id of ["vyred", "identity", "space-link", "path", "relay", "storage", "clock", "paired", "passkey", "claude", "modules", "install"]) assert.equal(c[id].ok, true, `${id}: ${JSON.stringify(c[id])}`);
  assert.equal(c.vyred.detail, "0.0.1 · 1a2b3c4");
  assert.deepEqual([c.identity.label, c.identity.detail], ["Signed in to Vyre", "alex.vyre.run, 3 devices"]);
  assert.deepEqual([c["space-link"].label, c["space-link"].detail], ["Link to Personal", "up, 2 other devices seen"]);
  assert.deepEqual([c.path.label, c.path.detail], ["Path to your server", "direct, 12 ms"]);
  assert.equal(c.relay.detail, "answering, 38 ms");
  assert.deepEqual([c.storage.label, c.storage.detail], ["Storage: nas-1", "reachable, 412 GB free"]);
  assert.equal(c.clock.detail, "within 2 s of the relay");
  assert.equal(c.door.ok, null, "a Mac has no door");
  assert.equal(c.door.detail, "only a server has one");
  assert.equal(c.passkey.detail, "vyre.harlow.vyre.run");
  assert.equal(c.modules.detail, "2 running");
  assert.equal(c.install.detail, "5.9 MB");
  assert.equal(c["vyre-on-path"].ok, true);
  assert.equal(c.recall.detail, "indexing 1,234 of 5,678 sessions, low priority");
  assert.ok(r.ms < BUDGET_MS);
  const words = JSON.stringify(r.checks);
  assert.ok(!/tailscale|tailnet|wink|wireguard|derp|magicdns/i.test(words), "no word a person should not read");
});

test("doctor: each thing the user tripped on is a cross with the one thing to do", async () => {
  const c = byId(await diagnose(deps({
    tool: tools({ status: wink({
      identity: { signedIn: false },
      spaces: [{ id: "work", name: "Work", state: "offline", node: "up", path: null, latencyMs: null, peers: 0, peerList: [], why: "no path to the space", door: { listening: false, refused: true } }],
      relay: { enabled: true, reachable: false, latencyMs: null },
      storage: [{ id: "s2", name: "bucket-a", state: "unreachable", reachable: false }],
      clock: { skewMs: 94_000 },
    }), box: {
      "presence.keys": () => ({ data: [{ id: "k1", kind: "passkey", rp_id: "other.vyre.run" }] }),
      "onboard.status": () => ({ data: { detail: { claude: { installed: true, signedIn: false } } } }),
    } }),
    size: () => ({ bytes: 750_000_000, files: 30_000 }),
  })));
  assert.deepEqual([c.identity.ok, c.identity.detail, c.identity.fix], [false, "this computer is not signed in", "open the Vyre app and sign in, or run: vyre up"]);
  assert.deepEqual([c["space-link"].ok, c["space-link"].label, c["space-link"].fix], [false, "Link to Work", "the server is off or has no internet"]);
  assert.deepEqual([c.path.ok, c.path.detail, c.path.fix], [false, "none", "check this computer's internet connection"]);
  assert.deepEqual([c.relay.ok, c.relay.detail], [false, "not answering"]);
  assert.match(c.relay.fix, /outbound HTTPS \(port 443\)/);
  assert.deepEqual([c.door.ok, c.door.detail, c.door.fix], [false, "refused this device (not on the list)", "ask an owner to add it, or pair again with: vyre up"]);
  assert.deepEqual([c.storage.ok, c.storage.label, c.storage.fix], [false, "Storage: bucket-a", "check the access details saved for it in the vault"]);
  assert.deepEqual([c.clock.ok, c.clock.detail], [false, "94 s off, so pairing and device lists will be refused"]);
  assert.match(c.clock.fix, /automatic date and time/);
  assert.deepEqual([c.passkey.ok, c.passkey.detail], [false, "passkeys exist, but none for vyre.harlow.vyre.run"]);
  assert.match(c.passkey.fix, /vyre up/);
  assert.deepEqual([c.claude.ok, c.claude.detail], [false, "not signed in"]);
  assert.equal(c.install.ok, false);
  assert.match(c.install.fix, /npm install -g https:\/\/vyre\.run\/box\/vyre\.tgz/);
  const text = lines(c.passkey).map(stripAnsi);
  assert.match(text[0], /^  ✗ A passkey for the box's address · passkeys exist/);
  assert.match(text[1], /^      on the box: vyre up/);
  const link = lines(c["space-link"]).map(stripAnsi);
  assert.deepEqual(link, ["  ✗ Link to Work · down", "      the server is off or has no internet"]);
});

test("doctor: a relayed path with a working relay is a pass, through the relay, never an error; another VPN on this machine is a question, not a cross", async () => {
  const relayed = byId(await diagnose(deps({ tool: tools({ status: wink({ spaces: [{ id: "personal", name: "Personal", state: "relayed", node: "up", path: "relay", latencyMs: 84, peers: 1, peerList: [], door: { listening: false, refused: false } }] }) }) })));
  assert.deepEqual([relayed.path.ok, relayed.path.detail], [true, "through the relay, 84 ms (no direct path yet)"]);
  assert.equal(relayed.relay.ok, true);
  const vpn = byId(await diagnose(deps({ tool: tools({ status: wink({ otherVpn: true, spaces: [{ id: "personal", name: "Personal", state: "relayed", node: "down", path: "relay", latencyMs: null, peers: 0, peerList: [], relayOnly: "another VPN is running here", door: { listening: false, refused: false } }] }) }) })));
  assert.deepEqual([vpn["space-link"].ok, vpn["space-link"].detail], [null, "using the relay, because another VPN is running here"]);
  assert.equal(vpn.path.ok, true);
});

test("doctor: two spaces and two storage devices are one line each, and a missing relay or a clock that cannot be compared is a question", async () => {
  const two = { id: "x", name: "Work", state: "connected", node: "up", path: "direct", latencyMs: 9, peers: 1, peerList: [], door: { listening: false, refused: false } };
  const r = await diagnose(deps({ tool: tools({ status: wink({
    spaces: [wink().spaces[0], two, { ...two, id: "y", name: "Harlow", state: "offline", why: "x" }],
    storage: [wink().storage[0], { id: "s3", name: "bucket-a", state: "online", reachable: true, capacity: 4e12, used: 1e12, free: 3e12 }],
    relay: { enabled: false, reachable: false, latencyMs: null }, clock: { skewMs: null } }) }) }));
  assert.deepEqual(r.checks.filter(c => c.id === "space-link").map(c => [c.label, c.ok]), [["Link to Personal", true], ["Link to Work", true], ["Link to Harlow", false]]);
  assert.deepEqual(r.checks.filter(c => c.id === "storage").map(c => c.detail), ["reachable, 412 GB free", "reachable, 3.0 TB free"]);
  const c = byId(r);
  assert.deepEqual([c.relay.ok, c.relay.detail], [null, "turned off on this server"]);
  assert.deepEqual([c.clock.ok, c.clock.detail], [null, "could not reach the relay to compare"]);
});

test("doctor: a module whose manifest under-declares a tool or event is a named cross, not a silent gap", async () => {
  // The exact gotcha tailnet lost time to (team/archive/work-journals/tailnet.md, 28 Sep 2026): a module that
  // registers a tool or emits an event its own module.json does not declare fails to start, every
  // other module still loads, and vyred's log is the only place that says which one and why.
  // vyre doctor is the other place now.
  const c = byId(await diagnose(deps({ modules: async () => ({ data: [
    { name: "settings", state: "running" },
    { name: "relay", state: "failed", error: "relay registered tool relay.pair.ticket, which its manifest does not declare under does.tools" },
  ] }) })));
  assert.equal(c.modules.ok, false);
  assert.equal(c.modules.detail, "relay: relay registered tool relay.pair.ticket, which its manifest does not declare under does.tools");
  assert.match(c.modules.fix, /vyred's log/);
});

test("doctor: more than one failed module names all of them, not just the first", async () => {
  const c = byId(await diagnose(deps({ modules: async () => ({ data: [
    { name: "relay", state: "failed", error: "relay emitted relay.paired, which its manifest does not declare under watches.emits" },
    { name: "old-thing", state: "invalid", error: "module.json unreadable: Unexpected token" },
  ] }) })));
  assert.equal(c.modules.ok, false);
  assert.match(c.modules.detail, /^2 modules \(relay, old-thing\):/);
});

test("doctor: with vyred down, it says start it, and what it cannot check is a question, not a cross", async () => {
  const c = byId(await diagnose(deps({ health: async () => null, tool: async () => ({ error: { code: "unreachable", message: "down" } }) })));
  assert.deepEqual([c.vyred.ok, c.vyred.fix], [false, "vyre up"]);
  for (const id of ["identity", "space-link", "path", "relay", "door", "clock", "passkey", "claude", "modules"]) assert.equal(c[id].ok, null, id);
  assert.equal(c.identity.detail, "vyred is not running");
  assert.equal(c.paired.ok, null);
});

test("doctor: an unpaired Mac waiting for approval says the code to approve", async () => {
  const c = byId(await diagnose(deps({ tool: tools({ link: { linked: false, reachable: false, pending: { code: "123-456" } } }) })));
  assert.deepEqual([c.paired.ok, c.paired.fix], [false, "on the box: vyre link approve 123-456"]);
  assert.equal(c.passkey.ok, null, "not reachable yet is not a missing passkey");
});

test("doctor: a box that never answers costs its timeout, not a hang: the run stays under 2 s", async () => {
  const never = () => new Promise(() => {});
  const t0 = Date.now();
  const r = await diagnose(deps({ tool: async (n, i) => (n === "link.call" || n === "network.wink.status" ? never() : tools()(n, i)) }));
  const took = Date.now() - t0;
  assert.ok(took < BUDGET_MS + 300, `took ${took} ms`);
  const c = byId(r);
  assert.equal(c.identity.ok, null);
  assert.equal(c.identity.detail, "did not answer in 2 s");
  assert.equal(c.passkey.ok, null);
});

test("doctor: on a box it checks the box's side: its address, its passkey, Claude, paired Macs", async () => {
  const tool = async name => ({
    "names.status": { data: { address: BOX, phase: "serving" } },
    "presence.keys": { data: [] },
    "onboard.status": { data: { detail: { claude: { installed: true, signedIn: true, via: "api-key" } } } },
    "link.peers": { data: [{ id: "p1" }] },
  })[name] || { error: { code: "no_such_tool", message: name } };
  const c = byId(await diagnose(deps({ role: "box", tool })));
  const boxTool = async name => (name === "network.wink.status" ? { data: wink({ spaces: [{ id: "personal", name: "Personal", state: "connected", node: "up", path: null, latencyMs: null, peers: 2, peerList: [], door: { listening: true, refused: false } }] }) } : tool(name));
  const home = byId(await diagnose(deps({ role: "box", tool: boxTool })));
  assert.deepEqual([home.door.ok, home.door.detail], [true, "accepting linked devices"]);
  assert.equal(home.path, undefined, "a server that only hosts has no path to a server");
  const shut = byId(await diagnose(deps({ role: "box", tool: async name => (name === "network.wink.status" ? { data: wink({ spaces: [{ id: "p", name: "Personal", state: "offline", node: "down", path: null, latencyMs: null, peers: 0, peerList: [], door: { listening: false, refused: false } }] }) } : tool(name)) })));
  assert.deepEqual([shut.door.ok, shut.door.fix], [false, "on the server: restart Vyre"]);
  assert.equal(c.capsule, undefined);
  assert.deepEqual([c.passkey.ok, c.passkey.detail], [false, "none enrolled"]);
  assert.deepEqual([c.claude.ok, c.claude.detail], [true, "with an API key"]);
  assert.deepEqual([c.paired.ok, c.paired.detail], [true, "1 Mac"]);
});

test("doctor: the real command against a temp home answers in under 2 s, as JSON, with an exit code", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [], vault: { keystore: "file" } }));
  const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../bin/vyre");
  const env = { ...process.env, VYRE_HOME: root, VYRE_NO_DIALOGS: "1" };
  const t0 = Date.now();
  const r = await new Promise(res => execFile(process.execPath, [bin, "doctor", "--json"], { env }, (e, stdout) => res({ code: e ? e.code : 0, out: stdout })));
  const took = Date.now() - t0;
  const j = JSON.parse(r.out);
  assert.equal(r.code, 1, "vyred is not running here, which fails");
  assert.equal(j.ok, false);
  assert.deepEqual(j.checks.find(c => c.id === "vyred"), { id: "vyred", label: "vyred is not running", ok: false, fix: "vyre up" });
  assert.equal(j.checks.find(c => c.id === "identity").ok, null);
  assert.ok(j.ms < BUDGET_MS, `diagnose took ${j.ms} ms`);
  assert.ok(took < BUDGET_MS + 1500, `the whole command took ${took} ms, node start included`);
});

test("doctor: the Capsule reports Control-twice through capsule.report, and the last report is what doctor reads", async t => {
  const { start } = await import("../../daemon/index.js");
  const { call, request } = await import("../../daemon/client.js");
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local", transcripts: [], vault: { keystore: "file" } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  assert.equal((await call("capsule.report", { ok: false, message: "Input Monitoring is off" }, { root, caller: "capsule" })).error, undefined);
  await call("capsule.report", { ok: true }, { root, caller: "capsule" });
  const r = await request("GET", "/v1/events?type=capsule.hotkey&limit=1000", undefined, { root });
  assert.deepEqual(r.data.map(e => e.payload), [{ ok: false, message: "Input Monitoring is off" }, { ok: true, message: null }]);
});

test("doctor: an old vyre on PATH is flagged, first or later, with the command that removes it", async t => {
  const c = byId(await diagnose(deps({ path: () => ({ ours: true, others: [{ path: "/Users/alex/.local/bin/vyre", target: "/Users/alex/proto/bin/vyre", first: true }] }) })));
  assert.equal(c["vyre-on-path"].ok, false);
  assert.match(c["vyre-on-path"].detail, /\.local\/bin\/vyre comes first on PATH/);
  assert.match(c["vyre-on-path"].fix, /^rm .*\.local\/bin\/vyre, then hash -r$/);
  const later = byId(await diagnose(deps({ path: () => ({ ours: true, others: [{ path: "/opt/old/vyre", target: "/opt/old/vyre", first: false }] }) })));
  assert.equal(later["vyre-on-path"].ok, false);
  assert.match(later["vyre-on-path"].detail, /another vyre is also on PATH/);

  // The real helper, over a PATH with a stand-in prototype before this install.
  const { shadows, OURS } = await import("../shadow.js");
  const dir = tempHome(t);
  fs.writeFileSync(path.join(dir, "vyre"), "#!/bin/sh\necho vyred running\n", { mode: 0o755 });
  const s = shadows({ PATH: [dir, path.dirname(OURS)].join(path.delimiter) });
  assert.deepEqual([s.ours, s.others.length, s.others[0].first], [true, 1, true]);
  assert.deepEqual(shadows({ PATH: [path.dirname(OURS), dir].join(path.delimiter) }).others[0].first, false);
  // The postinstall runs before npm links the command; it knows the folder it will be in.
  assert.equal(shadows({ PATH: [dir, "/nowhere/bin"].join(path.delimiter), binDir: "/nowhere/bin" }).others[0].first, true);
});

test("doctor: onCheck hears every check as it answers, and item() makes a checks frame's item", async () => {
  const heard = [];
  const r = await diagnose(deps({ onCheck: (i, c) => heard.push([IDS[i], c && c.id]) }));
  assert.equal(heard.length, IDS.length, "one call per check");
  for (const [id, got] of heard) assert.ok(got === null || got === id, `${id} heard as ${got}`);
  assert.ok(!IDS.some(id => /tailscale|magicdns|phone|address/.test(id)), "the old network checks are gone");
  assert.deepEqual(item({ id: "relay", label: "Relay", ok: false, detail: "not answering", fix: "a firewall may block outbound HTTPS" }),
    { id: "relay", label: "Relay", state: "failed", note: "not answering · next: a firewall may block outbound HTTPS" });
  assert.deepEqual(item({ id: "vyre-on-path", label: "This is the vyre your shell runs", ok: true }), { id: "vyre-on-path", label: "This is the vyre your shell runs", state: "ok" });
  assert.equal(item({ id: "x", label: "x", ok: null, detail: "why" }).state, "unknown");
  assert.equal(r.checks.length, heard.filter(([, c]) => c).length);
});

test("doctor --view: checks frames as each check answers, all waiting first, the --json result last; no verbs", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [], vault: { keystore: "file" } }));
  const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../bin/vyre");
  const env = { ...process.env, VYRE_HOME: root, VYRE_NO_DIALOGS: "1", NO_COLOR: "1" };
  const vyre = args => new Promise(res => execFile(process.execPath, [bin, ...args], { env }, (e, stdout) => res({ code: e ? e.code : 0, out: stdout })));
  const c = /** @type {any} */ (await vyre(["commands", "doctor", "--json"]));
  const doc = JSON.parse(c.out).commands[0];
  assert.deepEqual([doc.verbs, doc.flags], [[], [{ name: "json" }]]);
  const r = /** @type {any} */ (await vyre(["doctor", "--view"]));
  assert.equal(r.code, 1, "vyred is not running here, which fails");
  const f = r.out.trim().split("\n").map(l => JSON.parse(l));
  const done = f.pop();
  assert.deepEqual(done, { v: 1, done: true, exit: 1 });
  assert.ok(f.length >= 3, `a frame per change: ${f.length}`);
  for (const x of f) {
    assert.equal(x.view.kind, "checks");
    for (const it of x.view.items) assert.ok(["ok", "wait", "failed", "unknown"].includes(it.state), it.state);
  }
  assert.ok(f[0].view.items.every(it => it.state === "wait"), "the first frame is every check waiting");
  assert.equal(f[0].data, null);
  const last = f.at(-1);
  assert.deepEqual(Object.keys(last.data), ["ok", "role", "ms", "checks"], "the last frame's data is what --json prints");
  assert.equal(last.view.items.find(it => it.id === "vyred").state, "failed");
  assert.match(last.view.items.find(it => it.id === "vyred").note, /next: vyre up/);
  assert.ok(last.view.items.every(it => it.state !== "wait"));
});
