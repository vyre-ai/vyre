// @ts-check
// Security: recall.search/thread/sessions had no project scoping at all — a named agent could
// search, read or list any project's sessions, not just its own. This mirrors core/memory/
// index.js's reach()/guard() (coordinated with federation, projects.access owner) so the two
// modules answer "what may this agent read" the same way. The owner's own surfaces and modules
// still see everything; only a named agent is scoped, by agents.projects intersected with
// projects.access (deny by default).

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { SESSIONS, HOME, writeTranscripts } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";

const NORTHWIND_SESSION = "11111111-aaaa-4000-8000-000000000003";
const HARLOW_SESSION = "11111111-aaaa-4000-8000-000000000001";
const UNMAPPED_SESSION = "11111111-aaaa-4000-8000-000000000004";

/** The fixture corpus, moved under a real work dir so real projects can own its folders (as
 * core/memory/floor.test.js does for the same reason). `extra` sessions use the same `${HOME}/...`
 * convention as the fixture and are moved the same way, for a test that needs to craft a specific
 * id collision. */
async function world(t, extra = []) {
  const root = fs.realpathSync(tempHome(t));
  const work = path.join(root, "Work");
  const moved = [...SESSIONS, ...extra].map(s => ({ ...s, cwd: s.cwd.replace(HOME, root) }));
  const dir = path.join(root, "transcripts");
  writeTranscripts(dir, moved);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [dir], recall: { every: 0 } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const opts = { root };
  await call("recall.index", {}, opts);
  assert.ok(!(await call("projects.create", { name: "Northwind", home: path.join(work, "northwind") }, opts)).error);
  assert.ok(!(await call("projects.create", { name: "Harlow", home: path.join(work, "harlow-site"), workspaces: [path.join(work, "harlow-intake")] }, opts)).error);
  assert.ok(!(await call("agents.create", { name: "kit", projects: ["northwind"] }, opts)).error);
  assert.ok(!(await call("agents.create", { name: "juno", kind: "assistant" }, opts)).error);
  // This worktree predates federation's projects.access module (still on work/federation,
  // d897210d): reach() calls projects.access.check and, per its own no_such_tool fallback (the
  // same one core/memory/index.js's reach() uses), falls back to agents.projects alone where
  // that tool is not installed at all — exactly this install. Once federation's projects.access
  // lands, add a projects.access.migrate/grant/revoke pass here (core/memory/floor.test.js has
  // the pattern) to cover the intersection and the revoke-narrows-immediately case too.
  return { d, opts, work };
}

test("recall.search: a named agent reads only its granted project, never the whole corpus", async t => {
  const { d } = await world(t);
  // Bare "mcp" (every model's shell, no name, no thread of its own) is NOT the person: it has no project, so it reads nothing (MS-1, reviewer-2's recall verdict).
  const bare = await d.registry.call("recall.search", { q: "intake form" }, "mcp");
  assert.equal(bare.error && bare.error.code, "denied", JSON.stringify(bare));
  // kit is granted only northwind: a Harlow-only term finds nothing, silently (not an error —
  // the same as any other search with no matches).
  assert.equal((await d.registry.call("recall.search", { q: "intake form" }, "mcp:agent:kit")).data.length, 0);
  // Its own project still works, with no project_cwds needed: kit's grant is the default scope.
  const own = await d.registry.call("recall.search", { q: "invoice" }, "mcp:agent:kit");
  assert.ok(own.data.length > 0);
  for (const h of own.data) assert.match(h.cwd, /northwind$/, h.cwd);
  // Asking for Harlow's folder by name is refused outright, not just empty.
  const cross = await d.registry.call("recall.search", { q: "invoice", project_cwds: [path.join(own.data[0].cwd, "..", "harlow-site")] }, "mcp:agent:kit");
  assert.match(cross.error?.message || "", /kit is not granted/);
  // A module forwarding a specific agent's call is scoped the same way as that agent directly.
  assert.equal((await d.registry.call("recall.search", { q: "intake form", agent: "kit" }, "module:memory")).data.length, 0);
  // The assistant sees every MAPPED project (both Northwind and Harlow), but never an unmapped
  // folder's raw content (the fixture's session 4 belongs to no project) — the lead's ruling,
  // 2026-09-28: a personal fact stays unrestricted for the assistant, but raw session content
  // does not extend past what is linked, matching memory's unfiled-room narrowing. A quoted
  // phrase (recall's own exact-phrase mode) keeps this to session 4 alone: an unquoted "left
  // this week" also OR-matches "week" in northwind's "a weekly total on Fridays".
  const phrase = { q: '"is left this week"' };
  assert.equal((await d.registry.call("recall.search", phrase, "mcp:agent:juno")).data.length, 0, "the assistant reads no unmapped folder");
  assert.equal((await d.registry.call("recall.search", phrase, "mcp:agent:kit")).data.length, 0);
  assert.ok((await d.registry.call("recall.search", { q: "invoice" }, "mcp:agent:juno")).data.length > 0, "the assistant reads a mapped project kit is not granted");
  assert.ok((await d.registry.call("recall.search", { q: "intake form" }, "mcp:agent:juno")).data.length > 0, "and every other mapped project too");
});

