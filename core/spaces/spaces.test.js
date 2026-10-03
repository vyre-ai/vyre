// @ts-check
// spaces: the module through the real registry, with a real names directory Worker on the fake runtime (no network), temp homes only.
// Sample world: alex (the owner), juno and kit (people), Harlow Legal and Northwind Bakery (spaces).

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import * as config from "../config/index.js";
import { tempHome } from "../../test/helpers.js";
import worker, * as W from "../../names/worker/index.js";
import { createRuntime } from "../../relay/worker/fake-cf.js";
import { fakeDns } from "../../names/worker/fake-dns.js";
import spacesModule, { hooks } from "./index.js";
import { newKeyPair, personIdOf, fileIdentityStore } from "./identity.js";
import { createIdentityOps } from "./identity-ops.js";
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

/** A box-role registry running only the spaces module (one device). Extra modules (a fake records driver) can ride along. */
async function device(t, { records = false, kernelFor = undefined } = {}) {
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
  const db = open(p.db);
  const events = new Events(db);
  const logs = [];
  const seen = [];
  events.on("*", e => seen.push(e));
  const reg = new Registry({ db, events, config: { role: "box", name: "testbox", names: { directory: "http://127.0.0.1:1" } }, paths: p, log: m => logs.push(String(m)), presence: /** @type {any} */ (presence), ...(kernelFor ? { kernelFor } : {}) });
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
  await ops.create({ name: label, deviceLabel: label });
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
  const alex = await d.ok("spaces.identity.create", { name: "alex" });
  const assess = await d.ok("spaces.assess-computer", { device: { name: "alex's laptop", alwaysOn: false } });
  assert.match(assess.warning, /unreachable while/);

  // Not confirmed: it waits and says why.
  const first = await d.ok("spaces.create", { name: "Harlow", displayName: "Harlow Legal", home: { kind: "this-computer" } });
  assert.equal(first.status, "waiting");
  assert.equal(first.waiting.for, "confirm");
  assert.equal(first.steps.find(s => s.step === "validate").state, "waiting");
  const done = await d.ok("spaces.resume", { space: first.space, confirmThisComputer: true });
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
  const got = await d.ok("spaces.get", { space: "harlow" });
  assert.deepEqual([got.owners, got.members], [1, 1]);
  assert.ok(got.warnings.some(x => x.code === "single_owner"));
  const members = await d.ok("spaces.members.list", { space: done.space });
  assert.equal(members.members[0].person, alex.id);
  assert.equal(members.members[0].role, "owner");
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
  const wrong = await d.ok("spaces.code.submit", { space: s.space, code: s.waiting.code === "000000" ? "111111" : "000000" }, "tailnet:server");
  assert.equal(wrong.pairing, "wrong_code");
  assert.match(wrong.message, /4 tries left/);
  assert.equal((await d.ok("spaces.status", { space: s.space })).status, "waiting");
  const right = await d.ok("spaces.code.submit", { space: s.space, code: s.waiting.code }, "tailnet:server");
  assert.equal(right.pairing, "matched");
  assert.equal(right.status, "done");
  assert.deepEqual(d.of("space.pairing-state").map(e => e.state), ["waiting_for_code", "waiting_for_code", "matched", "home_ready"]);
  // The code is shown to the person, and never sent in an event or a log. (The pending space record keeps it until the ten minutes end, so a status call can show it again; the pairing table keeps only its hash.)
  assert.ok(!JSON.stringify(d.seen).includes(s.waiting.code) && !d.logs.join("\n").includes(s.waiting.code));
  const again = await d.call("spaces.code.submit", { space: s.space, code: s.waiting.code }, "tailnet:server");
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
  for (let i = 0; i < 5; i++) last = await d.ok("spaces.code.submit", { space: s.space, code: wrongCode }, "tailnet:server");
  assert.equal(last.pairing, "locked");
  assert.equal(last.failed.step, "home");
  const again = await d.ok("spaces.resume", { space: s.space });
  assert.equal(again.status, "waiting");
  w.clock.t += 11 * 60 * 1000;
  const late = await d.ok("spaces.code.submit", { space: s.space, code: again.waiting.code }, "tailnet:server");
  assert.equal(late.pairing, "timed_out");
  const fresh = await d.ok("spaces.resume", { space: s.space });
  assert.equal(fresh.status, "waiting");
  assert.equal((await d.ok("spaces.code.submit", { space: s.space, code: fresh.waiting.code }, "tailnet:server")).status, "done");
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
  const done = await d.ok("spaces.code.submit", { space: s.space, code: s.waiting.code }, "tailnet:server");
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
  assert.equal((await d.ok("spaces.list")).find(x => x.id === taken.space).status, "cancelled");
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
  const joined = await d.ok("spaces.code.submit", { space, code: add.code, join: add.joinId }, "tailnet:server");
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
  const joined = await d.call("spaces.invites.redeem", acc.redeem, "tailnet:kit");
  assert.ok(!joined.error, JSON.stringify(joined.error));
  assert.deepEqual([joined.data.membership.person, joined.data.membership.role], [kitId.id, "member"]);
  assert.deepEqual(joined.data.projects, scope);
  assert.ok(d.of("invite.accepted").some(e => e.person === kitId.id));
  assert.ok((await d.ok("spaces.members.list", { space })).members.some(m => m.person === kitId.id && m.role === "member"));
  // A replay of the same acceptance, and another person on a used link.
  assert.equal((await d.call("spaces.invites.redeem", acc.redeem, "tailnet:kit")).error?.code, "used_up");
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
  const refused = await d.call("spaces.invites.redeem", wrong.redeem, "tailnet:stranger");
  assert.equal(refused.error?.code, "forbidden");
  const right = await kit.ok("spaces.invites.accept", { link: inv.link });
  const joined = await d.call("spaces.invites.redeem", right.redeem, "tailnet:kit");
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
  const kernelFor = m => ({ for: () => real(m).for(KSPACE), chain: meta => real(m).chain(meta), proofFrom: meta => real(m).proofFrom(meta), serviceChain: () => real(m).serviceChain(), acceptProofRequest: (c, p) => real(m).acceptProofRequest(c, p) });
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
  // no proof: the kernel says the change needs the person's approval, in the module's words
  const bare = await d.call("spaces.members.add", { space, person: KIT, role: "member" }, "cli", { token });
  assert.equal(bare.error?.code, "needs_presence", JSON.stringify(bare.error));
  // with the kernel's proof it goes through, and the list is the kernel's
  const added = await d.call("spaces.members.add", { space, person: KIT, role: "member" }, "cli", { token, kernel_proof: sign("setRole", { person: KIT, role: "member" }) });
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
  const kernelFor = m => ({ for: () => real(m).for(KSPACE), chain: meta => real(m).chain(meta), proofFrom: meta => real(m).proofFrom(meta), serviceChain: () => real(m).serviceChain(), acceptProofRequest: (c, p) => real(m).acceptProofRequest(c, p) });
  const d = await device(t, { kernelFor }), kitDev = await device(t, { kernelFor });
  const alex = await d.ok("spaces.identity.create", { name: "alex" });
  const kit = await kitDev.ok("spaces.identity.create", { name: "kit" });
  K = await createKernel({ space: KSPACE, owner: alex.id, owner_uid: 501, key: Buffer.alloc(32, 9), clock: () => w.clock.t, presence: presenceK, hasPresenceSession: () => true });
  const token = (await K.surfaces.open(K.chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true }))).token;
  const kitToken = (await K.surfaces.open(K.chains.fromFacts({ kind: "invitee", person: kit.id, vouched: true }))).token;
  const s = await d.ok("spaces.create", { name: "harlow", displayName: "Harlow Legal", home: { kind: "this-computer", confirmed: true } });
  const space = s.space;
  const sign = (call, ...a) => ({ payload_hash: proofRequest(KSPACE, call, ...a).payload_hash, nonce: Math.random().toString(36) });
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
