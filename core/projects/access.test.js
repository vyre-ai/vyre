// @ts-check
// projects.access: which agent may reach a project's data at all (Vyre Drive step 3, federation).
// Deny by default; granting needs the owner's presence (HUMAN_ONLY), revoking is instant
// (PERSON_ONLY). Runs the real module's start() into a fake ctx (move.test.js's own pattern), so
// tools are called directly — presence and caller enforcement themselves are the registry's job
// and are covered generically by core/harness/floor.test.js and test/mcp-server-tools.test.js.

import "../../scripts/mac-test-guard.mjs";
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
 * agents exists and the manual tool filling in once it does. failFirst: agents.list answers
 * this error the first N calls (a boot-order race, agents not up yet), then answers normally,
 * for the seed-order LOW: only a real answer, no_such_tool included, may mark the seed done. */
function world(t, { agents = null, failFirst = 0 } = {}) {
  const root = fs.realpathSync(tempHome(t));
  const home = path.join(root, "alex", "Work", "harlow-site");
  fs.mkdirSync(home, { recursive: true });
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  const cfg = config.load(root);
  const tools = new Map(), events = [];
  const state = { agents, calls: 0 };
  const ctx = {
    config: { ...cfg, role: "box", roots: [] },
    store: { db, migrate: steps => migrate(db, "projects", steps) },
    paths: { root },
    log: () => {},
    events: { emit: (type, payload) => events.push({ type, payload }), on: () => () => {} },
    tool: (name, def) => tools.set(name, def),
    // agents.list is the one external fixture; anything else this module's own tools declare
    // (projects.list, projects.access.check) is a real self-call, routed the same way
    // core/modules/index.js's ctx.call does for a module calling its own tool — projects.reach
    // needs both, not just agents.list.
    call: async (tool, input = {}) => {
      if (tool === "agents.list") {
        state.calls++;
        if (state.calls <= failFirst) return { error: { code: "unreachable", message: "agents is not up yet" } };
        return state.agents ? { data: state.agents } : { error: { code: "no_such_tool", message: "none" } };
      }
      const def = tools.get(tool);
      if (!def) return { error: { code: "no_such_tool", message: "none" } };
      try { return { data: await def.run(input, { caller: "module:projects" }) }; }
      catch (e) { return { error: { code: /** @type {any} */ (e).code || "failed", message: /** @type {Error} */ (e).message } }; }
    },
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

test("projects.add-workspace: person-only, instant, and calls through to Projects.addWorkspace (Vyre Drive step 4)", async t => {
  assert.ok(PERSON_ONLY.has("projects.add-workspace"), "a placement decision, no presence needed");
  assert.ok(!HUMAN_ONLY.has("projects.add-workspace"));
  const w = await started(t);
  const intake = path.join(w.root, "alex", "Work", "harlow-intake");
  fs.mkdirSync(intake, { recursive: true });
  const r = await w.call("projects.add-workspace", { project: "harlow-legal", folder: intake }, { caller: "cli" });
  assert.equal(r.added, "../harlow-intake");
  await assert.rejects(w.call("projects.add-workspace", { project: "no-such-project", folder: intake }, { caller: "cli" }), /no project/);
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

test("projects.access: the auto-seed retries a boot-order race, and marks itself done only once agents.list actually answers (reviewer's seed-order LOW)", async t => {
  // agents.list fails twice (not no_such_tool: a real "not up yet" error) before it answers,
  // simulating agents starting after projects in the same boot.
  const w = await started(t, { agents: [{ name: "kit", kind: "agent", projects: ["harlow-legal"] }], failFirst: 2 });
  assert.ok(w.state.calls >= 3, `expected at least 3 attempts (2 failures + 1 success), got ${w.state.calls}`);
  assert.equal((await w.call("projects.access.check", { project: "harlow-legal", agent: "kit" })).granted, true, "seeded once agents finally answered");
  assert.ok(w.db.prepare("SELECT 1 FROM projects_access_seeded").get(), "marked done only after a real answer");
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

test("projects.reach: the true owner is unrestricted; an unnamed, unrecognised caller is refused outright (cohesion's one-system audit)", async t => {
  const w = await started(t);
  for (const caller of ["cli", "local", "deck", "capsule", "module:memory", "mcp", "mcp:thread:t1"]) {
    assert.deepEqual(await w.call("projects.reach", { caller }), { all: true, agent: null }, caller);
  }
  for (const caller of ["unknown", "tailnet-guest:eve@example.com", "hook"]) {
    const r = await w.call("projects.reach", { caller }).catch(e => e);
    assert.equal(r.code, "denied", `${caller}: ${r.message}`);
  }
});

test("projects.reach: with the kernel's `person` answer the label decides nothing: a person is the owner whatever the label, a non-person with an owner-looking label is refused", async t => {
  const w = await started(t);
  assert.deepEqual(await w.call("projects.reach", { caller: "tailnet-guest:x", person: true }), { all: true, agent: null });
  for (const caller of ["cli", "deck", "capsule", "mcp", "unknown"]) {
    const r = await w.call("projects.reach", { caller, person: false }).catch(e => e);
    assert.equal(r.code, "denied", `${caller}: ${r.message}`);
  }
  assert.deepEqual(await w.call("projects.reach", { caller: "module:memory", person: false }), { all: true, agent: null }, "a module on its own behalf is still a module");
});

test("projects.reach: a named agent gets its own granted projects, intersected with projects.access, deny by default", async t => {
  const w = await started(t, { agents: [{ name: "kit", kind: "agent", projects: ["harlow-legal"] }] });
  // started() already ran the one-time auto-seed (2fb4258c), which backfills kit's own
  // agents.projects entry into projects.access — so this starts granted, not denied; revoking
  // it directly is what actually exercises "intersected with projects.access, deny by default".
  const r = await w.call("projects.reach", { agent: "kit", caller: "mcp:agent:kit" });
  assert.deepEqual(r.projects.map(p => p.slug), ["harlow-legal"]);
  await w.call("projects.access.revoke", { project: "harlow-legal", agent: "kit" }, { caller: "cli" });
  const r2 = await w.call("projects.reach", { agent: "kit", caller: "mcp:agent:kit" });
  assert.deepEqual(r2.projects, []);
});

test("projects.reach: a projects: \"*\" agent is checked against projects.access; the assistant never is", async t => {
  const w = await started(t, { agents: [{ name: "wilma", kind: "agent", projects: "*" }, { name: "juno", kind: "assistant", projects: "*" }] });
  await w.call("projects.create", { name: "Northwind", home: path.join(w.root, "northwind") }, { caller: "cli" });
  // projects.create auto-grants every existing wildcard agent (option (a), f8330ccc): wilma reads
  // the brand-new project at once. harlow-legal predates this fixture's agents but the one-time
  // auto-seed (2fb4258c) backfills wilma's own "*" against every project that existed when it
  // ran, harlow-legal included — so wilma starts with both, same as if it had always been there.
  assert.deepEqual((await w.call("projects.reach", { agent: "wilma", caller: "mcp:agent:wilma" })).projects.map(p => p.slug).sort(), ["harlow-legal", "northwind"]);
  await w.call("projects.access.revoke", { project: "northwind", agent: "wilma" }, { caller: "cli" });
  assert.deepEqual((await w.call("projects.reach", { agent: "wilma", caller: "mcp:agent:wilma" })).projects.map(p => p.slug), ["harlow-legal"]);
  // The assistant is never checked against projects.access at all, even an explicit revoke
  // under its own name: every project, unconditional.
  await w.call("projects.access.revoke", { project: "northwind", agent: "juno" }, { caller: "cli" });
  const j = await w.call("projects.reach", { agent: "juno", caller: "mcp:agent:juno" });
  assert.deepEqual(j.projects.map(p => p.slug).sort(), ["harlow-legal", "northwind"]);
  assert.equal(j.all, false, "the assistant is not r.all for content: it still names its projects, unfiled stays the true owner's alone");
  // kind: "facts" gives the assistant true all:true (personal facts, distilled, not raw content).
  assert.deepEqual(await w.call("projects.reach", { agent: "juno", kind: "facts", caller: "mcp:agent:juno" }), { all: true, agent: "juno" });
});

test("projects.access: grant, revoke and clear are agents' and this module's own internal door, never a third-party module (reviewer's MEDIUM 2 on f8330ccc)", async t => {
  const w = await started(t);
  for (const [tool, input] of [["projects.access.grant", { project: "harlow-legal", agent: "kit" }], ["projects.access.revoke", { project: "harlow-legal", agent: "kit" }], ["projects.access.clear", { agent: "kit" }]]) {
    const r = await w.call(tool, input, { caller: "module:evil-plugin" }).catch(e => e);
    assert.equal(r.code, "denied", `${tool} by module:evil-plugin should have been refused`);
  }
  // The two doors that are meant to reach these still can.
  assert.ok(!(await w.call("projects.access.grant", { project: "harlow-legal", agent: "kit" }, { caller: "module:agents" })).error);
  assert.ok(!(await w.call("projects.access.revoke", { project: "harlow-legal", agent: "kit" }, { caller: "module:agents" })).error);
  assert.ok(!(await w.call("projects.access.clear", { agent: "kit" }, { caller: "module:agents" })).error);
  // The owner's own surfaces are unaffected: this is a module-caller-only narrowing.
  assert.ok(!(await w.call("projects.access.grant", { project: "harlow-legal", agent: "kit" }, { caller: "cli" })).error);
});

test("projects.create: a module caller is refused unless it is sync's own door (reviewer's MEDIUM on 7021d4e1)", async t => {
  const w = await started(t);
  const input = { name: "Northwind", home: path.join(w.root, "alex", "Work", "northwind") };
  const r = await w.call("projects.create", input, { caller: "module:evil-plugin" }).catch(e => e);
  assert.equal(r.code, "denied", "an agent's own module cannot map any folder it likes into a brand-new project");
  // sync's own door (attachMapped's create-new-project branch, core/sync/index.js) still works.
  const created = await w.call("projects.create", input, { caller: "module:sync" });
  assert.equal(created.slug, "northwind");
});

test("projects.add-workspace: a module caller is refused unless it is sync's own door, and sync's attach-to-existing path actually works end to end (reviewer's MEDIUM on 7021d4e1: \"attach-to-existing is dead\")", async t => {
  const w = await started(t);
  const intake = path.join(w.root, "alex", "Work", "harlow-intake");
  fs.mkdirSync(intake, { recursive: true });
  const refused = await w.call("projects.add-workspace", { project: "harlow-legal", folder: intake }, { caller: "module:evil-plugin" }).catch(e => e);
  assert.equal(refused.code, "denied", "an agent's own module cannot attach a folder to an existing project");
  // The exact call attachMapped makes on its "exists" branch: an existing project, sync's own caller.
  const attached = await w.call("projects.add-workspace", { project: "harlow-legal", folder: intake }, { caller: "module:sync" });
  assert.equal(attached.added, "../harlow-intake");
  // A person's own surfaces are unaffected: this is a module-caller-only narrowing.
  const other = path.join(w.root, "alex", "Work", "harlow-other");
  fs.mkdirSync(other, { recursive: true });
  assert.ok(!(await w.call("projects.add-workspace", { project: "harlow-legal", folder: other }, { caller: "cli" })).error);
});

test("projects.create/add-workspace: github's own door (module:github) is allowed the same way sync's is (github team's ask, ADR 0041)", async t => {
  const w = await started(t);
  const created = await w.call("projects.create",
    { name: "Northwind", home: path.join(w.root, "alex", "Work", "northwind") }, { caller: "module:github" });
  assert.equal(created.slug, "northwind");
  const another = path.join(w.root, "alex", "Work", "northwind-docs");
  fs.mkdirSync(another, { recursive: true });
  const attached = await w.call("projects.add-workspace", { project: "northwind", folder: another }, { caller: "module:github" });
  assert.equal(attached.added, "../northwind-docs");
  // Still not a door for any other module: adding one caller never widens it to "module" broadly.
  for (const [tool, input] of [
    ["projects.create", { name: "Bad", home: path.join(w.root, "alex", "Work", "bad") }],
    ["projects.add-workspace", { project: "northwind", folder: another }],
  ]) {
    const r = await w.call(tool, input, { caller: "module:evil-plugin" }).catch(e => e);
    assert.equal(r.code, "denied", tool);
  }
});

test("projects: stop() ends the auto-seed's retries, waits for its step, and nothing touches the database after it", async t => {
  const w = world(t, { agents: null, failFirst: 1000 }); // agents never answers: the seed keeps retrying
  migrate(w.db, "projects", MIGRATIONS);
  const handle = await mod.start(w.ctx);
  await new Promise(r => setTimeout(r, 30)); // let it retry a few times
  const before = w.state.calls;
  assert.ok(before >= 1, "the seed was retrying");
  const t0 = Date.now();
  await handle.stop();
  assert.ok(Date.now() - t0 < 2000, "stop is bounded");
  const at = w.state.calls;
  await new Promise(r => setTimeout(r, 60));
  assert.equal(w.state.calls, at, "no retry after stop");
});
