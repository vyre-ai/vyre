import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "./index.js";
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
  assert.equal(room.size, 3, "the running call's own token decides, whatever a module passes");
  assert.deepEqual(Object.keys(room).sort(), ["canRead", "group", "read", "size"], "no chains, no names");
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
  assert.equal((await stream.audienceFor({})).size, 2);
  await k.grants.snapshot();
  await g.rebuild();
  assert.deepEqual([...C.read(bob, c.id).people].sort(), [BOB, CAROL]);
  assert.equal((await stream.audienceFor({})).size, 2);
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
  assert.equal(r.size, 2);
  assert.equal(await r.canRead(urn("task", "t1")), true);
  for (const type of ["team_member", "playbook", "contact"]) assert.equal(await r.canRead(urn(type, "x1")), false, type);
  // carol reaches only team members and playbooks
  r = await room(["team_member", "playbook"]);
  assert.equal(await r.canRead(urn("team_member", "m1")), true);
  assert.equal(await r.canRead(urn("playbook", "p1")), true);
  assert.equal(await r.canRead(urn("task", "t1")), false);
  assert.equal(JSON.stringify(Object.keys(r).sort()), JSON.stringify(["canRead", "group", "read", "size"]));
  void carol;
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
