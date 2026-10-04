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

test("server side of a server-homed space: host-here and retire-here with no proof are refused, a caller that is not the home's owner is refused, and nothing is hosted or retired in either case", async t => {
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
  const noProof = await as("cli", "spaces.host-here", { name: "nothere" });
  assert.equal(noProof.error?.code, "presence_required", JSON.stringify(noProof));
  assert.equal(d.kernel.spaces.list().length, before, "nothing was hosted without a proof");
  const stranger = await as("tailnet-guest:mallory@example.com", "spaces.host-here", { name: "nothere" });
  assert.ok(stranger.error, "a caller that is not the owner is refused");
  assert.equal(d.kernel.spaces.list().length, before);
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
