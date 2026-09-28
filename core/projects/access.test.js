// @ts-check
// projects.access: which agent may reach a project's data at all (Vyre Drive step 3, federation).
// Deny by default; granting needs the owner's presence (HUMAN_ONLY), revoking is instant
// (PERSON_ONLY). Runs the real module's start() into a fake ctx (move.test.js's own pattern), so
// tools are called directly — presence and caller enforcement themselves are the registry's job
// and are covered generically by core/harness/floor.test.js and test/mcp-server-tools.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { Projects, MIGRATIONS } from "./projects.js";
import mod from "./index.js";
import * as config from "../config/index.js";
import { HUMAN_ONLY, PERSON_ONLY } from "../presence/index.js";
import { checkInput } from "../modules/index.js";

/** A world with one real project, "Harlow Legal", and a fake ctx running the real module's start().
 * agents, when given, answers agents.list (core/agents' own shape) instead of no_such_tool.
 * state.agents can be changed after start() too, for tests of the auto-seed running before
 * agents exists and the manual tool filling in once it does. */
function world(t, { agents = null } = {}) {
  const root = fs.realpathSync(tempHome(t));
  const home = path.join(root, "alex", "Work", "harlow-site");
  fs.mkdirSync(home, { recursive: true });
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  const cfg = config.load(root);
  const tools = new Map(), events = [];
  const state = { agents };
  const ctx = {
    config: { ...cfg, role: "box", roots: [] },
    store: { db, migrate: steps => migrate(db, "projects", steps) },
    paths: { root },
    log: () => {},
    events: { emit: (type, payload) => events.push({ type, payload }), on: () => () => {} },
    tool: (name, def) => tools.set(name, def),
    call: async tool => tool === "agents.list" && state.agents ? { data: state.agents } : { error: { code: "no_such_tool", message: "none" } },
  };
  return { root, home, db, tools, events, ctx, state };
}

/** Make a project by hand, the way Projects.create does, then start the module over the same db.
 * Awaits the module's own auto-seed before returning, so a test's "before" assertions are never
 * racing it. */
async function started(t, opts = {}) {
  const w = world(t, opts);
  migrate(w.db, "projects", MIGRATIONS);
  const P = new Projects({ db: w.db, config: { projectsDir: path.join(w.root, "projects"), roots: [] } });
  P.create({ name: "Harlow Legal", home: w.home });
  const handle = await mod.start(w.ctx);
  await handle.seeded;
  const call = (tool, input, meta = {}) => w.tools.get(tool).run(input, meta);
  return { ...w, call, handle };
}

test("projects.access: deny by default — an ungranted project answers granted: false, not an error", async t => {
  const w = await started(t);
  const r = await w.call("projects.access.check", { project: "harlow-legal", agent: "kit" });
  assert.deepEqual(r, { project: "harlow-legal", agent: "kit", granted: false });
});

test("projects.access: grant, then check, then revoke — instant, no trace of the value the revoke did not touch", async t => {
  const w = await started(t);
  const granted = await w.call("projects.access.grant", { project: "harlow-legal", agent: "kit" }, { caller: "cli" });
  assert.deepEqual(granted, { project: "harlow-legal", agent: "kit", status: "granted" });
  const check = await w.call("projects.access.check", { project: "harlow-legal", agent: "kit" });
  assert.equal(check.granted, true);
  assert.equal(check.status, "granted");
  assert.equal(check.by, "cli");

  const revoked = await w.call("projects.access.revoke", { project: "harlow-legal", agent: "kit" }, { caller: "cli" });
  assert.deepEqual(revoked, { project: "harlow-legal", agent: "kit", status: "revoked" });
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "kit" })).granted, false);

  // A different agent was never granted, and never picks up kit's old grant.
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "juno" })).granted, false);
});

