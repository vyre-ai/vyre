// @ts-check
// A team member reaches the records a service keeps (the skill library, Flow definitions and approvals) by NO path: not the member door's records group, not a registry records tool run
// with her own session token, not the activity log (events.read from the start or from a cursor, and a subscription). The owner, an admin and the keeper service still do. Two members and
// the owner on a real vyred with the kernel on. Every step that once leaked (a private personal skill, a Space-level draft, a Flow approval forged in the owner's name) must now be refused or
// empty, and nothing the owner or a keeper reads may change. SHIM(presence) `kernelPresence` accepts any proof, as the other real-daemon suites do. Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "./index.js";
import { tempHome } from "../../test/helpers.js";
import { createRemoteServer } from "../../kernel/remote/server.js";
import { WIRE_VERSION } from "../../kernel/remote/wire.js";
import { createMemberTools } from "../work/member-tools.js";
import { flowHash, canonical } from "../../kernel/flows/schema.js";
import { MEMORY_FACT } from "../../kernel/gateway/memory.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const skill = (/** @type {string} */ name, /** @type {string} */ says) => `---\nname: ${name}\ndescription: Use this when the person asks about ${name}, which is ${says}\n---\n${says}\n`;
/** The words that must never reach Ben: the owner's personal skill, a Space-level draft, Ana's personal skill, and the text of a Flow the owner approved. */
const SECRET = ["OWNER-PRIVATE-TEXT", "SPACE-DRAFT-TEXT", "ANA-PRIVATE-TEXT", "OWNER-FLOW-MARKER"];
const KEPT = /^vyre:\/\/[^/]+\/(skill|def-flow|flow-approval|flow-state|flow-control|flow-tests|flow-schedule|flow-run)\//;

/** @param {any} t */
async function world(t) {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner, SPACE = d.kernel.id.space, K = d.kernel;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const person of [ANA, BEN]) await K.gateway.grants.setRole(ownerChain, { person, role: "member" }, { presence: proof() });
  const chainOf = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "relay" });
  const tokenOf = async (/** @type {any} */ chain) => ({ token: (await K.surfaces.open(chain, {})).token });
  const asOwner = async (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli", await tokenOf(ownerChain));
  const server = createRemoteServer({ space: SPACE, kernel: K, services: {} });
  let n = 0;
  /** One request through the server's real dispatch, as a peer of the Space. */
  const door = async (/** @type {string} */ person, /** @type {string} */ call, /** @type {any[]} */ ...args) => {
    const r = await server.serve({ v: WIRE_VERSION, id: "r" + (++n), space: SPACE, ts: Date.now(), call, args }, { device_key_id: "dev-" + person.slice(4, 10), person, path: "relay" });
    return r.ok ? { ok: true, v: r.result } : { ok: false, e: `${r.error.code}: ${r.error.message}` };
  };
  // the owner's: a personal skill, an approved Space skill, a Space draft, an approved Flow; Ana's: a personal skill through the member door
  const p = await asOwner("skills.draft", { name: "owner-secret", level: "personal", body: skill("owner-secret", "OWNER-PRIVATE-TEXT") });
  assert.ok(!p.error, JSON.stringify(p.error));
  assert.ok(!(await asOwner("skills.approve", { name: "owner-secret", level: "personal", version: p.data.version })).error);
  const live = await asOwner("skills.draft", { name: "space-live", level: "space", body: skill("space-live", "SPACE-LIVE-TEXT") });
  assert.ok(!(await asOwner("skills.approve", { name: "space-live", level: "space", version: live.data.version })).error);
  assert.ok(!(await asOwner("skills.draft", { name: "space-draft", level: "space", body: skill("space-draft", "SPACE-DRAFT-TEXT") })).error);
  const skillsDoor = createMemberTools({ space: SPACE, kernel: K, registry: d.registry }).skills;
  const a1 = await skillsDoor.draft(chainOf(ANA), { name: "ana-private", level: "personal", body: skill("ana-private", "ANA-PRIVATE-TEXT") });
  await skillsDoor.approve(chainOf(ANA), { name: "ana-private", level: "personal", version: a1.version });
  const fl = await asOwner("flows.define", { flow: { format: 1, name: "owner_flow", label: "OWNER-FLOW-MARKER", authorship: "human", trigger: { on: "manual" }, steps: [] } });
  assert.ok(fl.data && fl.data.ok, JSON.stringify(fl.error || fl.data));
  const fa = await asOwner("flows.approve", { id: fl.data.id, version: fl.data.version, hash: fl.data.hash });
  assert.ok(!fa.error, JSON.stringify(fa.error));
  // the ids of the kept records, as the keeper sees them
  const svc = K.gateway.serviceChain("skills");
  const kept = (await K.gateway.records.query(svc, "skill", { page: { limit: 50 } })).rows;
  const idOf = (/** @type {string} */ name) => { const r = kept.find((/** @type {any} */ x) => x.data.name === name); assert.ok(r, `the library holds ${name}`); return r; };
  return { d, K, OWNER, SPACE, ownerChain, chainOf, tokenOf, asOwner, door, kept, idOf, flowId: fl.data.id, skillsDoor };
}

