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


test("lend: a module record that says the first grant was given is not consent the kernel honours (backup restore, revoked offers): on again asks the kernel and gets a plain refusal; and a device whose list leaves the space out is refused", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "lend2-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, kernel: true, presence: present, log: () => {} });
  t.after(() => d.stop());
  const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "cli" });
  const made = (await deck("spaces.identity.create", { name: "alex" })).data;
  const a = (await deck("spaces.create", { name: "lendb", home: { kind: "this-computer", confirmed: true } })).data;
  const b = (await deck("spaces.create", { name: "lendc", home: { kind: "this-computer", confirmed: true } })).data;
  // the module's own record claims a first grant was given for space A; the kernel has no offer at all
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(root, "vyre.db"));
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  db.prepare("INSERT INTO spaces_kv (key, value) VALUES (?, ?)").run(`lend/${a.space}/${made.eid}`, JSON.stringify({ lent: false, device: made.eid, first_grant_at: 1, allowed_by: made.id, at: 1 }));
  const r = await deck("spaces.devices.lend", { space: a.space, device: made.eid, on: true });
  assert.ok(r.error, "no silent success: the kernel holds no consent");
  assert.equal(r.error.code, "presence_required", JSON.stringify(r.error));
  const hosted = d.kernel.spaces.hosted(a.space);
  assert.deepEqual(hosted.gateway.grants.offers.active({ member: made.id, device: made.eid, device_key: made.eid }), { spaceAllows: false, memberAccepts: false });
  // a device whose list leaves space B out cannot be lent into B
  assert.ok(!(await deck("spaces.devices.set", { device: made.eid, spaces: [a.space] })).error);
  const nb = await deck("spaces.devices.lend", { space: b.space, device: made.eid, on: true });
  assert.equal(nb.error && nb.error.code, "device_removed", JSON.stringify(nb));
});

