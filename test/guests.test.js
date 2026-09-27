// @ts-check
// Guests and agent nodes on the box's tailnet listener (ADR 0014 parts 8 and 9), end to end: the
// real names listener's request path, with whois simulated, in front of a real vyred router. Only
// the WireGuard source address says who is calling; the headers each request carries are ignored.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { start } from "../core/daemon/index.js";
import * as config from "../core/config/index.js";
import { names } from "../core/names/service.js";
import { HUMAN_ONLY } from "../core/presence/index.js";
import { tempHome } from "./helpers.js";

const OWNER_IP = "100.101.1.2", SAM_IP = "100.101.2.7", PAT_IP = "100.101.2.8", KIT_IP = "100.101.3.1";
const WHO = {
  [OWNER_IP]: { login: "alex@example.com", tagged: false, node: "alex-phone", stableId: "nPHONE", tags: [], caps: {} },
  [SAM_IP]: { login: "sam@harlow.example", tagged: false, node: "sams-laptop", stableId: "nSAM", tags: [], caps: {} },
  [PAT_IP]: { login: "pat@northwind.example", tagged: false, node: "pats-mac", stableId: "nPAT", tags: [],
    caps: { "vyre.run/cap/guest": [{ tools: ["threads.list", "vault.reveal"] }] } },
  [KIT_IP]: { login: null, tagged: true, node: "kit", stableId: "nKIT", tags: ["tag:vyre-agent"], caps: {} },
};

/**
 * A presence verifier that asks for a proof on every human-only tool and takes any proof it is
 * given: so whatever is refused below is refused for who the caller is, not for a bad proof.
 */
const lenient = {
  required: (tool, def) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence),
  verify: async ({ proof }) => (proof ? { ok: true, method: "test" } : { ok: false, message: "needs a person", methods: ["test"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
};

async function box(t, { guests = { enabled: true, people: { "sam@harlow.example": { tools: ["threads.list", "glass.close", "glass.take", "glass.open"] } } },
  agentOf = async id => (id === "nKIT" ? "kit" : null) } = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [],
    network: { tailscale: true, owner: "alex@example.com", port: 0, guests }, computers: { tailnet: { enabled: true, tag: "tag:vyre-agent" } },
    modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {} });
  t.after(() => d.stop());
  const ctx = d.registry.context({ name: "names", version: "0.1.0", does: { tools: [] }, watches: { emits: ["owner.seen"] } });
  const svc = names({ ctx, agentOf, ts: { whois: async ip => WHO[ip] || null, status: async () => ({}) }, save: p => config.save(p, root, d.config),
    certs: { load: () => null, save: () => {} }, dns: async () => ({}), issue: async () => ({}) });
  t.after(() => svc.close());
  /** One request through the listener, from a tailnet address. */
  const send = async (ip, method, url, input, headers = {}) => {
    const req = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]), { method, url,
      headers: { host: "alex.vyre.run:0", "content-type": "application/json", "x-vyre-caller": "cli", ...headers }, socket: { remoteAddress: ip } });
    let raw = "", status = 0;
    const res = { setHeader() {}, writeHead(s) { status = s; }, end(b = "") { raw += b; }, headersSent: false };
    await svc.onRequest(req, res);
    return { status, ...(raw ? JSON.parse(raw) : {}) };
  };
  const call = (ip, tool, input = {}, headers) => send(ip, "POST", `/v1/tools/${tool}`, input, headers);
  return { d, root, send, call };
}

test("guests: a listed guest calls its tools and nothing else, and learns nothing about the rest", async t => {
  const { d, send, call } = await box(t);
  assert.equal((await call(SAM_IP, "threads.list")).status, 200);
  // Not safe, even though config lists them: glass.take is never a guest's, and neither are
  // glass.open and glass.close (tailnet streams are the owner's alone). Not listed: 404 as well.
  for (const tool of ["glass.take", "glass.open", "glass.close", "names.status", "gate.approve", "link.pair.approve", "presence.enroll", "vault.reveal",
    "network.guests.add", "network.guests.list", "no.such"]) {
    const r = await call(SAM_IP, tool, {});
    assert.deepEqual([tool, r.status, r.error && r.error.code], [tool, 404, "no_such_tool"]);
    assert.equal(r.error.message, "no such tool here", "one message for all of them");
  }
  assert.deepEqual((await send(SAM_IP, "GET", "/v1/tools")).data.map(x => x.name).sort(), ["threads.list"]);
  for (const p of ["/v1/events", "/v1/modules", "/v1/health", "/v1/events/stream"]) assert.equal((await send(SAM_IP, "GET", p)).status, 404, p);
  assert.equal((await send(SAM_IP, "POST", "/v1/presence/challenge", { tool: "gate.approve" })).status, 404);
  assert.equal(d.config.network.ownerSeen, undefined, "a guest is not the owner being seen");
  // The owner, on the same listener, still reaches everything.
  assert.equal((await call(OWNER_IP, "names.status")).status, 404, "names is disabled in this test, so its tool is absent even for the owner");
  assert.equal((await send(OWNER_IP, "GET", "/v1/health")).status, 200);
  assert.ok(d.config.network.ownerSeen);
});

