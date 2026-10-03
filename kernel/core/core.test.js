import test from "node:test";
import assert from "node:assert/strict";
import { mintUuid, mintId, isUuid, timeOf } from "./ids.js";
import { canonical, sha256 } from "./canonical.js";
import { createChainBuilder, isChain, isExactlyPerson, chainHash, mergeLabels } from "./chain.js";
import { createAuthorizer, contains, patternCovers } from "./authorize.js";
import { createEventLog, verifyEvents, genesis } from "./events.js";
import { covers, containedPrefix, segments } from "./urn.js";

const SPACE = "spc_aaaaaaaaaaaa";
const OWNER = "per_owner";
const key = Buffer.alloc(32, 7);
let T = 1_800_000_000_000;
const clock = () => T;
const builder = (extra = {}) => createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key, clock, ...extra });
const sock = (surface, over = {}) => ({ kind: "socket", surface, uid: 501, pid: 1, inside_model_process: false, capsule_verified: true, ...over });

test("ids: time-prefixed, v4 marker, sortable, round-trip", () => {
  const a = mintUuid(1000), b = mintUuid(2000);
  assert.ok(isUuid(a) && a[14] === "4" && /[89ab]/.test(a[19]));
  assert.ok(a < b);
  assert.equal(timeOf(a), 1000);
  assert.equal(timeOf(mintId("dec", 5000)), 5000);
  assert.equal(isUuid("0190c3f2-1111-7abc-8def-000000000000"), false, "a v7 marker is refused (Twenty rejects it)");
  assert.throws(() => mintUuid(-1));
});

test("canonical: key order and undefined do not change the bytes; non-finite numbers throw", () => {
  assert.equal(canonical({ b: 1, a: [1, undefined], c: undefined }), '{"a":[1,null],"b":1}');
  assert.equal(sha256(canonical({ x: 1, y: 2 })), sha256(canonical({ y: 2, x: 1 })));
  assert.throws(() => canonical({ n: NaN }));
});

test("chain: the owner's own surface is exactly one person; a wrong uid has no chain", () => {
  const b = builder();
  const c = b.fromFacts(sock("deck"));
  assert.ok(isChain(c) && isExactlyPerson(c));
  assert.equal(c.hops[0].actor.id, OWNER);
  assert.throws(() => b.fromFacts(sock("cli", { uid: 502 })), { code: "not_a_member" });
  assert.throws(() => b.fromFacts(sock("capsule", { capsule_verified: false })), { code: "not_a_member" });
});

test("chain: a model's call is never the person, whatever surface it names", () => {
  const b = builder();
  for (const s of ["cli", "deck", "mcp", "harness"]) {
    const c = b.fromFacts(sock(s, { inside_model_process: s !== "mcp" && s !== "harness" }));
    assert.ok(!c.hops.some(h => h.actor.kind === "person"), s);
    assert.equal(c.hops[0].actor.kind, "agent");
  }
  const hook = b.fromFacts(sock("hook", { inside_model_process: true }));
  assert.deepEqual(hook.hops.map(h => h.actor.kind), ["agent", "service"]);
});

test("chain: an unvouched agent claim yields no chain; a vouched one is [person, agent]", () => {
  const b = builder();
  assert.throws(() => b.fromFacts({ kind: "agent_session", agent: "kit", session: "s1", thread: "t", vouched: false }), { code: "not_a_member" });
  const c = b.fromFacts({ kind: "agent_session", agent: "kit", session: "s1", thread: "t", vouched: true });
  assert.deepEqual(c.hops.map(h => h.actor.kind), ["person", "agent"]);
  assert.equal(isExactlyPerson(c), false);
});

test("chain: a device of a non-member person has no chain; a member's device is [person] with a device via", () => {
  const b = builder({ is_person: p => p === OWNER || p === "per_two" });
  assert.throws(() => b.fromFacts({ kind: "device", device_key_id: "d1", person: "per_x", path: "direct" }), { code: "not_a_member" });
  const c = b.fromFacts({ kind: "device", device_key_id: "d1", person: "per_two", path: "relay" });
  assert.ok(isExactlyPerson(c));
  assert.equal(c.hops[0].via.device, "device:d1");
});

test("chain: a module call appends a service hop to the inbound chain and never shortens it", () => {
  const b = builder();
  const person = b.fromFacts(sock("deck"));
  const c = b.fromFacts({ kind: "module", module: "email", first_party: true, inbound: person });
  assert.deepEqual(c.hops.map(h => h.actor.kind), ["person", "service"]);
  assert.equal(c.hops[1].entered_by, "registry");
  assert.equal(c.labels.trust, "member");
  const added = b.fromFacts({ kind: "module", module: "zz", first_party: false, inbound: person });
  assert.equal(added.labels.trust, "external");
  assert.throws(() => b.fromFacts({ kind: "module", module: "x", first_party: true, inbound: { hops: [] } }), { code: "not_a_member" });
});

test("chain: a hand-made object is not a chain; built ones are frozen", () => {
  const b = builder();
  const c = b.fromFacts(sock("deck"));
  assert.equal(isChain({ ...c }), false);
  assert.equal(isChain(JSON.parse(JSON.stringify(c))), false);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.hops) && Object.isFrozen(c.hops[0].actor));
});

