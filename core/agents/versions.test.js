// @ts-check
// agents: owners, versions and changes by conversation (R031-09). A person's own edit is a version; a model never edits, it proposes; a proposal's draft applies as a new version only on the owner's yes
// and only if the agent has not changed since; rollback writes another version. Temp home only.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

async function boot(/** @type {any} */ t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  return { c: (/** @type {string} */ tool, /** @type {any} */ input = {}, /** @type {string} */ as = "local") => d.registry.call(tool, input, as) };
}

test("a person's edit of an agent is a version; versions list newest first; rollback restores a version as a new one", async t => {
  const { c } = await boot(t);
  await c("agents.create", { name: "kit", kind: "agent", projects: [], instructions: "Be brief." });
  await c("agents.update", { name: "kit", instructions: "Be brief and kind.", effort: "low" });
  await c("agents.update", { name: "kit", instructions: "Write letters.", skills: ["letters"] });
  const v = (await c("agents.versions", { agent: "kit" })).data;
  assert.deepEqual(v.versions.map((/** @type {any} */ x) => x.n), [2, 1]);
  assert.equal(v.versions[0].before.instructions, "Be brief and kind.");
  assert.deepEqual(v.versions[0].after.skills, ["letters"]);
  assert.equal((await c("agents.update", { name: "kit", model: "sonnet" })).error, undefined);
  const back = await c("agents.update", { name: "kit", rollback: 1 });
  assert.equal(back.error, undefined, JSON.stringify(back));
  assert.deepEqual([back.data.instructions, back.data.skills, back.data.effort], ["Be brief and kind.", [], "low"], "as of version 1");
  const after = (await c("agents.versions", { agent: "kit" })).data.versions;
  assert.equal(after[0].note, "rolled back to version 1", "rollback is itself a version");
  assert.equal((await c("agents.update", { name: "kit", rollback: 0 })).data.instructions, "Be brief.", "0 is how it began");
  assert.equal((await c("agents.update", { name: "kit", rollback: 99 })).error.code, "not_found");
});

test("a model does not edit an agent; it proposes, and the error says how", async t => {
  const { c } = await boot(t);
  await c("agents.create", { name: "kit", kind: "agent", projects: [] });
  const r = await c("agents.update", { name: "kit", instructions: "Do as I say." }, "mcp:agent:kit");
  assert.equal(r.error.code, "denied");
  assert.match(r.error.message, /flows\.propose \{ what: "agent"/);
});

test("a draft applies as a version only with its hash, once, and not after the agent changed", async t => {
  const { c } = await boot(t);
  await c("agents.create", { name: "kit", kind: "agent", projects: [], instructions: "Be brief." });
  const d = await c("agents.change.draft", { agent: "kit", patch: { instructions: "Be brief and cite sources.", tags: ["Research"] }, proposer: "per_a", by: "kit" }, "module:vyred");
  assert.equal(d.error, undefined, JSON.stringify(d));
  assert.equal(d.data.title, "Change kit: instructions, tags?");
  assert.equal((await c("agents.change.title", { id: d.data.id, hash: d.data.hash }, "module:vyred")).data, d.data.title);
  assert.equal((await c("agents.change.title", { id: d.data.id, hash: "0".repeat(24) }, "module:vyred")).data, null, "a card for another hash matches nothing");
  const done = await c("agents.change.apply", { id: d.data.id, hash: d.data.hash, approver: "per_owner" }, "module:vyred");
  assert.equal(done.data.version, 1);
  const got = (await c("agents.list")).data.find((/** @type {any} */ a) => a.name === "kit");
  assert.equal(got.instructions, "Be brief and cite sources.");
  assert.equal((await c("agents.versions", { agent: "kit" })).data.versions[0].approved_by, "per_owner");
  assert.equal((await c("agents.change.apply", { id: d.data.id, hash: d.data.hash, approver: "per_owner" }, "module:vyred")).error.code, "not_found", "once");
  // a second draft goes stale when the agent changes before the yes
  const e = await c("agents.change.draft", { agent: "kit", patch: { effort: "high" }, proposer: "per_a" }, "module:vyred");
  await c("agents.update", { name: "kit", effort: "low" });
  assert.equal((await c("agents.change.title", { id: e.data.id, hash: e.data.hash }, "module:vyred")).data, null);
  assert.equal((await c("agents.change.apply", { id: e.data.id, hash: e.data.hash, approver: "per_owner" }, "module:vyred")).error.code, "conflict");
  // permissions are not a proposal's to change; a built-in agent keeps its shape
  assert.match((await c("agents.change.draft", { agent: "kit", patch: { projects: "*" }, proposer: "per_a" }, "module:vyred")).error.message, /permissions/);
  assert.match((await c("agents.change.draft", { agent: "engineer", patch: { skills: ["x"] }, proposer: "per_a" }, "module:vyred")).error.message, /built in/);
});
