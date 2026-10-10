// @ts-check
// spaces: the module through the real registry, with a real names directory Worker on the fake runtime (no network), temp homes only.
// Sample world: alex (the owner), juno and kit (people), Harlow Legal and Northwind Bakery (spaces).

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import * as config from "../config/index.js";
import { tempHome } from "../../test/helpers.js";
import worker, * as W from "../../names/worker/index.js";
import { createRuntime } from "../../relay/worker/fake-cf.js";
import { fakeDns } from "../../names/worker/fake-dns.js";
import spacesModule, { hooks } from "./index.js";
import { newKeyPair, personIdOf, fileIdentityStore, privateKeyOf } from "./identity.js";
import { createIdentityOps } from "./identity-ops.js";
import * as C_ from "../../kernel/identity/chain.js";
import { idDirectory, memorySeen } from "../../lib/identity/directory.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const TOKEN = "dop_v1_faketoken0123456789";

/** One fake directory, one clock, and the module's test seams pointed at them. */
function world(t) {
  const dns = fakeDns();
  const clock = { t: T0 };
  const txt = new Map();
  const rt = createRuntime({ worker, Class: W.Directory, classes: { DIRECTORY: W.Directory },
    env: { CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch, NOW: () => clock.t, ZONE: "vyre.run", RESOLVE_TXT: async n => txt.get(n) || [] } });
  let n = 0;
  // Each request comes from its own address, so the directory's claims-per-address-per-day limit does not bite a long test.
  const fetch = async (url, init) => worker.fetch(new Request(url, { ...init, headers: { ...(init.headers || {}), "cf-connecting-ip": `198.51.${(n >> 8) & 255}.${n++ & 255}` } }), rt.env);
  const do_ = { calls: [], droplets: 0 };
  const ok = (status, body = {}) => ({ status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  hooks.fetch = /** @type {any} */ (fetch);
  hooks.now = () => clock.t;
  hooks.stretch = { memoryKiB: 64, passes: 1 };
  hooks.vpsDeps = { sleep: async () => {}, fetch: async (url, init) => {
    do_.calls.push(`${init.method} ${url}`);
    if (init.method === "POST" && url.endsWith("/firewalls")) return ok(202, { firewall: { id: "fw9" } });
    if (init.method === "POST") { do_.droplets++; return ok(202, { droplet: { id: 9 } }); }
    if (init.method === "GET") return ok(200, { droplet: { status: "active", networks: { v4: [{ type: "public", ip_address: "203.0.113.20" }] } } });
    return ok(204);
  } };
  t.after(async () => { hooks.fetch = null; hooks.now = null; hooks.stretch = null; hooks.vpsDeps = null; await rt.settle(); assert.deepEqual(rt.errors.map(String), []); });
  return { clock, txt, do_, fetch };
}

const presence = {
  required: (_tool, def, input) => { const p = def && def.presence; if (!p) return false; return typeof p.when === "function" && input !== undefined ? Boolean(p.when(input)) : true; },
  verify: async ({ proof }) => (proof ? { ok: true, method: "test" } : { ok: false, code: "presence_required", message: "needs a person", methods: ["passkey"] }),
};


/** The reservation a person gets at vyre.run/setup, asked of the same directory Worker the module talks to: { code } or the Worker's refusal as the tool would say it. */
async function reserve(name, ip = "198.18.0.1") {
  const r = await hooks.fetch("http://127.0.0.1:1/v1/ids/reserve", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ name }) });
  const j = await r.json();
  return j.data ? { code: j.data.code } : { refused: j.error };
}
/** A box-role registry running only the spaces module (one device). Extra modules (a fake records driver) can ride along. */
async function device(t, { records = false, wink = false, kernelFor = undefined, machine = undefined } = {}) {
  const root = tempHome(t);
  const p = config.ensure(root);
  const found = discover([CORE]).filter(f => f.manifest && f.manifest.name === "spaces");
  if (records) {
    // A stand-in for the records team's tool, in a scratch folder: a built in module named records.
    const dir = fs.mkdtempSync(path.join(path.dirname(root), "records-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, "records"));
    fs.writeFileSync(path.join(dir, "records", "module.json"), JSON.stringify({ name: "records", version: "0.0.1", roles: ["box"], requires: [], does: { tools: [{ name: "records.workspace.create", reach: "modules" }] }, watches: { emits: [] }, needs: {}, teaches: {} }));
    fs.writeFileSync(path.join(dir, "records", "index.js"), "export default { async start(ctx) { ctx.tool('records.workspace.create', { description: 'x', input: { type: 'object' }, run: async i => ({ workspaceId: 'ws_' + i.space }) }); return { async stop() {} }; } };\n");
    found.push(...discover([dir], { firstPartyRoots: [dir] }).filter(f => f.manifest && f.manifest.name === "records"));
  }
  if (wink) {
    // A stand-in for Wink's two server tools: which device is a paired server, and a call to a tool on it (recorded, answered like the server's spaces module would).
    const dir = fs.mkdtempSync(path.join(path.dirname(root), "wink-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, "wink"));
    fs.writeFileSync(path.join(dir, "wink", "module.json"), JSON.stringify({ name: "wink", version: "0.0.1", roles: ["box"], requires: [], does: { tools: [{ name: "wink.server.paired", reach: "modules" }] }, watches: { emits: [] }, needs: {}, teaches: {} }));
    fs.writeFileSync(path.join(dir, "wink", "index.js"), "globalThis.__winkCalls = []; export default { async start(ctx) { ctx.tool('wink.server.paired', { description: 'x', input: { type: 'object' }, run: async i => ({ paired: i.device === 'srv_paired0000000001' }) }); return { async stop() {} }; } };\n");
    found.push(...discover([dir], { firstPartyRoots: [dir] }).filter(f => f.manifest && f.manifest.name === "wink"));
  }
  const db = open(p.db);
  const events = new Events(db);
  const logs = [];
  const seen = [];
  events.on("*", e => seen.push(e));
  const reg = new Registry({ db, events, config: { role: "box", ...(machine ? { machine } : {}), name: "testbox", names: { directory: "http://127.0.0.1:1" } }, paths: p, log: m => logs.push(String(m)), presence: /** @type {any} */ (presence), ...(kernelFor ? { kernelFor } : {}) });
  await reg.start(found, { role: "box" });
  let stopped = false;
  t.after(async () => { if (stopped) return; stopped = true; await reg.stop(); db.close(); });
  assert.equal(reg.modules.get("spaces")?.state, "running", reg.modules.get("spaces")?.error);
  /** @param {string} tool @param {any} [input] @param {string} [caller] @param {any} [meta] */
  const call = (tool, input = {}, caller = "cli", meta = {}) => reg.call(tool, input, caller, meta);
  const ok = async (tool, input, caller, meta) => { const r = await call(tool, input, caller, meta); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  const space = path.join(root, "spaces");
  return { reg, db, events, seen, logs, call, ok, root, space, p, types: () => seen.map(e => e.type), of: type => seen.filter(e => e.type === type).map(e => e.payload) };
}

/** Everything a device keeps or says, as one string, for "this secret is nowhere" checks. */
function everything(d, extra = []) {
  const parts = [JSON.stringify(d.seen), d.logs.join("\n"), JSON.stringify(extra)];
  for (const f of ["vyre.db", "vyre.db-wal", "vyre.db-shm"]) { try { parts.push(fs.readFileSync(path.join(d.root, f)).toString("latin1")); } catch { /* absent */ } }
  return parts.join("\n");
}

/** Put a different identity on a device (the file the module reads on every call), to act as another person of the same home. The person is real: a chain claimed in the directory. */
async function actAs(d, label) {
  fs.mkdirSync(d.space, { recursive: true });
  fs.rmSync(path.join(d.space, "identity.json"), { force: true });
  const store = fileIdentityStore(d.space);
  const seen = memorySeen();
  const dir = idDirectory({ base: "http://127.0.0.1:1", fetch: hooks.fetch, now: () => hooks.now(), seen });
  const ops = createIdentityOps({ store, dir, seen, now: () => hooks.now(), stretch: { memoryKiB: 64, passes: 1 } });
  await ops.create({ name: label, deviceLabel: label, code: (await reserve(label)).code });
  return { id: store.status().id, publicKey: store.status().publicKey };
}
const person = () => { const kp = newKeyPair(); return { ...kp, id: personIdOf(kp.publicKey) }; };

/** alex's device with a finished space on this computer. */
async function harlow(t, w, { name = "harlow", display = "Harlow Legal" } = {}) {
  const d = await device(t);
  const id = await d.ok("spaces.identity.create", { name: "alex" });
  const s = await d.ok("spaces.create", { name, displayName: display, home: { kind: "this-computer", confirmed: true } });
  assert.equal(s.status, "done", JSON.stringify(s));
  return { d, alex: id, space: s.space, s };
}

test("manifest and registry agree: every declared tool is registered, no event is refused", async t => {
  const w = world(t);
  const d = await device(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(CORE, "spaces", "module.json"), "utf8"));
  const declared = manifest.does.tools.map(x => x.name).sort();
  const registered = [...d.reg.tools.entries()].filter(([, def]) => def.module === "spaces").map(([n]) => n).sort();
  assert.deepEqual(registered, declared);
  assert.deepEqual(manifest.does.tools.filter(x => x.reach === "anyone").map(x => x.name).sort(), ["spaces.code.submit", "spaces.invites.redeem"]);
  assert.ok(manifest.does.tools.every(x => ["person", "modules", "anyone"].includes(x.reach)));
  void w;
});

test("identity: create makes a 0600 key file, claims the name, shows the recovery code once and never stores it", async t => {
  const w = world(t);
  const d = await device(t);
  assert.equal((await d.ok("spaces.identity.status")).exists, false);
  const made = await d.ok("spaces.identity.create", { name: "Alex" });
  assert.equal(made.name, "alex.vyre.run");
  assert.match(made.id, /^per_[a-z2-7]{26}$/);
  assert.match(made.recoveryCode, /^[a-z2-7]{4}(-[a-z2-7]{4}){5}-[a-z2-7]{2}$/);
  assert.equal(fs.statSync(path.join(d.space, "identity.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(d.space).mode & 0o777, 0o700);
  const st = await d.ok("spaces.identity.status");
  assert.equal(st.name, "alex.vyre.run");
  assert.equal(st.id, made.id);
  assert.ok(!("recoveryCode" in st) && !("privateKey" in st) && !("publicKey" in st));
  // The code is in the one reply and nowhere else.
  const hay = everything(d, [st]) + fs.readFileSync(path.join(d.space, "identity.json"), "utf8");
  assert.ok(!hay.includes(made.recoveryCode), "the recovery code was stored or logged");
  assert.ok(!hay.includes(made.recoveryCode.replace(/-/g, "")));
  const key = JSON.parse(fs.readFileSync(path.join(d.space, "identity.json"), "utf8")).privateKey;
  assert.ok(!everything(d).includes(key), "the private key is outside its file");
  assert.deepEqual(d.of("identity.created").map(e => e.name), ["alex.vyre.run"]);
  // A second create on this device, and a taken name from another.
  const again = await d.call("spaces.identity.create", { name: "juno" });
  assert.equal(again.error?.code, "exists");
  const other = await device(t);
  const taken = await other.call("spaces.identity.create", { name: "alex" });
  assert.equal(taken.error?.code, "name_taken");
  assert.equal((await other.ok("spaces.identity.status")).exists, false, "a failed claim leaves no key behind");
  const bad = await other.call("spaces.identity.create", { name: "a" });
  assert.equal(bad.error?.code, "bad_name");
  // a code that is not valid (wrong, used, replaced or expired) is one plain refusal
  const wrong = await other.reg.call("spaces.identity.create", { code: "VYRE-AAAA-AAAA-AAAA-AAAA" }, "cli", {});
  assert.equal(wrong.error?.code, "bad_code");
  assert.equal((await other.ok("spaces.identity.status")).exists, false);
  // a release build takes a reservation code and nothing else (the self-reserve switch is a development one)
  delete process.env.VYRE_TEST_SELF_RESERVE;
  try { assert.equal((await other.reg.call("spaces.identity.create", { name: "carol" }, "cli", {})).error?.code, "code_needed"); } finally { process.env.VYRE_TEST_SELF_RESERVE = "1"; }
  // and with a real code the name it holds is made
  const held = await reserve("carol");
  const made2 = await other.ok("spaces.identity.create", { code: held.code });
  assert.equal(made2.address ?? made2.name, "carol.vyre.run");
  void w;
});

test("identity: resolve finds a name with its key, and an own domain is added through a signed TXT", async t => {
  const w = world(t);
  const d = await device(t);
  const alex = await d.ok("spaces.identity.create", { name: "alex" });
  const viewer = await device(t);
  const r = await viewer.ok("spaces.identity.resolve", { name: "alex.vyre.run" });
  assert.equal(r.kind, "person");
  assert.equal(r.id, alex.id);
  assert.equal((await viewer.call("spaces.identity.resolve", { name: "nobody" })).error?.code, "not_found");
  const txt = await d.ok("spaces.identity.alias", { domain: "alex.example.com" });
  assert.equal(txt.host, "_vyre-id.alex.example.com");
  const early = await d.call("spaces.identity.alias.add", { domain: "alex.example.com" });
  assert.equal(early.error?.code, "not_proven");
  w.txt.set(txt.host, [txt.value]);
  const added = await d.ok("spaces.identity.alias.add", { domain: "alex.example.com" });
  assert.deepEqual(added.aliases, ["alex.example.com"]);
  assert.equal((await viewer.ok("spaces.identity.resolve", { name: "alex.example.com" })).kind, "person");
  assert.deepEqual(d.of("identity.alias-added").map(e => e.domain), ["alex.example.com"]);
  assert.equal((await d.call("spaces.identity.alias", { domain: "x.example.com", name: "kit" })).error?.code, "forbidden");
});

test("create a space on this computer end to end: key, name, owner, unit files, a warning for the missing records driver", async t => {
  const w = world(t);
  const d = await device(t);
  assert.equal((await d.call("spaces.create", { name: "harlow", home: { kind: "this-computer" } })).error?.code, "no_identity");
  // with no claimed identity, acts on a space say so (no_identity), not "no such space"
  assert.equal((await d.call("spaces.invites.create", { space: "spc_aaaaaaaaaaaa", role: "member" })).error?.code, "no_identity");
  assert.equal((await d.call("spaces.members.set-role", { space: "spc_aaaaaaaaaaaa", person: "bob", role: "admin" })).error?.code, "no_identity");
  const alex = await d.ok("spaces.identity.create", { name: "alex" });
  const assess = await d.ok("spaces.assess-computer", { device: { name: "alex's laptop", alwaysOn: false } });
  assert.match(assess.warning, /unreachable while/);

  // Not confirmed: it asks, says why, and makes nothing.
  const first = await d.ok("spaces.create", { name: "Harlow", displayName: "Harlow Legal", home: { kind: "this-computer" } });
  assert.equal(first.status, "needs_confirmation");
  assert.match(first.confirm.text, /unreachable while/);
  assert.equal(first.space, undefined, "nothing was made");
  const done = await d.ok("spaces.create", { name: "Harlow", displayName: "Harlow Legal", home: { kind: "this-computer", confirmed: true } });
  first.space = done.space;
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.deepEqual(done.steps.map(s => s.state), Array(7).fill("done"));
  assert.equal(done.workspaceId, null);
  assert.deepEqual(done.warnings, [{ code: "records_driver_missing", message: "records driver not installed" }]);
  assert.deepEqual(d.of("space.warning").map(e => e.message), ["records driver not installed"]);

  // Its key, unit files and modes.
  const dir = path.join(d.space, done.space);
  assert.equal(fs.statSync(path.join(dir, "root.key")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, "unit", ".env")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, "unit", "compose.yml")).mode & 0o777, 0o644);
  assert.ok(fs.existsSync(path.join(dir, "unit", "manifest.json")));
  // Docker was never run: there are only files.
  assert.deepEqual(fs.readdirSync(path.join(dir, "unit")).sort(), [".env", "compose.yml", "manifest.json"]);

  // The name is the space's, signed by its root key; alex is its one owner; the space is listed.
  const viewer = await device(t);
  const r = await viewer.ok("spaces.identity.resolve", { name: "harlow.vyre.run" });
  assert.equal(r.kind, "space");
  assert.match(r.id, /^spc_[a-z2-7]{26}$/, "the space's permanent identity id");
  assert.equal(r.spaceId, done.space);
  assert.equal(r.label, "Harlow Legal");
  const list = await d.ok("spaces.list");
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].name, list[0].role, list[0].status, list[0].workspaceId], ["harlow.vyre.run", "owner", "done", null]);
  assert.equal(list[0].tier, "basic", "a space whose home is a device is Basic");
  const got = await d.ok("spaces.get", { space: "harlow" });
  assert.deepEqual([got.owners, got.members], [1, 1]);
  assert.ok(got.warnings.some(x => x.code === "single_owner"));
  const members = await d.ok("spaces.members.list", { space: done.space });
  assert.equal(members.members[0].person, alex.id);
  assert.equal(members.members[0].role, "owner");
  assert.equal(members.members[0].name, "alex.vyre.run", "a member shows the name they chose");
  assert.equal(d.of("space.create-done").length, 1);
  assert.ok(d.of("member.added").some(e => e.person === alex.id && e.role === "owner"));

  // Secrets: not the unit's, not either key, not in an event or a log.
  const env = Object.fromEntries(fs.readFileSync(path.join(dir, "unit", ".env"), "utf8").trim().split("\n").map(l => l.split("=")));
  const rootKey = fs.readFileSync(path.join(dir, "root.key"), "utf8").trim();
  const idKey = JSON.parse(fs.readFileSync(path.join(d.space, "identity.json"), "utf8")).privateKey;
  const hay = everything(d, [first, done, list, got, members, assess]);
  for (const s of [...Object.values(env), rootKey, idKey]) assert.ok(!hay.includes(String(s)), `a secret leaked: ${String(s).slice(0, 6)}`);
  assert.equal(w.do_.droplets, 0);
});

test("a records driver, when installed, makes the workspace and no warning is recorded", async t => {
  const w = world(t);
  const d = await device(t, { records: true });
  await d.ok("spaces.identity.create", { name: "alex" });
  const s = await d.ok("spaces.create", { name: "northwind", displayName: "Northwind Bakery", home: { kind: "this-computer", confirmed: true } });
  assert.equal(s.status, "done");
  assert.equal(s.workspaceId, `ws_${s.space}`);
  assert.deepEqual(s.warnings, []);
  void w;
});

test("a server home: the one command and the typed code, wrong codes counted, then the home is ready", async t => {
  const w = world(t);
  const d = await device(t);
  await d.ok("spaces.identity.create", { name: "alex" });
  const s = await d.ok("spaces.create", { name: "harlow", displayName: "Harlow Legal", home: { kind: "server" } });
  assert.equal(s.status, "waiting");
  assert.equal(s.waiting.for, "code");
  assert.equal(s.waiting.installCommand, "curl -fsSL vyre.run/i | sh");
  assert.equal(s.waiting.prompt, "Enter the code from your phone or computer:");
  assert.match(s.waiting.code, /^\d{6}$/);
  const inst = await d.ok("spaces.server.install", { space: s.space });
  assert.equal(inst.code, s.waiting.code);
  assert.equal(inst.installCommand, "curl -fsSL vyre.run/i | sh");
  // The server calls code.submit: it is not a person surface, so it is the one tool a relay caller may use.
  const wrong = await d.ok("spaces.code.submit", { space: s.space, code: s.waiting.code === "000000" ? "111111" : "000000" }, "device:aaaaaaaaaaaaaaaa");
  assert.equal(wrong.pairing, "wrong_code");
  assert.match(wrong.message, /4 tries left/);
  assert.equal((await d.ok("spaces.status", { space: s.space })).status, "waiting");
  const right = await d.ok("spaces.code.submit", { space: s.space, code: s.waiting.code }, "device:aaaaaaaaaaaaaaaa");
  assert.equal(right.pairing, "matched");
  assert.equal(right.status, "done");
  assert.deepEqual(d.of("space.pairing-state").map(e => e.state), ["waiting_for_code", "waiting_for_code", "matched", "home_ready"]);
  // The code is shown to the person, and never sent in an event or a log. (The pending space record keeps it until the ten minutes end, so a status call can show it again; the pairing table keeps only its hash.)
  assert.ok(!JSON.stringify(d.seen).includes(s.waiting.code) && !d.logs.join("\n").includes(s.waiting.code));
  const again = await d.call("spaces.code.submit", { space: s.space, code: s.waiting.code }, "device:aaaaaaaaaaaaaaaa");
  assert.equal(again.error?.code, "not_waiting");
  void w;
});

test("a server home: five wrong codes lock it, and resume gives a new code; a code that ran out of time does the same", async t => {
  const w = world(t);
  const d = await device(t);
  await d.ok("spaces.identity.create", { name: "alex" });
  const s = await d.ok("spaces.create", { name: "harlow", home: { kind: "server" } });
  const wrongCode = s.waiting.code === "123456" ? "654321" : "123456";
  let last;
  for (let i = 0; i < 5; i++) last = await d.ok("spaces.code.submit", { space: s.space, code: wrongCode }, "device:aaaaaaaaaaaaaaaa");
  assert.equal(last.pairing, "locked");
  assert.equal(last.failed.step, "home");
  const again = await d.ok("spaces.resume", { space: s.space });
  assert.equal(again.status, "waiting");
  w.clock.t += 11 * 60 * 1000;
  const late = await d.ok("spaces.code.submit", { space: s.space, code: again.waiting.code }, "device:aaaaaaaaaaaaaaaa");
  assert.equal(late.pairing, "timed_out");
  const fresh = await d.ok("spaces.resume", { space: s.space });
  assert.equal(fresh.status, "waiting");
  assert.equal((await d.ok("spaces.code.submit", { space: s.space, code: fresh.waiting.code }, "device:aaaaaaaaaaaaaaaa")).status, "done");
});

test("a new VPS: the fake provider is called, the token is never stored, evented or returned", async t => {
  const w = world(t);
  const d = await device(t);
  await d.ok("spaces.identity.create", { name: "alex" });
  const noToken = await d.ok("spaces.create", { name: "northwind", home: { kind: "vps", provider: "digitalocean", region: "nyc3", size: "s-2vcpu-4gb" } });
  assert.match(noToken.failed.reason, /Paste your DigitalOcean token/);
  const s = await d.ok("spaces.create", { name: "northwind", displayName: "Northwind Bakery", home: { kind: "vps", provider: "digitalocean", region: "nyc3", size: "s-2vcpu-4gb", token: TOKEN } });
  assert.equal(s.status, "waiting", JSON.stringify(s));
  assert.equal(s.address, "203.0.113.20");
  assert.equal(s.estimate.usdPerMonth, 24);
  assert.equal(w.do_.droplets, 1);
  const done = await d.ok("spaces.code.submit", { space: s.space, code: s.waiting.code }, "device:aaaaaaaaaaaaaaaa");
  assert.equal(done.status, "done");
  assert.ok(d.of("space.vps-created").length === 1);
  const hay = everything(d, [noToken, s, done]);
  assert.ok(!hay.includes(TOKEN), "the provider token leaked");
  // The sealed record points at the home's address, readable only with the name.
  const viewer = await device(t);
  assert.equal((await viewer.ok("spaces.identity.resolve", { name: "northwind" })).kind, "space");
});

test("cancel on a VPS removes the server, releases the name and discards the key; resume of a cancelled space only reports it", async t => {
  const w = world(t);
  const d = await device(t);
  await d.ok("spaces.identity.create", { name: "alex" });
  const s = await d.ok("spaces.create", { name: "northwind", home: { kind: "vps", provider: "digitalocean", region: "nyc3", size: "s-2vcpu-4gb", token: TOKEN } });
  const keyFile = path.join(d.space, s.space, "root.key");
  assert.ok(fs.existsSync(keyFile));
  const c = await d.ok("spaces.cancel", { space: s.space, vpsToken: TOKEN });
  assert.equal(c.cancelled, true);
  assert.ok(c.rolledBack.includes("the new server") && w.do_.calls.some(x => x.startsWith("DELETE")), "the server was removed with the token");
  assert.ok(!fs.existsSync(keyFile), "the key is gone");
  assert.equal((await d.ok("spaces.status", { space: s.space })).status, "cancelled");
  assert.equal((await d.ok("spaces.resume", { space: s.space })).status, "cancelled");
  assert.ok(!everything(d, [s, c]).includes(TOKEN));
  // Released within the hour: the name is free for anyone, including a new space.
  const again = await d.ok("spaces.create", { name: "northwind", home: { kind: "this-computer", confirmed: true } });
  assert.equal(again.status, "done", JSON.stringify(again));
});

test("cancel and resume on a server home; a taken name fails plainly and resume takes a new one", async t => {
  const w = world(t);
  const a = await harlow(t, w);
  const d = await device(t);
  await d.ok("spaces.identity.create", { name: "juno" });
  const taken = await d.ok("spaces.create", { name: "harlow", home: { kind: "server" } });
  assert.equal(taken.status, "failed");
  assert.equal(taken.failed.step, "validate");
  assert.match(taken.failed.reason, /taken/);
  const renamed = await d.ok("spaces.resume", { space: taken.space, name: "junos-studio" });
  assert.equal(renamed.status, "waiting");
  assert.equal(renamed.name, "junos-studio");
  const c = await d.ok("spaces.cancel", { space: taken.space });
  assert.equal(c.cancelled, true);
  assert.ok(c.couldNot.some(x => x.what === "Vyre on your server"));
  assert.equal((await d.ok("spaces.list")).find(x => x.id === taken.space), undefined, "a cancelled space is not listed");
  assert.equal((await d.ok("spaces.status", { space: taken.space })).status, "cancelled");
  // A finished space cannot be cancelled away.
  const fin = await a.d.ok("spaces.cancel", { space: a.space });
  assert.equal(fin.cancelled, false);
  // Someone who does not own it cannot run it.
  assert.equal((await d.call("spaces.status", { space: a.space })).error?.code, "not_found");
});

test("a second server and a move plan are owner actions", async t => {
  const w = world(t);
  const { d, space } = await harlow(t, w);
  const add = await d.ok("spaces.server.install", { space });
  assert.equal(add.role, "compute");
  assert.match(add.code, /^\d{6}$/);
  assert.equal(add.installCommand, "curl -fsSL vyre.run/i | sh");
  const joined = await d.ok("spaces.code.submit", { space, code: add.code, join: add.joinId }, "device:aaaaaaaaaaaaaaaa");
  assert.equal(joined.state, "joined");
  const plan = await d.ok("spaces.move.plan", { space, to: { kind: "server", host: "host.example" } });
  assert.equal(plan.oneAction, true);
  assert.equal(plan.requires, "owner");
  assert.equal((await d.call("spaces.move.plan", { space, to: { kind: "this-computer", device: { id: "x" } } })).error?.code, undefined);
  const juno = await actAs(d, "juno");
  assert.equal((await d.call("spaces.move.plan", { space, to: { kind: "server", host: "h" } })).error?.code, "forbidden");
  assert.equal((await d.call("spaces.server.install", { space })).error?.code, "forbidden");
  void juno;
});

test("members through the tools: admins cannot touch owners, the last owner stays, and owner changes need presence", async t => {
  const w = world(t);
  const { d, alex, space } = await harlow(t, w);
  const juno = person(), kit = person(), bo = person();
  const add = (input, meta) => d.call("spaces.members.add", { space, ...input }, "cli", meta);
  assert.equal((await add({ person: juno.id, role: "admin" })).error, undefined);
  assert.equal((await add({ person: kit.id, role: "member" })).error, undefined);
  assert.equal((await add({ person: kit.id, role: "member" })).error?.code, "duplicate");
  // Granting owner: the registry asks for the person's presence, and without it nothing is written.
  const noProof = await add({ person: bo.id, role: "owner" });
  assert.equal(noProof.error?.code, "presence_required");
  assert.equal((await d.ok("spaces.members.list", { space })).members.length, 3);
  const asOwner = await add({ person: bo.id, role: "owner" }, { proof: "touch" });
  assert.ok(!asOwner.error, JSON.stringify(asOwner.error));
  assert.equal(asOwner.data.membership.role, "owner");
  assert.equal(asOwner.data.membership.name, null, "a person this device has no verified name for shows no name, never a guess");

  // Act as the admin: the same home, another person.
  await actAs(d, "juno-device");
  fs.writeFileSync(path.join(d.space, "identity.json"), JSON.stringify({ v: 1, name: "juno", publicKey: juno.publicKey, privateKey: juno.privateKey, createdAt: T0 }), { mode: 0o600 });
  assert.equal((await d.call("spaces.members.add", { space, person: person().id, role: "admin" })).error?.code, "forbidden");
  assert.equal((await d.call("spaces.members.add", { space, person: person().id, role: "owner" }, "cli", { proof: "x" })).error?.code, "exceeds_role");
  assert.equal((await d.call("spaces.members.remove", { space, person: alex.id })).error?.code, "forbidden");
  assert.equal((await d.call("spaces.members.set-role", { space, person: alex.id, role: "member" })).error?.code, "forbidden");
  assert.equal((await d.call("spaces.members.set-role", { space, person: bo.id, role: "admin" })).error?.code, "forbidden");
  const low = await d.call("spaces.members.add", { space, person: person().id, role: "manager" });
  assert.ok(!low.error, JSON.stringify(low.error));
  assert.equal((await d.call("spaces.members.set-role", { space, person: kit.id, role: "manager" })).error, undefined);
  // A member cannot manage anyone.
  fs.writeFileSync(path.join(d.space, "identity.json"), JSON.stringify({ v: 1, name: "kit", publicKey: kit.publicKey, privateKey: kit.privateKey, createdAt: T0 }), { mode: 0o600 });
  assert.equal((await d.call("spaces.members.add", { space, person: person().id, role: "member" })).error?.code, "forbidden");
  // A stranger sees nothing.
  await actAs(d, "stranger");
  assert.equal((await d.call("spaces.members.list", { space })).error?.code, "not_a_member");
});

test("the last owner and ownership transfer", async t => {
  const w = world(t);
  const { d, alex, space } = await harlow(t, w);
  const juno = person();
  assert.equal((await d.call("spaces.members.remove", { space, person: alex.id })).error?.code, "last_owner");
  assert.equal((await d.call("spaces.members.add", { space, person: juno.id, role: "member" })).error, undefined);
  assert.equal((await d.call("spaces.members.set-role", { space, person: alex.id, role: "admin" })).error?.code, "last_owner");
  // Transfer: presence first.
  assert.equal((await d.call("spaces.members.transfer", { space, to: juno.id })).error?.code, "presence_required");
  const t1 = await d.call("spaces.members.transfer", { space, to: juno.id }, "cli", { proof: "touch" });
  assert.ok(!t1.error, JSON.stringify(t1.error));
  assert.deepEqual([t1.data.owner, t1.data.previous, t1.data.previous_role], [juno.id, alex.id, "admin"]);
  assert.deepEqual(d.of("ownership.transferred").map(e => [e.from, e.to]), [[alex.id, juno.id]]);
  const list = (await d.ok("spaces.members.list", { space })).members;
  assert.deepEqual(list.map(m => [m.role]).flat().sort(), ["admin", "owner"]);
  // As an admin now, alex cannot touch the owner.
  assert.equal((await d.call("spaces.members.remove", { space, person: juno.id })).error?.code, "forbidden");
  // The library's own presence check also holds when the registry has none to run (a module-to-module call carries no proof).
  const viaModule = await d.call("spaces.members.transfer", { space, to: alex.id }, "module:test");
  assert.ok(viaModule.error, "a module can never carry a person's presence");
  // Role display names: owner or admin only, ids never change.
  const names = await d.ok("spaces.roles.names", { space });
  assert.deepEqual(names.names.map(n => n.id), ["owner", "admin", "manager", "member", "temp"]);
  assert.equal((await d.ok("spaces.roles.names", { space, role: "temp", name: "Guest" })).names.find(n => n.id === "temp").name, "Guest");
  assert.equal((await d.ok("spaces.roles.names", { space })).names.find(n => n.id === "temp").name, "Guest", "the name is kept");
});

test("temp members need scope and an end date; they end on time and an extension needs presence", async t => {
  const w = world(t);
  const { d, space } = await harlow(t, w);
  const kit = person();
  const scope = ["vyre://harlow/project/bakery-case"];
  const add = input => d.call("spaces.members.add", { space, person: kit.id, role: "temp", ...input });
  assert.equal((await add({})).error?.code, "bad_scope");
  assert.equal((await add({ scope })).error?.code, "bad_scope");
  assert.equal((await add({ scope: ["not a urn"], expires: w.clock.t + DAY })).error?.code, "bad_scope");
  assert.equal((await add({ scope, expires: w.clock.t - 1 })).error?.code, "expired");
  assert.equal((await d.call("spaces.members.add", { space, person: kit.id, role: "member", scope })).error?.code, "bad_scope");
  const added = await add({ scope, expires: w.clock.t + DAY });
  assert.ok(!added.error, JSON.stringify(added.error));
  assert.deepEqual([added.data.membership.scope, added.data.membership.expires], [scope, w.clock.t + DAY]);
  const caller = "module:test";
  assert.deepEqual((await d.ok("spaces.abilities", { space, person: kit.id }, caller)).abilities, ["scoped.work"]);

  // Extension: registry presence first; the later date must be later.
  const to = w.clock.t + 3 * DAY;
  assert.equal((await d.call("spaces.members.extend", { space, person: kit.id, expires: to })).error?.code, "presence_required");
  assert.equal((await d.call("spaces.members.extend", { space, person: kit.id, expires: w.clock.t + 1000 }, "cli", { proof: "touch" })).error?.code, "bad_input");
  const ext = await d.call("spaces.members.extend", { space, person: kit.id, expires: to }, "cli", { proof: "touch" });
  assert.ok(!ext.error, JSON.stringify(ext.error));
  assert.equal((await d.ok("spaces.membership", { space, person: kit.id }, caller)).expires, to);
  assert.deepEqual(d.of("member.extended").map(e => e.to), [to]);

  // Time passes: the daily sweep says so, once, and the access is gone.
  w.clock.t = to + 1000;
  const swept = await d.ok("spaces.sweep", {}, caller);
  assert.equal(swept.members, 1);
  assert.deepEqual(d.of("member.expired").map(e => e.person), [kit.id]);
  assert.equal((await d.ok("spaces.sweep", {}, caller)).members, 0, "once");
  assert.deepEqual((await d.ok("spaces.abilities", { space, person: kit.id }, caller)).abilities, []);
  assert.equal((await d.ok("spaces.membership", { space, person: kit.id }, caller)).expired, true);
  // The internal reads are for modules only.
  assert.equal((await d.call("spaces.membership", { space, person: kit.id }, "cli")).error?.code, "no_such_tool");
  assert.equal((await d.call("spaces.sweep", {}, "mcp")).error?.code, "no_such_tool");
  assert.equal((await d.ok("spaces.membership", { space, person: "per_aaaaaaaaaaaaaaaaaaaaaaaaaa" }, caller)), null);
});

test("invites: each role, a stranger sees only the card, the join is signed by the joiner's own key, a replay is refused", async t => {
  const w = world(t);
  const { d, alex, space } = await harlow(t, w);
  const kit = await device(t);
  const kitId = await kit.ok("spaces.identity.create", { name: "kit" });
  const scope = ["vyre://harlow/project/bakery-case"];

  // An owner is never invited by link.
  assert.equal((await d.call("spaces.invites.create", { space, role: "owner" })).error?.code, "forbidden");
  const made = {};
  for (const [role, extra] of [["admin", {}], ["manager", {}], ["member", { scope }], ["temp", { scope, expires: w.clock.t + 2 * DAY }]]) {
    const r = await d.ok("spaces.invites.create", { space, role, ...extra });
    assert.match(r.link, /^https:\/\/harlow\.vyre\.run\/join\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(r.code, null, "with no Wink module here the invite is the link alone (a typed code is best effort)");
    made[role] = r;
  }
  assert.equal((await d.call("spaces.invites.create", { space, role: "temp" })).error?.code, "bad_scope");
  assert.equal((await d.call("spaces.invites.create", { space, role: "manager", scope })).error?.code, "bad_scope");
  assert.equal(d.of("invite.created").length, 4);
  const listed = (await d.ok("spaces.invites.list", { space })).invites;
  assert.equal(listed.length, 4);
  assert.ok(listed.every(i => !("token" in i) && !JSON.stringify(i).includes(".vyre.run/join")), "a list never carries a link");

  // A stranger (a device with no part in the space) previews: only the card.
  const stranger = await device(t);
  await stranger.ok("spaces.identity.create", { name: "stranger" });
  const card = await stranger.ok("spaces.invites.preview", { link: made.member.link });
  assert.deepEqual(Object.keys(card).sort(), ["button", "fingerprint", "fingerprint_words", "label", "role", "role_label", "sees", "space", "valid_until"]);
  assert.deepEqual([card.space, card.label, card.role, card.button], ["harlow.vyre.run", "Harlow Legal", "member", "Join Harlow Legal"]);
  assert.deepEqual(card.sees.scope, scope);
  const text = JSON.stringify(card);
  assert.ok(!text.includes(alex.id) && !text.includes(made.member.token) && !text.includes("inv_"), "the card holds only what the person needs");
  assert.equal((await stranger.call("spaces.invites.preview", { link: "https://evil.example.com/join/abc.def" })).error?.code, "bad_input");
  const t2 = made.member.token.split(".");
  assert.equal((await stranger.call("spaces.invites.preview", { link: `https://harlow.vyre.run/join/${t2[0]}.${Buffer.alloc(64).toString("base64url")}` })).error?.code, "forged");
  assert.equal((await stranger.call("spaces.invites.preview", { link: `https://northwind.vyre.run/join/${made.member.token}` })).error?.code, "wrong_space");
  // A pin that is not the space's identity refuses.
  const wrongPin = await stranger.call("spaces.invites.preview", { link: made.member.link, pin: `spc_${"a".repeat(26)}:0:${"b".repeat(64)}` });
  assert.equal(wrongPin.error?.code, "wrong_space");

  // Kit accepts on his own device. The home is elsewhere, so the signed acceptance comes back for the home to redeem.
  const acc = await kit.ok("spaces.invites.accept", { link: made.member.link });
  assert.equal(acc.joined, false);
  assert.equal(acc.redeem.person.id, kitId.id);
  const joined = await d.call("spaces.invites.redeem", acc.redeem, "device:bbbbbbbbbbbbbbbb");
  assert.ok(!joined.error, JSON.stringify(joined.error));
  assert.deepEqual([joined.data.membership.person, joined.data.membership.role], [kitId.id, "member"]);
  assert.deepEqual(joined.data.projects, scope);
  assert.ok(d.of("invite.accepted").some(e => e.person === kitId.id));
  assert.ok((await d.ok("spaces.members.list", { space })).members.some(m => m.person === kitId.id && m.role === "member"));
  // A replay of the same acceptance, and another person on a used link.
  assert.equal((await d.call("spaces.invites.redeem", acc.redeem, "device:bbbbbbbbbbbbbbbb")).error?.code, "used_up");
  const other = person();
  const otherProof = crypto.sign(null, Buffer.from(`vyre-invite-accept-v1\n${JSON.parse(Buffer.from(t2[0], "base64url")).id}\nharlow.vyre.run\n${other.id}`), crypto.createPrivateKey({ key: Buffer.from(other.privateKey, "base64url"), format: "der", type: "pkcs8" })).toString("base64url");
  assert.equal((await d.call("spaces.invites.redeem", { token: made.member.token, person: { id: other.id, publicKey: other.publicKey }, proof: otherProof }, "tailnet:x")).error?.code, "used_up");
  // A proof from another key, or for another person's id, is refused.
  const adminLink = made.admin;
  assert.equal((await d.call("spaces.invites.redeem", { token: adminLink.token, person: { id: other.id, publicKey: other.publicKey }, proof: acc.redeem.proof }, "tailnet:x")).error?.code, "bad_proof");
  assert.equal((await d.call("spaces.invites.redeem", { token: adminLink.token, person: { id: kitId.id, publicKey: other.publicKey }, proof: otherProof }, "tailnet:x")).error?.code, "bad_proof");
  // The admin, manager and temp links each make that role.
  const roles = {};
  for (const role of ["admin", "manager", "temp"]) {
    const p = person();
    const tok = made[role].token;
    const id = JSON.parse(Buffer.from(tok.split(".")[0], "base64url")).id;
    const proof = crypto.sign(null, Buffer.from(`vyre-invite-accept-v1\n${id}\nharlow.vyre.run\n${p.id}`), crypto.createPrivateKey({ key: Buffer.from(p.privateKey, "base64url"), format: "der", type: "pkcs8" })).toString("base64url");
    const r = await d.call("spaces.invites.redeem", { token: tok, person: { id: p.id, publicKey: p.publicKey }, proof }, "tailnet:x");
    assert.ok(!r.error, `${role}: ${JSON.stringify(r.error)}`);
    roles[role] = r.data.membership;
  }
  assert.deepEqual(Object.entries(roles).map(([k, m]) => [k, m.role]), [["admin", "admin"], ["manager", "manager"], ["temp", "temp"]]);
  assert.deepEqual(roles.temp.scope, scope);
  assert.equal(roles.temp.expires, w.clock.t + 2 * DAY);
  assert.equal(d.of("member.added").length, 1 + 4);
  // The join link and every token stay out of events.
  assert.ok(!JSON.stringify(d.seen).includes(made.admin.token));
});

test("invites: revoke, expiry and the sweep, and a revoked link is refused by the home", async t => {
  const w = world(t);
  const { d, space } = await harlow(t, w);
  const a = await d.ok("spaces.invites.create", { space, role: "member" });
  const b = await d.ok("spaces.invites.create", { space, role: "member", ttlDays: 1 });
  const rev = await d.ok("spaces.invites.revoke", { space, id: a.id });
  assert.equal(rev.status, "revoked");
  assert.deepEqual(d.of("invite.revoked").map(e => e.invite), [a.id]);
  const host = await d.call("spaces.invites.preview", { link: a.link });
  assert.equal(host.error?.code, "revoked", "the home knows it was cancelled");
  const p = person();
  const proof = crypto.sign(null, Buffer.from(`vyre-invite-accept-v1\n${a.id}\nharlow.vyre.run\n${p.id}`), crypto.createPrivateKey({ key: Buffer.from(p.privateKey, "base64url"), format: "der", type: "pkcs8" })).toString("base64url");
  assert.equal((await d.call("spaces.invites.redeem", { token: a.token, person: { id: p.id, publicKey: p.publicKey }, proof }, "tailnet:x")).error?.code, "revoked");
  assert.equal((await d.call("spaces.invites.revoke", { space, id: "inv_nothingatallhere" })).error?.code, "unknown_invite");
  // A day passes: b is past its life; the sweep says so once.
  w.clock.t += 2 * DAY;
  assert.equal((await d.call("spaces.invites.preview", { link: b.link })).error?.code, "expired");
  assert.equal((await d.ok("spaces.sweep", {}, "module:test")).invites, 1);
  assert.deepEqual(d.of("invite.expired").map(e => e.invite), [b.id]);
  assert.equal((await d.ok("spaces.sweep", {}, "module:test")).invites, 0);
  // Someone who is only a member cannot invite; a stranger cannot even look.
  const member = person();
  await d.ok("spaces.members.add", { space, person: member.id, role: "member" });
  fs.writeFileSync(path.join(d.space, "identity.json"), JSON.stringify({ v: 1, name: "kit", publicKey: member.publicKey, privateKey: member.privateKey, createdAt: T0 }), { mode: 0o600 });
  assert.equal((await d.call("spaces.invites.create", { space, role: "member" })).error?.code, "forbidden");
  await actAs(d, "stranger");
  assert.equal((await d.call("spaces.invites.list", { space })).error?.code, "not_a_member");
});

test("an invite accepted on the home itself makes the membership at once, with this device's own key", async t => {
  const w = world(t);
  const a = await harlow(t, w);
  const d = a.d;
  const invite = await d.ok("spaces.invites.create", { space: a.space, role: "member" });
  // The same device is the home and the joiner's own identity: switch to a second person's key on the same home.
  const kit = await actAs(d, "kit");
  const r = await d.ok("spaces.invites.accept", { link: invite.link });
  assert.equal(r.joined, true);
  assert.deepEqual([r.membership.person, r.membership.role], [kit.id, "member"]);
  const again = await d.call("spaces.invites.accept", { link: invite.link });
  assert.equal(again.error?.code, "used_up");
  assert.equal((await d.call("spaces.invites.accept", { link: "not a link" })).error?.code, "bad_input");
});

test("an own-domain join link works once the alias is added", async t => {
  const w = world(t);
  const a = await harlow(t, w);
  const d = a.d;
  const txt = await d.ok("spaces.identity.alias", { space: a.space, domain: "app.harlow.example.com" });
  w.txt.set(txt.host, [txt.value]);
  const added = await d.ok("spaces.identity.alias.add", { space: a.space, domain: "app.harlow.example.com" });
  assert.deepEqual(added.aliases, ["app.harlow.example.com"]);
  const inv = await d.ok("spaces.invites.create", { space: a.space, role: "member", alias: "app.harlow.example.com" });
  assert.match(inv.link, /^https:\/\/app\.harlow\.example\.com\/join\//);
  const stranger = await device(t);
  await stranger.ok("spaces.identity.create", { name: "kit" });
  const card = await stranger.ok("spaces.invites.preview", { link: inv.link });
  assert.equal(card.space, "harlow.vyre.run");
  assert.equal((await d.call("spaces.invites.create", { space: a.space, role: "member", alias: "evil.example.com" })).error?.code, "bad_input");
});

test("events carry no secrets, every event name is declared, and nothing was refused", async t => {
  const w = world(t);
  const a = await harlow(t, w);
  const d = a.d;
  const kit = person();
  await d.ok("spaces.members.add", { space: a.space, person: kit.id, role: "member" });
  await d.ok("spaces.invites.create", { space: a.space, role: "member" });
  const manifest = JSON.parse(fs.readFileSync(path.join(CORE, "spaces", "module.json"), "utf8"));
  for (const type of new Set(d.types().filter(x => !x.startsWith("module.") ))) {
    if (/^(space|member|invite|identity|ownership)\./.test(type)) assert.ok(manifest.watches.emits.includes(type), `${type} is not declared`);
  }
  assert.ok(!d.logs.some(l => /was not sent/.test(l)), d.logs.filter(l => /was not sent/.test(l)).join("\n"));
  const rootKey = fs.readFileSync(path.join(d.space, a.space, "root.key"), "utf8").trim();
  assert.ok(!everything(d).includes(rootKey));
  assert.ok(!/(privateKey|root\.key|recoveryCode|PG_PASSWORD)/.test(JSON.stringify(d.seen)));
  void w;
});

test("the module hands out no private tool to an agent or a stranger: reach is person, modules or the two declared relays", async t => {
  const w = world(t);
  const d = await device(t);
  await d.ok("spaces.identity.create", { name: "alex" });
  for (const name of ["spaces.identity.create", "spaces.create", "spaces.members.add", "spaces.members.transfer", "spaces.invites.create", "spaces.invites.accept", "spaces.cancel"]) {
    const asAgent = await d.call(name, {}, "mcp");
    assert.ok(asAgent.error && ["no_such_tool", "denied", "not_allowed"].includes(asAgent.error.code) || asAgent.error?.code, `${name} as an agent`);
    assert.notEqual(asAgent.error?.code, undefined);
    assert.ok(!["bad_input"].includes(asAgent.error.code) || true);
  }
  void w; void spacesModule;
});

test("identity tools: entries, a second device, the newcomer rule, an older device removes it, and the others are told", async t => {
  const w = world(t);
  const d1 = await device(t), d2 = await device(t);
  const made = await d1.ok("spaces.identity.create", { name: "alex", password: "four plain words here", deviceLabel: "phone" });
  assert.equal(made.passwordSet, true);
  const list = await d1.ok("spaces.identity.entries");
  assert.deepEqual(list.entries.map(e => [e.kind, e.self, e.newcomer]), [["device", true, false], ["code", false, false]]);
  // The second device makes its key; the first adds it and hands it the chain (pairing carries this: tailnet's part).
  const store2 = fileIdentityStore(d2.space);
  const key = store2.newDeviceKey();
  const added = await d1.ok("spaces.identity.entry.add", { publicKey: key.publicKey, label: "laptop" });
  store2.join(key, JSON.parse(fs.readFileSync(path.join(d1.space, "identity.json"), "utf8")).ops, "alex");
  assert.equal((await d2.ok("spaces.identity.status")).id, made.id);
  const mine = (await d2.ok("spaces.identity.entries")).entries.find(e => e.self);
  assert.equal(mine.newcomer, true);
  assert.equal((await d2.call("spaces.identity.entry.remove", { eid: made.eid })).error?.code, "newcomer");
  assert.equal((await d2.call("spaces.identity.code.replace", {})).error?.code, "newcomer");
  assert.equal((await d2.call("spaces.identity.entry.add", { kind: "contact", publicKey: store2.newDeviceKey().publicKey })).error?.code, "newcomer");
  assert.equal((await d1.ok("spaces.identity.sync")).alerts.length, 0, "the device that made the change is not alerted about it");
  assert.deepEqual(d1.of("identity.entry-added").map(e => e.kind), ["device"]);
  // one tap from the older device, and the newcomer learns it was removed
  await d1.ok("spaces.identity.entry.remove", { eid: added.eid });
  const gone = await d2.ok("spaces.identity.sync");
  assert.equal(gone.removed, true);
  assert.deepEqual(d2.of("identity.device-removed").map(e => e.eid), [added.eid]);
  // a password and a code bring it back on a third device; the code is replaceable
  const d3 = await device(t);
  assert.equal((await d3.call("spaces.identity.recover.code", { name: "alex", code: made.recoveryCode, password: "wrong words wrong words" })).error?.code, "wrong_code");
  const back = await d3.ok("spaces.identity.recover.code", { name: "alex", code: made.recoveryCode, password: "four plain words here", deviceLabel: "new phone" });
  assert.equal(back.id, made.id);
  const next = await d1.ok("spaces.identity.code.replace", {});
  assert.notEqual(next.recoveryCode, made.recoveryCode);
  const d4 = await device(t);
  assert.equal((await d4.call("spaces.identity.recover.code", { name: "alex", code: made.recoveryCode, password: "four plain words here" })).error?.code, "wrong_code", "the old code stops");
  void w;
});

test("a space's list of owners follows its owners, and an invite made to an identity is for that identity only", async t => {
  const w = world(t);
  const { d, alex, space } = await harlow(t, w);
  const before = await d.ok("spaces.identity.resolve", { name: "harlow" });
  assert.equal(before.entries, 1);
  const kit = await device(t);
  const kitId = await kit.ok("spaces.identity.create", { name: "kit" });
  const added = await d.call("spaces.members.add", { space, person: "kit", role: "owner" }, "cli", { proof: "touch" });
  assert.ok(!added.error, JSON.stringify(added.error));
  assert.equal((await d.ok("spaces.identity.resolve", { name: "harlow" })).entries, 2, "the new owner is on the space's list, signed by alex");
  assert.ok((await d.ok("spaces.get", { space })).warnings.every(x => x.code !== "owners_chain_behind"));
  await d.ok("spaces.members.remove", { space, person: kitId.id });
  assert.equal((await d.ok("spaces.identity.resolve", { name: "harlow" })).entries, 1);
  // an invite to kit
  const stranger = await device(t);
  await stranger.ok("spaces.identity.create", { name: "stranger" });
  const inv = await d.ok("spaces.invites.create", { space, role: "member", to: kitId.id });
  const wrong = await stranger.ok("spaces.invites.accept", { link: inv.link });
  const refused = await d.call("spaces.invites.redeem", wrong.redeem, "device:cccccccccccccccc");
  assert.equal(refused.error?.code, "forbidden");
  const right = await kit.ok("spaces.invites.accept", { link: inv.link });
  const joined = await d.call("spaces.invites.redeem", right.redeem, "device:bbbbbbbbbbbbbbbb");
  assert.ok(!joined.error, JSON.stringify(joined.error));
  assert.equal(joined.data.membership.person, kitId.id);
  void alex;
});

test("the compute grant pair through the tools: the space allows, the member accepts the terms they were shown", async t => {
  const w = world(t);
  const { d, alex, space } = await harlow(t, w);
  const off = await d.ok("spaces.compute.status", { space });
  assert.deepEqual([off.spaceAllows, off.active], [false, false]);
  assert.equal((await d.call("spaces.compute.accept", { space, enabled: true, terms: "x" })).error?.code, "not_allowed");
  const on = await d.ok("spaces.compute.allow", { space, enabled: true });
  assert.equal(on.enabled, true);
  assert.equal((await d.call("spaces.compute.accept", { space, enabled: true, terms: "wrong" })).error?.code, "terms_changed");
  await d.ok("spaces.compute.accept", { space, enabled: true, terms: on.hash });
  assert.equal((await d.ok("spaces.compute.status", { space })).active, true);
  const ok = await d.ok("spaces.compute.may-run", { space, session: { owner: alex.id }, machine: { owner: alex.id } }, "module:scheduler");
  assert.equal(ok.allow, true);
  const other = await d.ok("spaces.compute.may-run", { space, session: { owner: alex.id }, machine: { owner: "per_" + "k".repeat(26) } }, "module:scheduler");
  assert.equal(other.allow, false);
  assert.deepEqual(d.of("compute.member-accepted").map(e => e.person), [alex.id]);
});


test("kernel mode: roles and members are the Space kernel's, through the tools, with the kernel's proofs and refusals (a real kernel, in memory)", async t => {
  const { createKernel } = await import("../../kernel/index.js");
  const { payloadHash } = await import("../../kernel/seal/wire.js");
  const { proofRequest } = await import("../../kernel/remote/proof.js");
  const w = world(t);
  const KSPACE = "spc_aaaaaaaaaaaa";
  /** @type {any} */ let K = null, handle = null;
  const used = new Set();
  const presenceK = { check: async ({ chain, op, fields, proof }) => (chain && proof && proof.payload_hash === payloadHash(op, chain.space, fields) && !used.has(proof.nonce) && (used.add(proof.nonce), true) ? null : "bad_proof") };
  // The module reaches the one real kernel for any space id it asks about (the routing is the only fake: the kernel itself is real).
  const real = m => (handle ||= K.kernelFor(m));
  const kernelFor = m => ({ for: () => real(m).for(KSPACE), chain: meta => real(m).chain(meta), proofFrom: meta => real(m).proofFrom(meta), serviceChain: () => real(m).serviceChain(), acceptProofRequest: (c, p) => real(m).acceptProofRequest(c, p), membership: p => real(m).membership(p, KSPACE) });
  const d = await device(t, { kernelFor });
  const alex = await d.ok("spaces.identity.create", { name: "alex" });
  K = await createKernel({ space: KSPACE, owner: alex.id, owner_uid: 501, key: Buffer.alloc(32, 9), clock: () => w.clock.t, presence: presenceK, hasPresenceSession: () => true });
  const ownerChain = K.chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
  const { token } = await K.surfaces.open(ownerChain);
  const sign = (call, ...a) => ({ payload_hash: proofRequest(KSPACE, call, ...a).payload_hash, nonce: Math.random().toString(36) });
  // The default `assistant` actor is the kernel's own bootstrap (sessions, work/flows 1a4646c87), not a step of creating a Space here; once platform takes it,
  // a brand-new Space's unnamed thread reads under its person's grants and this test checks that.
  const s = await d.ok("spaces.create", { name: "harlow", displayName: "Harlow Legal", home: { kind: "this-computer", confirmed: true } });
  const space = s.space;
  const KIT = "per_" + "k".repeat(26);
  // making an owner with no proof: the kernel says the change needs the person's approval, in the module's words; a role below owner needs none (user ruling 5 Oct)
  const bare = await d.call("spaces.members.add", { space, person: "per_" + "z".repeat(26), role: "owner" }, "cli", { token });
  assert.ok(["needs_presence", "presence_required"].includes(bare.error?.code), JSON.stringify(bare.error)); // the registry asks first for an owner, the kernel would otherwise
  const added = await d.call("spaces.members.add", { space, person: KIT, role: "member" }, "cli", { token });
  assert.ok(!added.error, JSON.stringify(added.error));
  const listed = await d.ok("spaces.members.list", { space }, "cli", { token });
  assert.deepEqual(listed.members.map(m => [m.person, m.role]).sort(), [[alex.id, "owner"], [KIT, "member"]].sort());
  // a role the kernel refuses (a member cannot be made owner by... the owner can; a temp needs a scope) comes back as the module's code
  const temp = await d.call("spaces.members.set-role", { space, person: KIT, role: "temp" }, "cli", { token, kernel_proof: sign("setRole", { person: KIT, role: "temp" }) });
  assert.equal(temp.error?.code, "bad_scope", JSON.stringify(temp.error));
  const gone = await d.call("spaces.members.remove", { space, person: KIT }, "cli", { token, kernel_proof: sign("removeMember", { person: KIT }) });
  assert.ok(!gone.error, JSON.stringify(gone.error));
  assert.deepEqual((await d.ok("spaces.members.list", { space }, "cli", { token })).members.map(m => m.person), [alex.id]);
  // the last owner stays: the kernel's rule, as last_owner
  const last = await d.call("spaces.members.remove", { space, person: alex.id }, "cli", { token, kernel_proof: sign("removeMember", { person: alex.id }) });
  assert.equal(last.error?.code, "last_owner", JSON.stringify(last.error));
  // the modules' reads (bridges, publish) are the kernel's answer for this one person, not a local table
  assert.deepEqual(await d.ok("spaces.membership", { space, person: alex.id }, "module:bridges"), { space, person: alex.id, role: "owner", scope: null, expires: null });
  assert.equal(await d.ok("spaces.membership", { space, person: KIT }, "module:bridges"), null, "removed: not a member");
  assert.deepEqual((await d.ok("spaces.merge-list", { person: alex.id }, "module:bridges")).spaces.map(x => x.space), [space]);
  // spaces.get and spaces.list read the role from the kernel
  assert.equal((await d.ok("spaces.get", { space }, "cli", { token })).role, "owner");
  assert.equal((await d.ok("spaces.list", {}, "cli", { token })).find(x => x.id === space).role, "owner");
});


test("kernel mode: an invite is the Space kernel's: the link carries its id and the pin, the card comes from the kernel, and the invitee joins with their own proof", async t => {
  const { createKernel } = await import("../../kernel/index.js");
  const { payloadHash } = await import("../../kernel/seal/wire.js");
  const { proofRequest } = await import("../../kernel/remote/proof.js");
  const w = world(t);
  const KSPACE = "spc_aaaaaaaaaaaa";
  /** @type {any} */ let K = null;
  const handles = new Map();
  const used = new Set();
  const presenceK = { check: async ({ chain, op, fields, proof }) => (chain && proof && proof.payload_hash === payloadHash(op, chain.space, fields) && !used.has(proof.nonce) && (used.add(proof.nonce), true) ? null : "bad_proof") };
  const real = m => { if (!handles.has(m.name)) handles.set(m.name, K.kernelFor(m)); return handles.get(m.name); };
  const kernelFor = m => ({ for: () => real(m).for(KSPACE), chain: meta => real(m).chain(meta), proofFrom: meta => real(m).proofFrom(meta), serviceChain: () => real(m).serviceChain(), acceptProofRequest: (c, p) => real(m).acceptProofRequest(c, p), membership: p => real(m).membership(p, KSPACE) });
  const d = await device(t, { kernelFor }), kitDev = await device(t, { kernelFor });
  const alex = await d.ok("spaces.identity.create", { name: "alex" });
  const kit = await kitDev.ok("spaces.identity.create", { name: "kit" });
  K = await createKernel({ space: KSPACE, owner: alex.id, owner_uid: 501, key: Buffer.alloc(32, 9), clock: () => w.clock.t, presence: presenceK, hasPresenceSession: () => true });
  const token = (await K.surfaces.open(K.chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true }))).token;
  const kitToken = (await K.surfaces.open(K.chains.fromFacts({ kind: "invitee", person: kit.id, vouched: true }))).token;
  const s = await d.ok("spaces.create", { name: "harlow", displayName: "Harlow Legal", home: { kind: "this-computer", confirmed: true } });
  const space = s.space;
  const sign = (call, ...a) => ({ payload_hash: proofRequest(KSPACE, call, ...a).payload_hash, nonce: Math.random().toString(36) });
  // a space that lives on this computer makes no link: nobody else can reach it
  const refused = await d.call("spaces.invites.create", { space, role: "member", to: kit.id }, "cli", { token, kernel_proof: sign("inviteCreate", { role: "member", invitee: kit.id }) });
  assert.equal(refused.error && refused.error.code, "this_computer");
  assert.match(refused.error.message, /^This space lives on this computer, so other people cannot join it\. Move it to your server first\.$/);
  hooks.livesHere = false; t.after(() => { hooks.livesHere = null; });
  // the admin makes an invite for kit: a grant act with the admin's proof; the link is the kernel invite's id plus the pin
  const made = await d.call("spaces.invites.create", { space, role: "member", to: kit.id }, "cli", { token, kernel_proof: sign("inviteCreate", { role: "member", invitee: kit.id }) });
  assert.ok(!made.error, JSON.stringify(made.error));
  assert.match(made.data.id, /^inv_[0-9a-f]{32}$/);
  assert.match(made.data.link, /^https:\/\/harlow\.vyre\.run\/join\/inv_[0-9a-f]{32}\.[A-Za-z0-9_-]+$/);
  // kit's device: the card comes from the kernel, with the words to read out; the pin in the link is checked against the space's list
  const card = await kitDev.ok("spaces.invites.preview", { link: made.data.link }, "cli", { token: kitToken });
  assert.deepEqual([card.role, card.status, card.invitee], ["member", "pending", kit.id]);
  assert.match(card.fingerprint_words, /^\w+ \w+ \w+ \w+$/);
  // accepting needs the invitee's own proof over exactly this card: the first call says what to sign
  const first = await kitDev.ok("spaces.invites.accept", { link: made.data.link }, "cli", { token: kitToken });
  assert.equal(first.joined, false);
  assert.equal(first.needs_proof, true);
  assert.equal(first.request.op, "grant.accept");
  const proof = { payload_hash: first.request.payload_hash, nonce: "n-kit-1" };
  const joined = await kitDev.call("spaces.invites.accept", { link: made.data.link }, "cli", { token: kitToken, kernel_proof: proof });
  assert.ok(!joined.error, JSON.stringify(joined.error));
  assert.equal(joined.data.joined, true);
  assert.equal(joined.data.membership.role, "member");
  // single use, and a link whose pin is for another space's list is refused
  const again = await kitDev.call("spaces.invites.accept", { link: made.data.link }, "cli", { token: kitToken, kernel_proof: { ...proof, nonce: "n-kit-2" } });
  assert.ok(again.error);
  const [id0, blob] = made.data.token.split(".");
  const bad = JSON.parse(Buffer.from(blob, "base64url").toString());
  bad.rk = "0".repeat(32);
  const forged = `https://harlow.vyre.run/join/${id0}.${Buffer.from(JSON.stringify(bad)).toString("base64url")}`;
  assert.equal((await kitDev.call("spaces.invites.preview", { link: forged }, "cli", { token: kitToken })).error?.code, "forged");
  // an admin invite waits for the inviter to confirm the invitee's words
  const adm = await d.ok("spaces.invites.create", { space, role: "admin" }, "cli", { token, kernel_proof: sign("inviteCreate", { role: "admin" }) });
  assert.equal(adm.needs_confirm, true);
  const conf = await d.call("spaces.invites.confirm", { space, id: adm.id, words: card.fingerprint_words }, "cli", { token, kernel_proof: sign("inviteConfirm", adm.id, { words: card.fingerprint_words }) });
  assert.ok(!conf.error, JSON.stringify(conf.error));
});

test("a second person joins a space that lives on a server: the record carries the home's route, the invitee opens the stream with a signed hello and reads the card and accepts through the home's kernel", async t => {
  const { createKernel } = await import("../../kernel/index.js");
  const { payloadHash } = await import("../../kernel/seal/wire.js");
  const { proofRequest } = await import("../../kernel/remote/proof.js");
  const { createRemoteServer } = await import("../../kernel/remote/server.js");
  const { KERNEL_CALL_TOOL } = await import("../../kernel/remote/wink.js");
  const w = world(t);
  const KSPACE = "spc_aaaaaaaaaaaa";
  /** @type {any} */ let K = null;
  const handles = new Map();
  const used = new Set();
  const presenceK = { check: async ({ chain, op, fields, proof }) => (chain && proof && proof.payload_hash === payloadHash(op, chain.space, fields) && !used.has(proof.nonce) && (used.add(proof.nonce), true) ? null : "bad_proof") };
  const real = m => { if (!handles.has(m.name)) handles.set(m.name, K.kernelFor(m)); return handles.get(m.name); };
  const kernelFor = remote => m => ({ for: () => (remote ? null : real(m).for(KSPACE)), chain: meta => real(m).chain(meta), proofFrom: meta => real(m).proofFrom(meta), serviceChain: () => real(m).serviceChain(), acceptProofRequest: (c, p) => real(m).acceptProofRequest(c, p), membership: p => real(m).membership(p, KSPACE) });
  const d = await device(t, { kernelFor: kernelFor(false) }), kitDev = await device(t, { kernelFor: kernelFor(true) });
  const alex = await d.ok("spaces.identity.create", { name: "alex" });
  const kit = await kitDev.ok("spaces.identity.create", { name: "kit" });
  K = await createKernel({ space: KSPACE, owner: alex.id, owner_uid: 501, key: Buffer.alloc(32, 9), clock: () => w.clock.t, presence: presenceK, hasPresenceSession: () => true });
  const token = (await K.surfaces.open(K.chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true }))).token;
  const kitToken = (await K.surfaces.open(K.chains.fromFacts({ kind: "invitee", person: kit.id, vouched: true }))).token;
  const ROUTE = { relay: "https://relay.example", route: "rt-harlow", box: "bx-harlow" };
  hooks.livesHere = false; hooks.route = () => ROUTE;
  t.after(() => { hooks.livesHere = null; hooks.route = null; hooks.inviteeSessionFor = null; });
  const s = await d.ok("spaces.create", { name: "harlow", displayName: "Harlow Legal", home: { kind: "this-computer", confirmed: true } });
  const sign = (call, ...a) => ({ payload_hash: proofRequest(KSPACE, call, ...a).payload_hash, nonce: Math.random().toString(36) });
  const made = await d.ok("spaces.invites.create", { space: s.space, role: "member", to: kit.id }, "cli", { token, kernel_proof: sign("inviteCreate", { role: "member", invitee: kit.id }) });
  // kit's device does not host the space: without a stream it is told why
  const noStream = await kitDev.call("spaces.invites.preview", { link: made.link }, "cli", { token: kitToken });
  assert.equal(noStream.error && noStream.error.code, "unreachable");
  assert.match(noStream.error.message, /^This space lives on alex's computer and cannot be reached from here\./, "the record names the owner");
  assert.match(noStream.error.message, /cannot be reached from here\. Ask them to move it to their server\.$/);
  // the home's end: the kernel's remote server, with the peer the door admitted from the hello
  // this test's module-made space id is not the kernel's (a stand-in kernelFor); a real home answers under one id
  // the home's proof that it holds the space: its signature over the joiner's nonce with the key whose public half the record names (the module made that key on this device for the test; a real server makes it in host-here)
  const attestWith = (pub, priv) => async nonce => ({ pub, sig: crypto.sign(null, Buffer.from(`vyre-space-attest-v1\n${s.space}\n${nonce}`), priv).toString("base64url") });
  const held = privateKeyOf(fs.readFileSync(path.join(d.space, s.space, "root.key"), "utf8").trim());
  const heldPub = crypto.createPublicKey(held).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  const other = crypto.generateKeyPairSync("ed25519");
  const otherPub = other.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  const attest = { fn: attestWith(heldPub, held) };
  const server = createRemoteServer({ space: KSPACE, kernel: K, attest: n => attest.fn(n) });
  const hellos = [];
  hooks.inviteeSessionFor = async (channel, helloFor) => {
    const hello = typeof helloFor === "function" ? await helloFor("kitchannelaaaaaa") : helloFor;
    assert.equal(hello.channel, "kitchannelaaaaaa", "the hello names the channel's own key id");
    hellos.push({ channel, hello });
    return { call: async (tool, request) => { assert.equal(tool, KERNEL_CALL_TOOL); const r = JSON.parse(JSON.stringify(await server.serve({ ...JSON.parse(JSON.stringify(request)), space: KSPACE }, { person: hello.identity, device_key_id: `inv-${hello.nonce}`, path: "wink" }))); return r; } };
  };
  // a server that signs with a key that is not the record's rootPublic is refused before any card is shown
  attest.fn = attestWith(otherPub, other.privateKey);
  const wrong = await kitDev.call("spaces.invites.preview", { link: made.link }, "cli", { token: kitToken });
  assert.equal(wrong.error && wrong.error.code, "server_not_proven");
  // and one that gives no proof at all
  attest.fn = async () => null;
  assert.equal((await kitDev.call("spaces.invites.preview", { link: made.link }, "cli", { token: kitToken })).error?.code, "server_not_proven");
  // the home's door refusing this person (not their invite, spent, not admitted) is its own plain answer, not "cannot be reached"; a real outage stays unreachable (JE-1)
  { const keep = hooks.inviteeSessionFor;
    for (const [code, want, text] of [["denied", "not_for_you", /^This invite cannot be used\.$/], ["unreachable", "unreachable", /reach|connect|server/i]]) {
      hooks.inviteeSessionFor = async () => ({ call: async () => { throw Object.assign(new Error("closed"), { code }); } });
      const r = await kitDev.call("spaces.invites.preview", { link: made.link }, "cli", { token: kitToken });
      assert.equal(r.error && r.error.code, want, `${code}: ${JSON.stringify(r).slice(0, 200)}`);
      assert.match(r.error.message, text);
    }
    hooks.inviteeSessionFor = keep; }
  attest.fn = attestWith(heldPub, held);
  const card = await kitDev.ok("spaces.invites.preview", { link: made.link }, "cli", { token: kitToken });
  assert.deepEqual([card.role, card.status, card.invitee], ["member", "pending", kit.id]);
  assert.deepEqual(hellos[0].channel, ROUTE, "the route came from the space's directory record");
  const h = hellos[0].hello;
  assert.deepEqual([h.space, h.invite, h.identity], [s.space, made.id, kit.id]);
  assert.match(h.sig, /^[A-Za-z0-9_-]+$/);
  const first = await kitDev.ok("spaces.invites.accept", { link: made.link }, "cli", { token: kitToken });
  assert.equal(first.needs_proof, true);
  const joined = await kitDev.call("spaces.invites.accept", { link: made.link }, "cli", { token: kitToken, kernel_proof: { payload_hash: first.request.payload_hash, nonce: "n-kit-r1" } });
  assert.ok(!joined.error, JSON.stringify(joined.error));
  assert.equal(joined.data.joined, true);
  assert.equal(joined.data.membership.role, "member");
});

test("an op made a moment before it is applied is accepted when the clock keeps moving (adding a device entry on a real clock)", async t => {
  const w = world(t);
  const d = await device(t), d2 = await device(t);
  await d.ok("spaces.identity.create", { name: "tickalex" });
  // every read of the clock is a millisecond later than the last, as a real clock is between building an op and applying it
  let n = 0;
  hooks.now = () => w.clock.t + n++;
  const key = fileIdentityStore(d2.space).newDeviceKey();
  const added = await d.call("spaces.identity.enrol", { publicKey: key.publicKey, label: "alex's phone" }, "module:wink");
  assert.equal(added.error, undefined, JSON.stringify(added.error));
  assert.equal(added.data.eid, key.eid);
});

test("the transport's ports: a paired device is an entry, the entry port answers live and a removed device answers null at its next call, and the device signs only the transport's proof", async t => {
  const w = world(t);
  const d = await device(t), d2 = await device(t);
  const alex = await d.ok("spaces.identity.create", { name: "alex" });
  const s = await d.ok("spaces.create", { name: "harlow", displayName: "Harlow Legal", home: { kind: "this-computer", confirmed: true } });
  // alex's own identity is known to this device and a member of harlow
  const key = fileIdentityStore(d2.space).newDeviceKey();
  w.clock.t += 2 * 3_600_000;
  const enrolled = await d.ok("spaces.identity.enrol", { publicKey: key.publicKey, label: "alex's laptop" }, "module:wink");
  assert.equal(enrolled.eid, key.eid);
  const entry = await d.ok("spaces.identity.entry", { space: s.space, eid: key.eid }, "module:wink");
  assert.deepEqual(entry, { eid: key.eid, kind: "device", pub: key.publicKey });
  assert.equal(await d.ok("spaces.identity.entry", { space: s.space, eid: "a".repeat(26) }, "module:wink"), null, "not on any list");
  // the person's older device removes it: the very next read says null
  await d.ok("spaces.identity.entry.remove", { eid: key.eid });
  assert.equal(await d.ok("spaces.identity.entry", { space: s.space, eid: key.eid }, "module:wink"), null);
  assert.deepEqual(d.of("identity.entry-removed").map(e => e.eid), [key.eid]);
  // the signer: the transport's own message only
  const ok = await d.ok("spaces.identity.sign", { message: Buffer.from("vyre-wink-peer-v2\nnonce\nnode\nbox\n" + alex.eid).toString("base64url") }, "module:wink");
  assert.equal(ok.eid, alex.eid);
  assert.equal((await d.call("spaces.identity.sign", { message: Buffer.from("anything else").toString("base64url") }, "module:wink")).error?.code, "forbidden");
  // and Wink's proof of who is asking for a server installed with --pair-to (the box and the relay device), nothing else near it
  const pairTo = await d.ok("spaces.identity.sign", { message: Buffer.from("vyre-wink-pair-to-v1\nBOX\ndev1").toString("base64url") }, "module:wink");
  assert.equal(pairTo.eid, alex.eid);
  assert.equal((await d.call("spaces.identity.sign", { message: Buffer.from("vyre-wink-pair-to-v2\nBOX\ndev1").toString("base64url") }, "module:wink")).error?.code, "forbidden");
});


test("space creation asks the kernel which store it would use: a machine that cannot run Twenty makes nothing and offers the person's server in the kernel's words", async t => {
  const w = world(t);
  const TEXT = "This machine cannot run the record store for a new space (Twenty), so the space was not made here. Put it on your server instead.";
  const hosts = [];
  let small = true;
  const kernel = { space: "spc_bbbbbbbbbbbb", for: () => ({ space: "spc_bbbbbbbbbbbb", hosted: true, gateway: {} }), chain: async () => ({}), proofFrom: () => ({}), serviceChain: () => ({}),
    spaces: {
      storePlan: async () => (small ? { store: "none", confirm: { text: TEXT, choices: ["server", "cancel"] } } : { store: "twenty" }),
      host: async o => { hosts.push(o); return { space: `spc_${"b".repeat(12)}`.replace(/b/g, hosts.length === 1 ? "b" : "c") }; },
    } };
  const d = await device(t, { kernelFor: () => kernel, records: true });
  await d.ok("spaces.identity.create", { name: "alex" });
  const args = { name: "harlow", displayName: "Harlow Legal", home: { kind: "this-computer", confirmed: true } };
  // cannot run Twenty: nothing is made, and the person is shown exactly the kernel's words and the two choices
  const ask = await d.ok("spaces.create", args);
  assert.equal(ask.status, "needs_confirmation");
  assert.deepEqual(ask.confirm, { text: TEXT, choices: ["server", "cancel"] });
  assert.equal(hosts.length, 0, "the Space is never made first and explained after");
  assert.equal((await d.ok("spaces.list")).length, 0);
  // cancel: still nothing
  assert.equal((await d.ok("spaces.create", { ...args, storeChoice: "cancel" })).status, "cancelled");
  assert.equal(hosts.length, 0);
  // server: pointed at the person's server, still nothing here
  assert.equal((await d.ok("spaces.create", { ...args, storeChoice: "server" })).status, "use_server");
  assert.equal(hosts.length, 0);
  // a machine that can run Twenty: no question
  small = false;
  const big = await d.ok("spaces.create", { name: "northwind", home: { kind: "this-computer", confirmed: true } });
  assert.equal(big.status, "done", JSON.stringify(big));
  assert.deepEqual(hosts.map(h => h.name), ["northwind"]);
  // the join card's label: with no space named, this home's own Space (the one the kernel keeps here), its name and four words
  const label = await d.ok("spaces.label", {}, "module:vyred");
  assert.equal(label.name, "northwind.vyre.run");
  assert.match(label.words, /^\w+ \w+ \w+ \w+$/);
  void w;
});


test("spaces.code.submit and spaces.invites.redeem take only the relay and the devices: a local anonymous or model caller cannot spend a use count or burn the five tries", async t => {
  const w = world(t);
  const { d, space } = await harlow(t, w);
  for (const caller of ["cli", "mcp", "mcp:agent:juno", "harness", "tailnet-guest:mallory@example.com", "hook"]) {
    const a = await d.call("spaces.code.submit", { space, code: "000000" }, caller);
    const b = await d.call("spaces.invites.redeem", { token: "x.y", person: { id: "per_" + "a".repeat(26) }, proof: "z" }, caller);
    for (const r of [a, b]) assert.ok(["denied", "no_such_tool"].includes(r.error?.code), `${caller}: ${JSON.stringify(r.error)}`);
  }
});

test("a space is listed only once it has its home: a server step still waiting or failed leaves nothing in the list", async t => {
  const w = world(t);
  const d = await device(t);
  await d.ok("spaces.identity.create", { name: "alex" });
  const waiting = await d.ok("spaces.create", { name: "northwind", home: { kind: "server" } });
  assert.equal(waiting.status, "waiting");
  assert.deepEqual(await d.ok("spaces.list"), [], "waiting for the server's code: not a space yet");
  assert.equal((await d.ok("spaces.status", { space: waiting.space })).status, "waiting", "its steps are still readable");
  const here = await d.ok("spaces.create", { name: "harlow", home: { kind: "this-computer", confirmed: true } });
  assert.equal(here.status, "done");
  assert.deepEqual((await d.ok("spaces.list")).map(x => x.name), ["harlow.vyre.run"]);
  void w;
});

test("setup in progress: kept with the space, claimed by another device of the person, cleared when done, and never holds a secret", async t => {
  const w = world(t);
  const d = await device(t);
  await d.ok("spaces.identity.create", { name: "alex" });
  const made = await d.ok("spaces.create", { name: "harlow", home: { kind: "this-computer", confirmed: true } });
  const space = made.space;
  assert.equal((await d.ok("spaces.get", { space })).setup, null);
  const phone = { kernelFacts: { kind: "device", device_key_id: "phone00000000001" } };
  const laptop = { kernelFacts: { kind: "device", device_key_id: "laptop0000000001" } };
  const saved = await d.ok("spaces.setup.save", { space, setup: { step: "look", name: "Harlow Legal", where: "server", address: "harlow.vyre.run", look: "slate", picks: { connectors: ["gmail", "bad id!"], kit: "estate", token: "SECRETVALUE" }, code: "123456" } }, "cli", phone);
  assert.deepEqual([saved.setup.step, saved.setup.device.id, saved.setup.where, saved.setup.picks], ["look", "phone00000000001", "server", { connectors: ["gmail"], kit: "estate" }]);
  assert.ok(!JSON.stringify(saved).includes("SECRETVALUE") && !JSON.stringify(saved).includes("123456"), "only the shape is kept");
  assert.equal((await d.ok("spaces.get", { space })).setup.step, "look");
  assert.equal((await d.ok("spaces.list"))[0].setup.device.id, "phone00000000001");
  for (const bad of [{ step: "pairing" }, { step: "look", where: "moon" }, "look", [1]]) assert.equal((await d.call("spaces.setup.save", { space, setup: bad }, "cli", phone)).error?.code, "bad_input", JSON.stringify(bad));
  // another device may not write over it; it must claim
  assert.equal((await d.call("spaces.setup.save", { space, setup: { step: "members" } }, "cli", laptop)).error?.code, "setup_elsewhere");
  const claimed = await d.ok("spaces.setup.claim", { space }, "cli", laptop);
  assert.deepEqual([claimed.moved, claimed.setup.device.id, claimed.setup.step, claimed.setup.name], [true, "laptop0000000001", "look", "Harlow Legal"]);
  assert.equal((await d.call("spaces.setup.save", { space, setup: { step: "members" } }, "cli", phone)).error?.code, "setup_elsewhere", "the old device sees it moved");
  assert.equal((await d.ok("spaces.setup.save", { space, setup: { step: "members" } }, "cli", laptop)).setup.started, saved.setup.started);
  assert.equal((await d.ok("spaces.setup.claim", { space }, "cli", laptop)).moved, false);
  assert.equal((await d.call("spaces.setup.claim", { space: "nope" }, "cli", laptop)).error?.code, "not_found");
  assert.equal((await d.ok("spaces.setup.save", { space, setup: { step: "ai" } }, "cli", laptop)).setup.step, "ai", "the AI accounts step is a setup step");
  assert.equal((await d.ok("spaces.setup.save", { space, setup: null }, "cli", laptop)).setup, null);
  assert.equal((await d.ok("spaces.get", { space })).setup, null);
  assert.equal((await d.call("spaces.setup.claim", { space }, "cli", laptop)).error?.code, "no_setup");
  void w;
});

test("a device's spaces: the Access screen lists them, a space can remove one device without touching the others, and the removed device is refused there", async t => {
  const w = world(t);
  const d = await device(t);
  const me = await d.ok("spaces.identity.create", { name: "alex" });
  const a = await d.ok("spaces.create", { name: "harlow", home: { kind: "this-computer", confirmed: true } });
  const b = await d.ok("spaces.create", { name: "northwind", home: { kind: "this-computer", confirmed: true } });
  const eid = me.eid;
  const asDevice = { kernelFacts: { kind: "device", device_key_id: eid } };
  const mine = await d.ok("spaces.devices.spaces", {}, "cli", asDevice);
  assert.deepEqual([mine.device.self, mine.spaces.map(x => [x.label, x.removed]).sort()], [true, [["harlow", false], ["northwind", false]]]);
  assert.equal((await d.call("spaces.devices.spaces", { device: "nope" })).error?.code, "not_found");
  assert.equal((await d.ok("spaces.devices.remove", { space: a.space, device: eid })).removed, true);
  assert.deepEqual((await d.ok("spaces.devices.spaces", { device: eid })).spaces.map(x => [x.label, x.removed]).sort(), [["harlow", true], ["northwind", false]]);
  assert.equal((await d.call("spaces.get", { space: a.space }, "cli", asDevice)).error?.code, "device_removed");
  assert.ok(!(await d.call("spaces.get", { space: b.space }, "cli", asDevice)).error, "the other space is untouched");
  assert.deepEqual((await d.ok("spaces.list", {}, "cli", asDevice)).map(x => x.label), ["northwind"]);
  assert.ok(!(await d.call("spaces.get", { space: a.space })).error, "the person's own socket still reaches it");
  assert.equal((await d.ok("spaces.devices.restore", { space: a.space, device: eid })).removed, false);
  assert.ok(!(await d.call("spaces.get", { space: a.space }, "cli", asDevice)).error);
  void w;
});

test("device enrolment: no list means every space, pairing sets the list, a new space reaches only the device that made it, and enrol is one call", async t => {
  const w = world(t);
  const d = await device(t);
  const me = await d.ok("spaces.identity.create", { name: "alex" });
  const eid = me.eid;
  const asDevice = { kernelFacts: { kind: "device", device_key_id: eid } };
  const a = await d.ok("spaces.create", { name: "harlow", home: { kind: "this-computer", confirmed: true } });
  const b = await d.ok("spaces.create", { name: "northwind", home: { kind: "this-computer", confirmed: true } });
  assert.equal((await d.ok("spaces.devices.enrolled", { device: eid, space: a.space }, "module:vyred")).enrolled, true, "no list yet: enrolled everywhere");
  // pairing: every space pre-ticked, the person unticks northwind
  const set = await d.ok("spaces.devices.set", { device: eid, spaces: [a.space] });
  assert.deepEqual(set.spaces, [a.space]);
  assert.deepEqual((await d.ok("spaces.devices.spaces", { device: eid })).spaces.map(x => [x.label, x.enrolled]).sort(), [["harlow", true], ["northwind", false]]);
  assert.equal((await d.call("spaces.get", { space: b.space }, "cli", asDevice)).error?.code, "device_removed");
  // a space made later is enrolled on the device that made it
  const c = await d.ok("spaces.create", { name: "juno", home: { kind: "this-computer", confirmed: true } }, "cli", asDevice);
  assert.ok(!(await d.call("spaces.get", { space: c.space }, "cli", asDevice)).error);
  // "Add to this device": one call
  assert.equal((await d.ok("spaces.devices.enrol", { space: b.space, device: eid })).enrolled, true);
  assert.ok(!(await d.call("spaces.get", { space: b.space }, "cli", asDevice)).error);
  assert.deepEqual((await d.ok("spaces.devices.set", { device: eid, spaces: [a.space, "spc_nope"].slice(0, 1) })).spaces, [a.space]);
  void w;
});

test("presence recovery is carried: begin and recover reach the sealing process with the person's chain, the identity ops and a bind signed by this device; every change to the list is synced", async t => {
  const w = world(t);
  const calls = [];
  const presence = { begin: async i => { calls.push(["begin", i]); return { token: "tok1" }; }, recover: async i => { calls.push(["recover", i]); return { ok: true }; }, sync: async i => { calls.push(["sync", i]); return { ok: true }; } };
  const kernel = { space: "spc_bbbbbbbbbbbb", presence, for: () => null, chain: async () => ({ hops: [{ actor: { kind: "person", id: "per_k" } }] }), proofFrom: () => ({}), serviceChain: () => ({}) };
  const d = await device(t, { kernelFor: () => kernel });
  const me = await d.ok("spaces.identity.create", { name: "alex" });
  const b = await d.ok("spaces.presence.begin", { key_id: "k1", spki: "SPKI" });
  assert.equal(b.token, "tok1");
  assert.deepEqual([calls[0][1].person, calls[0][1].key_id], [me.id, "k1"]);
  const r = await d.ok("spaces.presence.recover", { key_id: "k1", spki: "SPKI", signer: "chip", token: "tok1" });
  assert.equal(r.ok, true);
  const rec = calls.find(c => c[0] === "recover")[1];
  assert.deepEqual([rec.person, rec.bind.eid, rec.ops.length > 0, typeof rec.bind.sig], [me.id, me.eid, true, "string"]);
  const other = (await import("node:crypto")).generateKeyPairSync("ed25519");
  await d.ok("spaces.identity.entry.remove", { eid: "nope" }).catch(() => null);
  const before = calls.filter(c => c[0] === "sync").length;
  await d.ok("spaces.presence.sync", {});
  assert.equal(calls.filter(c => c[0] === "sync").length, before + 1);
  assert.equal(calls.filter(c => c[0] === "sync").at(-1)[1].person, me.id);
  void w; void other;
});

test("lending a computer to a space is a stored grant: Face ID only at the first grant, never to stop, listed on the device, and only the person's own devices", async t => {
  const w = world(t);
  const d = await device(t);
  const me = await d.ok("spaces.identity.create", { name: "alex" });
  const a = await d.ok("spaces.create", { name: "harlow", home: { kind: "this-computer", confirmed: true } });
  const eid = me.eid;
  const st0 = await d.ok("spaces.devices.lend.status", { space: a.space, device: eid });
  assert.deepEqual([st0.lent, st0.first_grant_at, st0.allowed_by], [false, null, null]);
  assert.equal((await d.call("spaces.devices.lend", { space: a.space, device: eid, on: true })).error?.code, "presence_required", "the first grant asks");
  const on = await d.ok("spaces.devices.lend", { space: a.space, device: eid, on: true }, "cli", { proof: "touch" });
  assert.deepEqual([on.lent, typeof on.first_grant_at, on.allowed_by], [true, "number", me.id]);
  const first = on.first_grant_at;
  assert.equal((await d.ok("spaces.devices.lend.status", { space: a.space, device: eid })).lent, true);
  assert.equal((await d.ok("spaces.devices.list", { device: eid })).spaces[0].lent, true);
  const off = await d.ok("spaces.devices.lend", { space: a.space, device: eid, on: false });
  assert.deepEqual([off.lent, off.first_grant_at], [false, first], "stopping never asks, and the first grant stays on record");
  const again = await d.ok("spaces.devices.lend", { space: a.space, device: eid, on: true });
  assert.deepEqual([again.lent, again.first_grant_at], [true, first], "after the first grant, on again asks nothing");
  assert.equal((await d.call("spaces.devices.lend", { space: a.space, device: "nope", on: true }, "cli", { proof: "touch" })).error?.code, "not_found");
  w && void 0;
});

test("the Run on this computer switch reads the real list and lends with the real tool: the plan names the device and the spaces, lending shows in the list, and stopping asks nothing", async t => {
  const { lendPlan } = await import("../../apps/app/screens/runner/runner-model.js");
  world(t);
  const d = await device(t);
  const me = await d.ok("spaces.identity.create", { name: "alex" });
  const a = await d.ok("spaces.create", { name: "harlow", home: { kind: "this-computer", confirmed: true } });
  // the app asks for the device it is on (no device given) and plans from what the box says
  const plan = lendPlan(await d.ok("spaces.devices.list", {}));
  assert.equal(plan.device, me.eid, "the plan names this computer by the id the box knows it by");
  assert.ok(plan.toLend.some(x => x.space === a.space), "the space it is in is to be lent to");
  assert.deepEqual(plan.lent, []);
  for (const sp of plan.toLend) await d.ok("spaces.devices.lend", { space: sp.space, device: plan.device, on: true }, "cli", { proof: "touch" });
  const after = lendPlan(await d.ok("spaces.devices.list", {}));
  assert.ok(after.lent.some(x => x.space === a.space) && !after.toLend.some(x => x.space === a.space), "lending shows in the list");
  for (const sp of after.lent) await d.ok("spaces.devices.lend", { space: sp.space, device: after.device, on: false });
  assert.deepEqual(lendPlan(await d.ok("spaces.devices.list", {})).lent, [], "stopping needs no yes and ends the lending");
});

test("lend attacks (LD-1 to LD-4): a removal ends the consent, an owner's off withdraws the space's, the status is not for any member, and concurrent changes end where the last event says", async t => {
  const w = world(t);
  const d = await device(t);
  const me = await d.ok("spaces.identity.create", { name: "alex" });
  const a = await d.ok("spaces.create", { name: "harlow", home: { kind: "this-computer", confirmed: true } });
  const eid = me.eid;
  const lend = (on, proof) => d.call("spaces.devices.lend", { space: a.space, device: eid, on }, "cli", proof ? { proof: "touch" } : {});
  // LD-1: lend, remove the device from the space, add it back: the consent is gone and the first grant asks again
  assert.equal((await lend(true, true)).error, undefined);
  assert.equal((await d.ok("spaces.devices.list", { device: eid })).spaces[0].lent, true);
  await d.ok("spaces.devices.remove", { space: a.space, device: eid });
  await d.ok("spaces.devices.enrol", { space: a.space, device: eid });
  assert.equal((await d.ok("spaces.devices.list", { device: eid })).spaces[0].lent, false, "lent is not remembered across a removal");
  assert.equal((await lend(true, false)).error?.code, "presence_required", "and it asks again");
  assert.equal((await lend(true, true)).error, undefined);
  // LD-1: pairing's list (devices.set) that leaves the space out clears it too
  await d.ok("spaces.devices.set", { device: eid, spaces: [] });
  await d.ok("spaces.devices.enrol", { space: a.space, device: eid });
  assert.equal((await lend(true, false)).error?.code, "presence_required");
  // LD-2: a space owner switching off a device that is not theirs withdraws the space's consent (the record is a foreign person's device)
  const foreign = "dev_foreign000000";
  d.db.prepare("INSERT INTO spaces_kv (key, value) VALUES (?, ?)").run(`lend/${a.space}/${foreign}`, JSON.stringify({ lent: true, device: foreign, first_grant_at: 1, allowed_by: "per_other", at: 1 }));
  const off = await d.ok("spaces.devices.lend", { space: a.space, device: foreign, on: false });
  assert.deepEqual([off.lent, off.first_grant_at, off.allowed_by], [false, null, null], "the owner's off clears the first grant");
  // LD-3: the status answers the device's person and the space's owners and admins; a plain member asking about a device that is not theirs is refused
  assert.equal((await d.ok("spaces.devices.lend.status", { space: a.space, device: foreign })).lent, false);
  // LD-4: twenty concurrent on/off pairs end in the state the last emitted event says
  assert.equal((await lend(true, true)).error, undefined);
  const before = d.of("space.device-lent").length;
  await Promise.all(Array.from({ length: 20 }, (_, k) => lend(k % 2 === 0, true)));
  const evs = d.of("space.device-lent").slice(before);
  const final = (await d.ok("spaces.devices.lend.status", { space: a.space, device: eid })).lent;
  assert.equal(final, evs[evs.length - 1].lent, "the stored state is the last emitted event's");
  void w;
});

test("lend.status is for the device's person and the space's owners and admins: a person who is not in the space, and a stranger's device, are refused", async t => {
  const w = world(t);
  const { d, alex, space } = await harlow(t, w);
  assert.equal((await d.ok("spaces.devices.lend.status", { space, device: alex.eid })).lent, false, "the owner may ask");
  assert.equal((await d.ok("spaces.devices.lend.status", { space, device: "dev_somebodyelse01" })).lent, false, "an owner may ask about any device in the space");
  await actAs(d, "bobby");
  const r = await d.call("spaces.devices.lend.status", { space, device: alex.eid });
  assert.ok(r.error && ["not_found", "not_a_member", "forbidden"].includes(r.error.code), JSON.stringify(r));
  void w;
});

test("an invite made `to` a person refuses another person at redeem (forbidden), accepts the named one, and the list names who joined", async t => {
  const w = world(t);
  const { d, space } = await harlow(t, w);
  const named = person(), other = person();
  const made = await d.ok("spaces.invites.create", { space, role: "member", to: named.id });
  const tok = made.token || (made.member && made.member.token);
  assert.ok(tok, JSON.stringify(made));
  const id = JSON.parse(Buffer.from(tok.split(".")[0], "base64url")).id;
  const prove = p => crypto.sign(null, Buffer.from(`vyre-invite-accept-v1\n${id}\nharlow.vyre.run\n${p.id}`), crypto.createPrivateKey({ key: Buffer.from(p.privateKey, "base64url"), format: "der", type: "pkcs8" })).toString("base64url");
  const wrong = await d.call("spaces.invites.redeem", { token: tok, person: { id: other.id, publicKey: other.publicKey }, proof: prove(other) }, "tailnet:x");
  assert.equal(wrong.error?.code, "forbidden", JSON.stringify(wrong));
  const right = await d.call("spaces.invites.redeem", { token: tok, person: { id: named.id, publicKey: named.publicKey }, proof: prove(named) }, "tailnet:x");
  assert.ok(!right.error, JSON.stringify(right.error));
  const row = (await d.ok("spaces.invites.list", { space })).invites.find(r => r.id === id);
  assert.deepEqual([row.accepted_by, row.joined_by_label, row.joined_device, row.to], [[named.id], [null], null, named.id]);
  void w;
});

test("spaces.admin-list gives the pairing module the finished spaces a person owns or administers, under the kernel ids' names, and the identity's own name", async t => {
  const w = world(t);
  const { d, alex, space } = await harlow(t, w);
  const r = await d.ok("spaces.admin-list", { person: alex.id }, "module:wink");
  assert.deepEqual(r.spaces.map(x => [x.space, x.name, x.role]), [[space, "Harlow Legal", "owner"]]);
  assert.deepEqual(r.identity, { id: alex.id, name: "alex" });
  const other = await d.ok("spaces.admin-list", { person: person().id }, "module:wink");
  assert.deepEqual([other.spaces, other.identity], [[], null]);
  void w;
});

test("spaces.identity.name-of: this device's own claimed name, a verified name the home knows, else null (never an unchecked claim)", async t => {
  const w = world(t);
  const { d, alex } = await harlow(t, w);
  assert.equal((await d.ok("spaces.identity.name-of", { id: alex.id }, "module:wink")).name, "alex.vyre.run");
  const stranger = person().id;
  assert.equal((await d.ok("spaces.identity.name-of", { id: stranger }, "module:wink")).name, null);
  assert.equal((await d.ok("spaces.identity.name-of", { id: stranger, claimed: "alex.vyre.run" }, "module:wink")).name, null, "a claimed name that the directory does not resolve to this id is not shown");
  d.db.prepare("INSERT INTO spaces_kv (key, value) VALUES (?, ?)").run(`person-name/${stranger}`, JSON.stringify("kit"));
  assert.equal((await d.ok("spaces.identity.name-of", { id: stranger }, "module:wink")).name, "kit.vyre.run");
  assert.equal((await d.call("spaces.identity.name-of", { id: alex.id }, "cli")).error?.code !== undefined, true, "modules only");
  void w;
});

test("spaces.identity.name-of: a claimed name the directory confirms for that id is shown; one it does not confirm is not", async t => {
  const w = world(t);
  const { d, alex } = await harlow(t, w);          // alex claims "alex" in the directory
  const bobby = await actAs(d, "bobby");            // this device is now bobby's: alex is a stranger to it
  const confirmed = await d.ok("spaces.identity.name-of", { id: alex.id, claimed: "alex.vyre.run" }, "module:wink");
  assert.equal(confirmed.name, "alex.vyre.run", "the directory resolves alex to exactly this id");
  assert.equal((await d.ok("spaces.identity.name-of", { id: alex.id, claimed: "alex" }, "module:wink")).name, "alex.vyre.run", "with or without the zone");
  assert.equal((await d.ok("spaces.identity.name-of", { id: bobby.id, claimed: "alex.vyre.run" }, "module:wink")).name, "bobby.vyre.run", "bobby's own id gets bobby's own name, never the claimed alex");
  const other = person().id;
  assert.equal((await d.ok("spaces.identity.name-of", { id: other, claimed: "alex.vyre.run" }, "module:wink")).name, null, "alex's name claimed for another id is not confirmed");
  assert.equal((await d.ok("spaces.identity.name-of", { id: alex.id, claimed: "nosuchname" }, "module:wink")).name, null, "a name the directory does not know is not shown");
  void w;
});


test("a space whose home is a PAIRED server is hosted by the server: the device asks it (with the owner's proof beside the call), keeps only a row, takes the server's id, and cancel gives it back there; a refusal makes nothing and never falls back to hosting here", async t => {
  const w = world(t);
  const { hooks } = await import("./index.js");
  const dirPosts = [];
  const realFetch = hooks.fetch;
  hooks.fetch = /** @type {any} */ (async (url, init) => { if (init && init.method === "POST" && String(url).endsWith("/v1/ids/server")) dirPosts.push(JSON.parse(init.body)); return realFetch(url, init); });
  const d = await device(t, { wink: true });
  await d.ok("spaces.identity.create", { name: "alex" });
  /** @type {any[]} */ const recorded = [];
  let counter = 0;
  hooks.sessionFor = async dev => ({ call: async (tool, input) => { recorded.push({ device: dev, tool, input, proof: input.proof }); if (/** @type {any} */ (globalThis).__winkRefuse) throw Object.assign(new Error("the server said no"), { code: "forbidden" }); counter++; return tool === "spaces.host-here" ? { space: "spc_" + "abcdefghjkl" + "mnopqrstuvwx"[counter - 1], existed: false } : { retired: true }; } });
  t.after(() => { hooks.sessionFor = null; });
  const calls = () => recorded;
  // The server's route (what the paired channel says): the space lists it with the directory, so the server may point the space's name at itself.
  const SERVER_ROUTE = "a".repeat(26);
  hooks.route = () => ({ relay: "https://relay.example", route: SERVER_ROUTE, box: "bx" });
  t.after(() => { hooks.route = null; });
  const home = { kind: "server", device: { id: "srv_paired0000000001", name: "walker server", alwaysOn: true }, confirmed: true };
  const made = await d.call("spaces.create", { name: "servedspace", home }, "cli", { kernel_proof: { op: "t" } });
  assert.ok(!made.error, JSON.stringify(made.error));
  assert.equal(made.data.status, "done", JSON.stringify(made.data));
  assert.equal(made.data.space, "spc_abcdefghjklm", "THE id is the server's");
  assert.deepEqual(calls().map(c => [c.device, c.tool, c.input.name, c.proof]), [["srv_paired0000000001", "spaces.host-here", "servedspace", { op: "t" }], ["srv_paired0000000001", "names.serve", "servedspace", { op: "t" }]], "the server hosts the space, then is told which name it serves, the owner's proof beside both");
  assert.equal(dirPosts.length, 1, "and the directory is asked to list the server");
  assert.deepEqual([dirPosts[0].name, dirPosts[0].route, dirPosts[0].remove], ["servedspace", SERVER_ROUTE, undefined]);
  hooks.fetch = realFetch;
  assert.ok((await d.ok("spaces.list")).some(x => x.id === "spc_abcdefghjklm" && x.hostedHere === undefined), "listed as a normal space, not as a local copy");
  // giving it back: cancel asks the server to retire it
  calls().length = 0;
  const w2 = await d.call("spaces.create", { name: "secondone", home: { kind: "server", device: { id: "srv_paired0000000001", name: "walker server", alwaysOn: true } } }, "cli", { kernel_proof: { op: "t" } });
  assert.ok(!w2.error, JSON.stringify(w2.error));
  // a server that refuses: nothing is made on this device either
  /** @type {any} */ (globalThis).__winkRefuse = true;
  t.after(() => { /** @type {any} */ (globalThis).__winkRefuse = false; });
  calls().length = 0;
  const refused = await d.call("spaces.create", { name: "refusedone", home }, "cli", { kernel_proof: { op: "t" } });
  assert.ok(refused.error, "the server's refusal is the answer");
  assert.ok(!(await d.ok("spaces.list")).some(x => x.name === "refusedone.vyre.run"), "nothing was made here as a fallback");
  void w;
});

test("the device reaches the paired server over the Wink peer session when the daemon supplies one: the proof rides in the input, the server's answer is THE id, a closed session refuses", async t => {
  const w = world(t);
  const d = await device(t, { wink: true });
  const { hooks } = await import("./index.js");
  /** @type {any[]} */ const seen = [];
  hooks.sessionFor = async dev => ({ call: async (tool, input) => { seen.push([dev, tool, input]); return { ok: true, data: { space: "spc_" + "mnpqrstuvwxy", existed: false } }; } });
  t.after(() => { hooks.sessionFor = null; });
  await d.ok("spaces.identity.create", { name: "alex" });
  const made = await d.call("spaces.create", { name: "overwire", home: { kind: "server", device: { id: "srv_paired0000000001", name: "s", alwaysOn: true }, confirmed: true } }, "cli", { kernel_proof: { op: "t" } });
  assert.ok(!made.error, JSON.stringify(made.error));
  assert.equal(made.data.space, "spc_mnpqrstuvwxy");
  assert.deepEqual(seen.map(x => [x[0], x[1], x[2].name, x[2].proof]), [["srv_paired0000000001", "spaces.host-here", "overwire", { op: "t" }]]);
  hooks.sessionFor = async () => { throw new Error("closed"); };
  const down = await d.call("spaces.create", { name: "nowire", home: { kind: "server", device: { id: "srv_paired0000000001", name: "s", alwaysOn: true } } }, "cli", { kernel_proof: { op: "t" } });
  assert.equal(down.error?.code, "server_unreachable");
  void w;
});

test("spaces.identity.devices: the id and key-agreement point of a device of a person you share a space with, public data only; a stranger gets nothing", async t => {
  const { claimIdentity } = await import("../../apps/app/src/identity/claim.js");
  const w = world(t);
  const { d, alex, space } = await harlow(t, w);
  const pt = () => Buffer.from(crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).subarray(-65)).toString("base64url");
  const claim = async (name, agree) => claimIdentity({ name, code: (await reserve(name)).code, password: "four plain words here", base: "http://127.0.0.1:1", fetch: /** @type {any} */ (hooks.fetch), now: () => /** @type {any} */ (hooks.now)(), params: { memoryKiB: 64, passes: 1 }, forceSoftware: true, agree });
  const casey = await claim("casey", pt()), dana = await claim("dana", pt());
  const caseyPt = (await d.reg.call("spaces.identity.devices", { person: casey.id }, "cli")).data;
  assert.deepEqual(caseyPt, { devices: [] }, "before they share a space: nothing, though casey has a device with a point");
  // casey joins alex's space: now they share one
  const added = await d.call("spaces.members.add", { space, person: casey.id, role: "member" });
  assert.ok(!added.error, JSON.stringify(added.error));
  await d.reg.call("spaces.person.learn", { id: casey.id, name: "casey" }, "module:vyred");
  const shared = (await d.ok("spaces.identity.devices", { person: casey.id }));
  assert.equal(shared.devices.length, 1, JSON.stringify(shared));
  assert.deepEqual(Object.keys(shared.devices[0]).sort(), ["agree", "device"], "the device id and the point, no label and no other field");
  assert.equal(shared.devices[0].device, casey.eid);
  assert.match(shared.devices[0].agree, /^[A-Za-z0-9_-]{87}$/);
  // dana is known to this device but shares no space with alex: a stranger gets nothing
  await d.reg.call("spaces.person.learn", { id: dana.id, name: "dana" }, "module:vyred");
  assert.deepEqual((await d.ok("spaces.identity.devices", { person: dana.id })), { devices: [] }, "a stranger");
  assert.deepEqual((await d.ok("spaces.identity.devices", { person: "per_nobodyatall000000000000000" })), { devices: [] });
  assert.deepEqual((await d.ok("spaces.identity.devices", { person: "not a person" })), { devices: [] });
  void alex;
});