test("recall.thread: a named agent reads a session only inside its granted project", async t => {
  const { d } = await world(t);
  assert.equal((await d.registry.call("recall.thread", { session: NORTHWIND_SESSION }, "mcp:agent:kit")).data.turns.length > 0, true);
  const outside = await d.registry.call("recall.thread", { session: HARLOW_SESSION }, "mcp:agent:kit");
  assert.match(outside.error?.message || "", /no session/);
  // Not told apart from a session that genuinely does not exist: an agent learns nothing about
  // what it cannot read, not even that it exists.
  const missing = await d.registry.call("recall.thread", { session: "no-such-session" }, "mcp:agent:kit");
  assert.equal(outside.error?.message, missing.error?.message.replace("no-such-session", HARLOW_SESSION));
  // The owner's own surfaces and the assistant are unaffected.
  assert.equal((await d.registry.call("recall.thread", { session: HARLOW_SESSION }, "cli")).data.turns.length > 0, true);
  assert.equal((await d.registry.call("recall.thread", { session: HARLOW_SESSION }, "mcp:agent:juno")).data.turns.length > 0, true);
});

test("recall.sessions: a named agent lists only its granted project's sessions", async t => {
  const { d, work } = await world(t);
  const kit = await d.registry.call("recall.sessions", {}, "mcp:agent:kit");
  assert.ok(kit.data.length > 0);
  for (const s of kit.data) assert.match(s.cwd, /northwind$/, s.cwd);
  assert.equal(kit.data.some(s => s.id === UNMAPPED_SESSION), false, "an unmapped session leaked to a scoped agent");
  const cross = await d.registry.call("recall.sessions", { cwd: path.join(work, "harlow-site") }, "mcp:agent:kit");
  assert.equal(cross.error?.code, "not_found", "the registry refuses a folder in a project kit is not granted (cwdArg), before recall does");
  // ids can name any session (the box's cross-project resolve for a Mac's picked ones); a
  // scoped agent's own list still narrows to what it may read.
  const ids = await d.registry.call("recall.sessions", { ids: [NORTHWIND_SESSION, HARLOW_SESSION] }, "mcp:agent:kit");
  assert.deepEqual(ids.data.map(s => s.id), [NORTHWIND_SESSION]);
});

test("recall: taking an agent's project away narrows its reach immediately", async t => {
  const { d, opts } = await world(t);
  assert.ok((await d.registry.call("recall.search", { q: "invoice" }, "mcp:agent:kit")).data.length > 0);
  assert.ok(!(await call("agents.update", { name: "kit", projects: [] }, opts)).error);
  const after = await d.registry.call("recall.search", { q: "invoice" }, "mcp:agent:kit");
  assert.match(after.error?.message || "", /kit is not granted any project yet/);
});

test("recall: a named agent that came from a mismatched caller is refused, and an unknown agent too", async t => {
  const { d } = await world(t);
  assert.match((await d.registry.call("recall.search", { q: "invoice", agent: "juno" }, "mcp:agent:kit")).error?.message || "", /came from agent kit but names agent juno/);
  assert.match((await d.registry.call("recall.search", { q: "invoice" }, "mcp:agent:nobody")).error?.message || "", /no agent nobody/);
});