test("chain: a stored job chain survives a restart, and a forged or foreign record yields nothing", () => {
  const b = builder();
  const c = b.fromFacts({ kind: "agent_session", agent: "kit", session: "s1", thread: "t", vouched: true });
  const stored = JSON.parse(JSON.stringify(b.serialize(c)));
  const back = builder().restore(stored);
  assert.deepEqual(back.hops, c.hops);
  assert.equal(back.job, stored.job);
  const forged = { ...stored, body: stored.body.replace("agent", "person") };
  assert.throws(() => builder().restore(forged), { code: "not_a_member" });
  assert.throws(() => createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 8) }).restore(stored), { code: "not_a_member" });
  assert.throws(() => builder().restore({ body: "{}", mac: "x" }), { code: "not_a_member" });
});

test("chain: taint is sticky and only grows; chain hash ignores time", () => {
  const b = builder();
  const c = b.fromFacts(sock("deck"));
  const t = b.weaken(c, { trust: "external", red: "pii", source_spaces: ["spc_bbbbbbbbbbbb"] });
  assert.equal(t.labels.trust, "external");
  assert.equal(t.labels.red, "pii");
  assert.deepEqual(t.labels.source_spaces, [SPACE, "spc_bbbbbbbbbbbb"]);
  const again = b.weaken(t, { trust: "member", red: "public", source_spaces: [SPACE] });
  assert.equal(again.labels.trust, "external", "a stronger label does not wash taint out");
  T += 5;
  assert.equal(chainHash(b.fromFacts(sock("deck"))), chainHash(c));
  assert.equal(mergeLabels({ trust: "system", red: "secret", source_spaces: [] }, { trust: "untrusted", red: "public", source_spaces: [] }).trust, "untrusted");
});

// ---- urn ----
test("urn: a selector covers its depth and below; * is one segment", () => {
  assert.ok(covers(`vyre://${SPACE}/matter/*`, `vyre://${SPACE}/matter/1`));
  assert.ok(covers(`vyre://${SPACE}/matter/1`, `vyre://${SPACE}/matter/1/notes`));
  assert.equal(covers(`vyre://${SPACE}/matter/1/notes`, `vyre://${SPACE}/matter/1`), false);
  assert.equal(covers("not-a-urn", `vyre://${SPACE}/matter/1`), false);
  assert.ok(containedPrefix(`vyre://${SPACE}/matter/1`, `vyre://${SPACE}/matter/*`));
  assert.equal(containedPrefix(`vyre://${SPACE}/matter/*`, `vyre://${SPACE}/matter/1`), false);
});

// ---- authorize ----
const ACTIONS = [
  { action: "crm.read", resource_type: "contact", risk: "read", label: "read", gloss: "" },
  { action: "crm.update", resource_type: "contact", risk: "write", label: "edit", gloss: "" },
  { action: "crm.merge", resource_type: "contact", risk: "write", label: "merge", gloss: "", since: 5 },
  { action: "email.send", resource_type: "message", risk: "outward.send", label: "send", gloss: "" },
  { action: "grants.create", resource_type: "grant", risk: "grant", label: "grant", gloss: "" },
  { action: "space.set", resource_type: "space", risk: "admin", label: "admin", gloss: "" },
];
const R = id => `vyre://${SPACE}/contact/${id}`;
const actorOf = (kind, id) => ({ kind, id, space: SPACE });
let gn = 0;
const grant = (over = {}) => ({
  id: `gr_${String(++gn).padStart(4, "0")}`, space: SPACE, subject: { kind: "actor", actor: actorOf("person", OWNER) },
  actions: ["crm.*"], action_set_version: 9, resource: { prefix: `vyre://${SPACE}/contact/*` }, conditions: {},
  issuer: actorOf("person", OWNER), source: "test", status: "active", created_at: 0, ...over,
});
function world({ grants = [], members = [], memberships = {}, ...cfg } = {}) {
  const all = new Map(grants.map(g => [g.id, g]));
  const known = new Set([`person:${OWNER}`, ...members]);
  return createAuthorizer({
    space: SPACE, actions: ACTIONS, clock,
    grants: { forSubject: a => [...all.values()].filter(g => g.subject.kind === "role" ? true : g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: id => all.get(id) },
    members: { has: a => known.has(`${a.kind}:${a.id}`), membership: a => memberships[`${a.kind}:${a.id}`] },
    ...cfg,
  });
}
const person = () => builder().fromFacts(sock("deck"));
const ask = (az, chain, action, resource = R(1), extra = {}) => az.authorize({ chain, action, resource, ...extra });

test("authorize: default is deny, and an allowed read says which grant carried it", async () => {
  const az = world();
  assert.deepEqual([(await ask(az, person(), "crm.read")).effect, (await ask(az, person(), "crm.read")).reason], ["deny", "no_grant"]);
  const g = grant();
  const ok = await ask(world({ grants: [g] }), person(), "crm.read");
  assert.deepEqual([ok.effect, ok.reason, ok.grants], ["allow", "ok", [g.id]]);
  assert.match(ok.decision, /^dec_/);
  assert.ok(Object.isFrozen(ok) && Object.isFrozen(ok.obligations));
});

test("authorize: a hand-made chain, an unknown action and a foreign Space are refused", async () => {
  const az = world({ grants: [grant()] });
  assert.equal((await ask(az, { hops: [], space: SPACE }, "crm.read")).reason, "bad_input");
  assert.equal((await ask(az, person(), "crm.zap")).reason, "unknown_action");
  assert.equal((await ask(az, person(), "crm.read", "vyre://spc_zzzzzzzzzzzz/contact/1")).reason, "wrong_space");
  assert.equal((await ask(az, person(), "crm.read", "nonsense")).reason, "wrong_space");
  const other = createChainBuilder({ space: "spc_bbbbbbbbbbbb", owner: OWNER, owner_uid: 501, key, clock }).fromFacts(sock("deck"));
  assert.equal((await ask(az, other, "crm.read")).reason, "wrong_space");
});

test("authorize: authority is the intersection; an agent in the chain without a grant is denied (confused deputy)", async () => {
  const b = builder();
  const chain = b.fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true });
  const az = world({ grants: [grant()], members: ["agent:kit"] });
  assert.equal((await ask(az, chain, "crm.read")).reason, "no_grant");
  const both = world({ grants: [grant(), grant({ subject: { kind: "actor", actor: actorOf("agent", "kit") }, actions: ["crm.read"] })], members: ["agent:kit"] });
  assert.equal((await ask(both, chain, "crm.read")).effect, "allow");
  assert.equal((await ask(both, chain, "crm.update")).effect, "deny", "the agent's grant is read only, so the person's write does not carry it");
  const stranger = b.fromFacts({ kind: "agent_session", agent: "ghost", session: "s", thread: "t", vouched: true });
  assert.equal((await ask(both, stranger, "crm.read")).reason, "not_a_member");
});