test("a directory that lost its claims gets the identity and the spaces' names back with spaces.identity.republish", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  /** @type {import("node:child_process").ChildProcess | null} */ let child = null;
  const up = async () => { child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] }); const c = child; await new Promise((res, rej) => { c.stdout?.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); c.on("exit", code => rej(new Error(`the stand-in exited early (${code})`))); }); };
  const down = async () => { const c = child; if (!c) return; await new Promise(res => { c.once("exit", res); c.kill("SIGTERM"); }); child = null; };
  await up();
  t.after(() => { if (child) child.kill("SIGTERM"); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "rep-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, kernel: true, log: () => {} });
  t.after(() => d.stop());
  const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "cli" });
  assert.ok(!(await deck("spaces.identity.create", { name: "alex" })).error);
  const sp = await deck("spaces.create", { name: "harlowrep", home: { kind: "this-computer", confirmed: true } });
  assert.equal(sp.data.status, "done", JSON.stringify(sp));
  const resolves = async (/** @type {string} */ name) => (await fetch(`http://127.0.0.1:${port}/v1/ids/resolve?name=${name}`)).status;
  assert.equal(await resolves("alex"), 200);
  await down(); await up(); // the directory restarts and forgets everything
  assert.equal(await resolves("alex"), 404);
  // the person's name is held again by a fresh reservation (the directory has no other way in), then the chain goes back
  const fresh = (await (await fetch(`http://127.0.0.1:${port}/v1/ids/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "alex" }) })).json()).data.code;
  const r = await deck("spaces.identity.republish", { code: fresh });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.deepEqual([r.data.identity, r.data.spaces, r.data.failed], [true, ["harlowrep.vyre.run"], []], JSON.stringify(r.data));
  assert.equal(await resolves("alex"), 200);
  assert.equal(await resolves("harlowrep"), 200);
});

test("the kernel's home space is a space in the device lists: pairing's list includes it, a device with an old explicit list is enrolled once at boot, and the daemon's enrolment answer for the home is yes", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "home-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  let d = await start({ root, kernel: true, log: () => {} });
  const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "cli" });
  const made = (await deck("spaces.identity.create", { name: "alex" })).data;
  const home = d.kernel.id.space;
  assert.match(home, /^spc_/);
  // the person's own (home) space is listed, always with a name and a tier (app-wire's walk showed null names without it): label "personal", a tier by the machine's role
  const homeRow = (await deck("spaces.list")).data.find((/** @type {any} */ x) => x.id === home);
  assert.ok(homeRow && homeRow.label === "personal" && ["basic", "cloud"].includes(homeRow.tier), "the home is listed as the person's own space, named and with a tier");
  const sp = (await deck("spaces.create", { name: "homelist", home: { kind: "this-computer", confirmed: true } })).data;
  // pairing's list: every space the person is in, the home space included
  const set = await deck("spaces.devices.set", { device: made.eid, spaces: [sp.space, home] });
  assert.ok(!set.error, JSON.stringify(set.error));
  assert.deepEqual(new Set(set.data.spaces), new Set([home, sp.space]));
  const rows = (await deck("spaces.devices.list", { device: made.eid })).data.spaces;
  assert.ok(rows.some((/** @type {any} */ r) => r.space === home && r.enrolled === true && r.home === true), JSON.stringify(rows));
  const enrolled = (/** @type {string} */ space) => d.registry.call("spaces.devices.enrolled", { device: made.eid, space }, "module:vyred", { door: true });
  assert.equal((await enrolled(home)).data.enrolled, true);
  // an old explicit list that lacks the home (a device paired before the home was a row): put back at boot, once
  await d.stop();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(root, "vyre.db"));
  db.prepare("UPDATE spaces_kv SET value = ? WHERE key = ?").run(JSON.stringify([sp.space]), `device-spaces/${made.eid}`);
  db.close();
  d = await start({ root, kernel: true, log: () => {} });
  t.after(() => d.stop());
  await new Promise(r => setTimeout(r, 1500));
  assert.equal((await d.registry.call("spaces.devices.enrolled", { device: made.eid, space: d.kernel.id.space }, "module:vyred", { door: true })).data.enrolled, true, "enrolled in the home after the boot migration");
});

test("spaces.devices.enrolled is fail-closed: an unknown space is enrolled only when the kernel hosts it and the person belongs; and a server with no identity lists the spaces its kernel hosts for its owner", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "fc-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, kernel: true, log: () => {} });
  t.after(() => d.stop());
  const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "cli" });
  const enrolled = async (/** @type {string} */ device, /** @type {string} */ space) => (await d.registry.call("spaces.devices.enrolled", { device, space }, "module:vyred", { door: true })).data.enrolled;
  // a server with no identity of its own: its owner is the person, it lists the space its kernel hosts for that owner
  const hosted = await d.kernel.spaces.host({ owner: d.kernel.id.owner, name: "serverspace" });
  const listed = await deck("spaces.list");
  assert.ok(!listed.error, JSON.stringify(listed.error));
  assert.ok(listed.data.some((/** @type {any} */ x) => x.id === hosted.space && x.name === "serverspace.vyre.run" && x.role === "owner"), JSON.stringify(listed.data));
  assert.ok(listed.data.some((/** @type {any} */ x) => x.id === d.kernel.id.space));
  const dev = "devicexxxxxxxxxx1";
  // the box knows two paired phones (active relay_devices rows of kind app); everything else is an id nobody paired
  const ins = d.registry.deps.db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, ?, 'p', 1, ?, ?, ?)");
  ins.run(dev, "phone", "app", 0, null); ins.run("devicexxxxxxxxxx2", "phone two", "app", 0, null); ins.run("devremovedxxxxxx3", "old phone", "app", 0, 5); ins.run("devwebbrowserxxx4", "browser", "web", 0, null);
  const kvRow = (/** @type {string} */ k) => d.registry.deps.db.prepare("SELECT value FROM spaces_kv WHERE key = ?").get(k);
  assert.equal(await enrolled("deviceneverpaired5", d.kernel.id.space), false, "an id in no table is not enrolled, with no list");
  assert.equal(await enrolled("devremovedxxxxxx3", d.kernel.id.space), false, "a removed relay device");
  assert.equal(await enrolled("devwebbrowserxxx4", d.kernel.id.space), false, "a browser is not a paired app device");
  for (const id of ["deviceneverpaired5", "devremovedxxxxxx3", "devwebbrowserxxx4"]) assert.equal(kvRow(`device-spaces/${id}`), undefined, `${id} left no list behind`);
  assert.equal(kvRow(`device-spaces/${dev}`), undefined, "no list before first contact");
  assert.equal(await enrolled(dev, d.kernel.id.space), true, "the home, a device with no list");
  assert.equal(await enrolled(dev, hosted.space), true, "a hosted space the owner belongs to");
  assert.equal(await enrolled(dev, "spc_aaaaaaaaaaaa"), false, "a space nobody here hosts");
  assert.equal(await enrolled(dev, "not-a-space"), false);
  const other = "per_" + "b".repeat(26);
  const theirs = await d.kernel.spaces.host({ owner: other, name: "theirs" });
  assert.equal(await enrolled(dev, theirs.space), false, "a hosted space the person is not a member of");
  // the device argument must have a device id's shape; nothing else is looked up
  for (const bad of ["", "a b", "x".repeat(200), "dev/../x", "short"]) assert.equal(await enrolled(bad, d.kernel.id.space), false, JSON.stringify(bad));
  // a creation that was cancelled is no space to be enrolled in, and neither is one still being made
  const mine = (await deck("spaces.identity.create", { name: "alex" })).data;
  assert.ok(mine.id);
  const w = (await deck("spaces.create", { name: "cancelme", home: { kind: "server" } })).data;
  assert.equal(await enrolled(dev, w.space), false, "still being made");
  assert.ok(!(await deck("spaces.cancel", { space: w.space })).error);
  assert.equal(await enrolled(dev, w.space), false, "cancelled");
  // a finished space of the person's: enrolled, and not once the kernel says the person is no longer a member of it
  const fin = (await deck("spaces.create", { name: "finishedone", home: { kind: "this-computer", confirmed: true } })).data;
  assert.equal(await enrolled(dev, fin.space), false, "dev met the box before this space existed: it is not on dev's list (the sunset rule)");
  ins.run("devicexxxxxxxxxx8", "phone eight", "app", 0, null);
  assert.equal(await enrolled("devicexxxxxxxxxx8", fin.space), true, "a paired device meeting the box now is enrolled in the spaces its person belongs to");
  // migration by contact: the first answer wrote this device an explicit list; a space joined LATER is not added to it by itself
  const afterContact = (await deck("spaces.devices.list", { device: dev })).error;
  void afterContact;
  const late = await d.kernel.spaces.host({ owner: d.kernel.id.owner, name: "joinedlater" });
  assert.equal(await enrolled(dev, late.space), false, "a space made after the device's first contact is not enrolled until the person adds it");
  // a removed member is not enrolled: a hosted space where the person was a member and then was removed
  const theirOwner = "per_" + "c".repeat(26);
  const shared = await d.kernel.spaces.host({ owner: theirOwner, name: "sharedwith" });
  fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "");
  const them = shared.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev0000000000000x", person: theirOwner, path: "direct", session: "s" });
  const me2 = d.kernel.id.owner;
  await shared.gateway.grants.setRole(them, { person: me2, role: "member" }, { presence: { method: "stand-in" } });
  const dev2 = "devicexxxxxxxxxx2";
  assert.equal(await enrolled(dev2, shared.space), true, "a member of a hosted space");
  // the first contact wrote ONE list, with the spaces that existed then
  const listOf = (/** @type {string} */ k) => JSON.parse(String(kvRow(`device-spaces/${k}`).value));
  assert.ok(Array.isArray(listOf(dev)) && listOf(dev).includes(d.kernel.id.space), "a live paired phone got a list at first contact");
  // an expired temp member: enrolled while the temp access stands (a device meeting the box then), not for a device that meets it after it ended
  const tmpShared = await d.kernel.spaces.host({ owner: theirOwner, name: "tempshared" });
  const them2 = tmpShared.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev0000000000000y", person: theirOwner, path: "direct", session: "s" });
  await tmpShared.gateway.grants.setRole(them2, { person: me2, role: "temp", scope: [`vyre://${tmpShared.space}/contact/*`], expires: Date.now() + 2500 }, { presence: { method: "stand-in" } });
  ins.run("devicexxxxxxxxxx6", "phone six", "app", 0, null); ins.run("devicexxxxxxxxxx7", "phone seven", "app", 0, null);
  assert.equal(await enrolled("devicexxxxxxxxxx2", tmpShared.space), false, "a space made after the device's first contact is not on its list");
  assert.equal(await enrolled("devicexxxxxxxxxx6", tmpShared.space), true, "a device meeting the box while the temp access stands");
  await new Promise(r => setTimeout(r, 3200));
  assert.equal(tmpShared.kernel.grants.roleOf({ kind: "person", id: me2, space: tmpShared.space }), null, `the kernel itself says the temp access has ended (me2 ${me2}, theirOwner ${theirOwner}, ${JSON.stringify(await tmpShared.gateway.grants.members.list(them2))})`);
  assert.equal(await enrolled("devicexxxxxxxxxx7", tmpShared.space), false, "the temp access has ended: a device meeting the box now is not enrolled in it");
  await shared.gateway.grants.removeMember(them, { person: me2 }, { presence: { method: "stand-in" } });
  assert.equal(await enrolled(dev2, shared.space), false, "removed: the kernel says so at call time");
});

test("spaces.host-here: this home's owner has its OWN kernel host a space (kernel, folder and key here), idempotent by id; a bad name or id is refused", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "host-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, kernel: true, presence: present, log: () => {} });
  t.after(() => d.stop());
  const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "cli" });
  const r = await deck("spaces.host-here", { name: "servedhere" });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.match(r.data.space, /^spc_[a-z2-7]{12}$/);
  assert.equal(d.kernel.spaces.hosts(r.data.space), true, "this home's kernel hosts it");
  assert.ok(fs.existsSync(path.join(root, "kernel", "spaces", r.data.space, "space.json")));
  const again = await deck("spaces.host-here", { name: "servedhere", id: r.data.space });
  assert.deepEqual([again.data.space, again.data.existed], [r.data.space, true]);
  assert.equal((await deck("spaces.host-here", { name: "x" })).error?.code, "bad_name");
  assert.equal((await deck("spaces.host-here", { name: "fine", id: "spc_nope" })).error?.code, "bad_input");
});
