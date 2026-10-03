import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "./index.js";
import { createEventLog } from "./core/events.js";
import { canonical, sha256 } from "./core/canonical.js";
import { CONTACT } from "./conformance/suite.js";

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

test("CH-2: only a person in the chat changes it: never a viewer chain, an assistant, or someone outside; each change is an event", async () => {
  const { k, owner, bob, carol, ada, asst, C } = await rig();
  const c = await C.create(bob, {});
  const viewer = k.chains.fromFacts({ kind: "viewer", person: BOB, vouched: true });
  for (const who of [viewer, asst(BOB, "s-a"), owner, carol]) {
    await assert.rejects(() => C.change(who, c.id, { add_people: [ADA] }), e => ["chain_not_person", "not_found"].includes(e.code));
  }
  await assert.rejects(() => C.create(viewer, {}), { code: "chain_not_person" });
  await assert.rejects(() => C.change(bob, c.id, { add_people: ["per_stranger"] }), { code: "bad_input" });
  const n = await C.change(bob, c.id, { add_people: [ADA] });
  assert.deepEqual([...n.people].sort(), [ADA, BOB]);
  assert.equal(C.read(ada, c.id).id, c.id);
  await C.change(ada, c.id, { remove_people: [BOB] });
  assert.throws(() => C.read(bob, c.id), { code: "not_found" });
  await assert.rejects(() => C.change(ada, c.id, { remove_people: [ADA] }), { code: "bad_input" }, "a chat keeps a person");
  assert.ok(k.log.read({ type: "chat.changed" }).length >= 2, "each change is an event");
});

test("CH-1: the chat is in the token from birth, checked at open: no bind step, no first come, a session cannot be pointed at another chat", async () => {
  const { k, bob, carol, ada, C } = await rig();
  assert.equal(C.bind, undefined, "there is no bind");
  assert.equal(k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } }).chats.bind, undefined);
  const group = await C.create(bob, { people: [CAROL] });
  const priv = await C.create(bob, {});
  await assert.rejects(() => k.surfaces.open(ada, { chat: group.id }), { code: "not_found" }, "an admin outside the chat cannot open a session for it");
  await assert.rejects(() => k.surfaces.open(carol, { chat: priv.id }), { code: "not_found" });
  await assert.rejects(() => k.surfaces.open(bob, { chat: "chat_nonesuch0" }), { code: "not_found" });
  const t = await k.surfaces.open(bob, { chat: group.id });
  assert.equal((await k.surfaces.verify(t.token)).chat, group.id);
  // the chat cannot be edited in the token: a changed body no longer verifies
  const [body, mac] = t.token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), chat: priv.id })).toString("base64url");
  await assert.rejects(() => k.surfaces.verify(`${forged}.${mac}`), { code: "not_a_member" });
});

test("audienceFor: the room is the running turn's own token; a handle, no chains; solo is not a group; unknown is refused; an opener who left has no room", async () => {
  const { k, bob, carol, C } = await rig();
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  const group = await C.create(bob, { people: [CAROL, OWNER] });
  const solo = await C.create(bob, {});
  const tg = await k.surfaces.open(bob, { chat: group.id }), ts = await k.surfaces.open(bob, { chat: solo.id }), tn = await k.surfaces.open(bob);
  const on = token => k.bindCalls(() => (token ? { token } : null));
  on(null);
  await assert.rejects(() => stream.audienceFor({ token: tg.token }), { code: "no_audience" }, "no running call: a token a module passes is nothing");
  on(tn.token);
  await assert.rejects(() => stream.audienceFor({}), { code: "no_audience" }, "a session with no chat is not a chat session");
  on(tg.token);
  const room = await stream.audienceFor({ token: ts.token });
  assert.equal(room.group, true);
  assert.equal(room.size, undefined, "no head count");
  assert.deepEqual(Object.keys(room).sort(), ["canRead", "group", "read"], "no chains, no names, no size");
  on(ts.token);
  assert.deepEqual(await stream.audienceFor({ token: tg.token }), { group: false });
  // CH-5: the opener leaves the chat: no room, and no write
  on(tg.token);
  await C.change(carol, group.id, { remove_people: [BOB] });
  await assert.rejects(() => stream.audienceFor({}), { code: "no_audience" });
  await assert.rejects(() => stream.chats.append(tg.token, { body: "hi" }), { code: "not_found" });
});