test("guests: a grant's tools count without a listing, still only the safe ones; off means nobody", async t => {
  const { d, root, call } = await box(t);
  assert.equal((await call(PAT_IP, "threads.list")).status, 200, "granted vyre.run/cap/guest threads.list");
  assert.equal((await call(PAT_IP, "vault.reveal", { name: "x" })).status, 404, "granted, but not safe");
  assert.equal((await call(PAT_IP, "glass.close", { session: "x" })).status, 404, "granted by no one, and not safe");
  config.save({ network: { guests: { enabled: false, people: d.config.network.guests.people } } }, root, d.config);
  for (const ip of [SAM_IP, PAT_IP]) {
    const r = await call(ip, "threads.list");
    assert.deepEqual([r.status, r.error.code], [403, "not_owner"]);
  }
});

test("guests: a guest never approves, never proves presence, never pairs, and a socket cannot claim to be one", async t => {
  const { d, call } = await box(t);
  const guest = "tailnet-guest:sam@harlow.example";
  const proof = { method: "test" };
  // Past the router (a module that forgot, a future tool): the registry and the tools refuse too.
  for (const tool of ["gate.approve", "gate.reject", "glass.take", "presence.enroll", "link.pair.approve", "network.guests.add"]) {
    const r = await d.registry.call(tool, { id: "x", code: "123-456", target: "computer:kit", surface: "deck:x", login: "a@b.example", tools: [] }, guest, { proof });
    assert.equal(r.error && r.error.code, "denied", tool);
  }
  const pair = await d.registry.call("link.pair.request", { name: "sams-laptop" }, guest, {});
  assert.match(pair.error.message, /from the Mac, over the tailnet/);
  // x-vyre-caller over the listener is ignored, and over the socket a guest's label is anonymous.
  const { socketCaller } = await import("../core/daemon/index.js");
  assert.equal(socketCaller({ headers: { "x-vyre-caller": guest } }), "anonymous");
  assert.equal((await call(SAM_IP, "threads.list", {}, { "x-vyre-caller": "cli" })).status, 200);
});

test("guests: a guest cannot close the owner's Glass session", async t => {
  const { d, call } = await box(t);
  d.registry.deps.db.prepare("INSERT INTO glass_sessions (id, target, surface, caller, opened, closed) VALUES ('s-owner', 'box', 'deck:mac', 'tailnet:alex@example.com', 1, NULL)").run();
  assert.equal((await call(SAM_IP, "glass.close", { session: "s-owner" })).status, 404);
  assert.deepEqual((await d.registry.call("glass.close", { session: "s-owner" }, "cli")).data, { closed: true });
});

test("agent nodes: the node's agent must also bring that same agent's key", async t => {
  const { d, call } = await box(t);
  // threads.vouch, faked: two agents, each with its own key.
  const vouch = /** @type {any} */ (d.registry.tools.get("threads.vouch"));
  vouch.run = async i => ({ thread: i.agent === "kit" && i.key === "kit-key" ? "t-kit" : i.agent === "ivy" && i.key === "ivy-key" ? "t-ivy" : null });
  let seen = null;
  d.registry.tools.set("system.whoami", { module: "system", description: "", input: { type: "object" }, internal: false, callers: null, hook: false, presence: false,
    run: async (_, meta) => { seen = meta; return {}; } });
  const none = await call(KIT_IP, "system.whoami");
  assert.deepEqual([none.status, none.error.code], [403, "denied"]);
  const other = await call(KIT_IP, "system.whoami", {}, { "x-vyre-agent-key": "ivy-key" });
  assert.deepEqual([other.status, other.error.code], [403, "denied"], "another agent's key is not this node's agent");
  assert.equal(seen, null);
  const ok = await call(KIT_IP, "system.whoami", {}, { "x-vyre-agent-key": "kit-key" });
  assert.equal(ok.status, 200);
  const m = /** @type {any} */ (seen);
  assert.equal(m.caller, "tailnet:agent:kit");
  assert.equal(m.agent, "kit");
  assert.equal(m.thread, "t-kit");
  assert.deepEqual([m.peer.kind, m.peer.agent, m.peer.stableId, m.peer.login], ["agent", "kit", "nKIT", null]);
  // An agent's node is not one of the owner's devices: it cannot pair.
  const pair = await call(KIT_IP, "link.pair.request", { name: "kit" }, { "x-vyre-agent-key": "kit-key" });
  assert.match(pair.error.message, /from the Mac, over the tailnet/);
});

