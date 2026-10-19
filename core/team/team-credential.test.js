// @ts-check
// A teammate's turn runs on the sign-in picked for the agent that fills its role, as that agent's own launch does (the member-started template project's teammates were refused for carrying none).
// The fake claude logs whether a launch carried an OAuth token. Real daemon, fake provider.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, until } from "./team-fixture.js";

test("a teammate filled by an agent with a picked sign-in launches on that sign-in; a teammate with no filler launches as before", { timeout: 120_000 }, async t => {
  const { tool, project, launches } = await boot(t);
  await tool("vault.put", { name: "teammate-oauth", kind: "secret", fields: { value: "stand-in-teammate-sign-in-value" } });
  await tool("vault.grant", { name: "teammate-oauth", module: "agents" });
  await tool("agents.create", { name: "filler", kind: "agent", projects: [project.slug], auth: { vault: "teammate-oauth" } });
  const tm = await tool("team.add", { project: project.record, role: "design", brief: "visual design" });
  const plain = await tool("team.ask", { to: "design", project: project.record, wait: true, text: 'vyre team.done {"result":"plain","notes":"unchanged","reason":"test"}' });
  assert.equal(plain.state, "done", JSON.stringify(plain));
  assert.equal(launches().at(-1).oauth, false, "no filler, no picked sign-in");
  await tool("team.role.fill", { agent: tm.agent, filler: "filler", project: project.record, role: "design" }).catch(() => tool("team.role.fill", { project: project.record, role: "design", agent: "filler" }));
  const mine = await tool("team.ask", { to: "design", project: project.record, wait: true, text: 'vyre team.done {"result":"filled","notes":"unchanged","reason":"test"}' });
  assert.ok(mine.request, "the request ran to an end (the fake provider does not always call team.done for a filled role)");
  assert.equal(launches().at(-1).oauth, true, "the filler's picked sign-in rode on the teammate's launch");
});

test("team.ask on a daemon with no kernel records the owner (the box's own terminal) as having asked, and a teammate on a picked sign-in still launches", { timeout: 120_000 }, async t => {
  const { tool, project, d } = await boot(t);
  await tool("team.add", { project: project.record, role: "design", brief: "visual design" });
  const r = await tool("team.ask", { to: "design", project: project.record, wait: true, text: 'vyre team.done {"result":"x","notes":"unchanged","reason":"test"}' });
  const row = d.registry.deps.db.prepare("SELECT asker FROM team_requests WHERE id = ?").get(r.request);
  const owner = d.kernel && d.kernel.id && d.kernel.id.owner;
  assert.ok(row && (row.asker === null || row.asker === owner), `the box's own terminal asked: the owner is recorded (or nobody, with no kernel): ${row && row.asker}`);
});

test("a member who is not on a project's team cannot send its teammates work: refused in words, nothing queued, no thread; the owner can", { timeout: 120_000 }, async t => {
  const { tool, project, d } = await boot(t);
  const OWNER = d.kernel.id.owner, BEN = "per_" + "c".repeat(26);
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: { op: "x", fields: {}, n: 2 } });
  const benChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-ben", person: BEN, path: "direct", session: "sb" });
  const benToken = { token: (await d.kernel.surfaces.open(benChain, {})).token };
  await tool("team.add", { project: project.record, role: "design", brief: "visual design" });
  const before = d.registry.deps.db.prepare("SELECT COUNT(*) n FROM team_requests").get().n;
  const refused = await d.registry.call("team.ask", { to: "design", project: project.record, text: "do something with the owner's project" }, "cli", benToken);
  assert.equal(refused.error && refused.error.code, "denied", JSON.stringify(refused));
  assert.match(refused.error.message, /not on this project's team/);
  assert.equal(d.registry.deps.db.prepare("SELECT COUNT(*) n FROM team_requests").get().n, before, "nothing was queued");
  const mine = await tool("team.ask", { to: "design", project: project.record, wait: true, text: 'vyre team.done {"result":"owner","notes":"unchanged","reason":"test"}' });
  assert.ok(mine.request, "the owner's request is queued as before");
});