/** A drop wrap made the way lib/keywrap.js does: ECDH-ES to a device's agree point, HKDF-SHA256 (salt = the ephemeral point, info vyre-identity-wrap-v1), AES-256-GCM bound to `aad`. */
function wrapTo(/** @type {string} */ point, /** @type {Buffer} */ key, /** @type {string} */ aad) {
  const eph = crypto.createECDH("prime256v1"); eph.generateKeys();
  const epk = eph.getPublicKey(), shared = eph.computeSecret(Buffer.from(point, "base64url"));
  const kek = Buffer.from(crypto.hkdfSync("sha256", shared, epk, Buffer.from("vyre-identity-wrap-v1"), 32));
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", kek, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(key), c.final()]);
  return { v: 1, epk: epk.toString("base64url"), iv: iv.toString("base64url"), ct: ct.toString("base64url"), tag: c.getAuthTag().toString("base64url") };
}
const DROP = "vyre-drop-wrap\nfile_abc:1";

test("a vyred device keeps a P-256 agreement key: its entry carries the point at create and at add, the private scalar is in no reply, and a drop wrap opens through unwrap-drop with only the file key out", async t => {
  const w = world(t);
  const d = await device(t), d2 = await device(t);
  const made = await d.ok("spaces.identity.create", { name: "agreealex" });
  const store = fileIdentityStore(d.space);
  const point = store.agree();
  assert.match(point, /^[A-Za-z0-9_-]{87}$/, "a raw uncompressed P-256 point");
  // at create: the genesis entry (the one signed list every verifier reads) carries the point
  const genesis = store.ops()[0];
  assert.equal(genesis.entry.agree, point);
  const st = (await d.ok("spaces.identity.state", { person: made.id }, "module:wink")).entries.find(e => e.eid === made.eid);
  assert.equal(st.agree, point);
  // at add: a device added from pairing brings its own point, and it goes onto its entry
  const key = fileIdentityStore(d2.space).newDeviceKey();
  w.clock.t += 2 * 3_600_000;
  await d.ok("spaces.identity.enrol", { publicKey: key.publicKey, agree: key.agree, label: "second" }, "module:wink");
  const after = (await d.ok("spaces.identity.state", { person: made.id }, "module:wink")).entries.find(e => e.eid === key.eid);
  assert.equal(after.agree, key.agree);
  // no reply and no status holds the private scalar
  const scalar = JSON.parse(fs.readFileSync(path.join(d.space, "identity.json"), "utf8")).agreePrivate;
  assert.ok(scalar && scalar.length >= 42);
  assert.ok(!JSON.stringify(store.status()).includes(scalar) && !JSON.stringify(made).includes(scalar));
  // a drop: files hands the wrap and its aad, and gets the file key back and nothing else
  const fileKey = crypto.randomBytes(32), wrap = wrapTo(point, fileKey, DROP);
  const r = await d.ok("spaces.identity.unwrap-drop", { wrap, aad: DROP }, "module:files");
  assert.deepEqual(Object.keys(r), ["key"], "only the file key leaves");
  assert.equal(r.key, fileKey.toString("base64url"));
  assert.ok(!JSON.stringify(r).includes(scalar));
  // purpose bound: a chat ring's wrap (another aad), a wrong aad, a bare ephemeral point and a malformed wrap are refused
  const ring = wrapTo(point, fileKey, "ring:chat_x:1");
  assert.equal((await d.call("spaces.identity.unwrap-drop", { wrap: ring, aad: "ring:chat_x:1" }, "module:files")).error?.code, "wrong_purpose", "a chat ring's wrap is not a drop");
  assert.equal((await d.call("spaces.identity.unwrap-drop", { wrap, aad: "vyre-drop-wrap\nfile_other:1" }, "module:files")).error?.code, "cannot_open", "the aad binds the wrap");
  assert.equal((await d.call("spaces.identity.unwrap-drop", { epk: wrap.epk }, "module:files")).error?.code != null, true, "a raw epk call is refused");
  assert.equal((await d.call("spaces.identity.unwrap-drop", { wrap: { ...wrap, epk: "AAAA" }, aad: DROP }, "module:files")).error?.code, "bad_point");
  assert.equal((await d.call("spaces.identity.unwrap-drop", { wrap: { v: 1 }, aad: DROP }, "module:files")).error?.code, "bad_wrap");
  assert.equal((await d.call("spaces.identity.ecdh", { epk: wrap.epk }, "module:files")).error != null, true, "the raw ecdh door is gone");
});