test("authorize: expiry, not-before, surface and node conditions", async () => {
  const mk = when => world({ grants: [grant({ conditions: when })] });
  assert.equal((await ask(mk({ when: { expires: T - 1 } }), person(), "crm.read")).reason, "expired");
  assert.equal((await ask(mk({ when: { expires: T + 1000 } }), person(), "crm.read")).effect, "allow");
  assert.equal((await ask(mk({ when: { not_before: T + 10, expires: T + 1000 } }), person(), "crm.read")).effect, "deny");
  assert.equal((await ask(mk({ where: { surfaces: ["cli"] } }), person(), "crm.read")).reason, "wrong_node");
  assert.equal((await ask(mk({ where: { surfaces: ["deck"] } }), person(), "crm.read")).effect, "allow");
  assert.equal((await ask(mk({ where: { nodes: ["n1"] } }), person(), "crm.read")).reason, "wrong_node");
});

test("authorize: a wildcard covers only actions that existed when the grant was made", async () => {
  const az = world({ grants: [grant({ action_set_version: 2 })] });
  assert.equal((await ask(az, person(), "crm.update")).effect, "allow");
  const merge = await ask(az, person(), "crm.merge");
  assert.deepEqual([merge.effect, merge.reason], ["deny", "pattern_not_covered"]);
  assert.equal((await ask(world({ grants: [grant({ action_set_version: 2, actions: ["crm.merge"] })] }), person(), "crm.merge")).effect, "allow", "named exactly, it is covered");
  assert.equal(patternCovers("*", "crm.read", 3, 1), "pattern_not_covered");
});

test("authorize: kernel-attribute predicates and selectors decide the resource", async () => {
  const g = grant({ resource: { prefix: `vyre://${SPACE}/contact/*`, where: [{ attr: "project", op: "in", value: ["p1", "p2"] }, { attr: "sensitivity", op: "ne", value: "privileged" }] } });
  const attrs = urn => (urn === R(1) ? { project: "p1", sensitivity: "internal" } : urn === R(2) ? { project: "p9", sensitivity: "internal" } : { project: "p2", sensitivity: "privileged" });
  const az = world({ grants: [g], attrs });
  assert.equal((await ask(az, person(), "crm.read", R(1))).effect, "allow");
  assert.equal((await ask(az, person(), "crm.read", R(2))).effect, "deny");
  assert.equal((await ask(az, person(), "crm.read", R(3))).effect, "deny");
});

test("authorize: policy by risk: outward asks, grant needs fresh presence, admin a session, privileged raises one step", async () => {
  const outward = { prefix: `vyre://${SPACE}/message/*` };
  const az = world({ grants: [grant({ actions: ["email.send"], resource: outward }), grant({ actions: ["grants.create"], resource: { prefix: `vyre://${SPACE}/grant/*` } }), grant({ actions: ["space.set"], resource: { prefix: `vyre://${SPACE}/space/*` } }), grant({ actions: ["crm.read"] })], attrs: urn => (urn === R(7) ? { sensitivity: "privileged" } : {}) });
  const send = await ask(az, person(), "email.send", `vyre://${SPACE}/message/m1`);
  assert.deepEqual([send.effect, send.reason], ["ask", "needs_approval"]);
  assert.ok(send.obligations.some(o => o.type === "ask" && o.approver === "owner" && o.checker_must_be_person === true));
  assert.ok(send.obligations.some(o => o.type === "presence" && o.method === "fresh"));
  assert.ok(send.obligations.some(o => o.type === "audit" && o.class === "outward"));
  const gr = await ask(az, person(), "grants.create", `vyre://${SPACE}/grant/g1`);
  assert.deepEqual([gr.effect, gr.reason], ["ask", "needs_presence"]);
  assert.equal(gr.obligations.find(o => o.type === "presence").method, "fresh");
  const ad = await ask(az, person(), "space.set", `vyre://${SPACE}/space/s`);
  assert.equal(ad.obligations.find(o => o.type === "presence").method, "session");
  assert.equal((await ask(az, person(), "crm.read", R(1))).effect, "allow");
  assert.equal((await ask(az, person(), "crm.read", R(7))).reason, "needs_presence");
});

