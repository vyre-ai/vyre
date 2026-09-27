// @ts-check
// commands.list: the running modules' declared verbs, only those the caller can run, sorted.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const HERE = import.meta.dirname;
const self = () => ({ dir: HERE, manifest: JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8")), problems: [] });

const bakery = { roles: ["local"], does: { tools: ["bakery.orders", "bakery.close", "bakery.inside"],
  commands: [
    { verb: "orders", tool: "bakery.orders", summary: "today's orders", args: ["day"] },
    { verb: "close", tool: "bakery.close", summary: "close the shop" },
    { verb: "inside", tool: "bakery.inside", summary: "only for modules" },
  ] } };
const bakerySrc = `export default { async start(ctx) {
  ctx.tool("bakery.orders", { run: async () => [] });
  ctx.tool("bakery.close", { run: async () => ({}) });
  ctx.tool("bakery.inside", { callers: ["module"], run: async () => ({}) });
  return {};
} };`;
const harlow = { roles: ["box"], does: { tools: ["harlow.cases"], commands: [{ verb: "cases", tool: "harlow.cases", summary: "open cases" }] } };

async function registry(t, opts = {}) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "bakery", bakery, bakerySrc);
  writeModule(root, "harlow", harlow, `export default { async start(ctx) { ctx.tool("harlow.cases", { run: async () => [] }); return {}; } };`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {} });
  await reg.start([self(), ...discover([root])], { role: "local", ...opts });
  return reg;
}

test("commands: every running module's verbs the caller can run, sorted by verb", async t => {
  const reg = await registry(t);
  const r = await reg.call("commands.list", {}, "cli");
  assert.deepEqual(r.data, [
    { module: "bakery", verb: "close", tool: "bakery.close", summary: "close the shop", args: [] },
    { module: "bakery", verb: "orders", tool: "bakery.orders", summary: "today's orders", args: ["day"] },
  ], "a module-only tool and a module that is off are left out");
  assert.deepEqual((await reg.call("commands.list", { surface: "capsule" }, "capsule")).data, r.data, "every surface gets the same list for now");
  assert.equal((await reg.call("commands.list", { surface: "watch" }, "cli")).error.code, "bad_input");
});

test("commands: switched off, the list is gone and the verbs' tools still run", async t => {
  const reg = await registry(t, { disable: ["commands"] });
  assert.equal((await reg.call("commands.list", {}, "cli")).error.code, "no_such_tool");
  assert.deepEqual((await reg.call("bakery.orders", {}, "cli")).data, []);
});
