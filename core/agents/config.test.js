// @ts-check
// agents: the configuration page's server half (config.js): the instructions file, context uploads and links, the Vault list, where it is used. Temp home only.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { contextBrief, contextName } from "./config.js";
import { agentPart } from "../../lib/files/layout.js";

async function boot(/** @type {any} */ t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], projectsDir: path.join(root, "projects"), vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  return { root, c: (/** @type {string} */ tool, /** @type {any} */ input = {}, /** @type {string} */ as = "local") => d.registry.call(tool, input, as) };
}

test("AGENTS.md is the agent's only instructions file (a version); CLAUDE.md cannot be written; old notes are appended once under Notes", async t => {
  const { c } = await boot(t);
  await c("agents.create", { name: "intake", kind: "agent", projects: [], instructions: "Draft intake." });
  assert.deepEqual((await c("agents.docs.get", { agent: "intake" })).data.files, { "AGENTS.md": "Draft intake." });
  assert.equal((await c("agents.docs.set", { agent: "intake", file: "AGENTS.md", text: "Draft intake, kindly.\n" })).error, undefined);
  const refused = await c("agents.docs.set", { agent: "intake", file: "CLAUDE.md", text: "Use plain words.\n" });
  assert.equal(refused.error.code, "bad_input");
  assert.match(refused.error.message, /Instructions live in AGENTS\.md/);
  assert.deepEqual((await c("agents.docs.get", { agent: "intake" })).data.files, { "AGENTS.md": "Draft intake, kindly." });
  const v = (await c("agents.versions", { agent: "intake" })).data.versions;
  assert.equal(v[0].after.instructions, "Draft intake, kindly.", "the edit is a version, so rollback works");
  assert.equal((await c("agents.docs.set", { agent: "intake", file: "NOTES.md", text: "x" })).error.code, "bad_input");
  assert.equal((await c("agents.docs.set", { agent: "intake", file: "AGENTS.md", text: "x".repeat(70_000) })).error.code, "bad_input");
  assert.equal((await c("agents.docs.set", { agent: "intake", file: "AGENTS.md", text: "no" }, "mcp:agent:intake")).error.code, "denied", "a model never writes its own instructions");
});

test("notes an older build kept in CLAUDE.md are appended once into AGENTS.md on the next write, and the folder keeps only a pointer", async t => {
  const { c, root } = await boot(t);
  await c("agents.create", { name: "intake", kind: "agent", projects: [], instructions: "Draft intake." });
  const listed = (await c("agents.list", {})).data;
  const a = /** @type {any} */ ((Array.isArray(listed) ? listed : listed.agents).find((/** @type {any} */ x) => x.name === "intake"));
  const kept = path.join(root, agentPart(String(a.uid), "instructions"), "CLAUDE.md");
  fs.mkdirSync(path.dirname(kept), { recursive: true });
  fs.writeFileSync(kept, "Use plain words.\n");
  assert.equal((await c("agents.docs.get", { agent: "intake" })).data.files["AGENTS.md"], "Draft intake.\n\n## Notes\n\nUse plain words.\n", "read: nothing is hidden");
  assert.equal((await c("agents.docs.set", { agent: "intake", file: "AGENTS.md", text: "Draft intake, kindly." })).error, undefined);
  const after = (await c("agents.docs.get", { agent: "intake" })).data.files["AGENTS.md"];
  assert.equal(after, "Draft intake, kindly.\n\n## Notes\n\nUse plain words.", "stored trimmed, as every edit is");
  assert.equal(fs.existsSync(kept), false, "the separate notes file is retired");
  await c("agents.docs.set", { agent: "intake", file: "AGENTS.md", text: after });
  assert.equal((await c("agents.docs.get", { agent: "intake" })).data.files["AGENTS.md"], after, "appended once, never twice");
  assert.equal((await c("agents.instructions", { agent: "intake" }, "module")).data.text, after, "the prompt reads the same text");
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

test("the agent brief names linked folders and Vault item names only; the instructions and context are named by the orientation, never copied", () => {
  const b = contextBrief({ links: ["/p/forms"], items: ["lawmatics-api"] });
  assert.match(b, /\/p\/forms/);
  assert.match(b, /lawmatics-api/);
  assert.ok(!/Use plain words/.test(b));
  assert.equal(contextBrief({ links: [], items: [] }), "");
  assert.equal(contextName("a/b\\c.txt"), "c.txt");
});