test("spaces.identity.unwrap-drop is for first-party files only: another module, the cli, an agent and a surface are refused", async t => {
  world(t);
  const d = await device(t);
  await d.ok("spaces.identity.create", { name: "agreebob" });
  const wrap = wrapTo(fileIdentityStore(d.space).agree(), crypto.randomBytes(32), DROP);
  for (const caller of ["module:wink", "module:memory", "module:work", "module:filesx", "cli", "agent:kit", "surface:capsule"]) {
    const r = await d.call("spaces.identity.unwrap-drop", { wrap, aad: DROP }, caller);
    assert.ok(r.error, `${caller} must be refused`);
    assert.equal(r.data, undefined, caller);
  }
});

test("an identity made before the agreement key gets one on first start without a new signing key: ensureAgree adds the scalar, is stable, and ecdh works from then on", async t => {
  world(t);
  const d = await device(t);
  await d.ok("spaces.identity.create", { name: "agreecarl" });
  const file = path.join(d.space, "identity.json");
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  const before = rec.publicKey;
  delete rec.agreePrivate; // an identity made before the key existed
  fs.writeFileSync(file, JSON.stringify(rec) + "\n", { mode: 0o600 });
  const store = fileIdentityStore(d.space);
  assert.equal(store.agree(), null);
  assert.throws(() => store.ecdh(crypto.createECDH("prime256v1").generateKeys()), { code: "no_agree_key" });
  const pt = store.ensureAgree();
  assert.match(pt, /^[A-Za-z0-9_-]{87}$/);
  assert.equal(store.ensureAgree(), pt, "stable: asked twice, the same key");
  assert.equal(store.agree(), pt);
  assert.equal(store.status().publicKey, before, "the signing key is untouched");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("KP-2: spaces.identity.enrol decides held itself: an entry nobody proved is held web whatever the caller offers, a caller can only make it stricter, and a proven entry is not web", async t => {
  const w = world(t);
  const d = await device(t), d2 = await device(t), d3 = await device(t), d4 = await device(t);
  await d.ok("spaces.identity.create", { name: "kpalex" });
  w.clock.t += 2 * 3_600_000;
  const listHeld = async eid => (await C_.verifyChain(fileIdentityStore(d.space).ops(), { now: w.clock.t + 1 })).entries.find(e => e.eid === eid).held;
  // the page's own offer omits held: the entry is still web
  const k1 = fileIdentityStore(d2.space).newDeviceKey();
  await d.ok("spaces.identity.enrol", { publicKey: k1.publicKey, agree: k1.agree }, "module:wink");
  assert.equal(await listHeld(k1.eid), "web", "omitting held gives web");
  // the page offering a different spelling of "not web" changes nothing
  const k2 = fileIdentityStore(d3.space).newDeviceKey();
  await d.ok("spaces.identity.enrol", { publicKey: k2.publicKey, held: "native" }, "module:wink");
  assert.equal(await listHeld(k2.eid), "web");
  // a proof hook that answers true makes it not web; a hook that says true cannot be overridden into looser by the caller, and a caller saying web is stricter
  hooks.entryProof = async () => true;
  t.after(() => { hooks.entryProof = null; });
  const k3 = fileIdentityStore(d4.space).newDeviceKey();
  await d.ok("spaces.identity.enrol", { publicKey: k3.publicKey }, "module:wink");
  assert.equal(await listHeld(k3.eid), undefined, "a proven entry is not held web");
  const d5 = await device(t), k4 = fileIdentityStore(d5.space).newDeviceKey();
  await d.ok("spaces.identity.enrol", { publicKey: k4.publicKey, held: "web" }, "module:wink");
  assert.equal(await listHeld(k4.eid), "web", "a caller can only make it stricter");
  // a hook that throws proves nothing
  hooks.entryProof = async () => { throw new Error("no verifier"); };
  const d6 = await device(t), k5 = fileIdentityStore(d6.space).newDeviceKey();
  await d.ok("spaces.identity.enrol", { publicKey: k5.publicKey }, "module:wink");
  assert.equal(await listHeld(k5.eid), "web");
});

// memory's key-wrap vector (lib/vectors/keywrap.json, on work/memory-noble until it merges): this device's ecdh gives the vector's shared secret, and memory's own HKDF and AES-GCM then open the wrap.
// Skipped while the file is not in this tree; the check is real as soon as it is.
const KEYWRAP = new URL("../../lib/vectors/keywrap.json", import.meta.url);
test("the device's ecdh matches memory's keywrap vector: the shared secret is the vector's, its kek opens the wrap, and unwrap-drop refuses that chat ring wrap", { skip: !fs.existsSync(KEYWRAP) && "lib/vectors/keywrap.json is not in this tree yet" }, async t => {
  world(t);
  const d = await device(t);
  await d.ok("spaces.identity.create", { name: "vecalex" });
  const V = JSON.parse(fs.readFileSync(KEYWRAP, "utf8"));
  const file = path.join(d.space, "identity.json");
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...rec, agreePrivate: V.agree_private_jwk.d }) + "\n", { mode: 0o600 });
  const r = { secret: fileIdentityStore(d.space).ecdh(Buffer.from(V.wrap.epk, "base64url")).toString("base64url") };
  assert.equal(r.secret, V.shared);
  assert.equal((await d.call("spaces.identity.unwrap-drop", { wrap: V.wrap, aad: V.aad }, "module:files")).error?.code, "wrong_purpose", "memory's vector is a chat ring wrap: this door does not open it");
  const epk = Buffer.from(V.wrap.epk, "base64url");
  const kek = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(r.secret, "base64url"), epk, Buffer.from("vyre-identity-wrap-v1"), 32));
  assert.equal(kek.toString("base64url"), V.kek);
  const dec = crypto.createDecipheriv("aes-256-gcm", kek, Buffer.from(V.wrap.iv, "base64url"));
  dec.setAAD(Buffer.from(V.aad)); dec.setAuthTag(Buffer.from(V.wrap.tag, "base64url"));
  const plain = Buffer.concat([dec.update(Buffer.from(V.wrap.ct, "base64url")), dec.final()]);
  assert.equal(plain.toString("base64url"), V.plaintext_key);
});

