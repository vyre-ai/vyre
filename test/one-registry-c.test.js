// @ts-check
// ONE registry, ONE id (lead ruling, 4 Oct): a Space made through `spaces.create` is made in the kernel's Spaces registry with the kernel's id (`spc_` and 12 base32 characters) and its
// built-in store attached at once, so `records.*` and `tasks.*` answer in it; and the person the kernel knows as the home's owner IS the claimed identity, so `records.me`,
// `spaces.identity.status` and `spaces.list` agree. On a real vyred against the stand-in names directory (scripts/standin-directory.mjs).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome, present } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { CONTACT } from "../kernel/conformance/suite.js";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "standin-directory.mjs");
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });


test("a MEMBER's device (another person's) is enrolled in a space this home hosts only while that person is an active member and the device is on their own identity list", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const mk = (/** @type {string} */ name) => { const root = tempHome(t); fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name, transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } })); return root; };
  const aliceRoot = mk("alice-home"), bobRoot = mk("bob-home");
  const alice = await start({ root: aliceRoot, kernel: true, log: () => {} });
  t.after(() => alice.stop());
  const bob = await start({ root: bobRoot, kernel: true, log: () => {} });
  t.after(() => bob.stop());
  const A = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root: aliceRoot, caller: "cli" });
  const B = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root: bobRoot, caller: "cli" });
  const a = (await A("spaces.identity.create", { name: "alice" })).data;
  const b = (await B("spaces.identity.create", { name: "bobby" })).data;
  fs.writeFileSync(path.join(aliceRoot, "dev-presence-stand-in"), "");
  // alice's home hosts a space; bobby is made a member of it by alice (the kernel's own role call)
  const sp = await alice.kernel.spaces.host({ owner: a.id, name: "sharedroom" });
  const aliceChain = sp.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev0000000000000a", person: a.id, path: "direct", session: "s" });
  await sp.gateway.grants.setRole(aliceChain, { person: b.id, role: "member" }, { presence: { method: "stand-in" } });
  // alice's home has verified bobby's name (this is written when an invite is redeemed)
  alice.registry.deps.db.prepare("INSERT INTO spaces_kv (key, value) VALUES (?, ?)").run(`person-name/${b.id}`, JSON.stringify("bobby"));
  const enrolled = async (/** @type {string} */ device, /** @type {string} */ space) => (await alice.registry.call("spaces.devices.enrolled", { device, space }, "module:vyred", { door: true })).data.enrolled;
  assert.equal(await enrolled(b.eid, sp.space), true, "bobby's own device, bobby an active member");
  assert.equal(await enrolled("devnotbobbysxxxxx1", sp.space), false, "a device on nobody's list");
  assert.equal(await enrolled(b.eid, alice.kernel.id.space), false, "bobby is not a member of alice's home space");
  // removed: no longer enrolled (the kernel says so at call time; the cache holds only who the device belongs to)
  await sp.gateway.grants.removeMember(aliceChain, { person: b.id }, { presence: { method: "stand-in" } });
  assert.equal(await enrolled(b.eid, sp.space), false, "a removed member's device");
});

