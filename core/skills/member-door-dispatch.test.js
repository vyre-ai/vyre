// @ts-check
// The member door's records, events and session-token paths THROUGH the real dispatch (kernel/remote/server.js serve), on a real vyred: what a type kept by a module (the skill library here) shows a member
// who is not the owner or an admin. Two members and the owner. The rule lives in the gateway (kernel/gateway/records.js KEEPERS): a kept type is read and written only by its keeper's service chain and by an
// owner or admin, on every path: the door, a registry tool with a session token the door minted, events.read from the start of the log, the list of types. The owner's views and the skills door are unchanged.
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { createRemoteServer } from "../../kernel/remote/server.js";
import { WIRE_VERSION, CALLS } from "../../kernel/remote/wire.js";
import { MEMBER_BLOCKED_TYPES } from "../../kernel/remote/member-guard.js";
import { createMemberTools } from "../work/member-tools.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const skill = (/** @type {string} */ n, /** @type {string} */ s) => `---\nname: ${n}\ndescription: Use this when the person asks about ${n}, which is ${s}\n---\n${s}\n`;

test("a member reads or changes none of a kept type through the door's dispatch, a session token the door minted, the events or the types list; the owner and the skills door are unchanged", { timeout: 150_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner, SPACE = d.kernel.id.space;
  const oc = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const person of [ANA, BEN]) await d.kernel.gateway.grants.setRole(oc, { person, role: "member" }, { presence: proof() });
  const door = createMemberTools({ space: SPACE, kernel: d.kernel, registry: d.registry }).skills;
  const server = createRemoteServer({ space: SPACE, kernel: d.kernel, services: {} });
  let n = 0;
  const via = async (/** @type {string} */ person, /** @type {string} */ call, /** @type {any[]} */ ...args) => {
    const r = await server.serve({ v: WIRE_VERSION, id: "r" + (++n), space: SPACE, ts: Date.now(), call, args }, { device_key_id: "dev-" + person.slice(4, 10), person, path: "relay" });
    return r.ok ? { ok: true, v: r.result } : { ok: false, e: `${r.error.code}: ${r.error.message}` };
  };
  const tok = async () => ({ token: (await d.kernel.surfaces.open(oc, {})).token });
  const owner = async (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli", await tok());
  const leaks = (/** @type {any} */ r, /** @type {string} */ w) => JSON.stringify(r).includes(w);

  // the owner's personal skill, a Space draft, an approved Space skill; Ana's personal skill through her own door
  const p = await owner("skills.draft", { name: "owner-secret", level: "personal", kind: "skill", body: skill("owner-secret", "OWNER-PRIVATE-TEXT") });
  assert.ok(!p.error, JSON.stringify(p.error)); await owner("skills.approve", { name: "owner-secret", level: "personal", version: p.data.version });
  const s1 = await owner("skills.draft", { name: "space-live", level: "space", kind: "skill", body: skill("space-live", "SPACE-LIVE-TEXT") }); await owner("skills.approve", { name: "space-live", level: "space", version: s1.data.version });
  await owner("skills.draft", { name: "space-draft", level: "space", kind: "skill", body: skill("space-draft", "SPACE-DRAFT-TEXT") });
  const a1 = await door.draft(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-ana", person: ANA, path: "relay" }), { name: "ana-own", level: "personal", body: skill("ana-own", "ANA-OWN-TEXT") });
  assert.equal(a1.state, "draft");

  const oq = await via(OWNER, "records.query", "skill", { page: { limit: 50 } });
  assert.ok(oq.ok && oq.v.rows.length >= 4, "the owner reads the kept rows through the door");
  const ids = Object.fromEntries(oq.v.rows.map((/** @type {any} */ r) => [r.data.name, { id: r.id, version: r.version }]));

  // 1. the door's records calls, as a member
  const rows = (/** @type {any} */ r) => (r.ok && r.v && (r.v.rows || (Array.isArray(r.v) ? r.v : []))) || [];
  assert.equal(rows(await via(BEN, "records.query", "skill", { page: { limit: 50 } })).length, 0, "query");
  assert.ok(!(await via(BEN, "records.get", "skill", ids["owner-secret"].id)).ok, "get");
  assert.ok(!(await via(BEN, "records.reference", "skill", ids["owner-secret"].id)).ok, "reference");
  for (const q of [{ text: "OWNER-PRIVATE-TEXT" }, { text: "SPACE-DRAFT-TEXT" }, { text: "SPACE-LIVE-TEXT" }]) assert.ok(!leaks(await via(BEN, "records.search", q), q.text), `search ${q.text}`);
  assert.ok(!(await via(BEN, "records.aggregate", "skill", { group_by: "state" })).ok || rows(await via(BEN, "records.aggregate", "skill", { group_by: "state" })).length === 0, "aggregate");
  for (const [call, ...args] of [["records.update", "skill", ids["space-draft"].id, { state: "approved" }, ids["space-draft"].version], ["records.update", "skill", ids["space-live"].id, { body: skill("space-live", "INJECTED") }, ids["space-live"].version], ["records.remove", "skill", ids["space-live"].id, ids["space-live"].version], ["records.restore", "skill", ids["space-live"].id], ["records.create", "skill", { name: "planted", level: "space", scope: "", version: 1, state: "approved", kind: "skill", body: skill("planted", "PLANTED"), hash: "x", owner: "", proposer: "x" }]]) {
    assert.equal((await via(BEN, call, ...args)).ok, false, `${call} is refused`);
  }
  // 2. the types list leaves them out for a member and keeps them for the owner
  const defNames = (/** @type {any} */ r) => ((r.v && r.v.types) || r.v || []).map((/** @type {any} */ x) => x.name);
  assert.ok(!defNames(await via(BEN, "records.definitions")).includes("skill"), "the member's types list has no skill");
  // 3. events.read: neither the private text nor the draft, from the start of the log
  for (const spec of [{}, { limit: 500 }, { since: 0 }]) {
    const ev = await via(BEN, "events.read", spec);
    assert.ok(ev.ok, JSON.stringify(ev.e));
    for (const w of ["OWNER-PRIVATE-TEXT", "SPACE-DRAFT-TEXT", "SPACE-LIVE-TEXT", "ANA-OWN-TEXT"]) assert.ok(!leaks(ev, w), `events.read ${JSON.stringify(spec)} shows ${w}`);
  }
  assert.ok(leaks(await via(OWNER, "events.read", {}), "OWNER-PRIVATE-TEXT"), "the owner's log still shows what the owner wrote");
  // 4. a session token the door minted: the registry tools run on her chain and see none of it either
  const so = await via(BEN, "surfaces.open", {});
  assert.ok(so.ok && so.v && so.v.token, "a member opens a session through the door");
  for (const [tool, input] of [["records.list", { type: "skill" }], ["skills.list", {}], ["flows.list", {}]]) {
    const r = await d.registry.call(tool, input, "cli", { token: so.v.token });
    for (const w of ["OWNER-PRIVATE-TEXT", "SPACE-DRAFT-TEXT", "ANA-OWN-TEXT"]) assert.ok(!leaks(r, w), `${tool} with a door-minted token shows ${w}`);
  }
  // 5. the skills door still gives her what is hers and the Space's, and the owner is unchanged
  const mine = await door.list(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-ana", person: ANA, path: "relay" }), {});
  assert.ok(mine.skills.some((/** @type {any} */ s) => s.name === "space-live"), "the approved Space skill is hers to use");
  assert.ok(!mine.skills.some((/** @type {any} */ s) => s.name === "owner-secret"), "and the owner's personal one is not");
  const lst = await owner("skills.list", {});
  assert.ok(lst.data.skills.some((/** @type {any} */ s) => s.name === "owner-secret"), "the owner's own list keeps it");
  const st = JSON.stringify((await d.registry.call("skills.get", { id: "space/space-live" }, "cli", await tok())).data);
  assert.ok(!st.includes("INJECTED") && st.includes("SPACE-LIVE-TEXT"), "the approved text is what the owner approved");
});

test("every call of the member door's records and events groups is classified: a call added later cannot skip the guard", () => {
  const known = ["definitions", "define", "get", "reference", "query", "aggregate", "search", "create", "update", "remove", "restore",
    // the app Store's own calls, rows of the member door's table (core/work/member-tools.js): the tool refuses the kept types itself
    "list", "me", "actors", "types", "events"];
  assert.deepEqual([...CALLS.records].sort(), [...known].sort(), "a new records call must be classified in kernel/remote/member-guard.js (and here)");
  assert.deepEqual(CALLS.events, ["read"], "a new events call must be filtered like events.read (the gateway's canSee) and added here");
  assert.ok(MEMBER_BLOCKED_TYPES.has("skill"));
});