const leaks = (/** @type {any} */ x) => { const s = JSON.stringify(x === undefined ? null : x); return SECRET.filter(w => s.includes(w)); };
/** Refused, or empty, or at least nothing of a kept type and none of the secret words. */
const nothing = (/** @type {any} */ r) => {
  if (r === undefined || r === null) return true;
  if (r.ok === false || r.error) return true;
  const v = r.ok === true ? r.v : r.data !== undefined ? r.data : r;
  if (leaks(v).length) return false;
  const rows = Array.isArray(v) ? v : v && (v.rows || v.events || v.hits || v.types);
  if (Array.isArray(rows)) return rows.every((/** @type {any} */ x) => !KEPT.test(String((x && (x.subject || x.urn)) || "")) && !/^(skill|def-flow|flow-approval|flow-state)$/.test(String((x && (x.type || x.name)) || "")));
  return v === null || v === undefined || v.record === null || v.reference === null || v.data === null || (typeof v === "object" && Object.keys(v).every(k => /^(acted_in|next_cursor|truncated|links?|total|count|groups?)$/.test(k)));
};

test("PATH 1: the member door's own dispatch (createRemoteServer.serve): Ben reads and changes none of the kept records, the owner and the keeper still do", { timeout: 150_000 }, async t => {
  const w = await world(t);
  const B = (/** @type {string} */ c, /** @type {any[]} */ ...a) => w.door(BEN, c, ...a);
  // controls: the harness answers, and the owner and the keeper see the records
  const oq = await w.door(w.OWNER, "records.query", "skill", { page: { limit: 50 } });
  assert.ok(oq.ok && oq.v.rows.length >= 4, "the owner reads the skill records through the door: " + JSON.stringify(oq).slice(0, 200));
  assert.ok(w.kept.length >= 4, "the keeper service (the skills library) reads them");
  assert.ok((await B("records.query", "contact", { page: { limit: 5 } })).ok, "Ben's door works for an ordinary type");
  const ids = [w.idOf("owner-secret"), w.idOf("space-draft"), w.idOf("space-live"), w.idOf("ana-private")];
  for (const r of ids) {
    assert.ok(nothing(await B("records.get", "skill", r.id)), `get ${r.data.name}`);
    assert.ok(nothing(await B("records.reference", "skill", r.id)), `reference ${r.data.name}`);
    assert.equal((await B("records.update", "skill", r.id, { state: "approved", body: skill(r.data.name, "INJECTED-BY-BEN") }, r.version)).ok, false, `update ${r.data.name}`);
    assert.equal((await B("records.remove", "skill", r.id, r.version)).ok, false, `remove ${r.data.name}`);
    assert.equal((await B("records.restore", "skill", r.id)).ok, false, `restore ${r.data.name}`);
  }
  assert.ok(nothing(await B("records.query", "skill", { page: { limit: 50 } })), "query skill");
  assert.ok(nothing(await B("records.aggregate", "skill", { group_by: "state" })), "aggregate skill");
  for (const text of ["OWNER-PRIVATE-TEXT", "SPACE-DRAFT-TEXT", "ANA-PRIVATE-TEXT", "OWNER-FLOW-MARKER"]) {
    assert.ok(nothing(await B("records.search", { text, page: { limit: 20 } })), `search ${text}`);
    assert.ok(nothing(await B("records.search", { text, types: ["skill", "def-flow"], page: { limit: 20 } })), `search ${text} by type`);
  }
  assert.ok(nothing(await B("records.definitions")), "the list of types leaves the kept ones out");
  assert.equal((await B("records.create", "skill", { name: "ben-made", level: "space", scope: "", version: 1, state: "approved", kind: "skill", body: skill("ben-made", "BEN-APPROVED"), hash: "x", owner: "", proposer: `person:${BEN}` })).ok, false, "create an approved Space skill");
  // a Flow forged in the owner's name: the definition, the approval and the state
  const flow = { format: 1, name: "ben_forged", authorship: "human", trigger: { on: "manual" }, steps: [] }, hash = flowHash(flow);
  assert.equal((await B("records.create", "def-flow", { flow_id: "fl_forged", name: flow.name, space: w.SPACE, version: 1, hash, body: canonical(flow), authorship: "human", by: `person:${w.OWNER}` })).ok, false, "create def-flow");
  assert.equal((await B("records.create", "flow-approval", { flow_id: "fl_forged", version: 1, hash, approver: `person:${w.OWNER}`, at: Date.now() })).ok, false, "create flow-approval naming the owner");
  assert.equal((await B("records.create", "flow-state", { flow_id: "fl_forged", status: "active", active: 1, reason: "", since: Date.now() })).ok, false, "create flow-state active");
  assert.equal((await B("records.create", "flow-control", { key: "all", mode: "paused", since: 1, body: "{}" })).ok, false, "create flow-control");
  // the activity log through the same door
  for (const spec of [{}, { limit: 500 }, { since: 0 }, { since: 3 }]) assert.ok(nothing(await B("events.read", spec)), `events.read ${JSON.stringify(spec)}`);
  // afterwards: what the owner reads has not changed
  const list = (await w.asOwner("skills.list", {})).data;
  assert.ok(!list.skills.some((/** @type {any} */ s) => /ben-made/.test(s.id)), "no skill of Ben's in the owner's list");
  assert.ok(!JSON.stringify((await w.asOwner("skills.get", { id: "space/space-live" })).data).includes("INJECTED-BY-BEN"), "the approved Space skill is as the owner approved it");
  assert.ok(!list.skills.some((/** @type {any} */ s) => s.id === "space/space-draft"), "the Space draft is still a draft");
  assert.deepEqual(((await w.asOwner("flows.list", {})).data).map((/** @type {any} */ f) => f.id), [w.flowId], "the owner has her one Flow and no forged one");
  // the owner's events still show the log
  const oe = await w.door(w.OWNER, "events.read", {});
  assert.ok(oe.ok && JSON.stringify(oe.v).includes("OWNER-PRIVATE-TEXT"), "the owner still reads the log");
});

