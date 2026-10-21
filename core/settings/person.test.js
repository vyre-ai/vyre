// @ts-check
// Per person settings: a key declared perPerson keeps its account level in the calling person's own row, in this Space. Two members hold different values, the server-wide value is copied into a
// person's row once, a person is only ever the one on the kernel's chain, and a change to one person's row is shown to and undone by that person alone.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import * as config from "../config/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALEX = "per_" + "a".repeat(26), KIT = "per_" + "k".repeat(26), JUNO = "per_" + "j".repeat(26), MARLOW = "per_" + "m".repeat(26);
const as = (/** @type {string} */ person) => ({ kernelFacts: { kind: "device", device_key_id: "d-" + person.slice(4, 8), person, path: "direct" } });

async function world(t) {
  const root = tempHome(t);
  const p = config.ensure(root);
  const mods = path.join(path.dirname(root), "mods-" + path.basename(root));
  fs.mkdirSync(mods, { recursive: true });
  t.after(() => fs.rmSync(mods, { recursive: true, force: true }));
  writeModule(mods, "bakery", { roles: ["box"], requires: [], does: { tools: [] },
    settings: [{ key: "bakery.scheme", group: "appearance", label: "Scheme", type: "enum", enum: ["system", "dark", "paper"], default: "system", levels: ["account"], apply: "live", perPerson: true },
      { key: "bakery.oven", group: "appearance", label: "Oven", type: "string", default: "gas", levels: ["account"], apply: "live" }] },
  "export default { async start() { return { async stop() {} }; } };");
  const found = [...discover([CORE]).filter(f => f.manifest && f.manifest.name === "settings"), ...discover([mods], { firstPartyRoots: [mods] })];
  const db = open(p.db);
  const events = new Events(db);
  // the kernel's chain for a call: the person the daemon put on it, one hop; nothing for a call without one
  const kernelFor = () => ({ space: "spc_aaaaaaaaaaaa", owner: ALEX, for: () => null, proofFrom: () => ({}), serviceChain: () => ({}),
    chain: async (/** @type {any} */ meta) => { const who = meta && meta.kernelFacts && meta.kernelFacts.person; return { hops: who ? [{ actor: { kind: "person", id: who } }] : [] }; } });
  const reg = new Registry({ db, events, config: { role: "box" }, paths: p, log: () => {}, kernelFor });
  await reg.start(found, { role: "box" });
  t.after(async () => { await reg.stop(); db.close(); });
  assert.equal(reg.modules.get("settings")?.state, "running", reg.modules.get("settings")?.error);
  assert.equal(reg.modules.get("bakery")?.state, "running", reg.modules.get("bakery")?.error);
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ meta) => { const r = await reg.call(tool, input, caller, meta); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  return { reg, ok, root };
}

test("per person: two members of one Space hold different themes, and neither moves the other's", async t => {
  const w = await world(t);
  assert.equal((await w.ok("settings.get", { key: "bakery.scheme" }, "cli", as(ALEX))).value, "system", "the default until someone chooses");
  await w.ok("settings.set", { key: "bakery.scheme", value: "dark", level: "account" }, "cli", as(ALEX));
  await w.ok("settings.set", { key: "bakery.scheme", value: "paper", level: "account" }, "cli", as(KIT));
  assert.equal((await w.ok("settings.get", { key: "bakery.scheme" }, "cli", as(ALEX))).value, "dark");
  assert.equal((await w.ok("settings.get", { key: "bakery.scheme" }, "cli", as(KIT))).value, "paper");
  assert.equal((await w.ok("settings.get", { key: "bakery.scheme" }, "cli", as(JUNO))).value, "system", "a third member has chosen nothing");
  // a key not declared perPerson stays server-wide
  await w.ok("settings.set", { key: "bakery.oven", value: "wood", level: "account" }, "cli", as(ALEX));
  assert.equal((await w.ok("settings.get", { key: "bakery.oven" }, "cli", as(KIT))).value, "wood");
  // a reset puts one person back on the server-wide value and touches no one else
  await w.ok("settings.reset", { key: "bakery.scheme", level: "account" }, "cli", as(ALEX));
  assert.equal((await w.ok("settings.get", { key: "bakery.scheme" }, "cli", as(ALEX))).value, "system");
  assert.equal((await w.ok("settings.get", { key: "bakery.scheme" }, "cli", as(KIT))).value, "paper");
  assert.equal((await w.ok("settings.schema", {}, "cli", as(KIT))).keys.find((/** @type {any} */ k) => k.key === "bakery.scheme").perPerson, true);
});

