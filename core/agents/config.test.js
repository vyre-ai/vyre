// @ts-check
// agents: the configuration page's server half (config.js): the two instruction files, context uploads and links, the Vault list, where it is used. Temp home only.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { contextBrief, contextName } from "./config.js";

async function boot(/** @type {any} */ t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  return { root, c: (/** @type {string} */ tool, /** @type {any} */ input = {}, /** @type {string} */ as = "local") => d.registry.call(tool, input, as) };
}

test("AGENTS.md is the agent's instructions (a version); CLAUDE.md is kept beside it; both read back", async t => {
  const { c } = await boot(t);
  await c("agents.create", { name: "intake", kind: "agent", projects: [], instructions: "Draft intake." });
  assert.deepEqual((await c("agents.docs.get", { agent: "intake" })).data.files, { "AGENTS.md": "Draft intake.", "CLAUDE.md": "" });
  assert.equal((await c("agents.docs.set", { agent: "intake", file: "AGENTS.md", text: "Draft intake, kindly.\n" })).error, undefined);
  assert.equal((await c("agents.docs.set", { agent: "intake", file: "CLAUDE.md", text: "Use plain words.\n" })).error, undefined);
  assert.deepEqual((await c("agents.docs.get", { agent: "intake" })).data.files, { "AGENTS.md": "Draft intake, kindly.", "CLAUDE.md": "Use plain words.\n" });
  const v = (await c("agents.versions", { agent: "intake" })).data.versions;
  assert.equal(v[0].after.instructions, "Draft intake, kindly.", "the edit is a version, so rollback works");
  assert.equal((await c("agents.docs.set", { agent: "intake", file: "NOTES.md", text: "x" })).error.code, "bad_input");
  assert.equal((await c("agents.docs.set", { agent: "intake", file: "CLAUDE.md", text: "x".repeat(70_000) })).error.code, "bad_input");
  assert.equal((await c("agents.docs.set", { agent: "intake", file: "AGENTS.md", text: "no" }, "mcp:agent:intake")).error.code, "denied", "a model never writes its own instructions");
});

test("context: a file is kept under agents/<id>/context, listed, replaced by name and removed; a path in the name is only a name", async t => {
  const { c, root } = await boot(t);
  const made = (await c("agents.create", { name: "intake", kind: "agent", projects: [] })).data;
  const add = await c("agents.context.add", { agent: "intake", name: "../../brief.txt", base64: Buffer.from("hello").toString("base64") });
  assert.equal(add.error, undefined, JSON.stringify(add));
  assert.equal(add.data.name, "brief.txt");
  assert.equal(fs.readFileSync(path.join(root, "agents", made.uid, "context", "brief.txt"), "utf8"), "hello");
  assert.equal(fs.statSync(path.join(root, "agents", made.uid, "context", "brief.txt")).mode & 0o077, 0, "only the owner can read it");
  assert.deepEqual((await c("agents.context.list", { agent: "intake" })).data.files.map((/** @type {any} */ f) => [f.name, f.size]), [["brief.txt", 5]]);
  await c("agents.context.add", { agent: "intake", name: "brief.txt", base64: Buffer.from("hello again").toString("base64") });
  assert.equal((await c("agents.context.list", { agent: "intake" })).data.files[0].size, 11, "the same name replaces");
  assert.equal((await c("agents.context.add", { agent: "intake", name: "..", base64: "QQ==" })).error.code, "bad_input");
  assert.equal((await c("agents.context.add", { agent: "intake", name: "big.bin", base64: "A".repeat(15 * 1024 * 1024) })).error.code, "bad_input");
  assert.equal((await c("agents.context.remove", { agent: "intake", name: "brief.txt" })).error, undefined);
  assert.equal((await c("agents.context.remove", { agent: "intake", name: "brief.txt" })).error.code, "not_found");
  assert.deepEqual((await c("agents.context.list", { agent: "intake" })).data.files, []);
});

test("context: a folder links only when it lies inside one of the agent's projects, so linking never widens its reach", async t => {
  const { c, root } = await boot(t);
  const inside = path.join(root, "work", "intake-forms");
  fs.mkdirSync(inside, { recursive: true });
  const outside = path.join(root, "elsewhere");
  fs.mkdirSync(outside);
  await c("agents.create", { name: "intake", kind: "agent", projects: [] });
  const refused = await c("agents.context.link", { agent: "intake", path: inside });
  assert.equal(refused.error.code, "denied");
  assert.match(refused.error.message, /not inside one of its projects/);
  assert.equal((await c("agents.context.link", { agent: "intake", path: "relative/dir" })).error.code, "bad_input");
  assert.equal((await c("agents.context.link", { agent: "intake", path: path.join(root, "nope") })).error.code, "bad_input");
  assert.deepEqual((await c("agents.context.list", { agent: "intake" })).data.links, []);
  void outside;
});

test("vault: a name goes on the agent's list and out again; it grants nothing, and a model cannot put one there", async t => {
  const { c } = await boot(t);
  await c("agents.create", { name: "intake", kind: "agent", projects: [] });
  assert.equal((await c("agents.vault.assign", { agent: "intake", item: "lawmatics-api" })).error, undefined);
  assert.equal((await c("agents.vault.assign", { agent: "intake", item: "lawmatics-api" })).error, undefined, "twice is once");
  assert.deepEqual((await c("agents.vault.list", { agent: "intake" })).data.assigned, ["lawmatics-api"]);
  assert.equal((await c("agents.vault.assign", { agent: "intake", item: "../x\n" })).error.code, "bad_input");
  assert.equal((await c("agents.vault.assign", { agent: "intake", item: "mail" }, "mcp:agent:intake")).error.code, "denied");
  assert.equal((await c("agents.vault.unassign", { agent: "intake", item: "lawmatics-api" })).error, undefined);
  assert.deepEqual((await c("agents.vault.list", { agent: "intake" })).data.assigned, []);
});

test("used: an agent with no chats and no flows answers with empty lists, not an error", async t => {
  const { c } = await boot(t);
  await c("agents.create", { name: "intake", kind: "agent", projects: [] });
  const u = await c("agents.used", { agent: "intake" });
  assert.equal(u.error, undefined, JSON.stringify(u));
  assert.deepEqual([Array.isArray(u.data.chats), Array.isArray(u.data.flows)], [true, true]);
  assert.equal((await c("agents.used", { agent: "nobody" })).error.code, "not_found");
});

test("the brief carries CLAUDE.md, context file names, linked folders and Vault item names, never a content or a value", () => {
  const b = contextBrief({ dir: "/h/agents/agt_1/context", files: ["brief.pdf"], links: ["/p/forms"], items: ["lawmatics-api"], claude: "Use plain words." });
  assert.match(b, /Use plain words\./);
  assert.match(b, /brief\.pdf/);
  assert.match(b, /\/p\/forms/);
  assert.match(b, /lawmatics-api/);
  assert.equal(contextBrief({ dir: "/d", files: [], links: [], items: [], claude: "" }), "");
  assert.equal(contextName("a/b\\c.txt"), "c.txt");
});
