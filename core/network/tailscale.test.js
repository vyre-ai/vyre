// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTailscale, shape, tailnetKind } from "./tailscale.js";

const URL_ = "https://login.tailscale.com/a/abc123";
const status = (backend, extra = {}) => ({ BackendState: backend, Self: { ID: "n1", HostName: "alex", DNSName: "alex.tail1.ts.net.", UserID: 7, TailscaleIPs: ["100.64.1.2", "fd7a:115c:a1e0::1"] },
  User: { 7: { LoginName: "alex@gmail.com" }, 8: { LoginName: "kit@harlow.example" } }, CurrentTailnet: { Name: "alex@gmail.com" },
  Peer: { a: { ID: "p1", HostName: "laptop", DNSName: "laptop.tail1.ts.net.", UserID: 7, TailscaleIPs: ["100.64.1.3"], Online: true }, b: { ID: "p2", HostName: "kit", UserID: 8, TailscaleIPs: ["100.64.1.4"], Online: false } }, ...extra });

function world(initial) {
  const w = { s: initial, ups: 0, emitted: /** @type {any[]} */ ([]), logs: /** @type {string[]} */ ([]), timers: /** @type {Function[]} */ ([]) };
  const tools = new Map();
  const ctx = { log: m => w.logs.push(m), events: { emit: (t, p) => w.emitted.push({ t, p }) }, tool: (n, d) => tools.set(n, d) };
  const run = async args => (args[0] === "status" ? { code: 0, out: JSON.stringify(w.s), err: "" } : { code: 1, out: "", err: "x" });
  const up = async () => { w.ups++; w.s = { ...w.s, AuthURL: URL_ }; return { loginUrl: URL_, exited: false, code: null, output: "" }; };
  const svc = startTailscale(ctx, { run, up, setTimer: fn => { w.timers.push(fn); return { unref() {} }; }, clearTimer: () => { w.timers.length = 0; }, now: () => 1 });
  const call = (name, meta = { caller: "cli" }) => tools.get(name).run({}, meta);
  return { w, call, svc };
}

test("tailscale: the states and the tailnet's kind", () => {
  assert.equal(shape(status("Running")).state, "connected");
  assert.equal(shape(status("NeedsLogin")).state, "needs-login");
  assert.equal(shape(status("NeedsMachineAuth")).state, "needs-approval");
  assert.equal(shape(status("Stopped")).state, "off");
  const c = shape(status("Running"));
  assert.deepEqual([c.login, c.tailnet, c.tailnetKind, c.ip, c.node], ["alex@gmail.com", "alex@gmail.com", "personal", "100.64.1.2", "alex"]);
  assert.equal(tailnetKind("harlowlegal.com"), "organization");
  assert.equal(tailnetKind("alex.github"), "personal");
  assert.equal(tailnetKind("alex.passkey"), "personal");
  assert.equal(tailnetKind(null), null);
});

test("tailscale: login answers the link, watches until connected, and the link is only ever the answer", async () => {
  const { w, call, svc } = world(status("NeedsLogin"));
  await call("network.tailscale.status");                     // first look: no event for a first sight
  const r = await call("network.tailscale.login");
  assert.equal(r.loginUrl, URL_);
  assert.equal(r.state, "needs-login");
  assert.equal(w.ups, 1);
  const again = await call("network.tailscale.login");
  assert.equal(again.loginUrl, URL_, "fetched again on each click");
  assert.equal(w.ups, 1, "a pending link is reused, not a second `up`");
  assert.equal(w.timers.length, 1, "one watcher while the sign-in is pending");
  w.s = status("Running");
  await w.timers[0]();
  assert.equal(w.timers.length, 0, "the watcher ends at connected");
  assert.deepEqual(w.emitted, [{ t: "tailscale.changed", p: { state: "connected", tailnetKind: "personal" } }]);
  assert.ok(![...w.emitted.map(e => JSON.stringify(e)), ...w.logs].some(x => x.includes("abc123")), "the link is in no event and no log");
  assert.deepEqual(await call("network.tailscale.login"), { loginUrl: null, state: "connected" });
  svc.stop();
});

test("tailscale: needs-approval and peers of the same login", async () => {
  const { call } = world(status("NeedsMachineAuth"));
  assert.equal((await call("network.tailscale.status")).state, "needs-approval");
  const w2 = world(status("Running"));
  const p = await w2.call("network.tailscale.peers");
  assert.equal(p.login, "alex@gmail.com");
  assert.deepEqual(p.peers.map(x => [x.node, x.mine, x.online]), [["laptop.tail1.ts.net", true, true], ["kit", false, false]]);
});

