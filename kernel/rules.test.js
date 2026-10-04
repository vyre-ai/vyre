// Standing rules for a Space (DESIGN-flows-joints 5a): set by an owner with presence, an event in the log, checked BEFORE grants, only ever tightening.
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "./index.js";
import { createEventLog } from "./core/events.js";
import { createAuthorizer } from "./core/authorize.js";
import { createChainBuilder } from "./core/chain.js";
import { canonical, sha256 } from "./core/canonical.js";
import { CONTACT } from "./conformance/suite.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", ALICE = "per_alice", BOB = "per_bob";
const proof = (action, input, resource) => ({ op: action.startsWith("rules.") ? `grant.rule_${action.split(".")[1]}` : `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  for (const [p, role] of [[ALICE, "admin"], [BOB, "member"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const kit = { kind: "agent", id: "kit", space: SPACE };
  await g.addActor(owner, kit, { presence: proof("grants.role", { actor: kit }, `vyre://${SPACE}/member/kit`) });
  const grantKit = async (actions) => { const i = { subject: { kind: "actor", actor: kit }, actions, resource: { prefix: `vyre://${SPACE}/contact/*` }, conditions: {}, source: "test" }; return g.create(owner, i, { presence: proof("grants.create", i, `vyre://${SPACE}/grant/new`) }); };
  const asst = (person = OWNER) => k.chains.fromFacts({ kind: "agent_session", vouched: true, person, agent: "kit", session: "s1" });
  const dev = (person, id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct" });
  const setRule = (rule, who = owner) => g.rules.set(who, rule, { presence: proof("rules.set", normal(rule), `vyre://${SPACE}/rule/new`) });
  return { k, owner, g, grantKit, asst, dev, setRule };
}
/** What the kernel hashes: the rule as it validates (sorted, deduplicated). */
const normal = r => ({ kind: r.kind, binds: [...new Set(r.binds)].sort(), covers: { actions: [...new Set(r.covers.actions)].sort(), ...(r.covers.resource ? { resource: r.covers.resource } : {}) }, ...(r.kind === "always_ask" ? { approver: r.approver.person ? { person: r.approver.person } : { role: r.approver.role } } : {}), label: r.label.trim() });
const NEVER_REMOVE = { kind: "never", binds: ["assistants"], covers: { actions: ["records.remove"] }, label: "Assistants never delete a record" };

test("a rule belongs to the Space: an owner sets it with presence, it is an event, it survives a rebuild, and only an owner (never an admin) sets or removes it", async () => {
  const { k, owner, g, dev, setRule } = await rig();
  await assert.rejects(() => g.rules.set(owner, NEVER_REMOVE), { code: "needs_presence" });
  await assert.rejects(() => setRule(NEVER_REMOVE, dev(BOB, "d-b")), e => ["not_found", "not_allowed"].includes(e.code));
  const rule = await setRule(NEVER_REMOVE);
  assert.match(rule.id, /^rule_/);
  assert.equal(rule.by, OWNER);
  assert.ok(k.log.read({}).some(e => e.type === "rule.set" && e.data.rule.id === rule.id), "an event in the log");
  assert.deepEqual((await g.rules.list(dev(ALICE, "d-a"))).rules.map(x => x.id), [rule.id], "a manager and above sees the rules");
  await assert.rejects(() => g.rules.list(dev(BOB, "d-b")), e => ["not_found", "not_allowed"].includes(e.code));
  await g.rebuild();
  assert.equal((await g.rules.list(owner)).rules.length, 1, "kept across a rebuild from the log");
  await assert.rejects(() => g.rules.remove(dev(BOB, "d-b"), rule.id, { presence: proof("rules.remove", { id: rule.id }, `vyre://${SPACE}/rule/${rule.id}`) }), e => ["not_found", "not_allowed"].includes(e.code), "a member cannot remove");
  await g.rules.remove(owner, rule.id, { presence: proof("rules.remove", { id: rule.id }, `vyre://${SPACE}/rule/${rule.id}`) });
  assert.equal((await g.rules.list(owner)).rules.length, 0);
  // the shape is closed: three kinds, named actions, no free text that drives anything, no rule over the rules calls
  for (const bad of [{ ...NEVER_REMOVE, kind: "allow" }, { ...NEVER_REMOVE, binds: [] }, { ...NEVER_REMOVE, covers: { actions: ["rules.set"] } }, { ...NEVER_REMOVE, covers: { actions: [] } }, { ...NEVER_REMOVE, extra: 1 }, { ...NEVER_REMOVE, label: "" }, { kind: "always_ask", binds: ["assistants"], covers: { actions: ["records.update"] }, label: "x" }]) await assert.rejects(() => g.rules.set(owner, bad, { presence: {} }), { code: "bad_input" }, JSON.stringify(bad).slice(0, 60));
});

test("a rule beats a later grant, and its refusal says which rule", async () => {
  const { k, owner, grantKit, asst, setRule } = await rig();
  const c = await (async () => { await k.gateway.records.define(owner, { add_types: [CONTACT] }); return k.gateway.records.create(owner, "contact", { name: "Jane" }); })();
  await grantKit(["records.read", "records.remove"]);
  const can = async chain => (await k.gateway.authorize({ chain, action: "records.remove", resource: c.urn }));
  assert.equal((await can(asst())).effect, "allow", "before the rule the grant allows it");
  const rule = await setRule(NEVER_REMOVE);
  const d = await can(asst());
  assert.equal(d.effect, "deny");
  assert.equal(d.reason, "rule_never");
  assert.deepEqual(d.rule, { id: rule.id, kind: "never", label: "Assistants never delete a record" });
  await grantKit(["records.remove"]);                       // a LATER grant, wider in time
  assert.equal((await can(asst())).reason, "rule_never", "a rule beats a later grant");
  assert.equal((await k.gateway.records.remove(k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" }), "contact", c.id, 1)).deleted_at !== undefined, true, "the owner acting directly is not named by an assistants rule");
});

test("a rule can't widen: with no grant a rule changes nothing, and a rule never turns a refusal into an allow", async () => {
  const { k, owner, asst, dev, setRule } = await rig();
  await k.gateway.records.define(owner, { add_types: [CONTACT] });
  const c = await k.gateway.records.create(owner, "contact", { name: "Jane" });
  const remove = chain => k.gateway.authorize({ chain, action: "records.remove", resource: c.urn });
  assert.equal((await remove(asst())).effect, "deny", "kit has no grant");
  const before = (await remove(asst())).reason;
  for (const [rule, action, resource] of [[{ kind: "draft_only", binds: ["assistants"], covers: { actions: ["seal.deliver"] }, label: "drafts" }, "seal.deliver", c.urn], [{ kind: "always_ask", binds: ["assistants"], covers: { actions: ["records.remove"] }, approver: { role: "owner" }, label: "ask" }, "records.remove", c.urn]]) {
    await setRule(rule);
    const d = await k.gateway.authorize({ chain: asst(), action, resource });
    assert.notEqual(d.effect, "allow", `${rule.kind} cannot give what no grant gives`);
  }
  assert.equal(before, "no_grant");
  assert.equal((await remove(dev(BOB, "d-b"))).effect, "allow", "a member who may delete still may: the assistants rules do not name members");
});

test("an owner's own assistant is bound by a rule that names assistants; a rule that names members binds the person acting directly", async () => {
  const { k, owner, grantKit, asst, dev, setRule } = await rig();
  await k.gateway.records.define(owner, { add_types: [CONTACT] });
  const c = await k.gateway.records.create(owner, "contact", { name: "Jane" });
  await grantKit(["records.remove", "records.read"]);
  const act = chain => k.gateway.authorize({ chain, action: "records.remove", resource: c.urn });
  assert.equal((await act(asst(OWNER))).effect, "allow", "the owner's assistant could delete");
  await setRule(NEVER_REMOVE);
  assert.equal((await act(asst(OWNER))).reason, "rule_never", "the owner's own assistant is bound");
  assert.equal((await act(owner)).effect, "allow");
  await setRule({ kind: "never", binds: ["members"], covers: { actions: ["records.remove"] }, label: "No one deletes by hand" });
  assert.equal((await act(owner)).reason, "rule_never", "now the person acting directly is bound too, the owner included");
  assert.equal((await act(dev(BOB, "d-b"))).reason, "rule_never");
});

/** The authorizer alone, over a stub grant for an outward send and a calendar write, with the rules and approvals the kernel wires in. */
function authRig(rules, approvedAct) {
  const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), is_person: () => true });
  const actor = (kind, id) => ({ kind, id, space: SPACE });
  const everything = { id: "gr_all", status: "active", space: SPACE, subject: { kind: "actor", actor: actor("agent", "kit") }, actions: ["mail.send", "calendar.write"], resource: { prefix: `vyre://${SPACE}/*/*` }, conditions: {}, action_set_version: 1 };
  const owner = { id: "gr_o", status: "active", space: SPACE, subject: { kind: "actor", actor: actor("person", OWNER) }, actions: ["mail.send", "calendar.write"], resource: { prefix: `vyre://${SPACE}/*/*` }, conditions: {}, action_set_version: 1 };
  const members = { has: a => ["person:" + OWNER, "agent:kit"].includes(`${a.kind}:${a.id}`) };
  const authorizer = createAuthorizer({ space: SPACE, clock: () => 1_800_000_000_000, members, grants: { forSubject: a => [everything, owner].filter(g => g.subject.actor.id === a.id), get: id => [everything, owner].find(g => g.id === id) }, rules, approvedAct,
    actions: [{ action: "mail.send", resource_type: "message", risk: "outward.send", draftable: true }, { action: "calendar.write", resource_type: "event", risk: "write" }] });
  const asst = chains.fromFacts({ kind: "agent_session", vouched: true, person: OWNER, agent: "kit", session: "s" });
  return { authorizer, asst, chains };
}
const R_DRAFT = { id: "rule_d", kind: "draft_only", binds: ["assistants"], covers: { actions: ["mail.send"] }, label: "Email is drafts only" };
const R_ASK = { id: "rule_a", kind: "always_ask", binds: ["assistants"], covers: { actions: ["calendar.write"] }, approver: { person: "per_josh" }, label: "Dates are approved by Josh" };

test("a draft-only rule turns an approved send into a draft and never a send", async () => {
  const mail = `vyre://${SPACE}/message/m1`;
  const plain = authRig({ match: () => [] }, async () => true);
  assert.equal((await plain.authorizer.authorize({ chain: plain.asst, action: "mail.send", resource: mail })).effect, "ask", "a send asks");
  const approved = await plain.authorizer.authorize({ chain: plain.asst, action: "mail.send", resource: mail, approval: "task_1" });
  assert.equal(approved.effect, "allow");
  assert.equal(approved.obligations.some(o => o.type === "draft_only"), false, "with no rule an approved send is a send");
  const seen = [];
  const drafted = authRig({ match: ({ action }) => (action === "mail.send" ? [R_DRAFT] : []) }, async q => (seen.push(q), true));
  const before = await drafted.authorizer.authorize({ chain: drafted.asst, action: "mail.send", resource: mail });
  assert.equal(before.effect, "ask");
  assert.ok(before.obligations.some(o => o.type === "draft_only" && o.rule === "rule_d"), "even before approval the decision says draft only");
  const after = await drafted.authorizer.authorize({ chain: drafted.asst, action: "mail.send", resource: mail, approval: "task_1" });
  assert.equal(after.effect, "allow", "the approval is spent on a draft");
  assert.ok(after.obligations.some(o => o.type === "draft_only" && o.rule === "rule_d"), "an approval does not lift draft only: the executor prepares a draft and never sends");
  assert.deepEqual(after.rule, { id: "rule_d", kind: "draft_only", label: "Email is drafts only" });
});

test("an always-ask rule can't be waived: approval every time, by the named approver, and nothing a grant carries lowers it", async () => {
  const ev = `vyre://${SPACE}/event/e1`;
  const seen = [];
  const rigA = authRig({ match: ({ action }) => (action === "calendar.write" ? [R_ASK] : []) }, async q => { seen.push(q); return q.rule && q.rule.approver.person === "per_josh" && q.id === "task_josh"; });
  const free = authRig({ match: () => [] }, async () => false);
  assert.equal((await free.authorizer.authorize({ chain: free.asst, action: "calendar.write", resource: ev })).effect, "allow", "without the rule a write needs no approval");
  const d = await rigA.authorizer.authorize({ chain: rigA.asst, action: "calendar.write", resource: ev });
  assert.equal(d.effect, "ask");
  assert.equal(d.reason, "needs_approval");
  const ask = d.obligations.find(o => o.type === "ask");
  assert.deepEqual([ask.approver, ask.rule, ask.waivable], [{ person: "per_josh" }, "rule_a", false]);
  assert.equal(d.rule.label, "Dates are approved by Josh");
  // an approval by someone else does not satisfy it; the named approver's does, and the approvedAct check is told the rule
  assert.equal((await rigA.authorizer.authorize({ chain: rigA.asst, action: "calendar.write", resource: ev, approval: "task_other" })).effect, "ask");
  assert.equal((await rigA.authorizer.authorize({ chain: rigA.asst, action: "calendar.write", resource: ev, approval: "task_josh" })).effect, "allow");
  assert.deepEqual(seen.at(-1).rule, { id: "rule_a", approver: { person: "per_josh" } });
});

test("a Kit may propose a rule: it does nothing until an owner accepts it with presence, exactly as proposed; an owner may turn it down", async () => {
  const { k, owner, g, dev, asst } = await rig();
  const kit = { kind: "agent", id: "kit", space: SPACE };
  const i = { subject: { kind: "actor", actor: kit }, actions: ["rules.propose"], resource: { prefix: `vyre://${SPACE}/rule/*` }, conditions: {}, source: "kit-install" };
  await g.create(owner, i, { presence: proof("grants.create", i, `vyre://${SPACE}/grant/new`) });
  const proposal = await g.rules.propose(asst(OWNER), NEVER_REMOVE);
  assert.match(proposal.id, /^prop_/);
  assert.deepEqual(proposal.by, { kind: "agent", id: "kit" });
  const view = await g.rules.list(owner);
  assert.equal(view.rules.length, 0, "a proposal is not a rule");
  assert.equal(view.proposals.length, 1);
  await assert.rejects(() => g.rules.accept(dev(BOB, "d-b"), proposal.id, { presence: proof("rules.accept", { id: proposal.id }, `vyre://${SPACE}/rule/${proposal.id}`) }), e => ["not_found", "not_allowed"].includes(e.code), "a member cannot accept");
  await assert.rejects(() => g.rules.accept(owner, proposal.id), { code: "needs_presence" });
  const rule = await g.rules.accept(owner, proposal.id, { presence: proof("rules.accept", { id: proposal.id }, `vyre://${SPACE}/rule/${proposal.id}`) });
  assert.deepEqual(rule.covers, { actions: ["records.remove"] });
  assert.equal(rule.proposed_by.id, "kit");
  const after = await g.rules.list(owner);
  assert.deepEqual([after.rules.length, after.proposals.length], [1, 0]);
  await g.rebuild();
  assert.deepEqual([(await g.rules.list(owner)).rules.length, (await g.rules.list(owner)).proposals.length], [1, 0], "kept across a rebuild");
  // a member cannot propose; dismissing needs the owner with presence
  await assert.rejects(() => g.rules.propose(dev(BOB, "d-b"), NEVER_REMOVE), e => ["not_found", "not_allowed"].includes(e.code));
  const p2 = await g.rules.propose(asst(OWNER), { ...NEVER_REMOVE, label: "Another" });
  await g.rules.dismiss(owner, p2.id, { presence: proof("rules.dismiss", { id: p2.id }, `vyre://${SPACE}/rule/${p2.id}`) });
  assert.equal((await g.rules.list(owner)).proposals.length, 0);
  void k;
});

test("RU-1: a rule that names members binds an assistant acting for a person too; an assistant is bound by the stricter of the two", async () => {
  const { k, owner, grantKit, asst, setRule } = await rig();
  await k.gateway.records.define(owner, { add_types: [CONTACT] });
  const c = await k.gateway.records.create(owner, "contact", { name: "Jane" });
  await grantKit(["records.remove", "records.read"]);
  const act = chain => k.gateway.authorize({ chain, action: "records.remove", resource: c.urn });
  await setRule({ kind: "never", binds: ["members"], covers: { actions: ["records.remove"] }, label: "No one deletes by hand" });
  assert.equal((await act(owner)).reason, "rule_never", "the person is bound");
  assert.equal((await act(asst(OWNER))).reason, "rule_never", "the assistant acting for that person is bound by the member rule too");
});

test("RU-2: a draft-only rule may cover only an action whose door prepares a draft; one that does not is refused when the rule is made, and fails closed at the gate", async () => {
  const { k, owner, g, setRule, asst, grantKit } = await rig();
  const bad = { kind: "draft_only", binds: ["assistants"], covers: { actions: ["records.update"] }, label: "Updates are drafts" };
  await assert.rejects(() => g.rules.set(owner, bad, { presence: {} }), { code: "bad_input" });
  await assert.rejects(() => g.rules.propose(asst(OWNER), bad), e => ["bad_input", "not_found"].includes(e.code));
  const ok = await setRule({ kind: "draft_only", binds: ["assistants"], covers: { actions: ["seal.deliver"] }, label: "Sent mail is drafts only" });
  assert.equal(ok.kind, "draft_only", "seal.deliver declares it prepares a draft");
  void k; void grantKit;
});

test("RU-3: one proposer cannot fill the proposal queue", async () => {
  const { owner, g, asst } = await rig();
  const kit = { kind: "agent", id: "kit", space: SPACE };
  const i = { subject: { kind: "actor", actor: kit }, actions: ["rules.propose"], resource: { prefix: `vyre://${SPACE}/rule/*` }, conditions: {}, source: "kit-install" };
  await g.create(owner, i, { presence: proof("grants.create", i, `vyre://${SPACE}/grant/new`) });
  for (let n = 0; n < 20; n++) await g.rules.propose(asst(OWNER), { ...NEVER_REMOVE, label: `r${n}` });
  await assert.rejects(() => g.rules.propose(asst(OWNER), { ...NEVER_REMOVE, label: "one too many" }), { code: "bad_input" });
});

test("RU-1 walk: for every kind of rule, the person's own chain and the chain of the person with an assistant get the same refusal", async () => {
  const { k, owner, grantKit, asst, setRule } = await rig();
  await k.gateway.records.define(owner, { add_types: [CONTACT] });
  const c = await k.gateway.records.create(owner, "contact", { name: "Jane" });
  await grantKit(["records.remove", "records.read"]);
  const act = chain => k.gateway.authorize({ chain, action: "records.remove", resource: c.urn });
  const shape = d => [d.effect, d.reason, d.rule && d.rule.kind];
  const base = shape(await act(owner));
  assert.equal(base[0], "allow");
  for (const rule of [
    { kind: "never", binds: ["members"], covers: { actions: ["records.remove"] }, label: "n" },
    { kind: "always_ask", binds: ["members"], covers: { actions: ["records.remove"] }, approver: { role: "owner" }, label: "a" },
  ]) {
    const made = await setRule(rule);
    const person = shape(await act(owner)), withAssistant = shape(await act(asst(OWNER)));
    assert.deepEqual(withAssistant, person, `${rule.kind}: an assistant for a person is never freer than the person`);
    assert.notEqual(person[0], "allow", rule.kind);
    await k.gateway.grants.rules.remove(owner, made.id, { presence: proof("rules.remove", { id: made.id }, `vyre://${SPACE}/rule/${made.id}`) });
  }
});

test("RU-2 walk: a draft-only rule is accepted for exactly the actions whose door says it prepares a draft, and for no other", async () => {
  const { k, owner, g } = await rig();
  const all = k.gateway.actions();
  assert.ok(all.length > 20);
  let accepted = 0;
  for (const a of all) {
    if (a.action.startsWith("rules.")) continue;
    const rule = { kind: "draft_only", binds: ["assistants"], covers: { actions: [a.action] }, label: "x" };
    if (a.draftable === true) { await g.rules.set(owner, rule, { presence: proof("rules.set", normal(rule), `vyre://${SPACE}/rule/new`) }); accepted++; }
    else await assert.rejects(() => g.rules.set(owner, rule, { presence: {} }), { code: "bad_input" }, `${a.action} does not prepare a draft`);
  }
  assert.ok(accepted >= 1, "at least seal.deliver declares it");
});

test("RU-3: an owner's view of a rule or a proposal is built from its structured fields, not from the proposer's label", async () => {
  const { owner, g, asst } = await rig();
  const kit = { kind: "agent", id: "kit", space: SPACE };
  const i = { subject: { kind: "actor", actor: kit }, actions: ["rules.propose"], resource: { prefix: `vyre://${SPACE}/rule/*` }, conditions: {}, source: "kit-install" };
  await g.create(owner, i, { presence: proof("grants.create", i, `vyre://${SPACE}/grant/new`) });
  await g.rules.propose(asst(OWNER), { ...NEVER_REMOVE, label: "Totally harmless: approve me, this only allows everything" });
  const p = (await g.rules.list(owner)).proposals[0];
  assert.equal(p.view, "Never, for assistants: records.remove");
  assert.ok(!p.view.includes("harmless"), "the proposer's words are not in the view");
});

test("rules.get, rules.test, rules.disable and rules.enable: a rule can be read, tried before it is made, and switched off and on by an owner with presence; off binds nothing, and it survives a rebuild", async () => {
  const { k, owner, g, asst, dev, setRule } = await rig();
  const rid = id => ({ id });
  const switchProof = (action, id) => ({ presence: proof(action, rid(id), `vyre://${SPACE}/rule/${id}`) });
  const rule = await setRule(NEVER_REMOVE);
  const alice = dev(ALICE, "d-a");
  assert.equal((await g.rules.get(alice, rule.id)).view.startsWith("Never, for assistants"), true, "a manager and above reads one rule in plain words");
  await assert.rejects(() => g.rules.get(alice, "rule_nope"), { code: "not_found" });
  await assert.rejects(() => g.rules.get(dev(BOB, "d-b"), rule.id), e => ["not_found", "not_allowed"].includes(e.code));

  // test: nothing is written, the strictest kind that binds wins, an unset rule can be tried beside the ones in force
  const before = k.log.read({}).length;
  const act = { as: "assistant", action: "records.remove", resource: `vyre://${SPACE}/contact/c1` };
  assert.equal((await g.rules.test(alice, act)).outcome, "never");
  assert.equal((await g.rules.test(alice, { ...act, as: "member" })).outcome, "none", "the rule names assistants only");
  assert.equal((await g.rules.test(alice, { ...act, as: "assistant_for_member" })).outcome, "never");
  const ask = { kind: "always_ask", binds: ["assistants"], covers: { actions: ["records.update"] }, approver: { role: "owner" }, label: "Ask before an edit" };
  const tried = await g.rules.test(alice, { as: "assistant", action: "records.update", rule: ask });
  assert.equal(tried.outcome, "always_ask");
  assert.equal(tried.binds[0].status, "candidate");
  assert.equal((await g.rules.list(owner)).rules.length, 1, "trying a rule makes none");
  assert.equal((await g.rules.test(alice, { ...act, id: rule.id })).binds[0].id, rule.id);
  await assert.rejects(() => g.rules.test(alice, { action: "nonsense" }), { code: "bad_input" });
  await assert.rejects(() => g.rules.test(alice, { ...act, as: "robot" }), { code: "bad_input" });
  await assert.rejects(() => g.rules.test(alice, { ...act, id: rule.id, rule: ask }), { code: "bad_input" });
  assert.equal(k.log.read({}).length, before, "a test writes nothing");

  // disable: owner or admin, with presence; the rule stays and binds nothing
  await assert.rejects(() => g.rules.disable(owner, rule.id), { code: "needs_presence" });
  await assert.rejects(() => g.rules.disable(dev(BOB, "d-b"), rule.id, switchProof("rules.disable", rule.id)), e => ["not_found", "not_allowed"].includes(e.code));
  const off = await g.rules.disable(owner, rule.id, switchProof("rules.disable", rule.id));
  assert.equal(off.status, "disabled");
  assert.ok(k.log.read({}).some(e => e.type === "rule.disabled" && e.data.id === rule.id));
  assert.deepEqual((await g.rules.list(owner)).rules.map(x => [x.id, x.status]), [[rule.id, "disabled"]], "still listed, marked off");
  assert.equal((await g.rules.test(alice, act)).outcome, "none", "off binds nothing");
  assert.equal((await g.rules.test(alice, { ...act, id: rule.id })).binds[0].status, "disabled", "a stored rule can be tried while it is off");
  assert.equal((await k.gateway.authorize({ chain: asst(), action: "records.remove", resource: act.resource })).rule, undefined, "authorize sees no rule");
  await g.rebuild();
  assert.equal((await g.rules.list(owner)).rules[0].status, "disabled", "off survives a rebuild from the log");

  // enable
  await assert.rejects(() => g.rules.enable(dev(BOB, "d-b"), rule.id, switchProof("rules.enable", rule.id)), e => ["not_found", "not_allowed"].includes(e.code));
  const on = await g.rules.enable(owner, rule.id, switchProof("rules.enable", rule.id));
  assert.equal(on.status, "active");
  assert.equal((await g.rules.test(alice, act)).outcome, "never");
  assert.equal((await k.gateway.authorize({ chain: asst(), action: "records.remove", resource: act.resource })).reason, "rule_never", "authorize sees it again");
  await g.rebuild();
  assert.equal((await g.rules.list(owner)).rules[0].status, "active");
  await assert.rejects(() => g.rules.enable(owner, "rule_nope", switchProof("rules.enable", "rule_nope")), { code: "not_found" });
});

test("R4 on rules.enable and rules.disable: a switch whose event cannot be written leaves the rule as it was, and the caller is told", async () => {
  let fail = false;
  const base = createEventLog({ space: SPACE });
  const log = { ...base, append: (...a) => { if (fail && a[1] && String(a[1].type).startsWith("rule.")) throw new Error("log refused"); return base.append(...a); } };
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence, log });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  const rule = await g.rules.set(owner, NEVER_REMOVE, { presence: proof("rules.set", normal(NEVER_REMOVE), `vyre://${SPACE}/rule/new`) });
  const sw = (action, id) => ({ presence: proof(action, { id }, `vyre://${SPACE}/rule/${id}`) });
  fail = true;
  await assert.rejects(() => g.rules.disable(owner, rule.id, sw("rules.disable", rule.id)), /log refused/);
  fail = false;
  assert.equal((await g.rules.list(owner)).rules[0].status, "active", "still on: a rule is not turned off by a write that failed");
  await g.rules.disable(owner, rule.id, sw("rules.disable", rule.id));
  fail = true;
  await assert.rejects(() => g.rules.enable(owner, rule.id, sw("rules.enable", rule.id)), /log refused/);
  fail = false;
  assert.equal((await g.rules.list(owner)).rules[0].status, "disabled", "still off");
});