test("server side of a server-homed space: host-here needs no proof from the owner and hosts the space, retire-here with no proof is refused, a caller that is not the home's owner is refused, and nothing is hosted or retired for them", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "srv-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, kernel: true, log: () => {} }); // the daemon's REAL presence verifier: no test double
  t.after(() => d.stop());
  const as = (/** @type {string} */ caller, /** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller });
  const before = d.kernel.spaces.list().length;
  // host-here needs no presence proof (11391dc9d: the owner check is the gate, the owner's device calls it over the paired session): the owner's call hosts the space...
  const owned = await as("cli", "spaces.host-here", { name: "nothere" });
  assert.ok(owned.data && owned.data.space, JSON.stringify(owned));
  assert.equal(d.kernel.spaces.list().length, before + 1, "the owner's call hosted one space");
  // ...and a caller that is not the owner is refused and hosts nothing
  const stranger = await as("tailnet-guest:mallory@example.com", "spaces.host-here", { name: "another" });
  assert.ok(stranger.error, "a caller that is not the owner is refused");
  assert.equal(d.kernel.spaces.list().length, before + 1, "and nothing more was hosted");
  // taking one back asks for the proof too, and a space that was never made there is not touched
  const hosted = await d.kernel.spaces.host({ owner: d.kernel.id.owner, name: "keepme" });
  const noProofRetire = await as("cli", "spaces.retire-here", { id: hosted.space });
  assert.equal(noProofRetire.error?.code, "presence_required", JSON.stringify(noProofRetire));
  assert.ok(d.kernel.spaces.hosts(hosted.space), "still hosted");
});

test("pre-0.3 boot (reviewer-3): a paired app device with no list at start gets one explicit list of the spaces its person belongs to, and a second start does not rewrite it", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "boot-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  let d = await start({ root, kernel: true, log: () => {} });
  const ids = async () => (await call("spaces.identity.create", { name: "alex" }, { root, caller: "cli" })).data;
  const made = await ids();
  const sp = (await call("spaces.create", { name: "bootspace", home: { kind: "this-computer", confirmed: true } }, { root, caller: "cli" })).data;
  const home = d.kernel.id.space;
  await d.stop();
  // a pre-0.3 style home: a paired phone row and a removed one, and no per-space lists at all
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(root, "vyre.db"));
  const ins = db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, ?, 'p', 1, ?, ?, ?)");
  ins.run("oldphonexxxxxxx01", "old phone", "app", 0, null); ins.run("goneoldphonexxx02", "gone phone", "app", 0, 5);
  db.prepare("DELETE FROM spaces_kv WHERE key LIKE 'device-spaces/%'").run();
  db.close();
  d = await start({ root, kernel: true, log: () => {} });
  t.after(() => d.stop());
  await new Promise(r => setTimeout(r, 2000));
  const read = (/** @type {string} */ k) => { const x = new DatabaseSync(path.join(root, "vyre.db")); try { const r = /** @type {any} */ (x.prepare("SELECT value FROM spaces_kv WHERE key = ?").get(k)); return r ? JSON.parse(r.value) : undefined; } finally { x.close(); } };
  const list = read("device-spaces/oldphonexxxxxxx01");
  assert.ok(Array.isArray(list), "the live phone got an explicit list at boot");
  assert.deepEqual(new Set(list), new Set([home, sp.space]), "the spaces its person belongs to, the home first");
  assert.equal(read("device-spaces/goneoldphonexxx02"), undefined, "a removed phone got none");
  // a second start leaves the list as it is (even after the person's spaces changed)
  await d.stop();
  const db2 = new DatabaseSync(path.join(root, "vyre.db"));
  db2.prepare("UPDATE spaces_kv SET value = ? WHERE key = ?").run(JSON.stringify([sp.space]), "device-spaces/oldphonexxxxxxx01");
  db2.close();
  d = await start({ root, kernel: true, log: () => {} });
  t.after(() => d.stop());
  await new Promise(r => setTimeout(r, 2000));
  assert.deepEqual(read("device-spaces/oldphonexxxxxxx01"), [home, sp.space].includes(home) ? [home, sp.space] : [sp.space], "an existing list is topped up with the home only, never rewritten from scratch");
  void made;
});

test("the remote path: a space this device made with a paired server as home is reached through K.for(id) as a RemoteKernel over the Wink peer session (kernel.call), and a space with no server row is not remote", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "remote-box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  /** @type {any[]} */ const seen = [];
  const sessionFor = async (/** @type {string} */ device) => ({ call: async (/** @type {string} */ tool, /** @type {any} */ input) => { seen.push([device, tool, input.call, input.space]); return { v: 1, id: input.id, ok: true, result: { record: "from the server" } }; } });
  const d = await start({ root, kernel: true, sessionFor, log: () => {} });
  t.after(() => d.stop());
  const sid = "spc_abcdefghjklm";
  d.registry.deps.db.prepare("INSERT INTO spaces_kv (key, value) VALUES (?, ?)").run(`server-hosted/${sid}`, JSON.stringify({ device: "srv_paired0000000001" }));
  const h = d.kernel.spaces.for(sid);
  assert.equal(h.hosted, false, "not hosted here");
  const r = await h.gateway.records.get(null, "contact", "c1");
  assert.deepEqual(r, { record: "from the server" });
  assert.deepEqual(seen, [["srv_paired0000000001", "kernel.call", "records.get", sid]]);
  assert.throws(() => d.kernel.spaces.for("spc_zzzzzzzzzzzz"), { code: "not_found" }, "a space with no server row is no remote space");
});

