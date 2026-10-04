// @ts-check
// ONE registry, ONE id (lead ruling, 4 Oct): a Space made through `spaces.create` is made in the kernel's Spaces registry with the kernel's id (`spc_` and 12 base32 characters) and its
// built-in store attached at once, so `records.*` and `tasks.*` answer in it; and the person the kernel knows as the home's owner IS the claimed identity, so `records.me`,
// `spaces.identity.status` and `spaces.list` agree. On a real vyred against the stand-in names directory (scripts/standin-directory.mjs).
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

test("a Space made through spaces.create is the kernel's Space (one id, a store at once), and the kernel's owner is the claimed identity", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "walk-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const lines = /** @type {string[]} */ ([]);
  const d = await start({ root, kernel: true, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "cli" });
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await deck(tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)} :: ${lines.filter(l => /owner|identity|adopt/i.test(l)).join(" ; ").slice(0, 800)}`); return r.data; };

  const made = await ok("spaces.identity.create", { name: "alex" });
  const sp = await ok("spaces.create", { name: "estatedev", home: { kind: "this-computer", confirmed: true } });
  assert.equal(sp.status, "done", JSON.stringify(sp));
  const space = sp.space;
  assert.match(space, /^spc_[a-z2-7]{12}$/, "the kernel's id format is THE id");
  // the kernel hosts it, and records and tasks answer in it under the caller's own chain
  assert.ok(d.kernel.spaces.hosts(space), "the Space is in the kernel's registry");
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d", person: d.kernel.id.owner, path: "direct", session: "s" });
  const hosted = d.kernel.spaces.hosted(space);
  await hosted.gateway.records.define(hosted.kernel.chains.fromFacts({ kind: "device", device_key_id: "d", person: made.id, path: "direct", session: "s" }), { add_types: [CONTACT] });
  const rec = await ok("records.create", { space, type: "contact", data: { name: "Jane", age: 40 } });
  assert.ok(rec.record.urn.startsWith(`vyre://${space}/`));
  assert.equal((await ok("records.list", { space, type: "contact" })).rows.length, 1);
  assert.deepEqual((await ok("tasks.list", { space })).tasks, []);
  // one id for the space everywhere
  const listed = (await ok("spaces.list")).spaces || (await ok("spaces.list"));
  const row = (Array.isArray(listed) ? listed : listed.spaces).find(x => x.name === "estatedev.vyre.run");
  assert.equal(row.id, space, "spaces.list names the kernel's id");
  assert.equal((await ok("spaces.get", { space })).id, space, "spaces.get too");
  // one person: the claimed identity is the kernel's owner
  const status = await ok("spaces.identity.status");
  assert.equal(status.id, made.id);
  assert.equal((await ok("records.me")).person, status.id, "records.me is the identity");
  assert.equal(d.kernel.id.owner, status.id, "the kernel's owner is the identity");
  const tg = await deck("wink.pair.targets");
  if (!tg.error) assert.ok(tg.data.targets.some(x => x.kind === "identity" && x.id === status.id), `the pairing's identity target is the claimed identity: ${JSON.stringify(tg.data.targets)}`);
  void ownerChain;
});