test("recall: a guest, an unknown tailnet peer or a hook names no agent, and none is defaulted to the whole corpus (reviewer's MEDIUM)", async t => {
  const { d } = await world(t);
  for (const caller of ["guest:bob", "onboard", "agent:kit"]) {
    const r = await d.registry.call("recall.search", { q: "invoice" }, caller);
    assert.match(r.error?.message || "", /not available|recall is for the user's own surfaces/, caller);
  }
  // "hook" is a caller kind of its own (a rules hook, never a reader): recall.search declares no
  // hook tool, so this is refused earlier still, as "no such tool" (never "denied" with a hint
  // that recall exists to poke at).
  assert.equal((await d.registry.call("recall.search", { q: "invoice" }, "hook")).error?.code, "no_such_tool");
  assert.match((await d.registry.call("recall.thread", { session: NORTHWIND_SESSION }, "guest:bob")).error?.message || "", /not available/);
  assert.match((await d.registry.call("recall.sessions", {}, "guest:bob")).error?.message || "", /not available/);
  // The owner's own device, verified over the tailnet (never a guest, never an agent's own node),
  // reads as any other of the user's surfaces does — this is the case the MEDIUM's fix must not
  // break: "no guest, no unknown peer", not "no tailnet at all".
  const owner = await d.registry.call("recall.search", { q: "invoice" }, "device:fjm5lhrybh4cpttq");
  assert.ok(owner.data.length > 0);
  // A relay-paired device (ADR 0026, "device:<id>") is the owner's device too, over the relay
  // rather than the tailnet — reviewer's LOW: reach() only checked ownerOverTailnet, so a
  // paired phone's recall was refused even though callerAllowed let it through as "deck".
  const phone = await d.registry.call("recall.search", { q: "invoice" }, "device:abcdefghijklmnop");
  assert.ok(phone.data.length > 0);
});

test("recall.thread: a prefix that matches sessions inside and outside the grant resolves to the grant's own, never revealing the other (reviewer's LOW)", async t => {
  const collide = [
    { id: "22222222-dddd-4000-8000-000000000001", cwd: `${HOME}/Work/northwind`, start: Date.now(),
      turns: [{ role: "user", text: "A colliding-prefix session, in scope." }, { role: "assistant", text: "Noted." }] },
    { id: "22222222-dddd-4000-8000-000000000002", cwd: `${HOME}/Work/harlow-site`, start: Date.now(),
      turns: [{ role: "user", text: "A colliding-prefix session, out of scope." }, { role: "assistant", text: "Noted." }] },
  ];
  const { d } = await world(t, collide);
  const prefix = "22222222-dddd-4000-8000-00000000000";
  // An owner sees both, so the id is genuinely ambiguous to them.
  const forOwner = await d.registry.call("recall.thread", { session: prefix }, "cli");
  assert.match(forOwner.error?.message || "", /more than one session starts with/);
  // kit (granted only northwind) sees exactly one: no ambiguity, and no hint that a second,
  // ungranted session shares the prefix.
  const forKit = await d.registry.call("recall.thread", { session: prefix }, "mcp:agent:kit");
  assert.equal(forKit.data?.turns?.[0]?.text, "A colliding-prefix session, in scope.");
});

test("an unnamed model session cannot list or read another project's session; the person's surface can", async t => {
  const { d, opts } = await world(t);
  for (const [tool, input] of [["recall.sessions", {}], ["recall.sessions", { cwd: "/anywhere" }], ["recall.thread", { session: NORTHWIND_SESSION }], ["recall.thread", { session: HARLOW_SESSION }], ["recall.search", { q: "bakery" }]]) {
    for (const caller of ["mcp", "mcp:thread:t-none"]) {
      const r = await d.registry.call(tool, input, caller);
      assert.ok(r.error || (Array.isArray(r.data) && r.data.length === 0), `${caller} ${tool} must be refused or empty: ${JSON.stringify(r).slice(0, 160)}`);
    }
  }
  assert.ok((await call("recall.sessions", {}, opts)).data.length > 0, "the person's surface lists every session");
  assert.ok((await call("recall.thread", { session: NORTHWIND_SESSION }, opts)).data.turns.length > 0);
});