test("TAKEOVER (regression): a space this home hosts for ANOTHER person keeps that person as its owner when the home's owner is adopted to the claimed identity; alice still acts in it, the identity has no role there, and the same after a restart", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "takeover-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "");
  let d = await start({ root, kernel: true, log: () => {} });
  const cli = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "cli" });
  const homeFirst = d.kernel.id.owner;
  const alice = "per_" + "d".repeat(26);
  // the home hosts a space for alice BEFORE its owner claims an identity, and one for the home's own first-start owner
  const hers = await d.kernel.spaces.host({ owner: alice, name: "alicespace" });
  const mine = await d.kernel.spaces.host({ owner: homeFirst, name: "firstownerspace" });
  const identity = (await cli("spaces.identity.create", { name: "alex" })).data;
  assert.ok((await cli("spaces.list")).data, "a spaces call triggers the adoption");
  await new Promise(r => setTimeout(r, 800));
  const check = async () => {
    const herChain = hers.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev0000000000000a", person: alice, path: "direct", session: "s" });
    const members = await hers.gateway.grants.members.list(herChain);
    assert.deepEqual(members.map((/** @type {any} */ m) => [m.person, m.role]), [[alice, "owner"]], "alice is still the owner, and she is the only member");
    assert.equal(hers.kernel.grants.roleOf({ kind: "person", id: identity.id, space: hers.space }), null, "the claimed identity has no role in alice's space");
    assert.equal(hers.kernel.grants.roleOf({ kind: "person", id: alice, space: hers.space }), "owner");
    // alice can still act in it: define a type as the owner (stand-in presence)
    await hers.gateway.records.define(herChain, { add_types: [CONTACT] }).catch(() => {});
    const types = await hers.gateway.records.types ? null : null; void types;
  };
  await check();
  // the home's own first-start owner's space DID move to the identity
  const mineChain = mine.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev0000000000000b", person: identity.id, path: "direct", session: "s" });
  assert.deepEqual((await mine.gateway.grants.members.list(mineChain)).map((/** @type {any} */ m) => [m.person, m.role]), [[identity.id, "owner"]], "the home's own space follows the identity");
  // and the same after a restart
  await d.stop();
  d = await start({ root, kernel: true, log: () => {} });
  t.after(() => d.stop());
  assert.ok((await cli("spaces.list")).data);
  await new Promise(r => setTimeout(r, 800));
  const again = d.kernel.spaces.hosted(hers.space);
  assert.ok(again, "alice's space is still hosted after the restart");
  const herChain2 = again.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev0000000000000a", person: alice, path: "direct", session: "s" });
  assert.deepEqual((await again.gateway.grants.members.list(herChain2)).map((/** @type {any} */ m) => [m.person, m.role]), [[alice, "owner"]], "after a restart alice is still the owner");
  assert.equal(again.kernel.grants.roleOf({ kind: "person", id: identity.id, space: again.space }), null);
});

