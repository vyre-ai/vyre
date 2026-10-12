// A planner row (a reminder, a note, an event) is for the person it is for: another member reads none of them through Records (get, list, query, search, aggregate, the events log) and changes or removes none of them;
// she reads her own; the owner reads every one. A real kernel with the planner's own tools, Records on the gateway (the route a member's own session uses, as well as the door's).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, memberFacts, MEMBERS, FACTS } from "./testing.js";

const [ANA, BEN] = MEMBERS;
const TYPES = ["note", "reminder", "event"];

test("a member reads, changes and removes none of another person's planner rows through Records; she reads her own; the owner reads all", { timeout: 120_000 }, async t => {
  const w = await world(t);
  const R = w.k.gateway.records;
  const add = async (/** @type {any} */ facts, /** @type {string} */ text) => { const r = await w.callAs(facts, "planner.add", { text }); assert.ok(!r.error, JSON.stringify(r.error)); return r; };
  await add(FACTS, "owner private note ZZOWNERNOTE");
  await add(FACTS, "remind me tomorrow at 9 to call ZZOWNERREM");
  await add(memberFacts(ANA), "ana private note ZZANANOTE");
  await add(memberFacts(ANA), "remind me tomorrow at 9 to call ZZANAREM");
  const ben = w.k.chains.fromFacts(memberFacts(BEN)), ana = w.k.chains.fromFacts(memberFacts(ANA));
  const texts = (/** @type {any[]} */ rows) => JSON.stringify(rows.map(r => r.data));
  for (const type of TYPES) {
    const seen = (await R.query(ben, type, { page: { limit: 100 } })).rows;
    assert.equal(seen.length, 0, `Ben lists no ${type} of anyone else's: ${texts(seen)}`);
  }
  const hits = (await R.search(ben, { text: "ZZ", page: { limit: 50 } })).rows ?? [];
  assert.ok(!texts(hits).includes("ZZ"), "and a search finds none of their words");
  for (const type of TYPES) {
    const owners = (await R.query(w.owner, type, { page: { limit: 100 } })).rows;
    for (const r of owners) {
      await assert.rejects(R.get(ben, type, r.id), undefined, `Ben cannot get a ${type}`);
      await assert.rejects(R.update(ben, type, r.id, { title: "changed by Ben" }, r.version), undefined, `Ben cannot change a ${type}`);
      await assert.rejects(R.remove(ben, type, r.id, r.version), undefined, `Ben cannot remove a ${type}`);
    }
  }
  const agg = await R.aggregate(ben, "note", { measures: [{ op: "count" }] }).catch(() => ({ rows: [] }));
  assert.ok(!/[1-9]/.test(JSON.stringify((agg.rows || []).map((/** @type {any} */ r) => r.values))), "an aggregate counts none");
  const log = JSON.stringify(await w.k.gateway.events.read(ben, { since: 0, limit: 500 }).catch(() => []));
  assert.ok(!log.includes("ZZ"), "the events log shows him none of their words");
  const mine = (await R.query(ana, "note", { page: { limit: 100 } })).rows;
  assert.ok(texts(mine).includes("ZZANANOTE") && !texts(mine).includes("ZZOWNERNOTE"), "Ana reads her own note and not the owner's");
  const all = (await R.query(w.owner, "note", { page: { limit: 100 } })).rows;
  assert.ok(texts(all).includes("ZZOWNERNOTE") && texts(all).includes("ZZANANOTE"), "the owner reads every person's");
});