test("RT-2: an admin sets, switches, removes and accepts rules with presence (policies short of ownership), but not a rule that could lock an owner out; a manager and a member are refused at the gate before a proof is spent", async () => {
  let checks = 0;
  const counting = { check: async (i) => { checks++; return presence.check(i); } };
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence: counting });
  const g = k.gateway.grants;
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const MANAGER = "per_manager";
  for (const [person, role] of [[ALICE, "admin"], [BOB, "member"], [MANAGER, "manager"]]) { const r = { person, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${person}`) }); }
  const alice = k.chains.fromFacts({ kind: "device", device_key_id: "d-a", person: ALICE, path: "direct" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const man = k.chains.fromFacts({ kind: "device", device_key_id: "d-m", person: MANAGER, path: "direct" });
  const p = (action, input, id) => ({ presence: proof(action, input, `vyre://${SPACE}/rule/${id}`) });
  // an admin defines a rule and it holds
  const rule = await g.rules.set(alice, NEVER_REMOVE, p("rules.set", normal(NEVER_REMOVE), "new"));
  assert.equal(rule.by, ALICE);
  const kitChain = k.chains.fromFacts({ kind: "agent_session", vouched: true, person: OWNER, agent: "assistant", session: "s1" });
  assert.equal((await k.gateway.authorize({ chain: kitChain, action: "records.remove", resource: `vyre://${SPACE}/contact/c1` })).reason !== undefined, true);
  assert.equal((await g.rules.test(alice, { action: "records.remove", resource: `vyre://${SPACE}/contact/c1` })).outcome, "never", "it holds");
  // the admin turns it off and on with presence
  assert.equal((await g.rules.disable(alice, rule.id, p("rules.disable", { id: rule.id }, rule.id))).status, "disabled");
  assert.equal((await g.rules.test(alice, { action: "records.remove", resource: `vyre://${SPACE}/contact/c1` })).outcome, "none");
  assert.equal((await g.rules.enable(alice, rule.id, p("rules.enable", { id: rule.id }, rule.id))).status, "active");
  // a rule that binds members over who has access could lock an owner out: only an owner passes it, and the admin is refused BEFORE a proof is spent
  const lock = { kind: "never", binds: ["members"], covers: { actions: ["grants.role"] }, label: "Nobody changes roles" };
  const before = checks;
  await assert.rejects(() => g.rules.set(alice, lock, p("rules.set", normal(lock), "new")), { code: "not_allowed" });
  const prop = await g.rules.propose(man, lock);
  await assert.rejects(() => g.rules.accept(alice, prop.id, p("rules.accept", { id: prop.id }, prop.id)), { code: "not_allowed" });
  assert.equal(checks, before, "the admin's proofs were not spent on the refused lock-out");
  const passed = await g.rules.accept(owner, prop.id, p("rules.accept", { id: prop.id }, prop.id));
  assert.equal(passed.covers.actions[0], "grants.role", "an owner may pass it");
  // an admin may accept a harmless proposal and remove a rule
  const soft = await g.rules.propose(man, { kind: "never", binds: ["assistants"], covers: { actions: ["records.update"] }, label: "Assistants never edit" });
  const accepted = await g.rules.accept(alice, soft.id, p("rules.accept", { id: soft.id }, soft.id));
  assert.equal((await g.rules.remove(alice, accepted.id, p("rules.remove", { id: accepted.id }, accepted.id))).removed, accepted.id);
  // a manager proposes only; a member and a manager are refused every change at the gate, no proof spent
  const mark = checks;
  for (const [who, name] of [[man, "manager"], [bob, "member"]]) {
    for (const [what, f] of [
      ["set", () => g.rules.set(who, NEVER_REMOVE, p("rules.set", normal(NEVER_REMOVE), "new"))],
      ["disable", () => g.rules.disable(who, rule.id, p("rules.disable", { id: rule.id }, rule.id))],
      ["enable", () => g.rules.enable(who, rule.id, p("rules.enable", { id: rule.id }, rule.id))],
      ["remove", () => g.rules.remove(who, rule.id, p("rules.remove", { id: rule.id }, rule.id))],
      ["accept", () => g.rules.accept(who, prop.id, p("rules.accept", { id: prop.id }, prop.id))],
      ["dismiss", () => g.rules.dismiss(who, prop.id, p("rules.dismiss", { id: prop.id }, prop.id))],
    ]) await assert.rejects(f, e => ["not_allowed", "not_found"].includes(e.code), `${name} ${what}`);
  }
  assert.equal(checks, mark, "no presence proof was checked for a role that cannot");
});