test("PATH 2: a registry records tool run with Ben's own session token reaches none of the kept records", { timeout: 150_000 }, async t => {
  const w = await world(t);
  const bt = await w.tokenOf(w.chainOf(BEN)), ot = await w.tokenOf(w.ownerChain);
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ meta = bt) => w.d.registry.call(tool, input, "cli", meta);
  const urnOf = (/** @type {string} */ type, /** @type {string} */ id) => `vyre://${w.SPACE}/${type}/${id}`;
  // controls: the token works, and the owner's token reads what Ben's must not
  const me = await call("records.me", {});
  assert.ok(me.data && me.data.person === BEN, "Ben's token is Ben's: " + JSON.stringify(me).slice(0, 120));
  const ol = await call("records.list", { type: "skill" }, ot);
  assert.ok(ol.data && ol.data.rows.length >= 4, "the owner's token lists the skill records");
  assert.ok((await call("records.list", { type: "contact" })).data, "Ben's token lists an ordinary type");
  const secret = w.idOf("owner-secret"), draft = w.idOf("space-draft"), ana = w.idOf("ana-private");
  for (const type of ["skill", "def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"]) assert.ok(nothing(await call("records.list", { type })), `records.list ${type}`);
  for (const r of [secret, draft, ana, w.idOf("space-live")]) {
    const urn = urnOf("skill", r.id);
    assert.ok(nothing(await call("records.get", { urn })), `records.get ${r.data.name}`);
    assert.ok(nothing(await call("records.reference", { urn })), `records.reference ${r.data.name}`);
    assert.ok(nothing(await call("records.sees-as", { urn, who: "person" })), `records.sees-as ${r.data.name}`);
    assert.ok(nothing(await call("records.linked", { urn })), `records.linked ${r.data.name}`);
    assert.ok(nothing(await call("records.events", { record: urn })), `records.events for ${r.data.name}`);
    const up = await call("records.update", { urn, patch: { state: "approved", body: skill(r.data.name, "INJECTED-BY-BEN") }, base_version: r.version });
    assert.ok(up.error, `records.update ${r.data.name} is refused: ${JSON.stringify(up).slice(0, 120)}`);
  }
  assert.ok(nothing(await call("records.events", {})), "records.events, no filter");
  assert.ok(nothing(await call("records.events", { since: 0, limit: 500 })), "records.events from the start");
  assert.ok((await call("records.create", { type: "skill", data: { name: "ben-made", level: "space", scope: "", version: 1, state: "approved", kind: "skill", body: skill("ben-made", "BEN-APPROVED"), hash: "x", owner: "", proposer: `person:${BEN}` } })).error, "records.create skill is refused");
  const flow = { format: 1, name: "ben_forged", authorship: "human", trigger: { on: "manual" }, steps: [] }, hash = flowHash(flow);
  assert.ok((await call("records.create", { type: "flow-approval", data: { flow_id: "fl_forged", version: 1, hash, approver: `person:${w.OWNER}`, at: Date.now() } })).error, "records.create flow-approval naming the owner is refused");
  assert.ok((await call("records.create", { type: "def-flow", data: { flow_id: "fl_forged", name: flow.name, space: w.SPACE, version: 1, hash, body: canonical(flow), authorship: "human", by: `person:${w.OWNER}` } })).error, "records.create def-flow is refused");
  assert.ok(nothing(await call("records.types", {})), "records.types leaves the kept types out");
  // the owner's view did not change
  assert.ok(!JSON.stringify((await call("skills.get", { id: "space/space-live" }, ot)).data).includes("INJECTED-BY-BEN"));
  assert.deepEqual(((await call("flows.list", {}, ot)).data).map((/** @type {any} */ f) => f.id), [w.flowId]);
});