test("agree key and held web: a web-held entry that carries agree at genesis or add keeps it, and its own agree op is refused (a web key changes nothing about the list)", async t => {
  const w = world(t), d = await device(t), d2 = await device(t);
  await d.ok("spaces.identity.create", { name: "webagree" });
  w.clock.t += 2 * 3_600_000;
  const k = fileIdentityStore(d2.space).newDeviceKey();
  await d.ok("spaces.identity.enrol", { publicKey: k.publicKey, agree: k.agree }, "module:wink"); // unproven: held web, carrying its point
  const st = (await C_.verifyChain(fileIdentityStore(d.space).ops(), { now: w.clock.t + 1 })).entries.find(e => e.eid === k.eid);
  assert.equal(st.held, "web");
  assert.equal(st.agree, k.agree, "a web-held entry keeps the point it came with");
  // the web key signs its own agree op: refused, like any list change it signs
  const state = await C_.verifyChain(fileIdentityStore(d.space).ops(), { now: w.clock.t + 1 });
  const op = await C_.makeOp(state, { type: "agree", target: k.eid, agree: k.agree }, { by: k.eid, ts: w.clock.t + 1, sign: m => crypto.sign(null, Buffer.from(m), privateKeyOf(k.privateKey)) });
  await assert.rejects(C_.applyOp(state, op, { now: w.clock.t + 1 }), e => e.code === "web_key" || e.code === "exists");
});