test("authorize: presence is met only by a verified proof or a held session, and never by a bare claim", async () => {
  const g = grant({ actions: ["crm.update"], conditions: { how: { presence: "fresh" } } });
  const proof = { signer: "secure_enclave", signature: "x" };
  const none = world({ grants: [g] });
  assert.equal((await ask(none, person(), "crm.update", R(1), { presence: proof })).reason, "needs_presence", "no verifier configured: a claim counts for nothing");
  const yes = world({ grants: [g], verifyPresence: p => p === proof });
  assert.equal((await ask(yes, person(), "crm.update", R(1), { presence: proof })).effect, "allow");
  assert.equal((await ask(yes, person(), "crm.update", R(1), { presence: { ...proof } })).effect, "ask");
  const sess = world({ grants: [grant({ actions: ["crm.update"], conditions: { how: { presence: "session" } } })], hasPresenceSession: () => true });
  assert.equal((await ask(sess, person(), "crm.update")).effect, "allow");
});

test("authorize: delegation is contained in its parent, rechecked, and carries the parent's obligations", async () => {
  const parent = grant({ actions: ["crm.update", "crm.read"], conditions: { delegate: { allowed: true, max_depth: 2 }, how: { presence: "fresh" }, when: { expires: T + 1000 } } });
  const sub = actorOf("agent", "kit");
  const child = over => grant({ subject: { kind: "actor", actor: sub }, parent: parent.id, actions: ["crm.read"], conditions: { when: { expires: T + 500 }, delegate: { allowed: true, max_depth: 1 } }, ...over });
  const chain = builder().fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true });
  const okChild = child();
  const az = world({ grants: [parent, okChild], members: ["agent:kit"] });
  const r = await ask(az, chain, "crm.read");
  assert.equal(r.effect, "ask", "the parent's fresh presence comes along");
  assert.equal(r.reason, "needs_presence");
  assert.deepEqual(r.grants.length, 2);
  const wider = child({ actions: ["crm.merge"] });
  assert.equal((await ask(world({ grants: [grant({ actions: ["crm.*"] }), parent, wider], members: ["agent:kit"] }), chain, "crm.merge")).reason, "not_contained");
  const longer = child({ conditions: { when: { expires: T + 5000 } } });
  assert.equal((await ask(world({ grants: [grant({ actions: ["crm.*"] }), parent, longer], members: ["agent:kit"] }), chain, "crm.read")).reason, "not_contained");
  const revoked = { ...parent, status: "revoked" };
  assert.equal((await ask(world({ grants: [grant({ actions: ["crm.*"] }), revoked, okChild], members: ["agent:kit"] }), chain, "crm.read")).reason, "revoked");
  assert.equal(contains(parent, { ...okChild, resource: { prefix: `vyre://${SPACE}/*/*` } }), false);
  assert.equal(contains({ ...parent, conditions: { delegate: { allowed: false, max_depth: 0 } } }, okChild), false);
});

test("authorize: temp members reach only their scope and only until they expire", async () => {
  const tempChain = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key, clock, is_person: () => true }).fromFacts({ kind: "device", device_key_id: "d9", person: "per_temp", path: "direct" });
  const g = { ...grant({ subject: { kind: "actor", actor: actorOf("person", "per_temp") }, actions: ["crm.read"] }) };
  const mk = ms => world({ grants: [g], members: ["person:per_temp"], memberships: { "person:per_temp": ms } });
  const ms = { role: "temp", scope: [R(1)], expires: T + 100 };
  assert.equal((await ask(mk(ms), tempChain, "crm.read", R(1))).effect, "allow");
  assert.equal((await ask(mk(ms), tempChain, "crm.read", R(2))).reason, "no_grant");
  assert.equal((await ask(mk({ ...ms, expires: T - 1 }), tempChain, "crm.read", R(1))).reason, "expired");
  assert.equal((await ask(mk({ role: "temp", scope: [R(1)] }), tempChain, "crm.read", R(1))).reason, "expired", "a temp with no expiry is refused");
});

test("authorize: untrusted context cannot write; external context cannot grant; many Spaces cannot write quietly", async () => {
  const b = builder();
  const gs = [grant(), grant({ actions: ["grants.create"], resource: { prefix: `vyre://${SPACE}/grant/*` } })];
  const az = world({ grants: gs });
  const bad = b.weaken(person(), { trust: "untrusted", red: "public", source_spaces: [SPACE] });
  assert.deepEqual([(await ask(az, bad, "crm.update")).reason, (await ask(az, bad, "crm.read")).effect], ["tainted", "allow"]);
  const ext = b.weaken(person(), { trust: "external", red: "public", source_spaces: [SPACE] });
  assert.equal((await ask(az, ext, "grants.create", `vyre://${SPACE}/grant/g`)).reason, "tainted");
  const multi = b.weaken(person(), { trust: "member", red: "public", source_spaces: ["spc_bbbbbbbbbbbb"] });
  assert.equal((await ask(az, multi, "crm.update")).effect, "ask");
  assert.equal((await ask(az, multi, "crm.read")).effect, "allow");
});