test("agent nodes: without a resolver's answer, the node is refused as a tagged node", async t => {
  const { call } = await box(t, { agentOf: async () => null });
  const r = await call(KIT_IP, "threads.list", {}, { "x-vyre-agent-key": "kit-key" });
  assert.deepEqual([r.status, r.error.code], [403, "not_owner"]);
});

test("network.guests: add, remove and enable need presence and the owner; agents and guests are refused", async t => {
  const { d } = await box(t, { guests: { enabled: false, people: {} } });
  const got = [];
  d.events.on("guest.*", e => got.push([e.type, e.payload]));
  const proof = { method: "test" };
  assert.equal((await d.registry.call("network.guests.add", { login: "sam@harlow.example", tools: ["threads.list"] }, "cli")).error.code, "presence_required");
  for (const [caller, meta] of [["mcp:agent:kit", { agent: "kit", thread: "t" }], ["tailnet:agent:kit", { agent: "kit" }], ["tailnet-guest:sam@harlow.example", {}], ["anonymous", {}]]) {
    for (const [tool, input] of [["network.guests.add", { login: "sam@harlow.example", tools: [] }], ["network.guests.remove", { login: "sam@harlow.example" }], ["network.guests.enable", { on: true }]]) {
      const r = await d.registry.call(tool, input, caller, { ...meta, proof });
      assert.equal(r.error && r.error.code, "denied", `${caller} ${tool}`);
    }
  }
  const bad = await d.registry.call("network.guests.add", { login: "sam@harlow.example", tools: ["glass.take"] }, "cli", { proof });
  assert.match(bad.error.message, /threads.list; not glass.take/);
  assert.equal((await d.registry.call("network.guests.add", { login: "alex@example.com", tools: [] }, "cli", { proof })).error.code, "bad_input");
  const added = await d.registry.call("network.guests.add", { login: "sam@harlow.example", tools: ["threads.list"] }, "tailnet:alex@example.com", { proof });
  assert.deepEqual(added.data.people, [{ login: "sam@harlow.example", tools: ["threads.list"], allowed: [] }], "listed, but guests are off");
  const on = await d.registry.call("network.guests.enable", { on: true }, "cli", { proof });
  assert.deepEqual([on.data.enabled, on.data.people[0].allowed], [true, ["threads.list"]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d.paths.root, "config.json"), "utf8")).network.guests,
    { enabled: true, people: { "sam@harlow.example": { tools: ["threads.list"] } } });
  const gone = await d.registry.call("network.guests.remove", { login: "SAM@harlow.example" }, "cli", { proof });
  assert.deepEqual(gone.data.people, []);
  assert.deepEqual(got, [["guest.added", { login: "sam@harlow.example", tools: ["threads.list"] }], ["guest.removed", { login: "sam@harlow.example" }]]);
  assert.equal((await d.registry.call("network.guests.list", {}, "tailnet-guest:sam@harlow.example")).error.code, "denied");
});