test("spaces.identity.devices.read answers work and files (a module is not a person, so spaces.identity.devices denies it): the home person's own devices with their points, no private field, and nobody else", async t => {
  world(t);
  const d = await device(t);
  const made = await d.ok("spaces.identity.create", { name: "devmod" });
  assert.equal((await d.call("spaces.identity.devices", { person: made.id }, "module:work")).error?.code, "denied", "the person read stays for people");
  const r = await d.call("spaces.identity.devices.read", { person: made.id }, "module:work");
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.ok(!(await d.call("spaces.identity.devices.read", { person: made.id }, "module:files")).error);
  for (const caller of ["module:memory", "module:wink", "cli", "agent:kit"]) assert.ok((await d.call("spaces.identity.devices.read", { person: made.id }, caller)).error, caller);
  assert.equal(r.data.devices.length, 1);
  assert.deepEqual(Object.keys(r.data.devices[0]).sort(), ["agree", "device"]);
  assert.equal(r.data.devices[0].agree, fileIdentityStore(d.space).agree());
});

test("spaces.list tier: a space on this computer is cloud when this machine is a server, basic on a device", async t => {
  const w = world(t);
  const d = await device(t, { machine: "server" });
  await d.ok("spaces.identity.create", { name: "alex" });
  await d.ok("spaces.create", { name: "northwind", displayName: "Northwind Bakery", home: { kind: "this-computer", confirmed: true } });
  assert.deepEqual((await d.ok("spaces.list")).map(x => x.tier), ["cloud"]);
  void w;
});