test("the claimed identity is the home kernel's owner at once (no spaces call after the claim), on a fresh home, and on an existing home that claimed before the kernel ran", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const cfg = (/** @type {string} */ root, /** @type {string} */ name) => fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name, transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const lines = /** @type {string[]} */ ([]);
  const agree = async (/** @type {string} */ root, /** @type {any} */ d, /** @type {string} */ label) => {
    const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "cli" });
    const st = await deck("spaces.identity.status");
    assert.ok(!st.error, label + JSON.stringify(st.error));
    // records.me is the kernel's own tool: it must already name the identity, with no spaces call in between
    let me = await deck("records.me");
    for (let i = 0; i < 20 && !me.error && me.data.person !== st.data.id; i++) { await new Promise(r => setTimeout(r, 100)); me = await deck("records.me"); }
    assert.ok(!me.error, label + JSON.stringify(me.error));
    assert.equal(me.data.person, st.data.id, `${label}: records.me is the identity :: ${lines.filter(l => /owner|identity|adopt/i.test(l)).join(" ; ").slice(0, 600)}`);
    assert.equal(d.kernel.id.owner, st.data.id, `${label}: the kernel's owner is the identity`);
    const tg = await deck("wink.pair.targets");
    assert.ok(!tg.error, `${label}: wink.pair.targets ${JSON.stringify(tg.error)}`);
    assert.ok(tg.data.targets.some((/** @type {any} */ x) => x.kind === "identity" && x.id === st.data.id), `${label}: pair targets name the identity :: ${JSON.stringify(tg.data.targets)}`);
  };
  // fresh home: claim, then read at once
  const a = tempHome(t); cfg(a, "fresh-box");
  const da = await start({ root: a, kernel: true, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => da.stop());
  // SF-1 (reviewer-2): calls that return before the first await (module start, a spaces tool BEFORE any claim) must not leave the single-flight guard stuck, or the claim is never adopted
  for (let i = 0; i < 3; i++) assert.ok(!(await call("spaces.identity.status", {}, { root: a, caller: "cli" })).error);
  const casey = await call("spaces.identity.create", { name: "casey" }, { root: a, caller: "cli" });
  assert.ok(!casey.error, JSON.stringify(casey.error));
  await agree(a, da, "fresh home");
  // existing home: claimed with the kernel off, then started with it on
  const b = tempHome(t); cfg(b, "existing-box");
  const off = await start({ root: b, kernel: false, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  const made = await call("spaces.identity.create", { name: "drew" }, { root: b, caller: "cli" });
  assert.ok(!made.error, JSON.stringify(made.error));
  await off.stop();
  const on = await start({ root: b, kernel: true, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => on.stop());
  await agree(b, on, "existing home");
  assert.equal((await call("spaces.identity.status", {}, { root: b, caller: "cli" })).data.id, made.data.id, "the id did not change");
});

test("lend is the one switch: it makes the kernel's compute offers (the space's side and the member's own) and turning it off withdraws them", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "lend-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  fs.writeFileSync(path.join(root, "dev-presence-stand-in"), ""); // the development stand-in for Face ID (a development build only; every use is logged as a stand-in)
  const lines = /** @type {string[]} */ ([]);
  const d = await start({ root, kernel: true, presence: present, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  const standIn = { "x-vyre-kernel-proof": Buffer.from(JSON.stringify({ method: "stand-in" })).toString("base64url") };
  const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "cli", headers: standIn });
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await deck(tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)} :: ${lines.slice(-6).join(" ; ").slice(0, 600)}`); return r.data; };
  const made = await ok("spaces.identity.create", { name: "alex" });
  const sp = await ok("spaces.create", { name: "lenddev", home: { kind: "this-computer", confirmed: true } });
  const hosted = d.kernel.spaces.hosted(sp.space);
  const q = { member: made.id, device: made.eid, device_key: made.eid };
  assert.deepEqual(hosted.gateway.grants.offers.active(q), { spaceAllows: false, memberAccepts: false });
  const on = await ok("spaces.devices.lend", { space: sp.space, device: made.eid, on: true });
  assert.equal(on.lent, true);
  assert.deepEqual(hosted.gateway.grants.offers.active(q), { spaceAllows: true, memberAccepts: true }, "one switch made both kernel offers");
  assert.equal((await ok("spaces.devices.lend.status", { space: sp.space, device: made.eid })).lent, true);
  const off = await ok("spaces.devices.lend", { space: sp.space, device: made.eid, on: false });
  assert.equal(off.lent, false);
  assert.deepEqual(hosted.gateway.grants.offers.active(q), { spaceAllows: false, memberAccepts: false }, "off withdrew both");
  // taking the device out of the space takes the offers with it, and the stored first grant goes too
  assert.equal((await ok("spaces.devices.lend", { space: sp.space, device: made.eid, on: true })).lent, true);
  assert.deepEqual(hosted.gateway.grants.offers.active(q), { spaceAllows: true, memberAccepts: true });
  await ok("spaces.devices.remove", { space: sp.space, device: made.eid });
  assert.deepEqual(hosted.gateway.grants.offers.active(q), { spaceAllows: false, memberAccepts: false }, "a removed device is not lent");
  assert.equal((await ok("spaces.devices.lend.status", { space: sp.space, device: made.eid })).first_grant_at, null);
});

test("PA-1: creating a space is all or nothing in the kernel's registry too: a refused name, ten failures and a cancel leave no hosted Space and no folder", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "pa1-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, kernel: true, log: () => {} });
  t.after(() => d.stop());
  const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "cli" });
  assert.ok(!(await deck("spaces.identity.create", { name: "alex" })).error);
  const hostedCount = () => d.kernel.spaces.list().length;
  const folders = () => { try { return fs.readdirSync(path.join(root, "kernel", "spaces")).length; } catch { return 0; } };
  const first = await deck("spaces.create", { name: "harlow", home: { kind: "this-computer", confirmed: true } });
  assert.equal(first.data && first.data.status, "done", JSON.stringify(first));
  const base = [hostedCount(), folders()];
  // the same name again is refused: nothing is left behind, however often it is tried
  for (let i = 0; i < 10; i++) {
    const r = await deck("spaces.create", { name: "harlow", home: { kind: "this-computer", confirmed: true } });
    assert.ok(r.error || (r.data && r.data.status !== "done"), `try ${i}: ${JSON.stringify(r)}`);
    assert.deepEqual([hostedCount(), folders()], base, `try ${i} left a hosted Space behind: ${JSON.stringify(r).slice(0, 200)}`);
  }
  // a creation that is waiting (this computer not yet confirmed) holds one Space; cancel gives it back
  const w = await deck("spaces.create", { name: "northwind", home: { kind: "this-computer" } });
  assert.ok(!w.error, JSON.stringify(w.error));
  const wid = w.data.space;
  const cancelled = await deck("spaces.cancel", { space: wid });
  assert.ok(!cancelled.error, JSON.stringify(cancelled.error));
  assert.deepEqual([hostedCount(), folders()], base, "cancel took the kernel's Space back");
  assert.ok(!(await deck("spaces.list")).data.some((/** @type {any} */ x) => x.id === wid), "and it is not listed");
  // a creation whose kernel Space was taken back (a failed step retires it) is hosted again under the SAME id when the person resumes it, and finishes
  const w2 = await deck("spaces.create", { name: "juno", home: { kind: "this-computer" } });
  assert.ok(!w2.error, JSON.stringify(w2.error));
  const jid = w2.data.space;
  assert.deepEqual(await d.kernel.spaces.retire(jid), { retired: true });
  assert.ok(!d.kernel.spaces.hosts(jid), "taken back");
  const back = await deck("spaces.resume", { space: jid, confirmThisComputer: true });
  assert.ok(!back.error, JSON.stringify(back.error));
  assert.equal(back.data.status, "done", JSON.stringify(back.data));
  assert.ok(d.kernel.spaces.hosts(jid), "hosted again under the same id");
  assert.equal(back.data.space, jid);
  // the finished space still works
  assert.ok(!(await deck("spaces.get", { space: first.data.space })).error);
});

test("a Space this home hosted with the first-start owner (made before the claim, or by an older build) takes the claimed identity as its owner too (devbox)", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "hosted-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, kernel: true, log: () => {} });
  t.after(() => d.stop());
  const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "cli" });
  // a Space hosted for the home's first-start owner, before any identity exists
  const old = d.kernel.id.owner;
  const stale = await d.kernel.spaces.host({ owner: old, name: "stale" });
  assert.equal((await stale.gateway.grants.members.list(stale.kernel.chains.fromFacts({ kind: "device", device_key_id: "d", person: old, path: "direct", session: "s" }))).map((/** @type {any} */ m) => m.person)[0], old);
  const made = await deck("spaces.identity.create", { name: "alex" });
  assert.ok(!made.error, JSON.stringify(made.error));
  assert.ok(!(await deck("spaces.list")).error);
  const chain = stale.kernel.chains.fromFacts({ kind: "device", device_key_id: "d", person: made.data.id, path: "direct", session: "s" });
  const members = await stale.gateway.grants.members.list(chain);
  assert.deepEqual(members.map((/** @type {any} */ m) => [m.person, m.role]), [[made.data.id, "owner"]], "the hosted Space's owner is the identity, the old id is gone");
});

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
  const r = await deck("spaces.identity.republish");
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
  assert.ok((await deck("spaces.list")).data.every((/** @type {any} */ x) => x.id !== home), "the home is not listed as a space the person made");
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
  const w = (await deck("spaces.create", { name: "cancelme", home: { kind: "this-computer" } })).data;
  assert.equal(await enrolled(dev, w.space), false, "still being made");
  assert.ok(!(await deck("spaces.cancel", { space: w.space })).error);
  assert.equal(await enrolled(dev, w.space), false, "cancelled");
  // a finished space of the person's: enrolled, and not once the kernel says the person is no longer a member of it
  const fin = (await deck("spaces.create", { name: "finishedone", home: { kind: "this-computer", confirmed: true } })).data;
  assert.equal(await enrolled(dev, fin.space), true);
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