test("authorize: a model in the chain gets placeholders for sealed fields; a person alone does not", async () => {
  const chain = builder().fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true });
  const g = [grant(), grant({ subject: { kind: "actor", actor: actorOf("agent", "kit") }, actions: ["crm.read"] })];
  const az = world({ grants: g, members: ["agent:kit"], sealedFields: () => ["ssn"] });
  const r = await ask(az, chain, "crm.read");
  assert.deepEqual(r.obligations.find(o => o.type === "placeholders").fields, ["ssn"]);
  assert.equal((await ask(az, person(), "crm.read")).obligations.some(o => o.type === "placeholders"), false);
});

test("authorize: a standing service reads without a person and never writes; audience limits who may use a grant", async () => {
  const b = builder();
  const svc = b.fromFacts({ kind: "module", module: "search", first_party: true });
  const az = world({ standing: (s, a, r) => s === "search" && r.includes("/contact/") });
  assert.equal((await ask(az, svc, "crm.read")).effect, "allow");
  assert.equal((await ask(az, svc, "crm.update")).effect, "deny");
  assert.equal((await ask(az, svc, "crm.read", `vyre://${SPACE}/matter/1`)).effect, "deny", "K1-6: a standing read is limited to what the service declared");
  assert.equal((await ask(world({ standing: () => false }), svc, "crm.read")).effect, "deny", "no declaration, no read");
  const viaSvc = b.fromFacts({ kind: "module", module: "email", first_party: true, inbound: person() });
  const aud = world({ grants: [grant({ conditions: { audience: ["crm"] } })], members: ["service:email"] });
  assert.equal((await ask(aud, viaSvc, "crm.read")).effect, "deny");
});

test("authorize: decision ids are unique and an internal error fails closed", async () => {
  const az = world({ grants: [grant()] });
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add((await ask(az, person(), "crm.read")).decision);
  assert.equal(ids.size, 50);
  const boom = world({ grants: [grant()], attrs: () => { throw new Error("resolver down"); } });
  assert.equal((await ask(boom, person(), "crm.read")).effect, "deny");
});

// ---- events ----
const log = () => createEventLog({ space: SPACE, clock });
const ev = (over = {}) => ({ type: "contact.updated", sv: 1, subject: R(1), data: { name: "Jane" }, ...over });

test("events: the envelope comes from the chain; the caller cannot name the actor, trust or Space", () => {
  const l = log();
  const chain = builder().weaken(builder().fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true }), { trust: "external", red: "pii", source_spaces: ["spc_bbbbbbbbbbbb"] });
  const e = l.append(chain, { ...ev(), actor: "person:forged@x", trust: "system", source_spaces: [] }, { decision: "dec_1" });
  assert.equal(e.actor, `agent:kit@${SPACE}`);
  assert.equal(e.chain.length, 2);
  assert.equal(e.trust, "external");
  assert.equal(e.red, "pii");
  assert.deepEqual(e.source_spaces, [SPACE, "spc_bbbbbbbbbbbb"]);
  assert.equal(e.cause, "dec_1");
  assert.equal(e.prov.decision, "dec_1");
  assert.equal(e.seq, 1);
  assert.equal(e.prev, genesis(SPACE));
  assert.ok(isUuid(e.id) && Object.isFrozen(e));
});

test("events: refuses a hand-made chain, a bad type, a foreign subject, and a secret", () => {
  const l = log();
  assert.throws(() => l.append({ hops: [], space: SPACE }, ev()), { code: "bad_input" });
  assert.throws(() => l.append(person(), ev({ type: "Contact_Updated" })), { code: "bad_input" });
  assert.throws(() => l.append(person(), ev({ type: "contact.a.b" })), { code: "bad_input" });
  assert.throws(() => l.append(person(), ev({ subject: "vyre://spc_zzzzzzzzzzzz/contact/1" })), { code: "wrong_space" });
  assert.throws(() => l.append(person(), ev({ red: "secret" })), { code: "secret_refused" });
  assert.throws(() => l.append(person(), ev({ sv: 0 })), { code: "bad_input" });
  assert.equal(l.latestSeq(), 0);
});

test("events: the log is a hash chain; a changed, removed or reordered event is found", () => {
  const l = log();
  for (let i = 0; i < 5; i++) l.append(person(), ev({ data: { i } }));
  assert.deepEqual(l.verify(), { ok: true, head: l.head(), seq: 5 });
  const all = l.read();
  assert.deepEqual(all.map(e => e.seq), [1, 2, 3, 4, 5]);
  const tamper = all.map(e => ({ ...e }));
  tamper[2] = { ...tamper[2], actor: `person:other@${SPACE}` };
  assert.equal(verifyEvents(SPACE, tamper).at, 3);
  assert.equal(verifyEvents(SPACE, [all[0], all[2], all[3]]).ok, false);
  assert.equal(verifyEvents(SPACE, [all[1], all[0]]).ok, false);
  assert.equal(verifyEvents("spc_zzzzzzzzzzzz", all).ok, false, "another Space's genesis does not match");
});

