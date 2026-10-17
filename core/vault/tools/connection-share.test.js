// @ts-check
// A member shares her own app connection (vault.me.connection.share): a kernel grant on the connection's address at Fill in only, for a person, a team or an agent. Taking a share away, or deleting the
// connection, ends the grants and tells the hub to discard what those people left waiting at the Gate (mcp.sweep). Only she can do it, and never for someone else's connection.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { register as registerShare, csource } from "./connection-share.js";
import { connectionUrn } from "../connection-token.js";
import { ACCESS_LEVELS } from "../../../kernel/seal/uses.js";

const BOB = "per_bob", EVE = "per_eve", OWNER = "per_owner", KIT = "agt_kit", TEAM = "team_aaaa";

function rig(over = {}) {
  /** @type {any[]} */ const grants = [], calls = [];
  const mint = {
    make: async (/** @type {any} */ g) => { grants.push({ ...g, id: "gr_" + grants.length }); },
    end: async (/** @type {any} */ q) => { for (let i = grants.length - 1; i >= 0; i--) if (grants[i].source === q.source) grants.splice(i, 1); },
    list: async (/** @type {any} */ q) => grants.filter(g => g.source.startsWith(q.source)),
  };
  const mine = new Set(["clio"]);
  const kernel = { space: "spc_x", owner: OWNER, mint, chain: async (/** @type {any} */ m) => ({ hops: m.hops || [] }),
    grants: { members: { list: async () => [{ person: BOB, name: "Bob" }, { person: EVE, name: "Eve" }] }, teams: { list: async () => [{ id: TEAM, name: "Billing" }] } } };
  const reg = /** @type {Map<string, any>} */ (new Map());
  const ctx = { kernel, log: () => {}, call: async (/** @type {string} */ t, /** @type {any} */ i) => {
    calls.push([t, i]);
    if (t === "agents.uid") return i.name === "kit" ? { data: { uid: KIT } } : { error: { code: "not_found" } };
    if (t === "agents.list") return { data: [{ uid: KIT, name: "kit" }, { uid: "agt_atlas", name: "atlas" }] };
    // the agents the caller may instruct: kit (made by Eve, shared with Bob), not atlas
    if (t === "agents.instructors") return i.agent === "kit" ? { data: { level: "use", made_by: EVE, shares: [BOB, "per_dana"] } } : { error: { code: "not_found" } };
    return { data: { cancelled: 0 } };
  } };
  const people = { service: (/** @type {string} */ id) => ({ has: async (/** @type {string} */ n) => id === BOB && mine.has(n) }), ...over };
  const out = registerShare({ ctx, people: /** @type {any} */ (people), tool: (n, callers, d, i, run) => reg.set(n, { callers, run }) });
  const as = (/** @type {string} */ name, /** @type {any} */ input, /** @type {string | null} */ who = BOB, extra = {}) => reg.get(name).run(input, { caller: "device:abcdefghijklmnop", hops: who ? [{ actor: { kind: "person", id: who } }] : [], ...extra });
  return { grants, calls, reg, as, out };
}

test("share Fill in with a person, a team or an agent: one grant each on the connection's address, the kernel's use actions and no more", async () => {
  const { as, grants } = rig();
  await as("vault.me.connection.share", { name: "clio", kind: "person", subject: EVE, level: "use" });
  await as("vault.me.connection.share", { name: "clio", kind: "team", subject: TEAM, level: "use" });
  await as("vault.me.connection.share", { name: "clio", kind: "agent", subject: "kit", level: "use" });
  assert.equal(grants.length, 3);
  for (const g of grants) { assert.deepEqual(g.actions, [...ACCESS_LEVELS.use]); assert.equal(g.resource.prefix, connectionUrn("spc_x", BOB, "clio")); }
  assert.deepEqual(grants[0].subject.actor, { kind: "person", id: EVE, space: "spc_x" });
  assert.deepEqual(grants[1].subject, { kind: "group", id: TEAM });
  assert.deepEqual(grants[2].subject.actor, { kind: "agent", id: KIT, space: "spc_x" });
  assert.equal(grants[0].source, csource(BOB, "clio", EVE));
  assert.deepEqual((await as("vault.me.connection.shares", { name: "clio" })).shares.map((/** @type {any} */ s) => s.kind).sort(), ["agent", "person", "team"]);
  await as("vault.me.connection.share", { name: "clio", kind: "person", subject: EVE, level: "use" });
  assert.equal(grants.length, 3, "sharing again replaces, never doubles");
});

test("only Fill in: a connection is never shared at Read or Edit, to anyone", async () => {
  const { as, grants } = rig();
  for (const level of ["reveal", "edit", "manage", "root"]) await assert.rejects(as("vault.me.connection.share", { name: "clio", kind: "person", subject: EVE, level }), /Fill in/, level);
  assert.equal(grants.length, 0);
});

test("taking a share away ends the grant and sweeps what that grantee left waiting at the Gate", async () => {
  const { as, grants, calls } = rig();
  await as("vault.me.connection.share", { name: "clio", kind: "agent", subject: "kit", level: "use" });
  await as("vault.me.connection.share", { name: "clio", kind: "person", subject: EVE, level: "use" });
  calls.length = 0;
  await as("vault.me.connection.share", { name: "clio", kind: "person", subject: EVE, level: null });
  assert.equal(grants.length, 1);
  assert.deepEqual(calls.filter(c => c[0] === "mcp.sweep"), [["mcp.sweep", { owner: BOB, connection: "clio" }]]);
  await as("vault.me.connection.share", { name: "clio", kind: "agent", subject: "kit", level: null });
  assert.equal(grants.length, 0);
  assert.equal(calls.filter(c => c[0] === "mcp.sweep").length, 2, "every unshare sweeps");
});

