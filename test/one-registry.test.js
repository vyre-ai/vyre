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
import { tempHome } from "./helpers.js";
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
  const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "deck" });
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
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const cfg = (/** @type {string} */ root, /** @type {string} */ name) => fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name, transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const agree = async (/** @type {string} */ root, /** @type {any} */ d, /** @type {string} */ label) => {
    const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "deck" });
    const st = await deck("spaces.identity.status");
    assert.ok(!st.error, label + JSON.stringify(st.error));
    // records.me is the kernel's own tool: it must already name the identity, with no spaces call in between
    let me = await deck("records.me");
    for (let i = 0; i < 20 && !me.error && me.data.person !== st.data.id; i++) { await new Promise(r => setTimeout(r, 100)); me = await deck("records.me"); }
    assert.ok(!me.error, label + JSON.stringify(me.error));
    assert.equal(me.data.person, st.data.id, `${label}: records.me is the identity`);
    assert.equal(d.kernel.id.owner, st.data.id, `${label}: the kernel's owner is the identity`);
    const tg = await deck("wink.pair.targets");
    if (!tg.error) assert.ok(tg.data.targets.some((/** @type {any} */ x) => x.kind === "identity" && x.id === st.data.id), `${label}: pair targets name the identity`);
  };
  // fresh home: claim, then read at once
  const a = tempHome(t); cfg(a, "fresh-box");
  const da = await start({ root: a, kernel: true, log: () => {} });
  t.after(() => da.stop());
  assert.ok(!(await call("spaces.identity.create", { name: "casey" }, { root: a, caller: "deck" })).error);
  await agree(a, da, "fresh home");
  // existing home: claimed with the kernel off, then started with it on
  const b = tempHome(t); cfg(b, "existing-box");
  const off = await start({ root: b, kernel: false, log: () => {} });
  const made = await call("spaces.identity.create", { name: "drew" }, { root: b, caller: "deck" });
  assert.ok(!made.error, JSON.stringify(made.error));
  await off.stop();
  const on = await start({ root: b, kernel: true, log: () => {} });
  t.after(() => on.stop());
  await agree(b, on, "existing home");
  assert.equal((await call("spaces.identity.status", {}, { root: b, caller: "deck" })).data.id, made.data.id, "the id did not change");
});