test("network.guests.check: asks a fake tailscale who each online person is and what the listener would do", async t => {
  const { d } = await box(t, { guests: { enabled: true, people: { "sam@harlow.example": { tools: ["threads.list"] } } } });
  const dir = fs.mkdtempSync(path.join(d.paths.root, "ts-"));
  const bin = path.join(dir, "tailscale");
  const status = { BackendState: "Running", Self: { ID: "nBOX", TailscaleIPs: ["100.101.1.1"], UserID: 1 },
    User: { 1: { LoginName: "alex@example.com" }, 2: { LoginName: "sam@harlow.example" }, 3: { LoginName: "pat@northwind.example" }, 4: { LoginName: "lee@northwind.example" } },
    Peer: {
      k1: { ID: "nPHONE", DNSName: "alex-phone.tail0000.ts.net.", TailscaleIPs: [OWNER_IP], Online: true, UserID: 1 },
      k2: { ID: "nSAM", DNSName: "sams-laptop.", TailscaleIPs: [SAM_IP], Online: true, UserID: 2, ShareeNode: true },
      k3: { ID: "nPAT", DNSName: "pats-mac.", TailscaleIPs: [PAT_IP], Online: true, UserID: 3, ShareeNode: true },
      k4: { ID: "nLEE", DNSName: "lees-pc.", TailscaleIPs: ["100.101.2.9"], Online: false, UserID: 4, ShareeNode: true },
      k5: { ID: "nKIT", DNSName: "kit.", TailscaleIPs: [KIT_IP], Online: true, Tags: ["tag:vyre-agent"], UserID: 5 },
    } };
  const whois = {
    [SAM_IP]: { Node: { Name: "sams-laptop.", StableID: "nSAM" }, UserProfile: { LoginName: "sam@harlow.example" } },
    [PAT_IP]: { Node: { Name: "pats-mac.", StableID: "nPAT" }, UserProfile: { LoginName: "pat@northwind.example" },
      CapMap: { "vyre.run/cap/guest": [{ tools: ["threads.list", "glass.*"] }] } },
  };
  fs.writeFileSync(bin, `#!/usr/bin/env node
const [cmd, , ip] = process.argv.slice(2);
process.getBuiltinModule("node:fs").appendFileSync(${JSON.stringify(path.join(dir, "calls"))}, process.argv.slice(2).join(" ") + "\\n");
if (cmd === "status") { process.stdout.write(${JSON.stringify(JSON.stringify(status))}); process.exit(0); }
const w = ${JSON.stringify(whois)}[ip];
if (cmd === "whois" && w) { process.stdout.write(JSON.stringify(w)); process.exit(0); }
process.stderr.write("no"); process.exit(1);
`, { mode: 0o755 });
  const prev = process.env.VYRE_TAILSCALE_BIN;
  process.env.VYRE_TAILSCALE_BIN = bin;
  t.after(() => { if (prev === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = prev; });
  const r = (await d.registry.call("network.guests.check", {}, "cli")).data;
  assert.equal(r.enabled, true);
  assert.deepEqual(r.peers, [
    { login: "sam@harlow.example", node: "sams-laptop", stableId: "nSAM", served: true, listed: true, granted: [], tools: ["threads.list"], why: "guest" },
    { login: "pat@northwind.example", node: "pats-mac", stableId: "nPAT", served: true, listed: false, granted: ["threads.list", "glass.*"],
      tools: ["threads.list"], why: "guest" },
  ]);
  const calls = fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n");
  assert.deepEqual(calls, ["status --json", `whois --json ${SAM_IP}`, `whois --json ${PAT_IP}`], "offline, tagged and owner nodes are never asked about");
  const one = (await d.registry.call("network.guests.check", { login: "pat@northwind.example" }, "cli")).data;
  assert.deepEqual(one.peers.map(p => p.login), ["pat@northwind.example"]);
  config.save({ network: { guests: { enabled: false, people: {} } } }, d.paths.root, d.config);
  const off = (await d.registry.call("network.guests.check", {}, "cli")).data;
  assert.deepEqual(off.peers.map(p => [p.login, p.served, p.why]), [["sam@harlow.example", false, "not the owner"], ["pat@northwind.example", false, "not the owner"]]);
});

test("hosted app: the owner's calls from app.vyre.run are marked cross-origin; a guest's are refused", async t => {
  const { send, call } = await box(t);
  const app = { origin: "https://app.vyre.run" };
  assert.equal((await send(OWNER_IP, "OPTIONS", "/v1/tools/threads.list", undefined, { ...app, "access-control-request-method": "POST" })).status, 204);
  assert.deepEqual(await send(OWNER_IP, "GET", "/v1/health", undefined, app), { status: 200, data: { reachable: true } });
  // The router refuses a tool call from the hosted origin without a person session (e2e's rule).
  const bare = await call(OWNER_IP, "threads.list", {}, app);
  assert.deepEqual([bare.status, bare.error.code], [401, "person_session_required"]);
  // A guest from the same page gets nothing; the owner's own page needs no session.
  assert.equal((await call(SAM_IP, "threads.list", {}, app)).status, 403);
  assert.equal((await call(OWNER_IP, "threads.list", {}, { origin: "https://alex.vyre.run:0" })).status, 200);
});