test("tailscale: only the person's surfaces, devices, onboard and own session; every other caller is refused", async () => {
  const { call } = world(status("Running"));
  const good = ["cli", "local", "deck", "capsule", "device:abcdefghijklmnop", "module:onboard", "mcp:thread:t_123"];
  const bad = ["tailnet-guest:sam@harlow.example", "anonymous", "mcp", "hook", "onboard", "module:sneaky", "mcp:agent:kit", "cli:agent:kit", "device:abcdefghijklmnop:agent:kit", "mcp:thread:t_1:agent:kit", "tailnet:agent:kit", "harness:agent:kit", "", "sessions"];
  for (const tool of ["network.tailscale.status", "network.tailscale.login", "network.tailscale.peers"]) {
    for (const caller of good) await call(tool, { caller }).then(() => {}, e => assert.fail(`${tool} refused ${caller}: ${e.message}`));
    for (const caller of bad) await assert.rejects(call(tool, { caller }), /owner's/, `${tool} ${caller}`);
    await assert.rejects(call(tool, { caller: "cli", agent: "kit" }), /owner's/, `${tool} meta.agent`);
  }
  const ctx2 = { log() {}, events: { emit() {} }, tool: (n, d) => { ctx2.t[n] = d; }, t: /** @type {any} */ ({}) };
  startTailscale(ctx2, { run: async () => ({ code: 127, out: "", err: "" }) });
  const v = await ctx2.t["network.tailscale.status"].run({}, { caller: "cli" });
  assert.equal(v.state, "off");
  assert.match(v.why, /not installed/);
});

test("tailscale: one `up` however many clicks, one 15-minute watch that more clicks do not extend, and the event says only the state", async () => {
  let clock = 1000, resolveUp;
  const w = { s: status("NeedsLogin"), ups: 0, emitted: /** @type {any[]} */ ([]), timers: /** @type {Function[]} */ ([]) };
  const tools = new Map();
  const ctx = { log() {}, events: { emit: (t, p) => w.emitted.push({ t, p }) }, tool: (n, d) => tools.set(n, d) };
  const run = async () => ({ code: 0, out: JSON.stringify(w.s), err: "" });
  const up = () => { w.ups++; return new Promise(r => { resolveUp = r; }); };
  startTailscale(ctx, { run, up, setTimer: fn => { w.timers.push(fn); return { unref() {} }; }, clearTimer: () => { w.timers.length = 0; }, now: () => clock });
  const login = () => tools.get("network.tailscale.login").run({}, { caller: "cli" });
  const a = login(), b = login();
  await new Promise(r => setImmediate(r));
  assert.equal(w.ups, 1, "two clicks, one tailscale up");
  resolveUp({ loginUrl: URL_, exited: false });
  assert.equal((await a).loginUrl, URL_); assert.equal((await b).loginUrl, URL_);
  // after the first click 14 minutes pass, and another click does not extend the watch
  w.s = { ...status("NeedsLogin"), AuthURL: URL_ };
  clock += 14 * 60_000; await login();
  clock += 2 * 60_000;
  await w.timers[0]();
  assert.equal(w.timers.length, 0, "15 minutes from the first click, the watch is over");
  await login();
  assert.equal(w.timers.length, 0, "a click just after a finished watch starts no new one");
  clock += 61_000; await login();
  assert.equal(w.timers.length, 1, "a minute later a click can watch again");
  w.s = status("Running"); await w.timers[0]();
  const ev = w.emitted.filter(e => e.t === "tailscale.changed");
  assert.ok(ev.length >= 1);
  for (const e of ev) assert.deepEqual(Object.keys(e.p).sort(), ["state", "tailnetKind"], "no login, no address on the bus");
});

test("tailscale: with a setup session live and no owner, the login that signed the node in becomes the owner, once; never otherwise", async () => {
  const calls = [];
  const mk = (setupState, owner, s) => {
    const tools = new Map();
    const ctx = { log() {}, config: { network: owner ? { owner } : {} }, events: { emit() {} }, tool: (n, d) => tools.set(n, d),
      call: async (tool, input) => { calls.push({ tool, input }); return tool === "relay.setup.status" ? { data: { state: setupState } } : { data: {} }; } };
    startTailscale(ctx, { run: async () => ({ code: 0, out: JSON.stringify(s), err: "" }), up: async () => ({ loginUrl: URL_ }) });
    return tools;
  };
  const settle = () => new Promise(r => setImmediate(r));
  await mk("paired", null, status("Running")).get("network.tailscale.status").run({}, { caller: "cli" }); await settle();
  assert.deepEqual(calls.filter(c => c.tool === "names.owner").map(c => c.input), [{ login: "alex@gmail.com" }]);
  calls.length = 0;
  await mk("none", null, status("Running")).get("network.tailscale.status").run({}, { caller: "cli" }); await settle();
  await mk("waiting", "kit@harlow.example", status("Running")).get("network.tailscale.status").run({}, { caller: "cli" }); await settle();
  await mk("waiting", null, status("NeedsLogin")).get("network.tailscale.status").run({}, { caller: "cli" }); await settle();
  const tagged = status("Running"); tagged.Self = { ...tagged.Self, Tags: ["tag:server"] };
  await mk("waiting", null, tagged).get("network.tailscale.status").run({}, { caller: "cli" }); await settle();
  assert.deepEqual(calls.filter(c => c.tool === "names.owner"), [], "no session, an owner already, not connected, or a tagged node: nothing set");
});
