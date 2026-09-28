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

/** A world with one real project, "Harlow Legal", and a fake ctx running the real module's start(). */
function world(t) {
  const root = fs.realpathSync(tempHome(t));
  const home = path.join(root, "alex", "Work", "harlow-site");
  fs.mkdirSync(home, { recursive: true });
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  const cfg = config.load(root);
  const tools = new Map(), events = [];
  const ctx = {
    config: { ...cfg, role: "box", roots: [] },
    store: { db, migrate: steps => migrate(db, "projects", steps) },
    paths: { root },
    log: () => {},
    events: { emit: (type, payload) => events.push({ type, payload }), on: () => () => {} },
    tool: (name, def) => tools.set(name, def),
    call: async () => ({ error: { code: "no_such_tool", message: "none" } }),
  };
  return { root, home, db, tools, events, ctx };
}

/** Make a project by hand, the way Projects.create does, then start the module over the same db. */
async function started(t) {
  const w = world(t);
  migrate(w.db, "projects", MIGRATIONS);
  const P = new Projects({ db: w.db, config: { projectsDir: path.join(w.root, "projects"), roots: [] } });
  P.create({ name: "Harlow Legal", home: w.home });
  await mod.start(w.ctx);
  const call = (tool, input, meta = {}) => w.tools.get(tool).run(input, meta);
  return { ...w, call };
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