test("per person: the server-wide value is copied into a person's row once, the first time they read, and later server-wide changes do not reach it", async t => {
  const w = await world(t);
  await w.reg.call("settings.write", { key: "bakery.scheme", value: "paper" }, "module:bakery");
  assert.equal((await w.ok("settings.get", { key: "bakery.scheme" }, "cli", as(MARLOW))).value, "paper", "copied at the first read");
  await w.reg.call("settings.write", { key: "bakery.scheme", value: "dark" }, "module:bakery");
  assert.equal((await w.ok("settings.get", { key: "bakery.scheme" }, "cli", as(MARLOW))).value, "paper", "that person keeps their own copy");
  assert.equal((await w.ok("settings.get", { key: "bakery.scheme" }, "cli", as(JUNO))).value, "dark", "a person who first reads now copies the value now in effect");
});

test("per person: the person is the one on the kernel's chain; a call with none writes nothing, and what a caller sends does not name one", async t => {
  const w = await world(t);
  const r = await w.reg.call("settings.set", { key: "bakery.scheme", value: "dark", level: "account" }, "cli", {});
  assert.equal(r.error?.code, "denied", "no person on the chain: nobody's row is written");
  const named = await w.reg.call("settings.set", { key: "bakery.scheme", value: "dark", level: "account", person: KIT }, "cli", as(ALEX));
  assert.equal(named.error?.code, "bad_input", "a person named in the input is not even a field of the call");
  await w.ok("settings.set", { key: "bakery.scheme", value: "dark", level: "account" }, "cli", as(ALEX));
  assert.equal((await w.ok("settings.get", { key: "bakery.scheme" }, "cli", as(ALEX))).value, "dark", "the row written is the chain's person's");
  assert.equal((await w.ok("settings.get", { key: "bakery.scheme" }, "cli", as(KIT))).value, "system", "Kit's own row was not touched");
  // the per-person tools are for modules only, and a module writes only its own keys
  assert.ok((await w.reg.call("settings.person.get", { person: ALEX }, "cli", as(ALEX))).error, "a person's surface cannot ask for another's row");
  assert.ok((await w.reg.call("settings.person.set", { person: ALEX, key: "bakery.scheme", value: "paper" }, "cli", as(ALEX))).error);
  assert.match((await w.reg.call("settings.person.set", { person: KIT, key: "bakery.oven", value: "wood" }, "module:bakery")).error?.message || "", /not a per-person setting/, "only a per-person key");
  assert.equal((await w.ok("settings.person.set", { person: KIT, key: "bakery.scheme", value: "paper" }, "module:bakery")).ok, true);
  assert.deepEqual((await w.ok("settings.person.get", { person: KIT }, "module:bakery")).values, { "bakery.scheme": "paper" });
  assert.equal((await w.ok("settings.person.get", { holds: { key: "bakery.scheme", value: "paper" } }, "module:bakery")).holds, true);
  assert.equal((await w.ok("settings.person.get", { holds: { key: "bakery.scheme", value: "nope" } }, "module:bakery")).holds, false);
});

test("per person: a change to one person's row is listed for, and undone by, that person alone", async t => {
  const w = await world(t);
  await w.ok("settings.set", { key: "bakery.scheme", value: "dark", level: "account" }, "cli", as(ALEX));
  const mine = await w.ok("settings.changes", { key: "bakery.scheme" }, "cli", as(ALEX));
  assert.equal(mine.length, 1);
  assert.deepEqual(await w.ok("settings.changes", { key: "bakery.scheme" }, "cli", as(KIT)), [], "another member does not see it");
  assert.equal((await w.reg.call("settings.undo", { change: mine[0].id }, "cli", as(KIT))).error?.code, "denied");
  await w.ok("settings.undo", { change: mine[0].id }, "cli", as(ALEX));
  assert.equal((await w.ok("settings.get", { key: "bakery.scheme" }, "cli", as(ALEX))).value, "system");
});