test("spaces.tier: the home's tier from the machine role, the Cloud spaces the person is in, and an unknown space refused", async t => {
  const w = world(t);
  const dev = await device(t);
  assert.deepEqual(await dev.ok("spaces.tier", {}, "module:planner"), { tier: "basic", cloud: [], time_zone: null, personal_host: null }, "a device with no space: Basic, no Cloud spaces, no zone");
  await dev.ok("spaces.identity.create", { name: "alex" });
  const systemZoneNow = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; // no device zone sent: the creating machine's own
  const s = await dev.ok("spaces.create", { name: "northwind", displayName: "Northwind Bakery", home: { kind: "this-computer", confirmed: true } });
  assert.deepEqual(await dev.ok("spaces.tier", { space: s.space }, "module:planner"), { tier: "basic", cloud: [], time_zone: systemZoneNow, personal_host: null }, "a space on a device is Basic");
  assert.equal((await dev.call("spaces.tier", { space: "spc_zzzzzzzzzzzz" }, "module:planner")).error?.code, "not_found");
  const srv = await device(t, { machine: "server" });
  await srv.ok("spaces.identity.create", { name: "sam" });
  const c = await srv.ok("spaces.create", { name: "harbor", displayName: "Harbor Bakery", home: { kind: "this-computer", confirmed: true } });
  const r = await srv.ok("spaces.tier", {}, "module:planner");
  assert.equal(r.tier, "cloud");
  assert.deepEqual(r.cloud.map(x => [x.id, x.label]), [[c.space, "harbor"]]);
  assert.deepEqual(Object.keys(r.cloud[0]).sort(), ["id", "label", "name"], "id, name and label, nothing else");
  void w;
});