test("events: data is committed with a salt; erasing it leaves the chain intact and nothing to guess against", () => {
  const l = log();
  l.append(person(), ev({ data: { ssn: "123-45-6789" } }));
  const second = l.append(person(), ev());
  assert.equal(l.proves(1), true);
  const guess = sha256("" + canonical({ ssn: "123-45-6789" }));
  assert.notEqual(l.read()[0].commit, guess, "an unsalted guess does not match the commitment");
  l.erase(1);
  assert.equal(l.proves(1), false);
  assert.deepEqual(l.read()[0].data, { erased: true });
  assert.equal(l.verify().ok, true);
  assert.equal(l.read()[1].prev, l.read()[0].hash);
  assert.equal(second.seq, 2);
});

test("events: filters by type pattern, subject, corr, actor and cursor", () => {
  const l = log();
  l.append(person(), ev());
  l.append(person(), ev({ type: "contact.created", subject: R(2) }));
  l.append(person(), ev({ type: "matter.opened", subject: `vyre://${SPACE}/matter/1`, corr: "c1" }));
  assert.equal(l.read({ type: "contact.*" }).length, 2);
  assert.equal(l.read({ type: "*" }).length, 3);
  assert.equal(l.read({ type: "matter.opened" }).length, 1);
  assert.equal(l.read({ subject_prefix: `vyre://${SPACE}/contact/` }).length, 2);
  assert.equal(l.read({ corr: "c1" }).length, 1);
  assert.equal(l.read({ since: 2 }).length, 1);
  assert.equal(l.read({ actor: `person:${OWNER}@${SPACE}`, limit: 2 }).length, 2);
});

test("events: a consumer gets every event at least once, in order, and a failing handler is retried, not skipped", async () => {
  const l = log();
  const seen = [];
  let fail = true;
  l.subscribe("search", { type: "contact.*" }, e => { if (e.seq === 2 && fail) throw new Error("down"); seen.push(e.seq); });
  l.append(person(), ev());
  l.append(person(), ev());
  l.append(person(), ev({ type: "matter.opened", subject: `vyre://${SPACE}/matter/1` }));
  l.append(person(), ev());
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(seen, [1]);
  assert.equal(l.cursor("search"), 1, "the cursor stays before the event that failed");
  fail = false;
  await l.pump();
  assert.deepEqual(seen, [1, 2, 4]);
  assert.equal(l.cursor("search"), 4);
  const off = l.subscribe("late", { type: "*" }, () => {});
  off();
});

// ---- K1 gate fixes (reviewer-2 probes) ----
test("K1-1: a child grant dies when its adder is no longer a member, or is an expired temp member", async () => {
  const kit = actorOf("agent", "kit"), alice = actorOf("person", "per_alice");
  const parent = grant({ subject: { kind: "actor", actor: alice }, actions: ["crm.read"], conditions: { delegate: { allowed: true, max_depth: 2 } } });
  const child = grant({ subject: { kind: "actor", actor: kit }, parent: parent.id, actions: ["crm.read"], conditions: { delegate: { allowed: true, max_depth: 1 } } });
  const chain = builder().fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true });
  const own = grant({ actions: ["crm.read"] });
  const gone = world({ grants: [own, parent, child], members: ["agent:kit"] });
  assert.deepEqual([(await ask(gone, chain, "crm.read")).effect, (await ask(gone, chain, "crm.read")).reason], ["deny", "revoked"]);
  const here = world({ grants: [own, parent, child], members: ["agent:kit", "person:per_alice"] });
  assert.equal((await ask(here, chain, "crm.read")).effect, "allow");
  const temp = world({ grants: [own, parent, child], members: ["agent:kit", "person:per_alice"], memberships: { "person:per_alice": { role: "temp", expires: T - 1, scope: [`vyre://${SPACE}/contact/*`] } } });
  assert.equal((await ask(temp, chain, "crm.read")).effect, "deny");
});

test("K1-2: unknown trust or class labels are refused or most restrictive", async () => {
  const b = builder();
  const ext = b.appendService(b.fromFacts(sock("deck")), "zz", false);
  assert.throws(() => b.weaken(ext, { trust: "bogus", red: "public", source_spaces: [SPACE] }), { code: "bad_input" });
  assert.throws(() => mergeLabels(ext.labels, { trust: "member", red: "bogus", source_spaces: [] }), { code: "bad_input" });
  const stored = b.serialize(person());
  const o = JSON.parse(stored.body); o.labels.trust = "bogus";
  assert.throws(() => b.restore({ ...stored, body: JSON.stringify(o) }), { code: "not_a_member" }, "a tampered label fails the seal first");
});

test("K1-3: an event with an unknown class or visibility is refused, never lowered", () => {
  const log = createEventLog({ space: SPACE, clock });
  const c = person();
  const ev = over => ({ type: "crm.created", sv: 1, subject: R(1), data: {}, ...over });
  assert.throws(() => log.append(c, ev({ red: "bogus" })), { code: "bad_input" });
  assert.throws(() => log.append(c, ev({ vis: "everyone" })), { code: "bad_input" });
  assert.equal(log.append(c, ev({ red: "pii", vis: "members:x" })).red, "pii");
});

