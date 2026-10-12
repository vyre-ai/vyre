// The planner files a to-do with its own service chain, so the ownership rule judges the writer as the person the to-do is for (kernel/gateway/ownership.js actingForOf): a member's to-do goes only into a
// project she is on, an owner's anywhere. A real kernel, the planner's own tools.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, memberFacts, OWNER, MEMBERS, SPACE } from "./testing.js";
import { PROJECT } from "../../records/core-types.js";

const MEMBER = MEMBERS[0];
const person = (/** @type {string} */ id, /** @type {string} */ space) => ({ actor: { kind: "person", id, space } });

async function rig(/** @type {any} */ t) {
  const w = await world(t);
  const R = w.k.gateway.records;
  await R.define(w.owner, { add_types: [{ ...PROJECT, fields: PROJECT.fields.filter((/** @type {any} */ f) => f.name !== "client") }] });
  const space = SPACE;
  const theirs = await R.create(w.owner, "project", { name: "Owner's", slug: "owners", owner: person(OWNER, space) });
  const mine = await R.create(w.owner, "project", { name: "Hers", slug: "hers", owner: person(MEMBER, space) });
  return { w, theirs, mine };
}
const asMember = (/** @type {any} */ w, /** @type {string} */ tool, /** @type {any} */ input) => w.callAs(memberFacts(MEMBER), tool, input);

// MEASURED GAP, not fixed here (core/planner is rc1-b's tonight): the planner files EVERY to-do as the Space owner's (doer = K.owner, assigned_by = service:planner), whoever called it, so the ownership rule sees
// the owner as the writer and a member's planner.add reaches the owner's project. The planner has to refuse a project the CALLING person is not on before it writes; these two are the tests for that.
const GAP = { todo: "the planner files every to-do as the owner's: it must judge the calling member (rc1-b)" };
test("a member's to-do through the planner goes only into a project she is on", {}, async t => {
  const { w, theirs, mine } = await rig(t);
  const refused = await asMember(w, "planner.add", { kind: "todo", title: "into the owner's project", project: theirs.urn });
  assert.ok(refused.error, "refused: " + JSON.stringify(refused).slice(0, 200));
  assert.match(String(refused.error.message), /project you are on/);
  assert.ok((await asMember(w, "planner.add", { kind: "todo", title: "into hers", project: mine.urn })).data, "her own project");
  assert.ok((await asMember(w, "planner.add", { kind: "todo", title: "no project" })).data, "no project");
  assert.ok((await w.call("planner.add", { kind: "todo", title: "owner anywhere", project: theirs.urn })).data, "the owner files under any project");
});

test("a member cannot move her to-do into the owner's project with planner.update either", {}, async t => {
  const { w, theirs, mine } = await rig(t);
  const made = (await asMember(w, "planner.add", { kind: "todo", title: "hers", project: mine.urn })).data;
  assert.ok(made && made.id, "control: she made one in her project");
  const moved = await asMember(w, "planner.update", { item: made.id, project: theirs.urn });
  assert.ok(moved.error, "refused: " + JSON.stringify(moved).slice(0, 200));
  const back = await asMember(w, "planner.update", { item: made.id, title: "renamed" });
  assert.ok(back.data, "she still edits her own item: " + JSON.stringify(back).slice(0, 160));
});

test("a member's to-do is filed FOR HER, never as the owner's; another member cannot change, finish or remove it, the owner can", async t => {
  const { w, mine } = await rig(t);
  const OTHER = MEMBERS[1];
  const made = (await asMember(w, "planner.add", { kind: "todo", title: "hers", project: mine.urn })).data;
  assert.ok(made && made.id);
  const task = await w.k.gateway.ask.get(w.owner, made.id);
  assert.equal(task.doer && task.doer.id, MEMBER, "the doer is the calling member, not the Space owner");
  assert.notEqual(task.doer && task.doer.id, OWNER);
  const other = (tool, input) => w.callAs(memberFacts(OTHER), tool, input);
  for (const [tool, input] of [["planner.update", { item: made.id, title: "mine now" }], ["planner.delete", { item: made.id }]]) {
    const r = await other(tool, input);
    assert.equal(r.error?.code, "not_found", `${tool} by another member: ${JSON.stringify(r).slice(0, 160)}`);
  }
  assert.ok((await w.call("planner.update", { item: made.id, title: "owner edits" })).data, "the owner changes any to-do");
  assert.ok((await asMember(w, "planner.update", { item: made.id, title: "she edits" })).data, "and she still changes her own");
  assert.ok(!(await asMember(w, "planner.delete", { item: made.id })).error, "and removes it");
});