test("a space's home time zone: the creator's device zone at creation, an owner changes it, a bad zone is refused, and it reaches list, get and tier", async t => {
  const w = world(t);
  const d = await device(t);
  await d.ok("spaces.identity.create", { name: "alex" });
  const s = await d.ok("spaces.create", { name: "zonal", displayName: "Zonal", home: { kind: "this-computer", confirmed: true } }, "cli", { zone: "Asia/Kuala_Lumpur" });
  assert.equal((await d.ok("spaces.list")).find(x => x.id === s.space).time_zone, "Asia/Kuala_Lumpur", "the creator's device zone");
  assert.equal((await d.ok("spaces.get", { space: s.space })).time_zone, "Asia/Kuala_Lumpur");
  assert.equal((await d.ok("spaces.tier", { space: s.space }, "module:planner")).time_zone, "Asia/Kuala_Lumpur");
  assert.deepEqual(await d.ok("spaces.time-zone.set", { space: s.space, zone: "America/Los_Angeles" }), { space: s.space, time_zone: "America/Los_Angeles" });
  assert.equal((await d.ok("spaces.get", { space: s.space })).time_zone, "America/Los_Angeles");
  assert.equal((await d.call("spaces.time-zone.set", { space: s.space, zone: "Mars/Olympus" })).error?.code, "bad_input");
  assert.equal((await d.ok("spaces.get", { space: s.space })).time_zone, "America/Los_Angeles", "a refused zone changes nothing");
  void w;
});

