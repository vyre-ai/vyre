// @ts-check
// skills.list, skills.find and skills.get over a temp home: what each kind of caller may see (the permission system decides, not the query), what ranks first for an intent, and that nothing leaks a path.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import skills, { seams, sourcesOf } from "./index.js";
import { PKG_ROOT } from "../../kernel/devbuild.js";

const skill = (/** @type {string} */ dir, /** @type {string} */ name, /** @type {string} */ description, /** @type {string} */ body = "Steps.") => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`);
};

/** A home with learned skills at every level, a project folder with its own, and the module started on a fake ctx whose projects.reach answers like the real one. */
async function world(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-skills-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "home"), folder = path.join(base, "harlow-folder");
  skill(path.join(home, "learned", "account", "skills"), "send-invoices", "Use when sending invoices to clients and chasing payment");
  skill(path.join(home, "learned", "projects", "harlow", "skills"), "draft-motion", "Use when drafting a motion for the Harlow matter");
  skill(path.join(home, "learned", "projects", "secret-case", "skills"), "hidden-skill", "Use for the secret case only");
  skill(path.join(folder, ".claude", "skills"), "folder-skill", "Use when filing in the Harlow folder");
  skill(path.join(home, "learned", "agents", "juno", "skills"), "juno-only", "Use when juno triages the inbox");
  skill(path.join(home, "learned", "agents", "kit", "skills"), "kit-only", "Use when kit reviews code");
  /** @type {Record<string, any>} */ const tools = {};
  const calls = [];
  /** @type {Record<string, any>} */ const harnesses = {};
  const ctx = {
    paths: { root: home },
    tool: (/** @type {string} */ n, /** @type {any} */ d) => { tools[n] = d; },
    call: async (/** @type {string} */ name, /** @type {any} */ input) => {
      calls.push([name, input]);
      if (name === "sessions.harness.get") return { data: { harnesses: harnesses[input.provider] ? [{ provider: input.provider, caps: harnesses[input.provider] }] : [] } };
      if (name === "projects.list") return { data: { projects: [{ slug: "harlow", home: folder }, { slug: "secret-case", home: path.join(base, "other") }] } };
      if (name !== "projects.reach") return { error: { code: "no_such_tool" } };
      if (input.person) return { data: { all: true, agent: null } };
      if (input.agent === "juno") return { data: { all: false, agent: "juno", projects: [{ slug: "harlow", name: "Harlow", folders: [folder] }] } };
      if (input.agent === "kit") return { data: { all: false, agent: "kit", projects: [] } };
      throw Object.assign(new Error("refused"), { code: "denied" });
    },
  };
  seams.set(home, { pkg: PKG_ROOT });
  t.after(() => seams.delete(home));
  await skills.start(ctx);
  const as = (/** @type {string} */ caller) => ({
    list: (i = {}) => tools["skills.list"].run(i, { caller }),
    find: (i) => tools["skills.find"].run(i, { caller }),
    get: (i) => tools["skills.get"].run(i, { caller }),
  });
  return { home, folder, as, calls, harnesses, tools };
}
const ids = (/** @type {any} */ r) => r.skills.map((/** @type {any} */ s) => s.id).sort();

test("the person sees every level; a named agent sees Vyre's, the account's, its projects' and its own, and no one else's", async (t) => {
  const w = await world(t);
  const person = ids(await w.as("cli").list());
  for (const id of ["vyre/build-a-template", "vyre/turn-this-into-a-flow", "vyre/use-the-vault", "vyre/work-in-a-project", "vyre/write-a-watcher", "account/send-invoices", "project/harlow/draft-motion", "project/harlow/folder-skill", "project/secret-case/hidden-skill", "agent/juno/juno-only", "agent/kit/kit-only"]) assert.ok(person.includes(id), `the person lacks ${id}`);
  const juno = ids(await w.as("mcp:agent:juno").list());
  assert.deepEqual(juno, ["account/send-invoices", "agent/juno/juno-only", "project/harlow/draft-motion", "project/harlow/folder-skill", "vyre/build-a-template", "vyre/turn-this-into-a-flow", "vyre/use-the-vault", "vyre/work-in-a-project", "vyre/write-a-watcher"]);
  const kit = ids(await w.as("mcp:agent:kit").list());
  assert.ok(kit.includes("agent/kit/kit-only") && !kit.some((i) => i.startsWith("project/") || i === "agent/juno/juno-only"), "an agent with no project reach sees no project skill");
});

test("a caller that cannot be placed (an unnamed model session) gets Vyre's own skills and nothing private", async (t) => {
  const w = await world(t);
  assert.deepEqual(ids(await w.as("mcp").list()), ["vyre/build-a-template", "vyre/turn-this-into-a-flow", "vyre/use-the-vault", "vyre/work-in-a-project", "vyre/write-a-watcher"]);
  assert.deepEqual(ids(await w.as("tailnet-guest:x").list()), ["vyre/build-a-template", "vyre/turn-this-into-a-flow", "vyre/use-the-vault", "vyre/work-in-a-project", "vyre/write-a-watcher"]);
});

test("a skill you may not use is not ranked and not readable: it does not exist for you", async (t) => {
  const w = await world(t);
  const hidden = await w.as("mcp:agent:juno").find({ query: "the secret case", limit: 10 });
  assert.ok(!ids(hidden).includes("project/secret-case/hidden-skill"));
  await assert.rejects(w.as("mcp:agent:juno").get({ id: "project/secret-case/hidden-skill" }), (e) => e.code === "not_found");
  await assert.rejects(w.as("mcp").get({ id: "account/send-invoices" }), (e) => e.code === "not_found");
  assert.match((await w.as("mcp:agent:juno").get({ id: "project/harlow/draft-motion" })).text, /# draft-motion/);
  assert.match((await w.as("cli").get({ id: "project/secret-case/hidden-skill" })).text, /hidden-skill/);
});

test("find ranks by what you are about to do, with the docs ranker", async (t) => {
  const w = await world(t);
  const top = async (who, q) => (await w.as(who).find({ query: q, limit: 3 })).skills.map((s) => s.id);
  assert.equal((await top("mcp:agent:juno", "keep a password out of a file"))[0], "vyre/use-the-vault");
  assert.equal((await top("mcp:agent:juno", "write a watcher that reacts to events"))[0], "vyre/write-a-watcher");
  assert.equal((await top("mcp:agent:juno", "drafting a motion"))[0], "project/harlow/draft-motion");
  assert.equal((await top("cli", "chase payment on invoices"))[0], "account/send-invoices");
  assert.ok(!(await top("mcp", "chase payment on invoices")).includes("account/send-invoices"));
  const r = await w.as("cli").find({ query: "vault credential", limit: 1 });
  assert.equal(r.skills.length, 1);
  for (const s of r.skills) { assert.ok(s.description.length > 10 && Number.isInteger(s.tokens) && s.tokens > 0); }
  // the same ranker as the docs tool: one implementation
  assert.match(fs.readFileSync(new URL("./index.js", import.meta.url), "utf8"), /from "\.\.\/\.\.\/lib\/docs-rank\.js"/);
});

test("list narrows by project and level, and no result names a path", async (t) => {
  const w = await world(t);
  assert.deepEqual(ids(await w.as("cli").list({ level: "vyre" })), ["vyre/build-a-template", "vyre/turn-this-into-a-flow", "vyre/use-the-vault", "vyre/work-in-a-project", "vyre/write-a-watcher"]);
  assert.deepEqual(ids(await w.as("cli").list({ project: "harlow", level: "project" })), ["project/harlow/draft-motion", "project/harlow/folder-skill"]);
  const all = JSON.stringify(await w.as("cli").list());
  assert.ok(!all.includes(w.home) && !all.includes(w.folder) && !/SKILL\.md/.test(all), "an id is a name, never a path");
});

test("a malformed name or a huge file is skipped, and a skill with no front matter takes its folder name", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-skills-x-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, "harness", "skills", "plain"), { recursive: true });
  fs.writeFileSync(path.join(base, "harness", "skills", "plain", "SKILL.md"), "# no front matter\n");
  fs.mkdirSync(path.join(base, "harness", "skills", "big"), { recursive: true });
  fs.writeFileSync(path.join(base, "harness", "skills", "big", "SKILL.md"), "x".repeat(70 * 1024));
  fs.mkdirSync(path.join(base, "harness", "skills", "bad name"), { recursive: true });
  fs.writeFileSync(path.join(base, "harness", "skills", "bad name", "SKILL.md"), "# x\n");
  const out = sourcesOf({ pkg: base, home: path.join(base, "home"), person: false, agent: null, account: false, projects: [] });
  assert.deepEqual(out.map((s) => s.id), ["vyre/plain"]);
  assert.equal(out[0].name, "plain");
});

test("R031-85: with a harness named, a skill that needs what the harness showed it lacks is left out and named with the reason, a degradable one says what it loses, and no named harness hides nothing", async t => {
  const w = await world(t);
  const lib = path.join(w.home, "learned", "account", "skills");
  fs.mkdirSync(path.join(lib, "fan-out"), { recursive: true });
  fs.writeFileSync(path.join(lib, "fan-out", "SKILL.md"), "---\nname: fan-out\ndescription: Use when splitting a job across helpers\nneeds: [subagents]\n---\n\n# fan-out\n\nUse helpers.\n");
  fs.mkdirSync(path.join(lib, "fan-out-soft"), { recursive: true });
  fs.writeFileSync(path.join(lib, "fan-out-soft", "SKILL.md"), "---\nname: fan-out-soft\ndescription: Use when splitting a job across helpers, softly\nneeds: subagents\ndegrade: it does the parts one after another\n---\n\n# soft\n\nOne by one.\n");
  const list = (i = {}) => w.tools["skills.list"].run(i, { caller: "cli" });
  const find = (i) => w.tools["skills.find"].run(i, { caller: "cli" });
  assert.ok(ids(await list()).includes("account/fan-out"), "nothing is hidden without a harness");
  assert.ok(ids(await list({ harness: "codex" })).includes("account/fan-out"), "a harness no session has started hides nothing");
  w.harnesses.codex = { subagents: false, skills: true };
  const r = await list({ harness: "codex" });
  assert.ok(!ids(r).includes("account/fan-out"));
  assert.deepEqual(r.hidden, [{ id: "account/fan-out", reason: "needs subagents; codex does not offer subagents" }]);
  const soft = r.skills.find(s => s.id === "account/fan-out-soft");
  assert.equal(soft.works, "degraded");
  assert.match(soft.reason, /codex does not offer subagents; without it: it does the parts one after another/);
  assert.deepEqual(soft.needs, ["subagents"]);
  const found = await find({ query: "splitting a job across helpers", harness: "codex" });
  assert.ok(!found.skills.some(s => s.id === "account/fan-out") && found.skills.some(s => s.id === "account/fan-out-soft"));
  w.harnesses.claude = { subagents: true };
  assert.ok(ids(await list({ harness: "claude" })).includes("account/fan-out"), "a harness that showed it has them keeps both");
  assert.equal((await list({ harness: "claude" })).hidden, undefined);
});