test("a member's planner reads show her own items, not the owner's or another member's; the owner sees all", async t => {
  const { w } = await rig(t);
  const OTHER = MEMBERS[1];
  const as2 = (/** @type {string} */ tool, /** @type {any} */ input) => w.callAs(memberFacts(OTHER), tool, input);
  const at = "2027-01-01T10:00:00Z";
  await w.call("planner.add", { kind: "reminder", title: "OWNER reminder", at });
  await w.call("planner.add", { kind: "note", title: "OWNER note" });
  await w.call("planner.add", { kind: "todo", title: "OWNER todo" });
  const hers = (await asMember(w, "planner.add", { kind: "note", title: "HER note" })).data;
  const herTodo = (await asMember(w, "planner.add", { kind: "todo", title: "HER todo" })).data;
  await as2("planner.add", { kind: "reminder", title: "THIRD reminder", at });
  const titles = async (/** @type {any} */ r) => (r.data || []).map((/** @type {any} */ x) => x.title).sort();
  assert.deepEqual(await titles(await asMember(w, "planner.list", { state: "all" })), ["HER note", "HER todo"], "she lists only hers");
  assert.deepEqual(await titles(await as2("planner.list", { state: "all" })), ["THIRD reminder"]);
  assert.equal((await titles(await w.call("planner.list", { state: "all" }))).length, 6, "the owner sees every item");
  const others = (await w.call("planner.list", { state: "all" })).data.find((/** @type {any} */ x) => x.title === "OWNER note");
  const peek = await asMember(w, "planner.get", { item: others.id });
  assert.ok(peek.error, "planner.get of the owner's note refused: " + JSON.stringify(peek).slice(0, 160));
  assert.ok((await asMember(w, "planner.get", { item: hers.id })).data, "and her own is readable");
  assert.ok(herTodo.id);
  const up = await asMember(w, "planner.upcoming", { hours: 72 });
  assert.ok(!JSON.stringify(up).includes("OWNER"), "upcoming holds none of the owner's");
});

test("a member's reminder goes only on a chat she is in", async t => {
  const { w } = await rig(t);
  const r = await asMember(w, "planner.add", { kind: "reminder", title: "into the owner's chat", at: "2027-01-01T10:00:00Z", thread: "thr_not_hers" });
  assert.ok(r.error, "refused: " + JSON.stringify(r).slice(0, 200));
  assert.match(String(r.error.message), /chat you are in/);
  assert.ok((await w.call("planner.add", { kind: "reminder", title: "owner may", at: "2027-01-01T10:00:00Z", thread: "thr_any" })).data, "the owner is not held to it");
});

test("a member acting BY ID on the owner's to-do or on another member's reminder gets not_found and nothing changes; her own works, and so does the owner", async t => {
  const { w } = await rig(t);
  const OTHER = MEMBERS[1];
  const at = "2027-01-01T10:00:00Z";
  const ownerTodo = (await w.call("planner.add", { kind: "todo", title: "Vault: renew the key", list: "Vault" })).data;
  const theirs = (await w.callAs(memberFacts(OTHER), "planner.add", { kind: "reminder", title: "THIRD's reminder", at })).data;
  const mineRem = (await asMember(w, "planner.add", { kind: "reminder", title: "hers", at })).data;
  for (const id of [ownerTodo.id, theirs.id]) {
    for (const [tool, input] of [["planner.update", { item: id, title: "taken" }], ["planner.done", { item: id }], ["planner.snooze", { item: id, minutes: 10 }], ["planner.dismiss", { item: id }], ["planner.delete", { item: id }]]) {
      const r = await asMember(w, tool, input);
      assert.equal(r.error?.code, "not_found", `${tool} on ${id}: ${JSON.stringify(r).slice(0, 160)}`);
    }
  }
  const after = (await w.call("planner.list", { state: "all" })).data;
  for (const [id, title] of [[ownerTodo.id, "Vault: renew the key"], [theirs.id, "THIRD's reminder"]]) {
    const it = after.find((/** @type {any} */ x) => x.id === id);
    assert.ok(it && it.title === title && it.state === "open" && !it.deleted_at, `unchanged: ${id}`);
  }
  assert.ok((await asMember(w, "planner.update", { item: mineRem.id, title: "hers edited" })).data, "her own reminder");
  assert.ok((await w.call("planner.update", { item: theirs.id, title: "owner edits" })).data, "the owner changes any");
  assert.ok((await w.call("planner.done", { item: ownerTodo.id })).data !== undefined, "and finishes his own");
});

