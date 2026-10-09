// @ts-check
// A tool that takes a project by its short name (work.template.from-project) passes the registry's projectArg check for an agent granted that project, and is refused (not_found) for an agent with no grant
// or a grant on another project. The manifest entry under test is the real one from core/work/module.json; the tool behind it is a stand-in, since the check runs before the tool does.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { discover, Registry } from "../core/modules/index.js";
import { open } from "../core/store/index.js";
import { Events } from "../kernel/bus.js";
import { tempHome, writeModule } from "./helpers.js";
import { installFakeReach } from "./fixtures/fake-reach.js";

// Only work: the fake reach module owns `agents`, and `memory` needs the real module; those two are covered by test/project-arg.test.js (the declaration) and their own tests.
const TOOLS = [["work", "work.template.from-project"]];

/** The real manifest entry of a tool. @param {string} mod @param {string} name */
function entryOf(mod, name) {
  const m = JSON.parse(fs.readFileSync(new URL(`../core/${mod}/module.json`, import.meta.url), "utf8"));
  const e = (m.does.tools || []).find((/** @type {any} */ x) => (typeof x === "string" ? x : x.name) === name);
  assert.ok(e && typeof e === "object", `${name} has an object entry`);
  return e;
}

test("projectArg on a project short name: granted passes, ungranted and other-project are refused, and the grant's canonical slug is what runs", async (t) => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  for (const [mod, name] of TOOLS) {
    writeModule(root, mod, { does: { reads: [], tools: [entryOf(mod, name)] } }, `
      export default { async start(ctx) { ctx.tool(${JSON.stringify(name)}, { callers: ["mcp", "harness", "cli", "local", "deck"], run: async (input) => ({ ran: input.project }) }); return {}; } };`);
  }
  installFakeReach(root, home, {
    agents: [{ name: "kx", kind: "agent", projects: ["x-law"] }, { name: "ky", kind: "agent", projects: ["y-law"] }, { name: "kn", kind: "agent", projects: [] }],
    projects: [{ slug: "x-law", name: "X Law" }, { slug: "y-law", name: "Y Law" }],
    access: { "x-law:kx": true, "y-law:ky": true },
  });
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, paths: { root: home }, log: () => {} });
  await reg.start([...discover([root])], { role: "local" });
  for (const [, name] of TOOLS) {
    const as = (/** @type {string} */ agent, /** @type {string} */ project) => reg.call(name, { project, task: "t" }, `mcp:agent:${agent}`, { thread: "s1" });
    const first = await as("kx", "x-law"); assert.equal(first.data?.ran, "x-law", `${name}: granted, by short name ${JSON.stringify(first)}`);
    assert.equal((await as("kx", "X Law")).data?.ran, "x-law", `${name}: granted, by display name, run under the canonical slug`);
    assert.equal((await as("kn", "x-law")).error?.code, "not_found", `${name}: no grant`);
    assert.equal((await as("ky", "x-law")).error?.code, "not_found", `${name}: a grant on another project`);
  }
});