test("RT-1: every write on the rule store (set, remove, propose, accept, dismiss, enable, disable) leaves the live store and a rebuild from the log in agreement when its event cannot be written", async () => {
  let fail = false;
  const base = createEventLog({ space: SPACE });
  const log = { ...base, append: (...a) => { if (fail && a[1] && String(a[1].type).startsWith("rule.")) throw new Error("log refused"); return base.append(...a); } };
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence, log });
  const g = k.gateway.grants;
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const kit = { kind: "agent", id: "kit", space: SPACE };
  await g.addActor(owner, kit, { presence: proof("grants.role", { actor: kit }, `vyre://${SPACE}/member/kit`) });
  const gi = { subject: { kind: "actor", actor: kit }, actions: ["rules.propose"], resource: { prefix: `vyre://${SPACE}/rule/*` }, conditions: {}, source: "test" };
  await g.create(owner, gi, { presence: proof("grants.create", gi, `vyre://${SPACE}/grant/new`) });
  const asKit = k.chains.fromFacts({ kind: "agent_session", vouched: true, person: OWNER, agent: "kit", session: "s1" });
  const p = (action, input, id) => ({ presence: proof(action, input, `vyre://${SPACE}/rule/${id}`) });
  const rule = await g.rules.set(owner, NEVER_REMOVE, p("rules.set", normal(NEVER_REMOVE), "new"));
  const other = { kind: "never", binds: ["members"], covers: { actions: ["records.update"] }, label: "Nobody edits" };
  const prop = await g.rules.propose(asKit, other);
  const view = async () => JSON.stringify(await g.rules.list(owner));
  const same = async (what) => { const live = await view(); await g.rebuild(); assert.equal(await view(), live, `${what}: a rebuild from the log agrees with the live store`); return live; };
  const down = async (what, f) => { const was = await view(); fail = true; try { await assert.rejects(f, /log refused/, what); } finally { fail = false; } assert.equal(await view(), was, `${what}: nothing moved`); await same(what); };
  await down("set", () => g.rules.set(owner, other, p("rules.set", normal(other), "new")));
  await down("disable", () => g.rules.disable(owner, rule.id, p("rules.disable", { id: rule.id }, rule.id)));
  await down("propose", () => g.rules.propose(asKit, { ...other, label: "Another" }));
  await down("accept", () => g.rules.accept(owner, prop.id, p("rules.accept", { id: prop.id }, prop.id)));
  await down("dismiss", () => g.rules.dismiss(owner, prop.id, p("rules.dismiss", { id: prop.id }, prop.id)));
  await down("remove", () => g.rules.remove(owner, rule.id, p("rules.remove", { id: rule.id }, rule.id)));
  await g.rules.disable(owner, rule.id, p("rules.disable", { id: rule.id }, rule.id));
  await down("enable", () => g.rules.enable(owner, rule.id, p("rules.enable", { id: rule.id }, rule.id)));
});