test("PATH 3: the activity log: events.read from the start and from a cursor, and a subscription, show Ben none of the kept records; the owner sees them", { timeout: 150_000 }, async t => {
  const w = await world(t);
  const B = w.chainOf(BEN), E = w.K.gateway.events;
  const all = await E.read(w.ownerChain, {});
  assert.ok(JSON.stringify(all).includes("OWNER-PRIVATE-TEXT") && JSON.stringify(all).includes("OWNER-FLOW-MARKER"), "control: the owner's log shows the kept records' changes");
  const mid = all[Math.floor(all.length / 2)].seq;
  for (const spec of [{}, { since: 0 }, { since: mid }, { limit: 1000 }, { subject_prefix: `vyre://${w.SPACE}/skill/` }, { subject_prefix: `vyre://${w.SPACE}/def-flow/` }, { subject_prefix: `vyre://${w.SPACE}/` }]) {
    const got = await E.read(B, spec);
    assert.deepEqual(leaks(got), [], `events.read ${JSON.stringify(spec)} leaks nothing`);
    assert.ok(got.every((/** @type {any} */ e) => !KEPT.test(String(e.subject || ""))), `events.read ${JSON.stringify(spec)} has no event about a kept record`);
  }
  // a subscription Ben holds: what the owner and the keeper do afterwards is not delivered to him
  /** @type {any[]} */ const seen = [];
  const un = E.subscribe(B, "probe", {}, (/** @type {any} */ e) => { seen.push(e); });
  await w.asOwner("skills.draft", { name: "after-sub", level: "space", body: skill("after-sub", "SPACE-DRAFT-TEXT AFTER-SUBSCRIBE") });
  const fl2 = await w.asOwner("flows.define", { flow: { format: 1, name: "after_flow", label: "OWNER-FLOW-MARKER", authorship: "human", trigger: { on: "manual" }, steps: [] } });
  assert.ok(fl2.data && fl2.data.ok);
  await new Promise(r => setTimeout(r, 1500));
  if (typeof un === "function") un();
  assert.deepEqual(leaks(seen), [], "no secret word reached Ben's subscription");
  assert.ok(seen.every((e) => !KEPT.test(String(e.subject || ""))), "and no event about a kept record");
  // Ben's own records are still visible to him in the log (the filter hides the kept ones, not his log)
  assert.ok(Array.isArray(await E.read(B, { limit: 5 })));
});

