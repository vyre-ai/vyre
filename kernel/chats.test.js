import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "./index.js";
import { canonical, sha256 } from "./core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol", ADA = "per_ada";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  for (const [p, role] of [[BOB, "member"], [CAROL, "member"], [ADA, "admin"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const kit = { kind: "agent", id: "kit", space: SPACE };
  await g.addActor(owner, kit, { presence: proof("grants.role", { actor: kit }, `vyre://${SPACE}/member/kit`) });
  const dev = (person, id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct" });
  const asst = (person, session) => k.chains.fromFacts({ kind: "agent_session", vouched: true, person, agent: "kit", session });
  return { k, owner, g, bob: dev(BOB, "d-b"), carol: dev(CAROL, "d-c"), ada: dev(ADA, "d-a"), asst, C: k.gateway.grants.chats };
}

test("chat read: participants only; an owner or admin outside the chat is refused; an assistant reads only chats the person it acts for is in", async () => {
  const { owner, bob, carol, ada, asst, C } = await rig();
  const c = await C.create(bob, { people: [CAROL], assistants: ["kit"] });
  assert.deepEqual([...c.people].sort(), [BOB, CAROL]);
  assert.equal(C.read(bob, c.id).id, c.id);
  assert.equal(C.read(carol, c.id).id, c.id);
  for (const outsider of [owner, ada]) assert.throws(() => C.read(outsider, c.id), { code: "not_found" }, "an owner or an admin who is not in it");
  assert.equal(C.read(asst(BOB, "s1"), c.id).id, c.id, "kit acting for bob");
  assert.throws(() => C.read(asst(OWNER, "s2"), c.id), { code: "not_found" }, "kit acting for someone not in the chat");
  const other = await C.create(bob, {});
  assert.throws(() => C.read(asst(BOB, "s3"), other.id), { code: "not_found" }, "kit is not a participant of that chat");
  assert.throws(() => C.read(bob, "chat_nonesuch0"), { code: "not_found" });
});

test("chat change: only a person in the chat changes it, and everyone in it is a member", async () => {
  const { owner, bob, carol, ada, C } = await rig();
  const c = await C.create(bob, {});
  await assert.rejects(() => C.change(owner, c.id, { add_people: [ADA] }), { code: "not_found" }, "the owner is not in it");
  await assert.rejects(() => C.change(carol, c.id, { add_people: [ADA] }), { code: "not_found" });
  await assert.rejects(() => C.change(bob, c.id, { add_people: ["per_stranger"] }), { code: "bad_input" });
  const n = await C.change(bob, c.id, { add_people: [ADA] });
  assert.deepEqual([...n.people].sort(), [ADA, BOB]);
  assert.equal(C.read(ada, c.id).id, c.id);
  await C.change(ada, c.id, { remove_people: [BOB] });
  assert.throws(() => C.read(bob, c.id), { code: "not_found" });
  await assert.rejects(() => C.change(ada, c.id, { remove_people: [ADA] }), { code: "bad_input" }, "a chat keeps a person");
});

test("audienceFor(extra): the room comes from the session behind the token and the chat it was bound to, never an argument; group chains are read-only viewers, asker first; anything unknown throws", async () => {
  const { k, bob, carol, C } = await rig();
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  const c = await C.create(bob, { people: [CAROL, OWNER] });
  const t = await k.surfaces.open(bob);
  await assert.rejects(() => stream.audienceFor({ token: t.token }), { code: "no_audience" }, "a session bound to no chat");
  await assert.rejects(() => stream.audienceFor({}), { code: "no_audience" }, "no token");
  await assert.rejects(() => stream.audienceFor({ token: "x.y", session: t.session, chat: c.id }), { code: "no_audience" }, "a named session or chat is not a token");
  await assert.rejects(() => stream.audienceFor(undefined), { code: "no_audience" });
  await assert.rejects(() => C.bind(k.chains.fromFacts({ kind: "device", device_key_id: "d-x", person: ADA, path: "direct" }), t.session, c.id), { code: "not_found" }, "only someone in the chat binds");
  await C.bind(bob, t.session, c.id);
  const room = await stream.audienceFor({ token: t.token });
  assert.equal(room.group, true);
  assert.equal(room.chains.length, 3);
  assert.equal(room.chains[0].hops[0].actor.id, BOB, "asker first");
  assert.deepEqual(room.chains.map(x => x.hops[0].actor.id).sort(), [BOB, CAROL, OWNER].sort());
  for (const v of room.chains) assert.equal(v.viewer, true);
  // a binding never moves, and someone else cannot take the session over
  const other = await C.create(bob, {});
  await assert.rejects(() => C.bind(bob, t.session, other.id), { code: "bad_input" });
  await C.bind(carol, t.session, c.id);
  assert.equal((await stream.audienceFor({ token: t.token })).chains[0].hops[0].actor.id, BOB, "the asker stays bob");
  // a person who left the room is not in the audience of a later turn
  await C.change(bob, c.id, { remove_people: [CAROL] });
  assert.equal((await stream.audienceFor({ token: t.token })).chains.some(x => x.hops[0].actor.id === CAROL), false);
  // a chat of one person is not a group
  const solo = await C.create(bob, {});
  const t2 = await k.surfaces.open(bob);
  await C.bind(bob, t2.session, solo.id);
  assert.deepEqual(await stream.audienceFor({ token: t2.token }), { group: false });
  // a revoked session has no room
  k.surfaces.revoke(t2.session);
  await assert.rejects(() => stream.audienceFor({ token: t2.token }), { code: "no_audience" });
});

test("a viewer chain reads and does nothing else", async () => {
  const { k, bob, carol, C } = await rig();
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  const c = await C.create(bob, { people: [CAROL] });
  const t = await k.surfaces.open(bob);
  await C.bind(bob, t.session, c.id);
  const [v] = (await stream.audienceFor({ token: t.token })).chains;
  const w = await k.gateway.authorize({ chain: v, action: "records.update", resource: `vyre://${SPACE}/contact/x` });
  assert.equal(w.effect, "deny");
  assert.equal(w.reason, "viewer_chain");
  assert.ok(carol);
});

test("chats survive a rebuild from the sealed log, with their sessions", async () => {
  const { k, bob, C, g } = await rig();
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  const c = await C.create(bob, { assistants: ["kit"] });
  const t = await k.surfaces.open(bob);
  await C.bind(bob, t.session, c.id);
  await C.change(bob, c.id, { add_people: [CAROL] });
  await g.rebuild();
  assert.deepEqual([...C.read(bob, c.id).people].sort(), [BOB, CAROL]);
  assert.equal((await stream.audienceFor({ token: t.token })).chains.length, 2);
  await k.grants.snapshot();
  await g.rebuild();
  assert.deepEqual([...C.read(bob, c.id).people].sort(), [BOB, CAROL]);
  assert.equal((await stream.audienceFor({ token: t.token })).chains.length, 2);
});