test("deleting the connection ends every share on it and sweeps once", async () => {
  const { as, grants, calls, out } = rig();
  await as("vault.me.connection.share", { name: "clio", kind: "agent", subject: "kit", level: "use" });
  await as("vault.me.connection.share", { name: "clio", kind: "person", subject: EVE, level: "use" });
  calls.length = 0;
  await out.onRemoved(BOB, "clio");
  assert.equal(grants.length, 0);
  assert.deepEqual(calls.filter(c => c[0] === "mcp.sweep"), [["mcp.sweep", { owner: BOB, connection: "clio" }]]);
});

test("only her own connection, only a real grantee, only a person's own call", async () => {
  const { as, grants } = rig();
  await assert.rejects(as("vault.me.connection.share", { name: "clio", kind: "person", subject: EVE, level: "use" }, EVE), /no connection named clio/, "Eve has no clio: she cannot share Bob's");
  await assert.rejects(as("vault.me.connection.share", { name: "nope", kind: "person", subject: EVE, level: "use" }), /no connection named nope/);
  await assert.rejects(as("vault.me.connection.share", { name: "clio", kind: "person", subject: "per_zzz", level: "use" }), /not a member/);
  await assert.rejects(as("vault.me.connection.share", { name: "clio", kind: "team", subject: "team_none", level: "use" }), /no team/);
  await assert.rejects(as("vault.me.connection.share", { name: "clio", kind: "agent", subject: "ghost", level: "use" }), /no agent/);
  await assert.rejects(as("vault.me.connection.share", { name: "clio", kind: "role", subject: "admin", level: "use" }), /person, a team or an agent/);
  await assert.rejects(as("vault.me.connection.share", { name: "clio", kind: "person", subject: EVE, level: "use" }, OWNER), /member's own vault|denied/, "the owner uses the owner's tools");
  await assert.rejects(as("vault.me.connection.share", { name: "clio", kind: "person", subject: EVE, level: "use" }, BOB, { hops: [{ actor: { kind: "person", id: BOB } }, { actor: { kind: "agent", id: "kit" } }] }), /member's own vault|denied/, "an agent acting for her cannot share her connection");
  assert.equal(grants.length, 0);
});

test("an agent she may not instruct is not offered and cannot be shared with: a connection filled by an agent others instruct is used by them", async () => {
  const { as, grants } = rig();
  await assert.rejects(as("vault.me.connection.share", { name: "clio", kind: "agent", subject: "atlas", level: "use" }), /no agent/, "not found, the same as an agent that does not exist");
  assert.equal(grants.length, 0);
  await as("vault.me.connection.share", { name: "clio", kind: "agent", subject: "kit", level: "use" });
  assert.equal(grants.length, 1);
});

test("the directory: members, groups, and only the agents she may instruct, with who else instructs each", async () => {
  const { as } = rig();
  const d = await as("vault.me.connection.directory", {});
  assert.deepEqual(d.people.map((/** @type {any} */ p) => p.id), [EVE], "the other members, not herself");
  assert.deepEqual(d.groups.map((/** @type {any} */ g) => g.id), [TEAM]);
  assert.deepEqual(d.agents.map((/** @type {any} */ a) => a.id), [KIT], "atlas is not offered");
  assert.deepEqual([...d.agents[0].instructors].sort(), [BOB, EVE, "per_dana"].sort());
  await assert.rejects(as("vault.me.connection.directory", {}, OWNER), /member's own vault|denied/);
});

test("a turn's lend: Fill in to that chat's agent only, held to the thread, ended with the turn and swept; her ordinary shares are not touched", async () => {
  const { as, grants, calls, out } = rig();
  await as("vault.me.connection.share", { name: "clio", kind: "agent", subject: "kit", level: "use" });
  const r = await out.lendTurn(BOB, "clio", "kit", "thread_1", 9_999_999);
  assert.equal(grants.length, 2);
  const turn = grants.find(g => g.source === r.source);
  assert.ok(turn && turn.source.endsWith(":turn:thread_1"));
  assert.deepEqual(turn.actions, [...ACCESS_LEVELS.use]);
  assert.deepEqual(turn.conditions, { where: { sessions: ["thread_1"] }, when: { expires: 9_999_999 } }, "held to that chat, with the clock as a backstop");
  assert.deepEqual(turn.subject.actor, { kind: "agent", id: KIT, space: "spc_x" });
  await assert.rejects(out.lendTurn(EVE, "clio", "kit", "thread_1", 1), /no connection named clio/, "not hers: she cannot lend Bob's");
  await assert.rejects(out.lendTurn(BOB, "clio", "ghost", "thread_1", 1), /no agent/);
  calls.length = 0;
  assert.equal(await out.endTurn(BOB, "thread_2"), 0, "another chat's turn ends nothing here");
  assert.equal(grants.length, 2);
  assert.equal(await out.endTurn(BOB, "thread_1"), 1);
  assert.equal(grants.length, 1, "only the turn's lend went; her ordinary share stays");
  assert.deepEqual(calls.filter(c => c[0] === "mcp.sweep"), [["mcp.sweep", { owner: BOB, connection: "clio" }]]);
});