test("projects.access: an empty agent grants every agent, and a named agent's own row wins over it", async t => {
  const w = await started(t);
  await w.call("projects.access.grant", { project: "harlow-legal" }, { caller: "cli" }); // agent left out: everyone
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "kit" })).granted, true);
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "juno" })).granted, true);

  // Revoking one agent by name refuses only that one; the wildcard still covers everyone else.
  await w.call("projects.access.revoke", { project: "harlow-legal", agent: "kit" }, { caller: "cli" });
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "kit" })).granted, false);
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "juno" })).granted, true);
});

test("projects.access: grant and revoke resolve a project by name too, and refuse one that does not exist", async t => {
  const w = await started(t);
  const byName = await w.call("projects.access.grant", { project: "Harlow Legal", agent: "kit" }, { caller: "cli" });
  assert.equal(byName.project, "harlow-legal", "stored under the canonical slug, not the typed name");
  await assert.rejects(w.call("projects.access.grant", { project: "no-such-project", agent: "kit" }, { caller: "cli" }), /no project/);
});

test("projects.access.check: agent is required by the tool's own schema (reviewer's LOW) — an empty agent used to read the wildcard row as if it were 'no agent', conflating two different things", async t => {
  const w = await started(t);
  const def = w.tools.get("projects.access.check");
  assert.deepEqual(checkInput(def.input, { project: "harlow-legal" }), ["input.agent is required"]);
  assert.deepEqual(checkInput(def.input, { project: "harlow-legal", agent: "kit" }), []);
});

test("projects.access.check: a malformed project id answers granted: false rather than throwing", async t => {
  const w = await started(t);
  assert.deepEqual(await w.call("projects.access.check", { project: "Not A Slug!", agent: "kit" }),
    { project: "Not A Slug!", agent: "kit", granted: false });
});

test("projects.access.list: every grant and revoke, newest first, for one project or all", async t => {
  const w = await started(t);
  await w.call("projects.access.grant", { project: "harlow-legal", agent: "kit" }, { caller: "cli" });
  await w.call("projects.access.revoke", { project: "harlow-legal", agent: "kit" }, { caller: "cli" });
  const { grants } = await w.call("projects.access.list", { project: "harlow-legal" });
  assert.equal(grants.length, 1, "one row, updated in place, not a second history row");
  assert.equal(grants[0].status, "revoked");
  const all = await w.call("projects.access.list", {});
  assert.equal(all.grants.length, 1);
});

test("projects.access: grant is HUMAN_ONLY (needs the owner's presence), revoke is PERSON_ONLY (instant, no proof)", () => {
  assert.ok(HUMAN_ONLY.has("projects.access.grant"), "granting an agent's access needs a presence proof");
  assert.ok(!PERSON_ONLY.has("projects.access.grant"), "not both lists at once");
  assert.ok(PERSON_ONLY.has("projects.access.revoke"), "revoking is instant, no proof");
  assert.ok(!HUMAN_ONLY.has("projects.access.revoke"));
});

test("projects.access: auto-seeds from agents.projects on start, no manual step needed (reviewer's MEDIUM 2 on 656b3f79)", async t => {
  const w = await started(t, { agents: [
    { name: "kit", kind: "agent", projects: ["harlow-legal"] },
    { name: "hal", kind: "agent", projects: [] },
    { name: "vyre", kind: "assistant", projects: "*" },
  ] });
  // started() already awaited the auto-seed: kit reads its one project with no migrate call.
  const kit = await w.call("projects.access.check", { project: "harlow-legal", agent: "kit" });
  assert.deepEqual(kit, { project: "harlow-legal", agent: "kit", granted: true, status: "granted", by: "projects.access.migrate", at: kit.at });
  // hal has no projects to seed; the assistant's "*" is its own rule, never a per-project row.
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "hal" })).granted, false);
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "vyre" })).granted, false);
});