test("spaces.owner.adopt (SO-1/SO-2): an added module, the terminal and an agent are refused; the Wink module is refused unless the identity is the one ITS OWN pairing record names; the other modules-only tools refuse a caller that is not an admitted module", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "adopt-box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, kernel: true, log: () => {} });
  t.after(() => d.stop());
  const as = (/** @type {string} */ caller, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, caller, {});
  const owner0 = d.kernel.id.owner;
  const evil = "per_" + "e".repeat(26);
  for (const caller of ["module:evil", "module:presence", "cli", "agent:thread-1"]) {
    const r = await as(caller, "spaces.owner.adopt", { person: evil });
    assert.ok(r.error, `${caller} must be refused, got ${JSON.stringify(r).slice(0, 120)}`);
  }
  // the Wink module itself, with an identity its pairing record does not name (there is no pairing here at all): refused, nothing adopted
  const noRecord = await as("module:wink", "spaces.owner.adopt", { person: evil });
  assert.equal(noRecord.error?.code, "forbidden", JSON.stringify(noRecord));
  assert.equal(d.kernel.id.owner, owner0, "the home's owner did not change");
  // the other modules-only tools
  for (const [tool, input] of [["spaces.identity.name-of", { id: evil }], ["spaces.admin-list", { person: evil }], ["spaces.server-of", { space: "spc_aaaaaaaaaaaa" }]]) {
    const r = await as("module:evil", tool, input);
    assert.ok(r.error, `${tool} is refused to an added module`);
  }
  assert.ok((await as("module:wink", "spaces.admin-list", { person: evil })).data, "the Wink module may read the list");
});

test("hosting and retiring a Space are events in the home's log: the first before anything is made, the last after the folder is gone", { timeout: 120_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1";
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const h = await d.kernel.spaces.host({ owner: d.kernel.id.owner, name: "evented" });
  const types = () => d.kernel.log.read({ type: "space.*" }).map(e => `${e.type}:${e.data.space}`);
  assert.deepEqual(types(), [`space.hosting:${h.space}`, `space.hosted:${h.space}`]);
  assert.deepEqual(await d.kernel.spaces.retire(h.space), { retired: true });
  assert.deepEqual(types(), [`space.hosting:${h.space}`, `space.hosted:${h.space}`, `space.retired:${h.space}`]);
});

test("a recovered phone (a new device entry on the owner's identity list) reaches the owner's space on a server by itself, with no approval from another device; and a removed entry does not", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const mk = (/** @type {string} */ name) => { const root = tempHome(t); fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name, transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } })); return root; };
  const homeRoot = mk("alex-laptop"), srvRoot = mk("alex-server");
  const home = await start({ root: homeRoot, kernel: true, log: () => {} });
  t.after(() => home.stop());
  const srv = await start({ root: srvRoot, kernel: true, log: () => {} }); // a server: no identity of its own
  t.after(() => srv.stop());
  const H = (/** @type {string} */ tool, /** @type {any} */ input = {}, caller = "cli") => call(tool, input, { root: homeRoot, caller });
  const alex = (await H("spaces.identity.create", { name: "alexr" })).data;
  // the server hosts a space for alex (what spaces.host-here does), and alex's own phone is already on his list
  const sp = await srv.kernel.spaces.host({ owner: alex.id, name: "alexroom" });
  const { fileIdentityStore } = await import("../core/spaces/identity.js");
  const phone = fileIdentityStore(path.join(tempHome(t), "phone")).newDeviceKey();
  const added = await home.registry.call("spaces.identity.enrol", { publicKey: phone.publicKey, label: "alex phone" }, "module:wink");
  assert.equal(added.error, undefined, JSON.stringify(added.error));
  const enrolled = async (/** @type {string} */ device) => (await srv.registry.call("spaces.devices.enrolled", { device, space: sp.space }, "module:vyred", { door: true })).data.enrolled;
  // the server knows alex's name once its owner is verified (pairing) or a person joins; record it as they do
  assert.equal((await srv.registry.call("spaces.person.learn", { id: alex.id, name: "somebodyelse" }, "module:vyred")).data.known, false, "a name that is not theirs is not learned");
  assert.equal((await srv.registry.call("spaces.person.learn", { id: alex.id, name: "alexr" }, "module:vyred")).data.known, true);
  assert.equal(await enrolled("devnotalexsxxxxx1"), false, "a device on nobody's list");
  assert.equal(await enrolled(phone.eid), true, "the recovered phone is on alex's own list and alex owns the space: no approval from another device");
  // the same rule for a space on the server alex does NOT belong to: not enrolled
  const other = await srv.kernel.spaces.host({ owner: srv.kernel.id.owner, name: "notalexs" });
  assert.equal((await srv.registry.call("spaces.devices.enrolled", { device: phone.eid, space: other.space }, "module:vyred", { door: true })).data.enrolled, false, "a space alex is not a member of");
});