test("planner rows are read by the person they are for: a member reads no reminder or note through any Records route; the owner reads all; the planner's own tools are unchanged", async t => {
  const { w } = await rig(t);
  const R = w.k.gateway.records;
  const member = w.k.chains.fromFacts(memberFacts(MEMBER));
  const at = "2027-01-01T10:00:00Z";
  const ownerNote = (await w.call("planner.add", { kind: "note", title: "OWNER-NOTE", body: "OWNER-BODY" })).data;
  const ownerRem = (await w.call("planner.add", { kind: "reminder", title: "OWNER-REMINDER", at })).data;
  const hers = (await asMember(w, "planner.add", { kind: "note", title: "HER-NOTE" })).data;
  const herRem = (await asMember(w, "planner.add", { kind: "reminder", title: "HER-REMINDER", at })).data;
  const seen = async (/** @type {any} */ chain) => {
    const out = /** @type {string[]} */ ([]);
    for (const type of ["note", "reminder"]) {
      const q = await R.query(chain, type, { page: { limit: 50 } }).catch(() => ({ rows: [] }));
      for (const r of q.rows || []) out.push(String(r.data && r.data.title));
      for (const id of [ownerNote.id, ownerRem.id, hers.id, herRem.id]) { const g = await R.get(chain, type, id).catch(() => null); if (g && g.data) out.push("get:" + g.data.title); }
      const s = await R.search(chain, { text: "OWNER", types: [type] }).catch(() => ({ rows: [] }));
      for (const r of s.rows || []) out.push("search:" + type);
      const a = await R.aggregate(chain, type, { measures: [{ fn: "count" }] }).catch(() => []);
      if (JSON.stringify(a).match(/[1-9]/)) out.push("aggregate:" + type);
    }
    return out;
  };
  assert.deepEqual(await seen(member), [], "a member reads none of them through Records");
  for (const [type, id] of [["note", ownerNote.id], ["reminder", ownerRem.id], ["note", hers.id]]) {
    const before = (await R.get(w.owner, type, id)).data.title;
    await assert.rejects(() => R.update(member, type, id, { title: "TAKEN" }), `update of ${type} ${id} by a member`);
    await assert.rejects(() => R.remove(member, type, id), `remove of ${type} ${id} by a member`);
    assert.equal((await R.get(w.owner, type, id)).data.title, before, `${type} ${id} unchanged`);
  }
  await assert.rejects(() => R.create(member, "note", { title: "NEW", state: "open" }), "a member creates no planner note through Records");
  assert.ok((await seen(w.owner)).includes("OWNER-NOTE") && (await seen(w.owner)).includes("HER-REMINDER"), "the owner reads all");
  const list = (await asMember(w, "planner.list", { state: "all" })).data.map((/** @type {any} */ x) => x.title).sort();
  assert.deepEqual(list, ["HER-NOTE", "HER-REMINDER"], "the planner's own tools still show her items");
});

test("a member who is neither a task's doer, checker nor on its project cannot skip it, nor even propose to skip a task that needs a check", async t => {
  const { w } = await rig(t);
  const [BEN, ANA] = MEMBERS;
  const ask = w.k.gateway.ask;
  const stranger = w.k.chains.fromFacts(memberFacts(ANA));
  const person = (/** @type {string} */ id) => ({ kind: "person", id, space: SPACE });
  const plain = await ask.request(w.owner, { title: "plain task", doer: person(OWNER), output: { kind: "note" }, source: "manual" });
  const guarded = await ask.request(w.owner, { title: "checked task", doer: person(OWNER), checker: person(BEN), output: { kind: "note" }, source: "manual" });
  await assert.rejects(() => ask.skip(stranger, plain.id, "no"), { code: "not_allowed" }, "an unchecked task: refused");
  const before = (await ask.list(w.owner, {})).length;
  await assert.rejects(() => ask.skip(stranger, guarded.id, "no"), { code: "not_allowed" }, "a task that needs a check: not even a skip proposal for the owner's Now");
  assert.equal((await ask.list(w.owner, {})).length, before, "and no card was made");
  assert.ok(await ask.skip(w.owner, plain.id, "the owner may"), "the owner skips");
});