test("the keeper rule: the owner and the keeper service pass, a chain that is Ben plus the keeper's name does not, and Ben cannot become a keeper", { timeout: 150_000 }, async t => {
  const w = await world(t);
  const R = w.K.gateway.records;
  assert.ok((await R.query(w.ownerChain, "skill", { page: { limit: 50 } })).rows.length >= 4, "the owner reads the kept type");
  assert.ok((await R.query(w.K.gateway.serviceChain("skills"), "skill", { page: { limit: 50 } })).rows.length >= 4, "the keeper (a one-hop service chain of the skills module) reads it");
  // a person-plus-service chain (the shape a module builds when it acts FOR a person) is not the keeper: Ben with the skills module's name on his chain still reads nothing
  const twoHop = w.K.chains.forModule({ module: "skills", approver: w.chainOf(BEN) });
  const got = await R.query(twoHop, "skill", { page: { limit: 50 } }).then((/** @type {any} */ r) => r.rows, () => []);
  assert.deepEqual(got.map((/** @type {any} */ r) => r.data.name), [], "[Ben, service:skills] is not the keeper of skill");
  await assert.rejects(R.update(twoHop, "skill", w.idOf("space-draft").id, { state: "approved" }, w.idOf("space-draft").version), "and cannot write it");
  // another module's service chain is not the keeper of skill
  const other = w.K.gateway.serviceChain("watchers");
  const rows = await R.query(other, "skill", { page: { limit: 50 } }).then((/** @type {any} */ r) => r.rows, () => []);
  assert.deepEqual(rows.map((/** @type {any} */ r) => r.data.name), [], "the watchers module's chain is not the keeper of skill");
});

test("a chain that is a member plus a service name changes no protected row: Flow types (the flag, not the keeper list) and the work module's memory facts", { timeout: 150_000 }, async t => {
  const w = await world(t);
  const R = w.K.gateway.records;
  const ben = w.chainOf(BEN);
  // Flow rows exist: the owner defined and approved one in world()
  const owner = w.ownerChain;
  const approvals = (await R.query(owner, "flow-approval", { page: { limit: 10 } })).rows, defs = (await R.query(owner, "def-flow", { page: { limit: 10 } })).rows, states = (await R.query(owner, "flow-state", { page: { limit: 10 } })).rows;
  assert.ok(approvals.length && defs.length && states.length, "control: the owner reads the Flow rows");
  for (const mod of ["flows", "work", "skills"]) {
    const two = w.K.chains.forModule({ module: mod, approver: ben });
    for (const [type, rows] of [["flow-approval", approvals], ["def-flow", defs], ["flow-state", states]]) {
      const r = rows[0];
      assert.deepEqual(await R.query(two, type, { page: { limit: 10 } }).then((/** @type {any} */ x) => x.rows.length, () => 0), 0, `[Ben, service:${mod}] reads no ${type}`);
      await assert.rejects(R.update(two, type, r.id, { hash: "forged" }, r.version), `[Ben, service:${mod}] cannot update a ${type}`);
      await assert.rejects(R.remove(two, type, r.id, r.version), `[Ben, service:${mod}] cannot remove a ${type}`);
    }
  }
  // the work module's memory facts: a row the owner (an admin acting as themselves) makes, then [Ben, service:work] tries to change it
  await R.define(owner, { add_types: [MEMORY_FACT] }).catch(() => {});
  const fact = await R.create(owner, "memory_fact", { text: "OWNER-FACT", source: "test", kind: "fact", by: `person:${w.OWNER}`, filed_at: 1, key: "k-owner-fact", state: "active", labels: "{}", scope: "" });
  assert.ok(fact, "control: the owner files a memory fact");
  {
    const two = w.K.chains.forModule({ module: "work", approver: ben });
    await assert.rejects(R.update(two, "memory_fact", fact.id, { text: "CHANGED" }, fact.version), "[Ben, service:work] cannot change a memory fact");
    await assert.rejects(R.remove(two, "memory_fact", fact.id, fact.version), "[Ben, service:work] cannot remove a memory fact");
  }
});