test("K1-4: wildcards never cover admin, grant or outward actions; a missing action_set_version covers no wildcard", async () => {
  const wild = grant({ actions: ["*"], action_set_version: 9 });
  assert.equal((await ask(world({ grants: [wild] }), person(), "email.send")).effect, "deny");
  assert.equal((await ask(world({ grants: [wild] }), person(), "space.set", `vyre://${SPACE}/space/x`)).effect, "deny");
  assert.equal((await ask(world({ grants: [wild] }), person(), "grants.create")).effect, "deny");
  const x = grant({ actions: ["crm.*"], action_set_version: undefined });
  assert.equal((await ask(world({ grants: [x] }), person(), "crm.read")).reason, "pattern_not_covered");
  const named = grant({ actions: ["email.send"], action_set_version: undefined });
  assert.notEqual((await ask(world({ grants: [named] }), person(), "email.send")).effect, "deny", "a named action needs no version");
  assert.equal(patternCovers("crm.*", "crm.read", 0, undefined, "read"), "pattern_not_covered");
  assert.equal(patternCovers("crm.*", "crm.read", 0, 9, "outward.send"), "pattern_not_covered");
  assert.equal(contains(grant({ actions: ["*"], conditions: { delegate: { allowed: true, max_depth: 2 } } }), grant({ actions: ["email.send"], conditions: {} }), () => 0, () => "outward.send"), false);
});

test("K1-5: a predicate on a missing attribute never matches, for any op; an unknown op denies", async () => {
  for (const op of ["eq", "ne", "in"]) {
    const g = grant({ resource: { prefix: `vyre://${SPACE}/contact/*`, where: [{ attr: "sensitivity", op, value: op === "in" ? ["a"] : "privileged" }] } });
    assert.equal((await ask(world({ grants: [g] }), person(), "crm.read")).effect, "deny", op);
    assert.equal((await ask(world({ grants: [g], attrs: () => ({}) }), person(), "crm.read")).effect, "deny", op);
  }
  const ne = grant({ resource: { prefix: `vyre://${SPACE}/contact/*`, where: [{ attr: "sensitivity", op: "ne", value: "privileged" }] } });
  assert.equal((await ask(world({ grants: [ne], attrs: () => ({ sensitivity: "internal" }) }), person(), "crm.read")).effect, "allow");
  const odd = grant({ resource: { prefix: `vyre://${SPACE}/contact/*`, where: [{ attr: "sensitivity", op: "like", value: "x" }] } });
  assert.equal((await ask(world({ grants: [odd], attrs: () => ({ sensitivity: "x" }) }), person(), "crm.read")).effect, "deny");
});

test("urn: dot segments and encoded or control forms are refused at parse", () => {
  for (const bad of ["..", ".", "%2e%2e", "%2E", "a%2fb", "a\\b", "a\u0000b", "a\nb", "a."]) {
    assert.equal(segments(`vyre://${SPACE}/file/proj/${bad}/x`), null, JSON.stringify(bad));
  }
  assert.equal(covers(`vyre://${SPACE}/file/proj`, `vyre://${SPACE}/file/proj/../../credential/x`), false);
  assert.ok(segments(`vyre://${SPACE}/file/proj/a.pdf`));
});

test("K1-8a and 9: non-plain data is refused by canonical, via comes from the chain, subject_prefix matches whole segments", () => {
  assert.throws(() => canonical({ d: new Date(0) }), TypeError);
  assert.throws(() => canonical({ m: new Map() }), TypeError);
  const log = createEventLog({ space: SPACE, clock });
  const c = person();
  log.append(c, { type: "crm.created", sv: 1, subject: R(1), data: {} }, { via: { surface: "relay" } });
  assert.equal(log.read()[0].via.surface, "deck", "a caller cannot override the chain's via");
  log.append(c, { type: "crm.created", sv: 1, subject: R(10), data: {} });
  assert.equal(log.read({ subject_prefix: R(1) }).length, 1, ".../1 does not match .../10");
});

test("K1-7 and 8c: a presence session never stands for an assistant on admin or grant; an unknown condition or obligation asks; rate is an obligation", async () => {
  const b = builder();
  const withAgent = b.fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true });
  const adm = grant({ actions: ["space.set"], resource: { prefix: `vyre://${SPACE}/space/*` } });
  const sp = `vyre://${SPACE}/space/x`;
  const az = world({ grants: [adm, { ...adm, id: "gr_kit", subject: { kind: "actor", actor: actorOf("agent", "kit") } }], members: ["agent:kit"], hasPresenceSession: () => true });
  assert.equal((await ask(az, person(), "space.set", sp)).effect, "allow", "a person's own chain with a session");
  assert.equal((await ask(az, withAgent, "space.set", sp)).reason, "needs_presence", "an assistant in the chain does not inherit it");
  const odd = world({ grants: [grant({ conditions: { telepathy: true } })] });
  assert.equal((await ask(odd, person(), "crm.read")).effect, "ask");
  const rate = world({ grants: [grant({ conditions: { rate: { per: "hour", max: 5 } } })] });
  const r = await ask(rate, person(), "crm.read");
  assert.equal(r.effect, "allow");
  assert.ok(r.obligations.some(o => o.type === "rate"));
});

