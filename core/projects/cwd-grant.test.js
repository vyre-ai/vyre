// @ts-check
// An agent's folder is judged on its real path, and the tool runs on that path: a `..` or a symlink into another project
// is refused, and what gets through is the canonical folder (cwdArg, core/modules/index.js + projects.of).

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import * as config from "../config/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const CORE = path.resolve(import.meta.dirname, "..");

async function world(t) {
  // Registered first, so the registry stops and its database closes before the temp home is removed.
  /** @type {any} */ let reg = null, db = null;
  t.after(async () => { if (reg) await reg.stop(); if (db) db.close(); });
  const root = fs.realpathSync(tempHome(t));
  const north = path.join(root, "work", "northwind"), harlow = path.join(root, "work", "harlow");
  fs.mkdirSync(path.join(north, "src"), { recursive: true });
  fs.mkdirSync(path.join(harlow, "secrets"), { recursive: true });
  fs.symlinkSync(harlow, path.join(north, "link-to-harlow"));
  // agents.list / agents.scope: kit is granted northwind only.
  const mods = path.join(root, "mods");
  writeModule(mods, "agents", { version: "0.1.0", roles: ["local"], does: { tools: ["agents.list", "agents.scope"] } }, `export default { async start(ctx) {
    ctx.tool("agents.list", { effect: "read", input: { type: "object" }, run: async () => [{ name: "kit", kind: "agent", projects: ["northwind"] }] });
    ctx.tool("agents.scope", { internal: true, input: { type: "object" }, run: async () => ({ kind: "agent", projects: ["northwind"] }) });
    return {};
  } };`);
  const p = config.ensure(root);
  db = open(p.db);
  reg = new Registry({ db, events: new Events(db), config: { role: "local", projectsDir: path.join(root, "projects"), roots: [] }, paths: p, log: () => {}, firstPartyRoots: [mods] });
  const found = [...discover([CORE]).filter(f => f.manifest && f.manifest.name === "projects"), ...discover([mods], { firstPartyRoots: [mods] })];
  await reg.start(found, { role: "local" });
  assert.equal(reg.modules.get("projects").state, "running", reg.modules.get("projects").error);
  await reg.call("projects.create", { name: "Northwind", home: north }, "cli");
  await reg.call("projects.create", { name: "Harlow", home: harlow }, "cli");
  await reg.call("projects.access.migrate", {}, "cli");
  return { reg, north, harlow };
}

test("cwdArg: an agent's folder is judged on its real path: a `..` or a symlink into another project is refused, and what runs is the canonical folder", async t => {
  const { reg, north, harlow } = await world(t);
  const as = cwd => reg.call("projects.of", { cwd }, "mcp:agent:kit");
  const own = await as(path.join(north, "src"));
  assert.equal(own.data && own.data.slug, "northwind", JSON.stringify(own));
  assert.equal(own.data.folder, path.join(north, "src"), "the canonical folder comes back");
  assert.equal((await as(path.join(north, "src", "..", "..", "harlow"))).error.code, "not_found", "a .. path into another project");
  assert.equal((await as(path.join(north, "link-to-harlow"))).error.code, "not_found", "a symlink inside northwind into harlow");
  assert.equal((await as(path.join(north, "link-to-harlow", "secrets"))).error.code, "not_found", "and under it");
  assert.equal((await as(path.join(harlow, "secrets"))).error.code, "not_found", "the other project directly");
  assert.equal((await as(path.join(north, "src") + path.sep)).data.slug, "northwind", "a trailing slash is the same folder");
  assert.equal((await reg.call("projects.of", { cwd: path.join(harlow, "secrets") }, "cli")).data.slug, "harlow", "the person is unaffected");
});