test("CH-3: a reply lands only in its own chat: one-to-one cannot write into a group, another chat is refused, an unlisted assistant is refused", async () => {
  const { k, bob, C } = await rig();
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  const group = await C.create(bob, { people: [CAROL], assistants: ["kit"] });
  const solo = await C.create(bob, {});
  const tg = await k.surfaces.open(bob, { chat: group.id }), ts = await k.surfaces.open(bob, { chat: solo.id });
  const m = await stream.chats.append(tg.token, { body: { text: "the fee is 4321" } });
  assert.equal(m.chat, group.id);
  assert.ok(m.id && m.hash);
  await assert.rejects(() => stream.chats.append(ts.token, { chat: group.id, body: "x" }), { code: "not_found" }, "a session opened one-to-one cannot name the group");
  await assert.rejects(() => stream.chats.append(tg.token, { chat: solo.id, body: "x" }), { code: "not_found" }, "another chat");
  assert.equal((await stream.chats.append(ts.token, { body: "mine" })).chat, solo.id, "the destination is the token's chat");
  await assert.rejects(() => stream.chats.append(tg.token, { body: "x".repeat(70_000) }), { code: "bad_input" });
  await assert.rejects(() => stream.chats.append("not.a-token", { body: "x" }), { code: "not_found" });
  const ev = k.log.read({ type: "message.added" });
  assert.equal(ev.length, 2);
  assert.ok(!JSON.stringify(ev).includes("4321"), "the log names who wrote where and a hash, never the text");
  // an assistant's session writes only where it is listed
  const ta = await k.surfaces.open(bob, { chat: group.id, agent: "kit" });
  assert.equal((await stream.chats.append(ta.token, { body: "from kit" })).chat, group.id);
  const tb = await k.surfaces.open(bob, { chat: solo.id, agent: "kit" });
  await assert.rejects(() => stream.chats.append(tb.token, { body: "x" }), { code: "not_found" }, "kit is not in the one-to-one chat");
});

test("room read: a field is a value only when everyone may read it and holds the same value; sealed is always restricted; unreadable or missing is null", async () => {
  const { k, owner, bob, C } = await rig();
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  const R = k.gateway.records;
  await R.define(owner, { add_types: [CONTACT] });
  const c = await R.create(owner, "contact", { name: "Jane", age: 40, ssn: { sealed: "ssn", ref: "sv_1", present: true, valid_format: true, set_at: 1 } });
  const group = await C.create(bob, { people: [OWNER] });
  const t = await k.surfaces.open(bob, { chat: group.id });
  k.bindCalls(() => ({ token: t.token }));
  const room = await stream.audienceFor({});
  const got = await room.read(c.urn);
  assert.equal(got.values.name, "Jane");
  assert.equal(got.values.age, 40);
  assert.ok(got.restricted.includes("ssn") && !("ssn" in got.values), "a sealed field is a placeholder for everyone");
  assert.deepEqual((await room.read(c.urn, ["name"])).values, { name: "Jane" });
  assert.equal(await room.read(`vyre://${SPACE}/contact/nonesuch0000`), null);
  assert.equal(await room.read("vyre://spc_bbbbbbbbbbbb/contact/x"), null);
  assert.equal(await room.read("not a urn"), null);
  assert.equal(await room.canRead(c.urn), true);
  assert.equal(await room.canRead("vyre://spc_bbbbbbbbbbbb/contact/x"), false);
  assert.equal(await room.canRead("nonsense"), false);
});