test("K1-8b and 9f: a stored job chain expires; a poison event is retried, then set aside, and the consumer goes on", async () => {
  const b = builder({ job_max_age: 1000 });
  const stored = JSON.parse(JSON.stringify(b.serialize(person())));
  const keep = T; T += 5000;
  assert.throws(() => b.restore(stored), { code: "not_a_member" });
  T = keep;
  assert.ok(isChain(b.restore(stored)));
  const log = createEventLog({ space: SPACE, clock });
  const got = [];
  log.subscribe("c1", {}, e => { if (e.subject === R(1)) throw new Error("poison"); got.push(e.subject); });
  log.append(person(), { type: "crm.created", sv: 1, subject: R(1), data: {} });
  log.append(person(), { type: "crm.created", sv: 1, subject: R(2), data: {} });
  for (let i = 0; i < 12 && !log.deadLetters().length; i++) { await new Promise(r => setTimeout(r, 5)); await log.pump(); }
  assert.equal(log.deadLetters().length, 1, "after enough attempts the poison event is set aside");
  for (let i = 0; i < 4 && !got.length; i++) { await new Promise(r => setTimeout(r, 5)); await log.pump(); }
  assert.deepEqual(got, [R(2)]);
});

test("grant-risk acts are denied outright for a chain holding a model, and a field allow-list is an obligation the narrowest hop sets", async () => {
  const withAgent = builder().fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true });
  const adm = grant({ actions: ["grants.create"], resource: { prefix: `vyre://${SPACE}/grant/*` } });
  const az = world({ grants: [adm, { ...adm, id: "gr_kit", subject: { kind: "actor", actor: actorOf("agent", "kit") } }], members: ["agent:kit"], hasPresenceSession: () => true, verifyPresence: () => true });
  assert.equal((await ask(az, withAgent, "grants.create", `vyre://${SPACE}/grant/new`)).reason, "model_chain");
  const f = world({ grants: [grant({ actions: ["crm.read"], resource: { prefix: `vyre://${SPACE}/contact/*`, fields: ["name"] } })] });
  const r = await ask(f, person(), "crm.read");
  assert.deepEqual(r.obligations.find(o => o.type === "fields").allow, ["name"]);
});

test("authorize: an approved act satisfies the outward ask for exactly that act, as a once obligation; a deny is not softened", async () => {
  const send = grant({ actions: ["email.send"], resource: { prefix: `vyre://${SPACE}/message/*` } });
  const ok = world({ grants: [send], approvedAct: q => q.id === "task_ok" && q.action === "email.send" });
  const res = `vyre://${SPACE}/message/m1`;
  assert.equal((await ask(ok, person(), "email.send", res)).effect, "ask");
  const r = await ask(ok, person(), "email.send", res, { approval: "task_ok" });
  assert.equal(r.effect, "allow");
  assert.ok(r.obligations.some(o => o.type === "once" && o.grant === "approval:task_ok"));
  assert.equal((await ask(ok, person(), "email.send", res, { approval: "task_other" })).effect, "ask");
  const none = world({ grants: [], approvedAct: () => true });
  assert.equal((await ask(none, person(), "email.send", res, { approval: "task_ok" })).effect, "deny", "no grant: the approval does not create one");
});

test("chains: forFlow and forModule carry the approver, the run id as the job, and taint; session_person is the person without a presence session", () => {
  const b = builder({ is_person: p => p === OWNER || p === "per_two" });
  const approver = b.fromFacts({ kind: "device", device_key_id: "d1", person: OWNER, path: "direct" });
  const flow = b.forFlow({ flow: "fl_welcome", approver, run: "run_1" });
  assert.deepEqual(flow.hops.map(h => h.actor.kind), ["person", "automation"]);
  assert.equal(flow.job, "run_1");
  assert.equal(flow.labels.trust, "member");
  assert.equal(b.forFlow({ flow: "fl_welcome", approver, run: "run_2", tainted: true }).labels.trust, "external");
  assert.throws(() => b.forFlow({ flow: "f", approver: { hops: [] }, run: "r" }), { code: "not_a_member" });
  const agent = b.fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true });
  assert.throws(() => b.forFlow({ flow: "f", approver: agent, run: "r" }), { code: "not_a_member" }, "a model cannot approve a flow run");
  assert.deepEqual(b.forModule({ module: "stages", approver }).hops.map(h => h.actor.kind), ["person", "service"]);
  const sp = b.fromFacts({ kind: "session_person", person: "per_two", session: "s1", vouched: true });
  assert.ok(isExactlyPerson(sp));
  assert.equal(sp.hops[0].via.session, undefined, "no presence session");
  assert.throws(() => b.fromFacts({ kind: "session_person", person: "per_stranger", session: "s", vouched: true }), { code: "not_a_member" });
  assert.throws(() => b.fromFacts({ kind: "session_person", person: OWNER, session: "s" }), { code: "not_a_member" });
  const two = b.fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true, person: "per_two" });
  assert.equal(two.hops[0].actor.id, "per_two");
});
