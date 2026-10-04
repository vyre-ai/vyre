import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createSpaceSessions, createContinue, snapshot, restore } from "./index.js";

const SPACE = "spc_harlow000001", OTHER = "spc_northwind0001";
const person = id => ({ kind: "person", id, space: SPACE });
const ALEX = person("per_alex");
const chain = (space = SPACE, who = ALEX, trust = "member") => ({ space, hops: [{ actor: who }], labels: { trust, red: "internal", source_spaces: [space] } });
const allow = async () => ({ effect: "allow" });

// ---- the sessions registry: one Space, placement from the runner ----
test("create: placement comes from the runner; a chain from another space sees nothing", async () => {
  const sessions = createSpaceSessions({ space: SPACE, authorize: allow, runner: { decide: async () => ({ where: "here", reason: "both grants" }) } });
  const s = await sessions.create({ chain: chain(), person: ALEX });
  assert.equal(s.space, SPACE); assert.equal(s.where, "here");
  assert.equal((await sessions.get(chain(), s.id)).id, s.id);
  assert.equal(await sessions.get(chain(OTHER), s.id), null);
  assert.deepEqual(await sessions.list(chain(OTHER)), []);
  await assert.rejects(() => sessions.create({ chain: chain(OTHER), person: ALEX }), { code: "not_found" });
  const denied = createSpaceSessions({ space: SPACE, authorize: async () => ({ effect: "deny" }), runner: { decide: async () => ({ where: "server", reason: "" }) } });
  await assert.rejects(() => denied.create({ chain: chain(), person: ALEX }), { code: "not_found" });
});

// ---- checkpoint state and resume ----
const perms = [{ action: "records.read", resource: `vyre://${SPACE}/matter/*` }, { action: "email.send", resource: `vyre://${SPACE}/message/*` }];
test("state: taint and permissions are carried; a resume never improves the taint and drops what the chain no longer holds", async () => {
  const stored = new Map();
  const sync = { getCheckpoint: async id => stored.get(id) || null };
  let held = new Set(perms.map(p => p.action));
  const authorize = async i => ({ effect: held.has(i.action) ? "allow" : "deny" });
  const sessions = createSpaceSessions({ space: SPACE, authorize: async i => (i.action.startsWith("sessions.") ? { effect: "allow" } : authorize(i)), runner: { decide: async () => ({ where: "here", reason: "" }) }, sync });
  const s = await sessions.create({ chain: chain(), person: ALEX });
  const state = await sessions.stateFor(chain(), s.id, { labels: { trust: "external", red: "pii", source_spaces: [SPACE, OTHER] }, permissions: perms, tasks: ["t1"], meta: { turn: 3 } });
  stored.set(s.id, { turn: 3, seq: 40, state });
  held.delete("email.send");
  const r = await sessions.resume(chain(SPACE, ALEX, "member"), s.id);
  assert.equal(r.labels.trust, "external", "a clean chain does not launder a tainted session");
  assert.deepEqual(r.labels.source_spaces.sort(), [OTHER, SPACE].sort());
  assert.equal(r.labels.red, "pii");
  assert.deepEqual(r.permissions.map(p => p.action), ["records.read"]);
  assert.deepEqual(r.dropped.map(p => p.action), ["email.send"], "no longer held, so not carried");
  assert.deepEqual([r.turn, r.seq, r.tasks], [3, 40, ["t1"]]);
  const worse = await sessions.resume(chain(SPACE, ALEX, "untrusted"), s.id);
  assert.equal(worse.labels.trust, "untrusted", "a weaker resuming chain makes it weaker");
});
test("state: another session's checkpoint, an altered one and a missing one are refused", async () => {
  const sessions0 = createSpaceSessions({ space: SPACE, authorize: allow, runner: { decide: async () => ({ where: "here", reason: "" }) }, sync: { getCheckpoint: async () => null } });
  const s = await sessions0.create({ chain: chain(), person: ALEX });
  await assert.rejects(() => sessions0.resume(chain(), s.id), { code: "not_found" });
  const state = snapshot({ space: SPACE, session: s.id, labels: { trust: "member", red: "internal", source_spaces: [SPACE] }, permissions: [] });
  const q = over => restore({ chain: chain(), space: SPACE, session: s.id, state, authorize: allow, ...over });
  await q({});
  await assert.rejects(() => q({ session: "other" }), { code: "not_found" });
  await assert.rejects(() => q({ state: { ...state, taint: { ...state.taint, trust: "system" } } }), { code: "integrity" }, "a copy with better taint no longer matches its hash");
  await assert.rejects(() => q({ state: null }), { code: "integrity" });
  await assert.rejects(() => q({ chain: chain(OTHER) }), { code: "not_found" });
});