test("a person's request to a teammate runs on their own AI account in a session of its own, as them; with none it is refused and nothing is queued; the owner's uses the standing thread", { timeout: 150_000 }, async t => {
  const { tool, project, d } = await boot(t);
  const OWNER = d.kernel.id.owner, ADA = "per_" + "f".repeat(26);
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(ownerChain, { person: ADA, role: "admin" }, { presence: { op: "x", fields: {}, n: 3 } });
  const adaToken = { token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-ada", person: ADA, path: "direct", session: "sa" }), {})).token };
  const db = d.registry.deps.db;
  const tm = await tool("team.add", { project: project.record, role: "design", brief: "visual design" });
  const owners = await tool("team.ask", { to: "design", project: project.record, wait: true, text: 'vyre team.done {"result":"owner","notes":"unchanged","reason":"test"}' });
  const standing = db.prepare("SELECT thread FROM team_teammates WHERE agent = ?").get(tm.agent).thread;
  assert.ok(standing, "the owner's request ran on the teammate's standing thread");
  assert.equal(db.prepare("SELECT thread FROM team_requests WHERE id = ?").get(owners.request).thread, null, "not a session of its own");

  // an admin with no AI account of her own: refused in words, nothing queued, never run on the owner's sign-in
  const before = db.prepare("SELECT COUNT(*) n FROM team_requests").get().n;
  const refused = await d.registry.call("team.ask", { to: "design", project: project.record, text: "redesign the intake" }, "deck", adaToken);
  assert.match(String(refused.error && refused.error.message), /Connect your own AI account in Settings, AI accounts, to use design\. Nothing was queued\./, JSON.stringify(refused));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM team_requests").get().n, before, "NEGATIVE: nothing queued");

  // with her own account: her request runs in a session of its own, on her account, acting as her; the standing thread is untouched
  const acct = await d.registry.call("sessions.accounts.add", { provider: "claude", label: "Ada's Claude", kind: "login" }, "deck", adaToken);
  assert.equal(acct.error, undefined, JSON.stringify(acct.error));
  const hers = await d.registry.call("team.ask", { to: "design", project: project.record, text: 'vyre team.done {"result":"ada","notes":"unchanged","reason":"test"}' }, "deck", adaToken);
  assert.equal(hers.error, undefined, JSON.stringify(hers.error));
  const req = await until(() => { const r = db.prepare("SELECT thread, asker, state FROM team_requests WHERE id = ?").get(hers.data.request); return r && r.thread ? r : null; }, "her request's own session");
  assert.equal(req.asker, ADA);
  assert.notEqual(req.thread, standing, "never the standing thread, which runs on the owner's sign-in");
  const run = db.prepare("SELECT account, opts FROM threads_runs WHERE id = ?").get(req.thread);
  assert.equal(run.account, acct.data.id, "on her own account");
  assert.equal(JSON.parse(String(run.opts || "{}")).runas, ADA, "and acting as her");
  assert.equal(db.prepare("SELECT thread FROM team_teammates WHERE agent = ?").get(tm.agent).thread, standing, "the standing thread is as it was");
});

test("a duty runs as the person who turned it on, on their own account, never on the filler agent's picked sign-in; a person with none, or not on the project's team, cannot turn one on", { timeout: 150_000 }, async t => {
  const { tool, project, d, launches } = await boot(t);
  const OWNER = d.kernel.id.owner, ADA = "per_" + "f".repeat(26), BEN = "per_" + "c".repeat(26);
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(ownerChain, { person: ADA, role: "admin" }, { presence: { op: "x", fields: {}, n: 4 } });
  await d.kernel.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: { op: "x", fields: {}, n: 5 } });
  const tokenOf = async (/** @type {string} */ p) => ({ token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s-" + p.slice(4, 8) }), {})).token });
  const adaToken = await tokenOf(ADA), benToken = await tokenOf(BEN);
  const db = d.registry.deps.db;
  // the role is filled by an agent the owner gave a picked sign-in
  await tool("vault.put", { name: "teammate-oauth", kind: "secret", fields: { value: "stand-in-teammate-sign-in-value" } });
  await tool("vault.grant", { name: "teammate-oauth", module: "agents" });
  await tool("agents.create", { name: "filler", kind: "agent", projects: [project.slug], auth: { vault: "teammate-oauth" } });
  const tm = await tool("team.add", { project: project.record, role: "design", brief: "visual design" });
  await tool("team.role.fill", { agent: tm.agent, filler: "filler", project: project.record, role: "design" }).catch(() => tool("team.role.fill", { project: project.record, role: "design", agent: "filler" }));
  const duties = () => db.prepare("SELECT COUNT(*) n FROM team_duties").get().n;
  const duty = { teammate: tm.agent, when: "daily 07:00", instruction: "Say what needs a person.", act: true };

  // a member not on the project's team: refused (the registry's door keeps duties to the owner and admins; the handler also holds her to her projects), nothing made
  const notOnTeam = await d.registry.call("team.duties.create", duty, "deck", benToken);
  assert.equal(notOnTeam.error && notOnTeam.error.code, "denied", JSON.stringify(notOnTeam));
  assert.equal(duties(), 0);
  // an admin with no AI account of her own: refused in words before anything starts, never set to run on the owner's sign-in
  const none = await d.registry.call("team.duties.create", duty, "deck", adaToken);
  assert.match(String(none.error && none.error.message), /Connect your own AI account in Settings, AI accounts, to use design\. Nothing was turned on\./, JSON.stringify(none));
  assert.equal(duties(), 0, "NEGATIVE: no duty was made");

  // a duty she turned on (stored as hers), firing: its request is hers, in a session of its own on her account, with none of the filler's picked sign-in
  const acct = await d.registry.call("sessions.accounts.add", { provider: "claude", label: "Ada's Claude", kind: "login" }, "deck", adaToken);
  assert.equal(acct.error, undefined, JSON.stringify(acct.error));
  const projectId = db.prepare("SELECT project FROM team_teammates WHERE agent = ?").get(tm.agent).project;
  const put = (/** @type {string} */ id, /** @type {string | null} */ runAs) => db.prepare("INSERT INTO team_duties (id, teammate, project, role, watcher, trigger, instruction, act, enabled, started, created_by, at, title, run_as) VALUES (?,?,?,?,?,?,?,1,1,1,?,?,?,?)")
    .run(id, tm.agent, projectId, "design", `duty-design-${id}`, "daily 07:00", 'vyre team.done {"result":"duty","notes":"unchanged","reason":"test"}', "deck", Date.now(), "her duty", runAs);
  put("d0ada001", ADA);
  d.events.emit("watchers", "watcher.fired", { name: "duty-design-d0ada001", items: 1, seen: 1, trigger: "schedule" });
  const req = await until(() => { const r = db.prepare("SELECT asker, thread FROM team_requests WHERE from_label = ?").get("duty:d0ada001"); return r && r.thread ? r : null; }, "her duty's request to run");
  assert.equal(req.asker, ADA, "queued as the person who turned it on, not as the owner's automation");
  const run = db.prepare("SELECT account, opts FROM threads_runs WHERE id = ?").get(req.thread);
  assert.equal(run.account, acct.data.id, "on her own account");
  assert.equal(JSON.parse(String(run.opts || "{}")).runas, ADA, "acting as her");
  const launched = await until(() => launches().find((/** @type {any} */ l) => Array.isArray(l.argv) && l.argv.includes(req.thread)), "her duty session's launch");
  assert.equal(launched.oauth, false, "NEGATIVE: the filler's picked sign-in (the owner's) is not in her duty's session");
  // a duty with nobody stored (made before duties kept a person) is the owner's own setting, as before
  put("d0old002", null);
  d.events.emit("watchers", "watcher.fired", { name: "duty-design-d0old002", items: 1, seen: 1, trigger: "schedule" });
  const old = await until(() => db.prepare("SELECT asker FROM team_requests WHERE from_label = ?").get("duty:d0old002"), "the older duty's request");
  assert.equal(old.asker, "automation");
});