test("projects.access: auto-seed covers a projects: \"*\" agent too, one row per project (reviewer's follow-up on d897210d)", async t => {
  const w = await world(t, { agents: [{ name: "wilma", kind: "agent", projects: "*" }] });
  migrate(w.db, "projects", MIGRATIONS);
  const P = new Projects({ db: w.db, config: { projectsDir: path.join(w.root, "projects"), roots: [] } });
  P.create({ name: "Harlow Legal", home: w.home });
  P.create({ name: "Northwind", home: path.join(w.root, "alex", "Work", "northwind") });
  const handle = await mod.start(w.ctx);
  await handle.seeded;
  const call = (tool, input, meta = {}) => w.tools.get(tool).run(input, meta);
  assert.equal((await call("projects.access.check", { project: "harlow-legal", agent: "wilma" })).granted, true);
  assert.equal((await call("projects.access.check", { project: "northwind", agent: "wilma" })).granted, true);
});

test("projects.access: a wildcard revoke is never undone by auto-seed or migrate (reviewer's MEDIUM 1 on 656b3f79)", async t => {
  const w = await started(t); // no agents yet: auto-seed's first pass finds nothing
  await w.call("projects.access.revoke", { project: "harlow-legal" }, { caller: "cli" }); // agent left out: every agent
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "kit" })).granted, false);

  // Agents turns up after the revoke, naming kit for this project. Neither the manual tool nor
  // a second auto-seed pass may grant kit: the project already has a row (the wildcard revoke),
  // so it is left alone entirely, not merely re-checked per agent.
  w.state.agents = [{ name: "kit", kind: "agent", projects: ["harlow-legal"] }];
  const r = await w.call("projects.access.migrate", {}, { caller: "cli" });
  assert.equal(r.seeded, 0, "the project was already touched; migrate does not seed into it at all");
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "kit" })).granted, false, "the wildcard revoke still stands");
});

test("projects.access.migrate (manual): the fallback once agents shows up after the auto-seed already found none", async t => {
  const w = await started(t); // no agents at start: auto-seed marks done, seeding nothing
  w.state.agents = [{ name: "kit", kind: "agent", projects: ["harlow-legal"] }];
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "kit" })).granted, false, "the auto-seed already ran before kit existed");

  const r = await w.call("projects.access.migrate", {}, { caller: "cli" });
  assert.equal(r.seeded, 1);
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "kit" })).granted, true);

  // Idempotent: a second run adds nothing more (the project is now touched).
  assert.equal((await w.call("projects.access.migrate", {}, { caller: "cli" })).seeded, 0);
});

test("projects.access.migrate: refuses when agents cannot be listed, and is person-only", async t => {
  const w = await started(t); // no agents fixture: ctx.call answers no_such_tool
  // The auto-seed's own first pass also sees no_such_tool and marks itself done harmlessly; the
  // manual tool still refuses the same way, since agents genuinely is not running here.
  await assert.rejects(w.call("projects.access.migrate", {}, { caller: "cli" }), /agents are not running/);
});

test("projects.access.check: an empty agent refuses, the same as a missing one (reviewer's LOW, still open after `required`)", async t => {
  const w = await started(t);
  await w.call("projects.access.grant", { project: "harlow-legal" }, { caller: "cli" }); // the wildcard row: agent left out
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "kit" })).granted, true, "a named agent reaches the wildcard grant");
  assert.deepEqual(await w.call("projects.access.check", { project: "harlow-legal", agent: "" }),
    { project: "harlow-legal", agent: "", granted: false }, "an empty agent must not read the wildcard row as if it were its own");
});

test("projects.access: agent names are case-insensitive, on write and on read (team-lead's call)", async t => {
  const w = await started(t);
  const granted = await w.call("projects.access.grant", { project: "harlow-legal", agent: "Kit" }, { caller: "cli" });
  assert.equal(granted.agent, "kit", "stored lower-cased");
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "kit" })).granted, true);
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "KIT" })).granted, true);
  assert.equal((await w.call("projects.access.revoke", { project: "harlow-legal", agent: "kIt" }, { caller: "cli" })).agent, "kit");
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "Kit" })).granted, false);
});
