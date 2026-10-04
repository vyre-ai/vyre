// @ts-check
// events.catalog: every type the running modules may emit, and renamed types for one release.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { catalog, ALIASES } from "./index.js";

const HERE = import.meta.dirname;
const self = () => ({ dir: HERE, manifest: JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8")), problems: [] });
const idle = `export default { async start() { return {}; } };`;

async function registry(t, opts = {}) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "bakery", { roles: ["local"], watches: { emits: ["order.placed", "files.changed"] } }, idle);
  writeModule(root, "harlow", { roles: ["box"], watches: { emits: ["case.opened"] } }, idle);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {} });
  await reg.start([self(), ...discover([root])], { role: "local", ...opts });
  return reg;
}

test("events: the catalog is what running modules may emit, sorted, and the loader takes a folder named unlike its module", async t => {
  const reg = await registry(t);
  assert.equal(reg.status().find(m => m.name === "events")?.state, "running");
  assert.deepEqual((await reg.call("events.catalog", {}, "cli")).data, [
    { type: "files.changed", module: "bakery" },
    { type: "order.placed", module: "bakery" },
  ], "a module that is off is left out");
  assert.deepEqual(ALIASES, {}, "no renamed types today");
});

test("events: a renamed type is listed as deprecated with the name to use", () => {
  const rows = catalog([{ name: "files", state: "running", emits: ["files.changed"] }], { "file.changed": "files.changed" });
  assert.deepEqual(rows, [
    { type: "file.changed", module: "files", deprecated: true, use: "files.changed" },
    { type: "files.changed", module: "files" },
  ]);
});

test("events: switched off, the catalog is gone and the bus still carries events", async t => {
  const reg = await registry(t, { disable: ["events"] });
  assert.equal((await reg.call("events.catalog", {}, "cli")).error.code, "no_such_tool");
  reg.deps.events.emit("bakery", "order.placed", {});
  assert.equal(reg.deps.events.since(0).at(-1).type, "order.placed");
});
