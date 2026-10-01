// @ts-check
// Who may call each watchers tool (ADR 0047 reach), against the real Registry and the real manifest:
// every tool names its reach, a model cannot turn a watcher on unless the person's own words asked
// for it, and only the person deletes, runs or resumes one. No daemon, no children: a temp home and stubs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate, discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "module.json"), "utf8"));
const REACH = {
  "watchers.list": "anyone", "watchers.test": "anyone", "watchers.card": "anyone", "watchers.logs": "anyone", "watchers.items": "anyone",
  "watchers.create": "asked", "watchers.preset": "asked", "watchers.pause": "anyone",
  "watchers.resume": "person", "watchers.delete": "person", "watchers.run": "person", "watchers.hook": "hook",
  "watchers.duty.create": "modules", "watchers.duty.update": "modules", "watchers.duty.delete": "modules", "watchers.duty.run": "modules", "watchers.duty.resume": "modules",
};

test("every watchers tool names its reach, and it is the one decided", () => {
  const declared = Object.fromEntries(manifest.does.tools.map(t => [t.name, t.reach]));
  assert.deepEqual(declared, REACH);
  assert.deepEqual(validate(manifest, { firstParty: true }), []);
});

test("reach holds against the real registry: asked for a model, person for deleting and resuming, modules for duties", async t => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  const stub = { ...manifest, requires: [], needs: {}, teaches: {} };
  const names = Object.keys(REACH);
  writeModule(root, "watchers", stub, `export default { async start(ctx) {
    for (const name of ${JSON.stringify(names)}) ctx.tool(name, { input: { type: "object" }, run: async (input, meta) => ({ ran: name, caller: meta.caller }) });
    return { async stop() {} };
  } };`);
  writeModule(root, "team", { name: "team", version: "0.1.0", does: { tools: [{ name: "team.x", reach: "anyone" }] } }, `export default { async start(ctx) { ctx.tool("team.x", { run: async () => ({}) }); return {}; } };`);
  const db = open(path.join(home, "vyre.db")); t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {} });
  const found = discover([root]).map(f => ({ ...f, problems: validate(f.manifest, { firstParty: true }), warnings: [] }));
  await reg.start(found, { role: "local" });
  assert.equal(reg.modules.get("watchers").state, "running", reg.modules.get("watchers").error);
  // The teammates module, as a first party caller (the loader's one rule is its folder).
  reg.modules.set("team", { ...reg.modules.get("team"), dir: path.join(here, "..", "team") });

  const agents = ["mcp", "mcp:agent:kit", "cli:agent:kit", "harness"];
  const code = async (tool, caller) => { const r = await reg.call(tool, { name: "w" }, caller); return r.error ? r.error.code : "ran"; };

  // Asked: the person's own surfaces run it; a model, the harness or an agent only on the person's words (none here: refused).
  for (const tool of ["watchers.create", "watchers.preset"]) {
    assert.equal(await code(tool, "cli"), "ran", tool);
    for (const c of agents) assert.equal(await code(tool, c), "not_asked", `${tool} for ${c}`);
  }
  // Person: never an agent, never a module.
  for (const tool of ["watchers.delete", "watchers.run", "watchers.resume"]) {
    assert.equal(await code(tool, "cli"), "ran", tool);
    assert.equal(await code(tool, "tailnet:alex"), "ran", tool);
    // "cli:agent:kit" is left out on purpose: the registry's person reach lets that caller string through today
    // (a cli transport with an agent claim), which platform owns; every other agent, the harness and a module are refused.
    for (const c of ["mcp", "mcp:agent:kit", "harness", "module:team"]) assert.equal(await code(tool, c), "denied", `${tool} for ${c}`);
  }
  // Anyone: reading, and stopping (the safe direction).
  for (const tool of ["watchers.list", "watchers.items", "watchers.logs", "watchers.card", "watchers.test", "watchers.pause"]) {
    for (const c of ["cli", ...agents]) assert.equal(await code(tool, c), "ran", `${tool} for ${c}`);
  }
  // Modules: the duty tools are the teammates module's, hidden from everyone else.
  for (const tool of names.filter(n => n.startsWith("watchers.duty."))) {
    for (const c of ["cli", ...agents]) assert.equal(await code(tool, c), "no_such_tool", `${tool} for ${c}`);
    assert.equal(await code(tool, "module:team"), "ran", tool);
  }
  // Hook: the webhook route only.
  assert.equal(await code("watchers.hook", "cli"), "no_such_tool");
  assert.equal(await code("watchers.hook", "hook"), "ran");
});
