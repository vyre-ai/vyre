// @ts-check
// A module whose start fails, or whose registration the registry refuses, may have opened something before it threw. The registry asks the module's own stop() to close it, once, within a bound.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { validate, discover, Registry } from "./index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const good = { name: "notes", version: "0.1.0", does: { tools: ["notes.add"] } };

/** @param {import("node:test").TestContext} t @param {Array<[string, any, string]>} mods */
async function registry(t, mods) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  for (const [name, manifest, src] of mods) writeModule(root, name, manifest, src);
  const db = open(path.join(home, "vyre.db"));
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, rules: undefined });
  await reg.start(discover([root]).map(f => ({ ...f, problems: validate(f.manifest), warnings: [] })), { role: "local" });
  t.after(() => db.close());
  return { reg, home };
}

/** @param {string} mark @param {string} body what start does before it throws, and what stop does */
const mod = (mark, body, stopBody = `fs.appendFileSync(${JSON.stringify(mark)}, "stop\\n");`) =>
  `import fs from "node:fs"; export default { async start(ctx) { fs.appendFileSync(${JSON.stringify(mark)}, "start\\n"); ${body} }, async stop() { ${stopBody} } };`;

test("modules: a refused registration in start() has the module's stop() called, once, and the module is failed", async t => {
  const mark = path.join(tempHome(t), "mark");
  const { reg } = await registry(t, [["notes", good, mod(mark, `ctx.tool("notes.delete-all", { effect: "read", run: async () => 1 }); return {};`)]]);
  assert.equal(reg.status()[0].state, "failed");
  assert.match(reg.status()[0].error, /does not declare/);
  assert.equal(fs.readFileSync(mark, "utf8"), "start\nstop\n");
});

test("modules: a start that throws has the module's stop() called, and a stop that throws changes nothing", async t => {
  const mark = path.join(tempHome(t), "mark");
  const { reg } = await registry(t, [["notes", good, mod(mark, `throw new Error("no database");`, `fs.appendFileSync(${JSON.stringify(mark)}, "stop\\n"); throw new Error("stop failed too");`)]]);
  assert.equal(reg.status()[0].state, "failed");
  assert.match(reg.status()[0].error, /no database/);
  assert.equal(fs.readFileSync(mark, "utf8"), "start\nstop\n");
});

test("modules: a stop() that never settles is given up on within the bound and the next module still starts", { timeout: 30_000 }, async t => {
  const mark = path.join(tempHome(t), "mark");
  const t0 = Date.now();
  const { reg } = await registry(t, [
    ["notes", good, mod(mark, `throw new Error("no database");`, `await new Promise(() => {});`)],
    ["later", { name: "later", version: "0.1.0", does: { tools: ["later.ping"] } }, `export default { async start(ctx) { ctx.tool("later.ping", { effect: "read", run: async () => 1 }); return { async stop() {} }; } };`],
  ]);
  const s = Object.fromEntries(reg.status().map(m => [m.name, m.state]));
  assert.deepEqual([s.notes, s.later], ["failed", "running"]);
  assert.ok(Date.now() - t0 < 15_000, "bounded");
});

test("modules: a module that starts well has its stop() called only when the registry stops", async t => {
  const mark = path.join(tempHome(t), "mark");
  const { reg } = await registry(t, [["notes", good, mod(mark, `ctx.tool("notes.add", { effect: "read", run: async () => 1 }); return { async stop() { fs.appendFileSync(${JSON.stringify(mark)}, "handle-stop\\n"); } };`)]]);
  assert.equal(reg.status()[0].state, "running");
  assert.equal(fs.readFileSync(mark, "utf8"), "start\n", "the module's own stop() is not called for a good start");
  await reg.stop();
  assert.equal(fs.readFileSync(mark, "utf8"), "start\nhandle-stop\n");
});
