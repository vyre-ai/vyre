// @ts-check
// An added module ships a Kit (record types, fields, a link to projects), and an upgrade keeps everything: on a real daemon, a sandboxed module is installed, its Kit approved, its records made
// and linked to a project, then a new version of the module and of its Kit replaces it and every old record, table row and link is still there. Also what a module's Kit may not be.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { canonical } from "../kernel/core/canonical.js";
import { compile } from "../records/language/compile.js";
import { kernelKit, moduleKitProblems } from "../records/kit-adapter.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 25_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); } };
const presence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => { return q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof"; } }; };

const kitSource = (/** @type {number} */ version, /** @type {string} */ extra) => `import { defineKit, defineType, defineField } from "@vyre/sdk";
export const Item = defineType({
  name: "tasker_item", label: "Item",
  fields: {
    title: defineField.text({ label: "Title", required: true }),
    project: defineField.link({ to: "project", label: "Project", inverse: { name: "tasker_items", label: "Items" } }),
    done: defineField.boolean({ label: "Done" }),${extra}
  },
});
export default defineKit({ id: "tasker", version: ${version}, label: "Tasker", description: "Items that belong to a project", includes: [Item] });`;

const moduleSource = (/** @type {string} */ migrations, /** @type {string} */ add) => `export default { async start(ctx) {
  await ctx.store.migrate(${migrations});
  ctx.tool("tasker.add", { input: { type: "object" }, run: async ({ title, project, priority }) => {
    const made = await ctx.kernel.records.create("tasker_item", ${add});
    await ctx.store.exec("INSERT INTO tasker_log (urn) VALUES (?)", [made.urn]);
    return { urn: made.urn };
  } });
  ctx.tool("tasker.count", { effect: "read", input: { type: "object" }, run: async () => ({ n: (await ctx.store.query("SELECT COUNT(*) AS n FROM tasker_log"))[0].n, list: (await ctx.kernel.records.list("tasker_item", { limit: 50 })).rows.length }) });
  return {};
} };`;

const writeModule = (/** @type {string} */ dir, /** @type {string} */ version, /** @type {string} */ migrations, /** @type {string} */ add, /** @type {any} */ kit) => {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify({ name: "tasker", version, vyre: "1", description: "Items that belong to a project.",
    does: { tools: [{ name: "tasker.add", reach: "anyone", summary: "add an item" }, { name: "tasker.count", reach: "anyone", effect: "read", summary: "count items" }], kits: ["kit.json"] },
    needs: { kernel: { records: ["tasker_item"] } } }));
  fs.writeFileSync(path.join(dir, "index.js"), moduleSource(migrations, add));
  fs.writeFileSync(path.join(dir, "kit.json"), JSON.stringify(kit));
};