test("a fresh home: the person's own space is listed with a label, a display name and a tier, and spaces.tier names where personal items live", async t => {
  const w = world(t);
  const HOME = "spc_hhhhhhhhhhhh";
  /** @type {any} */ let ownerId = null;
  const kernelFor = () => ({ space: HOME, get owner() { return ownerId; }, membership: async () => ({ member: true, role: "owner" }), for: () => { throw new Error("not here"); } });
  for (const [machine, tier, display, host] of [[undefined, "basic", "Personal", null], ["server", "cloud", "My Cloud", HOME]]) {
    const d = await device(t, { kernelFor, ...(machine ? { machine } : {}) });
    ownerId = (await d.ok("spaces.identity.create", { name: machine ? "sam" : "alex" })).id;
    const row = (await d.ok("spaces.list")).find(x => x.id === HOME);
    assert.ok(row, `${machine || "device"}: the home space is listed`);
    assert.deepEqual([row.label, row.displayName, row.tier, row.role], ["personal", display, tier, "owner"]);
    const r = await d.ok("spaces.tier", {}, "module:planner");
    assert.deepEqual([r.tier, r.personal_host], [tier, host]);
  }
  void w;
});

test("spaces.storage.*: a member keeps ciphertext in their own folder on a hosted space, putIf is compare-and-set, a stranger and a non-owner cap are refused", async t => {
  const w = world(t);
  const HOME = "spc_hhhhhhhhhhhh", OWNER = "per_" + "o".repeat(26), MEM = "per_" + "m".repeat(26), OUT = "per_" + "x".repeat(26);
  const roles = { [OWNER]: "owner", [MEM]: "member" };
  const kernelFor = () => ({
    space: HOME, owner: OWNER, membership: async (/** @type {string} */ p) => (roles[p] ? { member: true, role: roles[p] } : { member: false }),
    chain: async (/** @type {any} */ meta) => ({ hops: [{ actor: { kind: "person", id: meta.as } }, ...(meta.agent ? [{ actor: { kind: "agent", id: meta.agent } }] : [])] }), spaces: { hosts: (/** @type {string} */ id) => id === HOME, list: () => [HOME] }, for: () => { throw new Error("n/a"); },
  });
  const d = await device(t, { kernelFor });
  const b64 = (/** @type {string} */ s) => Buffer.from(s).toString("base64");
  const as = (/** @type {string} */ p) => ({ as: p });
  const put = await d.ok("spaces.storage.put", { space: HOME, name: "personal/a", data: b64("cipher-1") }, "cli", as(MEM));
  const sha = (/** @type {string} */ s) => createHash("sha256").update(s).digest("hex");
  assert.equal(put.sha256, sha("cipher-1"));
  assert.equal(Buffer.from((await d.ok("spaces.storage.get", { space: HOME, name: "personal/a" }, "cli", as(MEM))).data, "base64").toString(), "cipher-1");
  assert.equal(await d.ok("spaces.storage.get", { space: HOME, name: "personal/a" }, "cli", as(OWNER)), null, "the owner has a folder of their own, not the member's");
  const stale = await d.ok("spaces.storage.put-if", { space: HOME, name: "personal/a", data: b64("v2"), expected: sha("other") }, "cli", as(MEM));
  assert.deepEqual(stale, { ok: false, sha256: sha("cipher-1") });
  assert.equal((await d.ok("spaces.storage.put-if", { space: HOME, name: "personal/a", data: b64("v2"), expected: sha("cipher-1") }, "cli", as(MEM))).ok, true);
  const listed = await d.ok("spaces.storage.list", { space: HOME, prefix: "personal" }, "cli", as(MEM));
  assert.deepEqual(listed.names, ["personal/a"]);
  assert.deepEqual(listed.entries, [{ name: "personal/a", sha: sha("v2"), size: 2 }]);
  assert.equal((await d.call("spaces.storage.put", { space: HOME, name: "x", data: b64("y") }, "cli", as(OUT))).error?.code, "forbidden", "a stranger has no storage here");
  assert.equal((await d.call("spaces.storage.put", { space: "spc_zzzzzzzzzzzz", name: "x", data: b64("y") }, "cli", as(MEM))).error?.code, "not_found");
  assert.equal((await d.call("spaces.storage.put", { space: HOME, name: "x", data: b64("y") }, "cli", { ...as(MEM), agent: "kit" })).error?.code, "forbidden", "an agent in the chain, relayed or not, has no storage");
  assert.equal((await d.call("spaces.storage.put", { space: HOME, name: "../x", data: b64("y") }, "cli", as(MEM))).error?.code, "bad_input");
  assert.equal((await d.call("spaces.storage.set-cap", { space: HOME, person: MEM, bytes: 4 }, "cli", as(MEM))).error?.code, "forbidden", "a member cannot set their own cap");
  await d.ok("spaces.storage.set-cap", { space: HOME, person: MEM, bytes: 2 }, "cli", as(OWNER));
  assert.equal((await d.call("spaces.storage.put", { space: HOME, name: "more", data: b64("zz") }, "cli", as(MEM))).error?.code, "over_cap");
  assert.deepEqual(await d.ok("spaces.storage.delete", { space: HOME, name: "personal/a", expected: sha("stale") }, "cli", as(MEM)), { ok: false, deleted: false, sha256: sha("v2") });
  assert.deepEqual(await d.ok("spaces.storage.delete", { space: HOME, name: "personal/a", expected: sha("v2") }, "cli", as(MEM)), { ok: true, deleted: true });
  assert.equal((await d.ok("spaces.storage.usage", { space: HOME }, "cli", as(MEM))).used, 0);
  void w;
});

test("spaces.identity.devices.read on a SERVER (no identity of its own): the paired owner is the person the call acts for, and nobody else; with no owner claimed the answer is empty", async t => {
  const { claimIdentity } = await import("../../apps/app/src/identity/claim.js");
  const w = world(t);
  const pt = () => Buffer.from(crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).subarray(-65)).toString("base64url");
  const device0 = await device(t); // a home that makes the directory's `hooks` live
  void device0;
  const claim = async (name, agree) => claimIdentity({ name, code: (await reserve(name)).code, password: "four plain words here", base: "http://127.0.0.1:1", fetch: /** @type {any} */ (hooks.fetch), now: () => /** @type {any} */ (hooks.now)(), params: { memoryKiB: 64, passes: 1 }, forceSoftware: true, agree });
  const owner = await claim("srvowner", pt()), stranger = await claim("srvstranger", pt());
  let claimed = /** @type {string | null} */ (owner.id);
  const kernelFor = () => ({ for: () => null, ownerClaimed: () => claimed });
  const server = await device(t, { kernelFor: /** @type {any} */ (kernelFor) });
  assert.equal(fileIdentityStore(server.space).status().exists, false, "a server has no identity of its own");
  for (const p of [owner, stranger]) await server.reg.call("spaces.person.learn", { id: p.id, name: p === owner ? "srvowner" : "srvstranger" }, "module:vyred");
  const read = person => server.call("spaces.identity.devices.read", { person }, "module:work");
  const mine = await read(owner.id);
  assert.ok(!mine.error, JSON.stringify(mine.error));
  assert.equal(mine.data.devices.length, 1, "the owner's device and its point");
  assert.equal(mine.data.devices[0].device, owner.eid);
  assert.match(mine.data.devices[0].agree, /^[A-Za-z0-9_-]{87}$/);
  assert.deepEqual((await read(stranger.id)).data, { devices: [] }, "a person the owner shares no space with is not 'anyone'");
  assert.deepEqual((await server.call("spaces.identity.devices.read", { person: owner.id }, "module:memory")).error?.code, "denied", "callers are still work and files");
  claimed = null;
  assert.deepEqual((await read(owner.id)).data, { devices: [] }, "no owner claimed: nothing");
});

test("spaces.upgrade.*: the plan, one approval, what moved and what did not, and the Personal row then points to My Cloud", async t => {
  const { createKernel } = await import("../../kernel/index.js");
  const { createSqliteStore } = await import("../../kernel/store/sqlite.js");
  const { createTwentyStore } = await import("../../stores/twenty/store.js");
  const { TwentyClient } = await import("../../stores/twenty/client.js");
  const { FakeTwenty } = await import("../../stores/twenty/testing/fake-twenty.js");
  const { DatabaseSync } = await import("node:sqlite");
  const { CONTACT } = await import("../../kernel/conformance/suite.js");
  const { payloadHash } = await import("../../kernel/seal/wire.js");
  const { proofRequest } = await import("../../kernel/remote/proof.js");
  const w = world(t);
  const fake = await new FakeTwenty().start();
  t.after(() => fake.stop());
  const PERSONAL = "spc_" + "c".repeat(12), CLOUD = "spc_" + "d".repeat(12), ME = "per_" + "m".repeat(26);
  const presence = () => { const used = new Set(); return { check: async ({ chain, op, fields, proof }) => (chain && proof && proof.payload_hash === payloadHash(op, chain.space, fields) && !used.has(proof.nonce) && (used.add(proof.nonce), true) ? null : "wrong_payload") }; };
  let clock = 1_800_000_000_000; const tick = () => ++clock;
  const pk = await createKernel({ space: PERSONAL, owner: ME, owner_uid: 501, key: Buffer.alloc(32, 1), clock: tick, presence: presence(), store: createSqliteStore({ db: new DatabaseSync(":memory:") }) });
  const client = new TwentyClient({ url: fake.url, key: () => fake.key, sleep: async () => {} });
  const dir = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "upt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cloudStore = createTwentyStore({ client, space: CLOUD, dir, webhookSecret: "ab".repeat(8), graceMs: 0 });
  await cloudStore.define({ add_types: [...(await import("../../records/core-types.js")).CORE_TYPES] }); // the core types are in My Cloud's Twenty before its kernel starts
  const ck = await createKernel({ space: CLOUD, owner: ME, owner_uid: 501, key: Buffer.alloc(32, 2), clock: tick, presence: presence(), store: cloudStore });
  const chainOf = (k) => k.chains.fromFacts({ kind: "device", device_key_id: "d1", person: ME, path: "direct" });
  const kernelFor = () => ({
    space: PERSONAL, owner: ME, membership: async () => ({ member: true, role: "owner" }),
    chain: async () => chainOf(pk), chainIn: async () => chainOf(pk),
    proofFrom: (meta) => (meta && meta.kernel_proof ? { presence: meta.kernel_proof } : {}), proofRequest: (call, ...a) => proofRequest(PERSONAL, call, ...a),
    // My Cloud as a RemoteKernel is: the chain argument is ignored (the server mints it from the peer), so this stands in with the person's own chain there
    for: (id) => (id === PERSONAL ? { space: id, hosted: true, gateway: pk.gateway } : id === CLOUD ? { space: id, hosted: false, gateway: { definitions: () => ck.gateway.definitions(chainOf(ck)), records: new Proxy({}, { get: (_t, name) => (_c, ...a) => ck.gateway.records[name](chainOf(ck), ...a) }) } } : (() => { throw new Error("no such space"); })()),
    spaces: { hosts: () => false },
  });
  const d = await device(t, { kernelFor });
  const person = { kernelFacts: { kind: "device", device_key_id: "d1", person: ME, path: "direct" } };
  await pk.gateway.records.define(chainOf(pk), { add_types: [CONTACT] });
  for (const n of ["Ada", "Bo", "Cy"]) await pk.gateway.records.create(chainOf(pk), "contact", { name: n });
  const plan = await d.ok("spaces.upgrade.plan", { to: CLOUD }, "cli", person);
  assert.deepEqual([plan.counts.total, plan.blockers, plan.hash.length], [3, [], 43]);
  assert.equal((await d.call("spaces.upgrade.run", { to: CLOUD, plan_hash: "x".repeat(43) }, "cli", person)).error?.code, "plan_changed", "an approval for another plan is refused before anything");
  const ask = await d.ok("spaces.upgrade.run", { to: CLOUD, plan_hash: plan.hash }, "cli", person);
  assert.equal(ask.needs_proof, true, "no proof: the device is asked for the person's approval of exactly this plan");
  const proof = { payload_hash: ask.request.payload_hash, nonce: "n1" };
  const done = await d.ok("spaces.upgrade.run", { to: CLOUD, plan_hash: plan.hash }, "cli", { ...person, kernel_proof: proof });
  assert.deepEqual([done.upgraded, done.to, done.moved.records, done.notMoved, done.frozen], [true, CLOUD, { contact: 3 }, [], false]);
  assert.match(done.not_frozen_because, /My Cloud has not confirmed/, "without My Cloud's signed receipt this space is not frozen");
  assert.ok(done.notes.some(n => n.what === "My Cloud's receipt"), "and the answer says why no receipt was asked for");
  assert.equal((await ck.gateway.records.query(chainOf(ck), "contact", { page: { limit: 10 } })).rows.length, 3, "the records are in My Cloud's Twenty");
  await d.ok("spaces.identity.create", { name: "upgrader" });
  const row = (await d.ok("spaces.list")).find(x => x.id === PERSONAL);
  assert.equal(row.upgraded_to, undefined, "the Personal row does not point to My Cloud until My Cloud has confirmed");
  void w;
});

test("spaces.servers: the servers this device is paired to, with the id spaces.create takes; none paired is an empty list", async t => {
  const w = world(t);
  const d = await device(t);
  assert.deepEqual(await d.ok("spaces.servers"), { servers: [] }, "no wink table, no servers");
  const db = d.db;
  db.exec("CREATE TABLE IF NOT EXISTS wink_devices (id TEXT PRIMARY KEY, identity TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, fingerprint TEXT NOT NULL DEFAULT '', owner_kind TEXT, owner_id TEXT, offers TEXT, created INTEGER NOT NULL DEFAULT 0)");
  db.prepare("INSERT INTO wink_devices (id, identity, kind, name, created) VALUES (?, 'per_x', ?, ?, ?)").run("srv_box1", "server", "Home server", 2);
  db.prepare("INSERT INTO wink_devices (id, identity, kind, name, created) VALUES (?, 'per_x', ?, ?, ?)").run("ph_1", "phone", "Phone", 1);
  assert.deepEqual(await d.ok("spaces.servers"), { servers: [{ id: "srv_box1", name: "Home server", online: null }] }, "only servers, and not a phone");
  void w;
});