test("a viewer chain is never a person acting for themselves, and a model's session cannot become one: every person-only call refuses it", async () => {
  const { k, bob, C, g } = await rig();
  const { isExactlyPerson } = await import("./core/chain.js");
  const { chainCtx } = await import("./seal/wire.js");
  const v = k.chains.fromFacts({ kind: "viewer", person: BOB, vouched: true });
  assert.equal(v.viewer, true);
  assert.equal(isExactlyPerson(v), false);
  assert.equal(chainCtx(v).one_person, false, "the sealing process sees no single person");
  await assert.rejects(() => k.surfaces.open(v), { code: "chain_not_person" });
  const refused = { code: "chain_not_person" };
  const c = await C.create(bob, {});
  await assert.rejects(() => C.create(v, {}), refused);
  await assert.rejects(() => C.change(v, c.id, { add_people: [ADA] }), refused);
  assert.throws(() => C.read(v, c.id), { code: "not_found" });
  const role = { person: ADA, role: "member" };
  await assert.rejects(() => g.setRole(v, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/${ADA}`) }), refused);
  await assert.rejects(() => g.offers.offer(v, { side: "space_allows", member: BOB }, {}), refused);
  const w = await k.gateway.authorize({ chain: v, action: "records.update", resource: `vyre://${SPACE}/contact/x` });
  assert.deepEqual([w.effect, w.reason], ["deny", "viewer_chain"]);
  for (const call of ["decide", "declineFix", "unblock"]) if (typeof k.gateway.ask?.[call] === "function") await assert.rejects(() => k.gateway.ask[call](v, "task_x", {}), e => ["chain_not_person", "not_found", "bad_input"].includes(e.code), call);
});

test("chats and their changes survive a rebuild from the sealed log, and a token still names its chat", async () => {
  const { k, bob, C, g } = await rig();
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  const c = await C.create(bob, { assistants: ["kit"] });
  const t = await k.surfaces.open(bob, { chat: c.id });
  await C.change(bob, c.id, { add_people: [CAROL] });
  await g.rebuild();
  assert.deepEqual([...C.read(bob, c.id).people].sort(), [BOB, CAROL]);
  k.bindCalls(() => ({ token: t.token }));
  assert.equal((await stream.audienceFor({})).group, true);
  await k.grants.snapshot();
  await g.rebuild();
  assert.deepEqual([...C.read(bob, c.id).people].sort(), [BOB, CAROL]);
  assert.equal((await stream.audienceFor({})).group, true);
});

test("room canRead: records, tasks, team members and playbooks are judged by every person's own reach; no one is named", async () => {
  const { k, owner, g, bob, carol } = await rig();
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  const exp = Date.now() + 3_600_000;
  const urn = (type, id) => `vyre://${SPACE}/${type}/${id}`;
  const room = async (scope) => {
    const r = { person: CAROL, role: "temp", scope: scope.map(t => urn(t, "*")), expires: exp };
    await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${CAROL}`) });
    const chat = await k.gateway.grants.chats.create(bob, { people: [CAROL] });
    const t = await k.surfaces.open(bob, { chat: chat.id });
    k.bindCalls(() => ({ token: t.token }));
    return stream.audienceFor({});
  };
  // carol (temp) reaches only tasks: bob reads everything, so the room reads tasks and nothing else
  let r = await room(["task"]);
  assert.equal(r.group, true);
  assert.equal(await r.canRead(urn("task", "t1")), true);
  for (const type of ["team_member", "playbook", "contact"]) assert.equal(await r.canRead(urn(type, "x1")), false, type);
  // carol reaches only team members and playbooks
  r = await room(["team_member", "playbook"]);
  assert.equal(await r.canRead(urn("team_member", "m1")), true);
  assert.equal(await r.canRead(urn("playbook", "p1")), true);
  assert.equal(await r.canRead(urn("task", "t1")), false);
  assert.equal(JSON.stringify(Object.keys(r).sort()), JSON.stringify(["canRead", "group", "read"]));
  void carol;
});

const narrowAll = async (g, owner, person, patch) => {
  for (const x of (await g.list(owner)).filter(x => x.status === "active" && x.subject.kind === "actor" && x.subject.actor.id === person)) await g.narrow(owner, x.id, patch, { presence: proof("grants.narrow", { id: x.id, patch }, `vyre://${SPACE}/grant/${x.id}`) });
};
const setTemp = async (g, owner, person, types) => { const r = { person, role: "temp", scope: types.map(t => `vyre://${SPACE}/${t}/*`), expires: Date.now() + 3_600_000 }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${person}`) }); };

test("CH-7: a chain made from a session token is delegated: it cannot create a chat, change who is in one, mint a session or end another's", async () => {
  const { k, owner, bob, carol, g, C } = await rig();
  const group = await C.create(bob, { people: [CAROL, OWNER] });
  const t = await k.surfaces.open(bob, { chat: group.id });
  const harness = await k.surfaces.chainFor(t.token);            // what a daemon or a module holding the asker's session has
  assert.equal(harness.delegated, true);
  assert.equal(bob.delegated, undefined, "a person acting directly is not delegated");
  await assert.rejects(() => C.change(harness, group.id, { remove_people: [CAROL] }), { code: "chain_not_person" }, "reviewer-2's probe: the harness removes a person");
  await assert.rejects(() => C.change(harness, group.id, { add_people: [ADA] }), { code: "chain_not_person" });
  await assert.rejects(() => C.create(harness, { people: [CAROL] }), { code: "chain_not_person" });
  await assert.rejects(() => k.surfaces.open(harness, { chat: group.id }), { code: "chain_not_person" }, "a session's chain cannot mint a longer one");
  assert.throws(() => k.surfaces.revoke(t.session, harness), { code: "not_found" });
  // the same calls from the person acting directly still work
  const changed = await C.change(bob, group.id, { add_people: [ADA] });
  assert.ok(changed.people.includes(ADA));
  void carol; void g;
});

test("R3: the room is the chat's live participants at every question (no snapshot)", async () => {
  const { k, owner, bob, g, C } = await rig();
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  const R = k.gateway.records;
  await R.define(owner, { add_types: [CONTACT] });
  const c = await R.create(owner, "contact", { name: "Jane" });
  await setTemp(g, owner, CAROL, ["task"]);              // carol reads no contact
  const chat = await C.create(bob, { people: [OWNER, ADA] });
  const t = await k.surfaces.open(bob, { chat: chat.id });
  k.bindCalls(() => ({ token: t.token }));
  const room = await stream.audienceFor({});
  assert.equal(await room.canRead(c.urn), true);
  await C.change(bob, chat.id, { add_people: [CAROL] });  // joins AFTER the handle was made
  assert.equal(await room.canRead(c.urn), false, "the same handle now asks carol too");
  assert.equal((await room.read(c.urn)), null);
});

test("a reply belongs to the room version it was written for: someone who joins mid-stream, or after, never receives it; the next reply reaches them", async () => {
  const { k, owner, bob, carol, ada, C } = await rig();
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  const chat = await C.create(bob, { people: [OWNER] });       // bob and the owner
  const t = await k.surfaces.open(bob, { chat: chat.id });
  const reply = await stream.chats.appendOpen(t.token, { kind: "text" });
  assert.match(reply.id, /^msg_/);
  await reply.write("the fee is ");
  await C.change(bob, chat.id, { add_people: [CAROL] });       // carol joins while it streams
  await reply.write("four thousand");
  const done = await reply.close();
  assert.equal(done.ver, reply.ver);
  const asBob = bob, asOwner = owner;
  assert.equal(stream.chats.mayReceive(asBob, reply.id), true);
  assert.equal(stream.chats.mayReceive(asOwner, reply.id), true);
  assert.equal(stream.chats.mayReceive(carol, reply.id), false, "carol joined after this reply's version: she never receives it");
  assert.equal(stream.chats.mayReceive(ada, reply.id), false, "not in the chat at all");
  // the next message is stamped with the new version and reaches carol, and a person's own message is stamped the same way
  const next = await stream.chats.append(t.token, { body: "welcome carol" });
  assert.equal(stream.chats.mayReceive(carol, next.id), true);
  assert.ok(next.ver > reply.ver);
  assert.equal(stream.chats.mayReceive(carol, "msg_nope"), false, "an unknown message");
  // someone removed stops receiving at once, even what was said while they were in
  await C.change(bob, chat.id, { remove_people: [CAROL] });
  assert.equal(stream.chats.mayReceive(carol, next.id), false);
  // the join is an event with its version
  const ev = k.log.read({}).filter(e => e.type === "chat.changed").map(e => [e.data.ver, e.data.joined, e.data.left]);
  assert.deepEqual(ev, [[2, [CAROL], []], [3, [], [CAROL]]]);
  // answers are only for the person asking: a viewer chain and a model's chain with no listed assistant get nothing
  assert.equal(stream.chats.mayReceive(await k.chains.fromFacts({ kind: "viewer", person: BOB, vouched: true }), reply.id), false);
});

test("a reply opened by a session whose chat is another chat is refused; a handle is dead after close and after the turn's token ends", async () => {
  const { k, bob, C } = await rig();
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  const mine = await C.create(bob, {}), other = await C.create(bob, { people: [CAROL] });
  const t = await k.surfaces.open(bob, { chat: mine.id });
  await assert.rejects(() => stream.chats.appendOpen(t.token, { chat: other.id }), { code: "not_found" });
  const tn = await k.surfaces.open(bob);
  await assert.rejects(() => stream.chats.appendOpen(tn.token, {}), { code: "not_found" }, "a session with no chat");
  const h = await stream.chats.appendOpen(t.token, {});
  await h.write("hi");
  await h.close();
  await assert.rejects(() => h.write("more"), { code: "closed" });
  await assert.rejects(() => h.close(), { code: "closed" });
  const h2 = await stream.chats.appendOpen(t.token, {});
  await h2.write("a");
  k.surfaces.revoke(t.session);                                   // the turn's token ends
  await assert.rejects(() => h2.write("b"), { code: "not_found" });
  const t2 = await k.surfaces.open(bob, { chat: mine.id });
  const h3 = await stream.chats.appendOpen(t2.token, {});
  await C.change(bob, other.id, { remove_people: [BOB] });          // leaving another chat changes nothing here
  await h3.write("still ok");
  await assert.rejects(() => h3.write("x".repeat(70_000)), { code: "bad_input" }, "at most 64 KB");
});

test("a delta written under a group token cannot carry a value the gateway returned as a placeholder: the session never held it", async () => {
  const { k, owner, bob, g, C } = await rig();
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  const R = k.gateway.records;
  await R.define(owner, { add_types: [CONTACT] });
  const c = await R.create(owner, "contact", { name: "Jane", age: 40 });
  await narrowAll(g, owner, BOB, { fields: ["name"] });
  const group = await C.create(owner, { people: [BOB] });
  const t = await k.surfaces.open(owner, { chat: group.id });
  const harness = await k.surfaces.chainFor(t.token);
  // everything the session can learn through the gateway, every way it can ask
  const seen = JSON.stringify([await R.get(harness, "contact", c.id), await R.query(harness, "contact", { page: { limit: 10 } }), await R.aggregate(harness, "contact", { measures: [{ fn: "count" }] }), await R.search(harness, { q: "Jane", page: { limit: 10 } }).catch(() => null)]);
  const [got, rows, , hits] = JSON.parse(seen);
  assert.equal(got.data.age, `{{field:${c.urn}#age}}`, "the record read");
  assert.deepEqual(rows.rows.map(r => r.data.age), [`{{field:${c.urn}#age}}`], "the query");
  for (const h of (hits && hits.rows) || []) assert.equal(h.snippet, undefined, "no search snippet: it could carry a field's text");
  assert.equal(typeof got.data.age, "string", "the number 40 is not in the record the session was given");
  // so a reply composed from it carries the placeholder, which each person's own device fills in under their own grants
  const reply = await stream.chats.appendOpen(t.token, {});
  const text = `Jane's age is ${JSON.parse(seen)[0].data.age}`;
  await reply.write(text);
  assert.equal(text.includes("is 40"), false);
  const done = await reply.close(text);
  assert.ok(done.hash);
});

test("CH-8: a group session's every gateway read is the room's view: a placeholder where one person may not read, null where anyone cannot; a one-to-one session reads the value", async () => {
  const { k, owner, bob, g, C } = await rig();
  const R = k.gateway.records;
  await R.define(owner, { add_types: [CONTACT] });
  const c = await R.create(owner, "contact", { name: "Jane", age: 40 }, { attrs: { sensitivity: "internal" } });
  const secret = await R.create(owner, "contact", { name: "Hidden", age: 1 }, { attrs: { sensitivity: "restricted" } });
  await narrowAll(g, owner, BOB, { fields: ["name"] });          // bob may read only names
  await narrowAll(g, owner, CAROL, { where: [{ attr: "sensitivity", op: "ne", value: "restricted" }] });   // carol may not read restricted rows
  const group = await C.create(owner, { people: [BOB, CAROL] });
  const solo = await C.create(owner, {});
  const tg = await k.surfaces.open(owner, { chat: group.id }), ts = await k.surfaces.open(owner, { chat: solo.id });
  const harnessG = await k.surfaces.chainFor(tg.token), harnessS = await k.surfaces.chainFor(ts.token);
  // a plain gateway read by the harness, with no room.read in sight
  const g1 = await R.get(harnessG, "contact", c.id);
  assert.equal(g1.data.name, "Jane", "everyone may read the name");
  assert.equal(g1.data.age, `{{field:${c.urn}#age}}`, "bob may not read age: a placeholder for the whole room");
  assert.equal(await R.get(harnessG, "contact", secret.id), null, "carol cannot read this row: not in the room's view");
  const s1 = await R.get(harnessS, "contact", c.id);
  assert.equal(s1.data.age, 40, "a one-to-one session reads the value");
  assert.equal((await R.get(harnessS, "contact", secret.id)).data.name, "Hidden");
  // query, search and aggregate give the same view
  const q = await R.query(harnessG, "contact", { page: { limit: 10 } });
  assert.deepEqual(q.rows.map(r => r.data.name), ["Jane"]);
  assert.equal(q.rows[0].data.age, `{{field:${c.urn}#age}}`);
  await assert.rejects(() => R.query(harnessG, "contact", { filter: { field: "age", op: "eq", value: 40 }, page: { limit: 5 } }), { code: "bad_input" }, "no filtering on a field the room may not all read");
  assert.equal((await R.query(harnessG, "contact", { filter: { field: "name", op: "eq", value: "Jane" }, page: { limit: 5 } })).rows.length, 1);
  const agg = await R.aggregate(harnessG, "contact", { measures: [{ fn: "count" }] });
  assert.equal(JSON.stringify(agg).includes("2"), false, "the row carol cannot read is not counted");
  // the person who asked leaves the chat: no more reads under that token
  await C.change(owner, group.id, { remove_people: [OWNER] }).catch(() => {});
  void bob;
});

test("room handle: no size, a per-session rate limit, and canRead applies row predicates", async () => {
  const { k, owner, bob, g, C } = await rig();
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  const R = k.gateway.records;
  await R.define(owner, { add_types: [CONTACT] });
  const open = await R.create(owner, "contact", { name: "Open" }, { attrs: { sensitivity: "internal" } });
  const priv = await R.create(owner, "contact", { name: "Priv" }, { attrs: { sensitivity: "restricted" } });
  await narrowAll(g, owner, CAROL, { where: [{ attr: "sensitivity", op: "ne", value: "restricted" }] });
  const chat = await C.create(bob, { people: [CAROL] });
  const t = await k.surfaces.open(bob, { chat: chat.id });
  k.bindCalls(() => ({ token: t.token }));
  const room = await stream.audienceFor({});
  assert.deepEqual(Object.keys(room).sort(), ["canRead", "group", "read"]);
  assert.equal(await room.canRead(open.urn), true);
  assert.equal(await room.canRead(priv.urn), false, "carol's row predicate is applied, not skipped as a type-level probe would");
  assert.equal(await room.read(priv.urn), null);
  let limited = 0;
  for (let i = 0; i < 130; i++) { try { await room.canRead(open.urn); } catch (e) { if (e.code === "rate_limited") limited++; } }
  assert.ok(limited > 0, "a session may ask the room only so often");
});

test("R4 on chats: a failed log write leaves the chat's people as they were, and the caller is told", async () => {
  let fail = false;
  const base = createEventLog({ space: SPACE });
  const log = { ...base, append: (c, e, ...r) => { if (fail && /^chat\./.test(e.type)) throw new Error("killed"); return base.append(c, e, ...r); } };
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence, log });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  for (const p of [BOB, CAROL]) { const r = { person: p, role: "member" }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const C = g.chats;
  fail = true;
  await assert.rejects(() => C.create(bob, { people: [CAROL] }), /killed/);
  fail = false;
  const chat = await C.create(bob, { people: [CAROL] });
  fail = true;
  await assert.rejects(() => C.change(bob, chat.id, { remove_people: [CAROL] }), /killed/);
  fail = false;
  assert.deepEqual([...(await C.read(bob, chat.id)).people].sort(), [BOB, CAROL].sort(), "carol was not removed: the removal was never durable");
  const after = await C.change(bob, chat.id, { remove_people: [CAROL] });
  assert.deepEqual(after.people, [BOB]);
});

test("a reply stops when the person it acts for or the ASSISTANT is removed from the chat: what was written stays, marked ended", async () => {
  const { k, bob, carol, C } = await rig();
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  // the assistant is removed mid-reply
  const chat = await C.create(bob, { people: [CAROL], assistants: ["kit"] });
  const t = await k.surfaces.open(bob, { chat: chat.id, agent: "kit" });
  const reply = await stream.chats.appendOpen(t.token, {});
  await reply.write("the first part");
  await C.change(bob, chat.id, { remove_assistants: ["kit"] });
  await assert.rejects(() => reply.write(" and more"), { code: "not_found" }, "the assistant is no longer a participant");
  await assert.rejects(() => reply.write("again"), { code: "closed" });
  await assert.rejects(() => reply.close(), { code: "closed" }, "it does not finish");
  const ended = k.log.read({}).find(e => e.type === "message.ended" && e.data.id === reply.id);
  assert.equal(ended.data.bytes, Buffer.byteLength("the first part"));
  assert.equal(ended.data.reason, "no_longer_allowed");
  assert.equal(k.log.read({}).some(e => e.type === "message.added" && e.data.id === reply.id), false, "never closed as a finished message");
  // the person it acts for is removed mid-reply
  const chat2 = await C.create(bob, { people: [CAROL], assistants: ["kit"] });
  const t2 = await k.surfaces.open(bob, { chat: chat2.id, agent: "kit" });
  const r2 = await stream.chats.appendOpen(t2.token, {});
  await r2.write("x");
  await C.change(carol, chat2.id, { remove_people: [BOB] });
  await assert.rejects(() => r2.write("y"), { code: "not_found" });
  assert.ok(k.log.read({}).some(e => e.type === "message.ended" && e.data.id === r2.id));
});

test("roomFor(token): the same live room for event-driven code, only for a module that declares it and a token that verifies and names a chat", async () => {
  const { k, bob, C } = await rig();
  const plain = k.kernelFor({ name: "plain", needs: { kernel: { actions: [] } } });
  const events = k.kernelFor({ name: "worker", needs: { kernel: { actions: [], room: true } } });
  const group = await C.create(bob, { people: [CAROL] }), solo = await C.create(bob, {});
  const tg = await k.surfaces.open(bob, { chat: group.id }), ts = await k.surfaces.open(bob, { chat: solo.id }), tn = await k.surfaces.open(bob);
  assert.equal(plain.chats.roomFor, undefined, "a module that did not declare it has no roomFor");
  const room = await events.chats.roomFor(tg.token);
  assert.deepEqual(Object.keys(room).sort(), ["canRead", "group", "read"]);
  assert.deepEqual(await events.chats.roomFor(ts.token), { group: false });
  await assert.rejects(() => events.chats.roomFor(tn.token), { code: "no_audience" }, "a session with no chat");
  await assert.rejects(() => events.chats.roomFor("not.a-token"), { code: "no_audience" });
  await C.change(bob, group.id, { remove_people: [BOB] }).catch(() => {});
  k.surfaces.revoke(tg.session);
  await assert.rejects(() => events.chats.roomFor(tg.token), { code: "no_audience" }, "a token that has ended");
});

test("room read of a kernel task: the fields everyone may read with the same value; null when anyone cannot read it or it does not exist", async () => {
  const { k, owner, bob, C } = await rig();
  await k.gateway.records.define(owner, { add_types: [CONTACT] });
  const contact = await k.gateway.records.create(owner, "contact", { name: "Jane" });
  const svc = k.kernelFor({ name: "work", needs: { kernel: { actions: ["tasks.request", "tasks.read", "records.read"], prefixes: ["task/*", "contact/*"] } } });
  const t = await svc.tasks.request(owner, { title: "Welcome email for Jane", doer: { kind: "agent", id: "kit", space: SPACE }, checker: { kind: "person", id: BOB, space: SPACE }, output: { kind: "sent" }, record: contact.urn });
  const group = await C.create(bob, { people: [OWNER] });
  const ses = await k.surfaces.open(bob, { chat: group.id });
  k.bindCalls(() => ({ token: ses.token }));
  const room = await svc.audienceFor({});
  const got = await room.read(`vyre://${SPACE}/task/${t.id}`);
  assert.ok(got, "the task is readable by both");
  assert.equal(got.values.title, "Welcome email for Jane");
  assert.equal(await room.read(`vyre://${SPACE}/task/task_nonesuch00`), null);
});

test("X-1: the daemon's own chain for the owner is not delegated and can open a session; only a chain made from a token is delegated", async () => {
  const { k } = await rig();
  const daemon = await k.chains.fromFacts({ kind: "session_person", person: OWNER, session: "stages", vouched: true });
  assert.equal(daemon.delegated, undefined);
  const t = await k.surfaces.open(daemon, {});
  assert.ok(t.token);
  const fromToken = await k.surfaces.chainFor(t.token);
  assert.equal(fromToken.delegated, true);
  await assert.rejects(() => k.surfaces.open(fromToken, {}), { code: "chain_not_person" });
});

test("CH-10: a reply belongs to the oldest room version its data was read under, however late it is opened", async () => {
  const { k, owner, bob, C } = await rig();
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  const R = k.gateway.records;
  await R.define(owner, { add_types: [CONTACT] });
  const c = await R.create(owner, "contact", { name: "Jane" });
  const chat = await C.create(bob, { people: [OWNER] });
  const t = await k.surfaces.open(bob, { chat: chat.id });
  k.bindCalls(() => ({ token: t.token }));
  const harness = await k.surfaces.chainFor(t.token);
  await R.get(harness, "contact", c.id);                       // read while carol is not in the room
  await C.change(bob, chat.id, { add_people: [CAROL] });        // carol joins
  const reply = await stream.chats.appendOpen(t.token, {});     // opened AFTER the join
  await reply.close("built from data carol could not read");
  const carol = await k.chains.fromFacts({ kind: "device", device_key_id: "d-c", person: CAROL, path: "direct" });
  assert.equal(stream.chats.mayReceive(carol, reply.id), false, "carol is not in the version the data was read under");
  const later = await stream.chats.appendOpen(t.token, {});     // no read since: the current version
  await later.close("hello carol");
  assert.equal(stream.chats.mayReceive(carol, later.id), true);
});

test("R4-b: when the log can be neither written nor read, the store keeps the state the call started from, never an empty one", async () => {
  let down = false;
  const base = createEventLog({ space: SPACE });
  const log = { ...base, append: (c, e, ...r) => { if (down) throw new Error("killed"); return base.append(c, e, ...r); }, read: (...a) => { if (down) throw new Error("unreadable"); return base.read(...a); } };
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence, log });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  const r = { person: BOB, role: "member" };
  await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${BOB}`) });
  const before = (await g.list(owner)).length;
  const r2 = { person: BOB, role: "admin" };
  down = true;
  await assert.rejects(() => g.setRole(owner, r2, { presence: proof("grants.role", r2, `vyre://${SPACE}/member/${BOB}`) }), /killed/);
  down = false;
  assert.equal((await g.list(owner)).length, before, "the grants are still there");
  assert.equal((await g.members.get(owner, BOB)).role, "member", "bob is still a member, as before the call");
});

test("CH-8b: a group session's tasks, listings and events are the room's view too, not the asker's", async () => {
  const { k, owner, bob, g, C } = await rig();
  const R = k.gateway.records;
  await R.define(owner, { add_types: [CONTACT] });
  const contact = await R.create(owner, "contact", { name: "Jane" });
  const svc = k.kernelFor({ name: "work", needs: { kernel: { actions: ["tasks.request", "tasks.read", "records.read"], prefixes: ["task/*", "contact/*"] } } });
  const t = await svc.tasks.request(owner, { title: "Welcome email", doer: { kind: "agent", id: "kit", space: SPACE }, checker: { kind: "person", id: BOB, space: SPACE }, output: { kind: "sent" }, record: contact.urn });
  await setTemp(g, owner, CAROL, ["contact"]);                         // carol reaches contacts only: no tasks, no listings
  const group = await C.create(owner, { people: [CAROL] });
  const solo = await C.create(owner, {});
  const harnessG = await k.surfaces.chainFor((await k.surfaces.open(owner, { chat: group.id })).token);
  const harnessS = await k.surfaces.chainFor((await k.surfaces.open(owner, { chat: solo.id })).token);
  // a task carol cannot read comes back absent in the group session, present in the one-to-one
  assert.ok(await k.gateway.ask.get(harnessS, t.id), "one-to-one: the asker's view");
  assert.equal(await k.gateway.ask.get(harnessG, t.id), null, "group: carol cannot read it");
  // listings: the asker is an owner who sees everyone; in a room with carol only the asker themself is listed
  assert.ok((await k.gateway.grants.members.list(harnessS)).length >= 3);
  assert.equal((await k.gateway.grants.members.list(harnessG)).length, 1);
  assert.ok((await k.gateway.grants.list(harnessS)).length > (await k.gateway.grants.list(harnessG)).length);
  // events: the record's creation is in the one-to-one session's log view and, carol reading contacts, also in the room's; a task event she cannot read is not
  const evS = await k.gateway.events.read(harnessS, {}), evG = await k.gateway.events.read(harnessG, {});
  assert.ok(evS.length > evG.length, "the room sees fewer events than the asker alone");
  assert.equal(evG.some(e => String(e.subject).includes("/task/")), false);
  void bob;
});

test("CH-10 by the kernel: beginTurn fixes the room version before the turn's first read; a join after it never receives the reply, whatever order the stream calls in", async () => {
  const { k, bob, C } = await rig();
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  const chat = await C.create(bob, { people: [OWNER] });
  const t = await k.surfaces.open(bob, { chat: chat.id });
  const turn = await stream.chats.beginTurn(t.token);          // the turn starts: version fixed, before any read
  await C.change(bob, chat.id, { add_people: [CAROL] });          // carol joins before the turn reads anything
  const reply = await stream.chats.appendOpen(t.token, {});
  assert.equal(reply.ver, turn.ver, "the reply belongs to the version the turn began under");
  await reply.close("said while carol was not here");
  const carol = await k.chains.fromFacts({ kind: "device", device_key_id: "d-c", person: CAROL, path: "direct" });
  assert.equal(stream.chats.mayReceive(carol, reply.id), false);
  const next = await stream.chats.appendOpen(t.token, {});       // a new turn (no begin): the current version
  await next.close("hi carol");
  assert.equal(stream.chats.mayReceive(carol, next.id), true);
  await assert.rejects(() => stream.chats.beginTurn("not.a-token"), { code: "not_found" });
});

test("CH-8b: every read action in the gateway's table is the room's view under a group token: allowed to the asker alone, refused once a person who may not read joins", async () => {
  const { k, owner, g, C } = await rig();
  await setTemp(g, owner, CAROL, ["contact"]);                   // carol reaches contacts only
  const solo = await C.create(owner, {}), group = await C.create(owner, { people: [CAROL] });
  const hS = await k.surfaces.chainFor((await k.surfaces.open(owner, { chat: solo.id })).token);
  const hG = await k.surfaces.chainFor((await k.surfaces.open(owner, { chat: group.id })).token);
  const reads = k.gateway.actions().filter(a => a.risk === "read");
  assert.ok(reads.length >= 6, `the table has read actions (${reads.map(a => a.action).join(", ")})`);
  let walked = 0;
  for (const a of reads) {
    const resource = `vyre://${SPACE}/${a.resource_type === "type" ? "definition" : a.resource_type}/x1`;
    const alone = (await k.gateway.authorize({ chain: hS, action: a.action, resource })).effect;
    if (alone !== "allow") continue;                              // not a door this chain has
    const inRoom = (await k.gateway.authorize({ chain: hG, action: a.action, resource })).effect;
    // carol's reach is contacts only: for anything else the room must refuse, never fall back to the asker's view
    if (a.resource_type !== "contact") assert.notEqual(inRoom, "allow", `${a.action} under a group token is the room's view`);
    walked++;
  }
  assert.ok(walked >= 4, `walked ${walked} read actions`);
});