test("an added module ships a Kit, and an upgrade keeps its records, its tables, its links and its tools", { timeout: 300_000, skip: process.platform !== "linux" ? "the added-module sandbox needs bwrap (linux)" : false }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  const dir = path.join(root, "modules", "tasker");
  const kit1 = compile(kitSource(1, ""));
  writeModule(dir, "0.1.0", JSON.stringify(["CREATE TABLE tasker_log (id INTEGER PRIMARY KEY AUTOINCREMENT, urn TEXT)"]), "{ title, ...(project ? { project } : {}) }", kit1);
  const boot = () => start({ root, log: () => {}, kernel: true, kernelPresence: presence() });
  let d = await boot();
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const chainOf = (/** @type {any} */ x) => x.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = async (/** @type {any} */ x) => ({ token: (await x.kernel.surfaces.open(chainOf(x), {})).token });
  assert.equal(d.registry.status().find((/** @type {any} */ m) => m.name === "tasker")?.state, "running");

  /** The way `vyre module add` proposes a module's Kit file, and the owner's yes. */
  const install = async (/** @type {any} */ x, /** @type {any} */ kit, /** @type {number} */ version) => {
    const p = await x.registry.call("flows.kit.propose", { kit, module: "tasker" }, "cli", await meta(x));
    assert.ok(p.data && p.data.ok, JSON.stringify(p));
    const row = await x.kernel.gateway.ask.get(chainOf(x), p.data.task);
    await x.kernel.gateway.ask.decide(chainOf(x), p.data.task, { outcome: "approved", proof: { op: "task.decide", fields: { task: p.data.task, payload_hash: row.payload.payload_hash, decision: row.payload.decision }, n: Math.random() } });
    await until(async () => ((await x.registry.call("flows.kit.list", {}, "cli", await meta(x))).data || []).find((/** @type {any} */ k) => (k.id ?? k.kit_id) === "tasker" && k.status === "installed" && Number(k.version) === version), `Kit tasker v${version} to install`);
  };
  await install(d, kit1, 1);
  const types1 = (await d.kernel.store.types()).find((/** @type {any} */ x) => x.name === "tasker_item");
  assert.deepEqual(types1.fields.map((/** @type {any} */ f) => f.name).filter((/** @type {string} */ n) => ["title", "project", "done"].includes(n)), ["title", "project", "done"]);

  // a project, and two items, one of them on the project
  const project = await d.kernel.gateway.records.create(chainOf(d), "project", { name: "Harlow intake" });
  const a = (await d.registry.call("tasker.add", { title: "Call the court", project: project.urn }, "local")).data;
  const b = (await d.registry.call("tasker.add", { title: "File the motion" }, "local")).data;
  assert.ok(a && a.urn && b && b.urn, "the module made records of the type its Kit defined");
  const linked = (await d.registry.call("records.linked", { urn: project.urn }, "cli", await meta(d))).data;
  assert.ok(JSON.stringify(linked).includes(a.urn) && !JSON.stringify(linked).includes(b.urn), `the project shows exactly the item linked to it: ${JSON.stringify(linked).slice(0, 200)}`);
  assert.deepEqual((await d.registry.call("tasker.count", {}, "local")).data, { n: 2, list: 2 });

  // the upgrade: a new version of the module (a migration adds a column, the tool fills it) and of its Kit (a new field), on a fresh start
  await d.stop();
  const kit2 = compile(kitSource(2, `\n    priority: defineField.choice(["Low", "High"], { label: "Priority" }),`));
  writeModule(dir, "0.2.0", JSON.stringify(["CREATE TABLE tasker_log (id INTEGER PRIMARY KEY AUTOINCREMENT, urn TEXT)", "ALTER TABLE tasker_log ADD COLUMN note TEXT"]), "{ title, ...(project ? { project } : {}), ...(priority ? { priority } : {}) }", kit2);
  d = await boot();
  assert.equal(d.registry.status().find((/** @type {any} */ m) => m.name === "tasker")?.state, "running", "the new version starts");
  assert.deepEqual((await d.registry.call("tasker.count", {}, "local")).data, { n: 2, list: 2 }, "the module's table and the Space's records are as they were");
  const diff = (await d.registry.call("flows.kit.diff", { kit: kit2, module: "tasker" }, "cli", await meta(d))).data;
  assert.ok(JSON.stringify(diff).includes("priority"), `the update shows the new field: ${JSON.stringify(diff).slice(0, 300)}`);
  await install(d, kit2, 2);
  const c = (await d.registry.call("tasker.add", { title: "Send the invoice", project: project.urn, priority: "High" }, "local")).data;
  assert.ok(c && c.urn);
  const got = (await d.registry.call("records.get", { urn: a.urn }, "cli", await meta(d))).data;
  assert.equal(got.data.title, "Call the court", "the old record is intact after the Kit's update");
  assert.equal(String(got.data.project).endsWith(project.urn.split("/").pop()), true, "and still on its project");
  const linked2 = JSON.stringify((await d.registry.call("records.linked", { urn: project.urn }, "cli", await meta(d))).data);
  assert.ok(linked2.includes(a.urn) && linked2.includes(c.urn), "the project shows the old and the new item");
  assert.deepEqual((await d.registry.call("tasker.count", {}, "local")).data, { n: 3, list: 3 });
  assert.ok(["tasker.add", "tasker.count"].every(n => d.registry.tools.has(n)), "the module's tools are the ones it had");
});

test("what a module's Kit may be: named for the module, no roles, no teammates, no project type, no core type", () => {
  const ok = kernelKit(compile(kitSource(1, "")));
  assert.deepEqual(moduleKitProblems("tasker", ok), []);
  assert.match(moduleKitProblems("other", ok).join(" "), /Kit's id is tasker/);
  const bad = JSON.parse(JSON.stringify(ok));
  bad.includes.types.push({ name: "contact", label: "Contact", fields: [] }, { name: "tasker_board", kind: "project", label: "Board", fields: [] });
  bad.includes.roles = [{ name: "boss" }]; bad.includes.teammates = [{ name: "juno" }];
  const why = moduleKitProblems("tasker", bad).join("\n");
  assert.match(why, /type contact is not named for the module/);
  assert.match(why, /tasker_board is a project type/);
  assert.match(why, /role boss: a module's Kit adds no roles/);
  assert.match(why, /teammate juno/);
});

test("a module's Kit given in the stored form is the same as the kernel's form, and a refused one is not proposed", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence() });
  t.after(() => d.stop());
  const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(chain, {})).token });
  const stored = compile(kitSource(1, ""));
  const card = (await d.registry.call("flows.kit.card", { kit: stored, module: "tasker" }, "cli", await meta())).data;
  assert.ok(card && card.ok !== false, JSON.stringify(card).slice(0, 300));
  const refused = (await d.registry.call("flows.kit.propose", { kit: { ...stored, id: "tasker", types: [...stored.types, { name: "contact", label: "Contact", fields: [] }] }, module: "tasker" }, "cli", await meta())).data;
  assert.equal(refused.ok, false);
  assert.match(JSON.stringify(refused.errors), /type contact is not named for the module/);
});