// ---- continue in another space ----
function cont(over = {}) {
  const tasks = new Map(); let id = 0; const started = [];
  const session = { id: "ses1", space: SPACE, title: "Estate matter" };
  const ask = {
    request: async (c, spec) => { const t = { id: `task${++id}`, state: "ready", ...spec }; tasks.set(t.id, t); return t; },
    get: async (c, i) => tasks.get(i) || null,
    approved: (i, h) => tasks.get(i).approvedHash === h,
  };
  const c = createContinue({
    summarize: async () => "Client Jane Doe wants a trust. SSN 123-45-6789. Harlow fee schedule is 400 per hour. Next step: draft the trust.",
    sanitize: async q => q.text.replace(/\d{3}-\d{2}-\d{4}/g, "[ssn:ref]"),
    sourceOnly: async () => ["Harlow fee schedule is 400 per hour"],
    ask, readSession: async (ch, i) => (i === "ses1" ? session : null), readTranscript: async () => "...",
    startSession: async (ch, space, first) => { started.push({ space, first }); return { id: "new1", space }; },
    authorize: async () => ({ effect: "allow" }), ...over,
  });
  return { c, tasks, started, session };
}
test("continue: the summary is stripped, raised as a task, and only an approved one starts the new session", async () => {
  const { c, tasks, started, session } = cont(); const before = JSON.stringify(session);
  const p = await c.propose({ chain: chain(), session: "ses1", target_space: OTHER, person: ALEX });
  assert.ok(!p.summary.includes("123-45-6789") && !p.summary.includes("400 per hour"));
  assert.match(p.summary, /ssn:ref/); assert.match(p.summary, /left out/);
  const t = tasks.get(p.task);
  assert.equal(t.source, "continue_in_space"); assert.equal(t.output.kind, "decision");
  await assert.rejects(() => c.deliver({ chain: chain(), task: p.task }), { code: "not_approved" });
  t.state = "done"; t.outcome = "approved"; t.approvedHash = "something else";
  await assert.rejects(() => c.deliver({ chain: chain(), task: p.task }), { code: "not_approved" }, "approval bound to another payload");
  t.approvedHash = p.hash;
  const s = await c.deliver({ chain: chain(), task: p.task });
  assert.equal(s.space, OTHER); assert.equal(started[0].first.context, p.summary); assert.deepEqual(started[0].first.from, { space: SPACE, session: "ses1" });
  assert.equal(JSON.stringify(session), before, "the old session is untouched");
  await assert.rejects(() => c.deliver({ chain: chain(), task: p.task }), { code: "not_found" }, "delivered once");
});
test("continue: an edit changes the hash so an earlier approval does not carry over; rejected means nothing starts", async () => {
  const { c, tasks, started } = cont();
  const p = await c.propose({ chain: chain(), session: "ses1", target_space: OTHER, person: ALEX });
  const t = tasks.get(p.task); t.state = "done"; t.outcome = "approved"; t.approvedHash = p.hash;
  const e = await c.edit({ chain: chain(), task: p.task, summary: "Short version. SSN 111-22-3333." });
  assert.notEqual(e.hash, p.hash);
  await assert.rejects(() => c.deliver({ chain: chain(), task: p.task }), { code: "not_approved" });
  const q = await c.propose({ chain: chain(), session: "ses1", target_space: OTHER, person: ALEX });
  const t2 = tasks.get(q.task); t2.state = "done"; t2.outcome = "rejected";
  await assert.rejects(() => c.deliver({ chain: chain(), task: q.task }), { code: "not_approved" });
  assert.equal(started.length, 0);
});
test("continue: another space's chain, the same space and a denied chain are refused", async () => {
  const { c } = cont();
  await assert.rejects(() => c.propose({ chain: chain(OTHER), session: "ses1", target_space: SPACE, person: ALEX }), { code: "not_found" });
  await assert.rejects(() => c.propose({ chain: chain(), session: "ses1", target_space: SPACE, person: ALEX }), { code: "bad_input" });
  await assert.rejects(() => c.propose({ chain: chain(), session: "nope", target_space: OTHER, person: ALEX }), { code: "not_found" });
  const d = cont({ authorize: async () => ({ effect: "deny" }) });
  await assert.rejects(() => d.c.propose({ chain: chain(), session: "ses1", target_space: OTHER, person: ALEX }), { code: "not_found" });
});
