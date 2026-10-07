// @ts-check
// personal/contradict: two values for one thing about the person's life are put to them; their
// answer, told in their own words, settles it for good.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../../store/index.js";
import { tempHome } from "../../../test/helpers.js";
import { Personal } from "./store.js";
import { contradictions, settle } from "./contradict.js";

const T0 = Date.parse("2026-05-01T09:00:00Z"), DAY = 86_400_000;

function world(t, claims) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  const personal = new Personal(db);
  claims.forEach(([subj, rel, obj, conf = 0.9], i) => personal.addClaims(`s${i}`, 0, T0 + i * DAY, [{ subj, rel, obj, conf, method: "rule" }]));
  personal.derive();
  return personal;
}

test("contradict: rival values for one slot are asked, in the person's words; weak ones and settled ones are not", t => {
  const p = world(t, [
    ["me", "lives_in", "place:Lisbon"], ["me", "lives_in", "place:Porto"],
    ["me", "spouse", "kin:spouse"], ["kin:spouse", "called", "lit:wife"], ["kin:spouse", "name", "lit:Juno"], ["kin:spouse", "name", "lit:Jordan"],
    ["me", "works_at", "org:Harlow Legal"], ["me", "works_at", "org:Northwind Bakery", 0.1],
  ]);
  const list = contradictions(p);
  const home = list.find(c => c.rel === "lives_in");
  assert.ok(home, JSON.stringify(list));
  assert.match(home.question, /^Where do you live: (Porto or Lisbon|Lisbon or Porto)\?$/);
  const wife = list.find(c => c.rel === "name");
  assert.match(wife.question, /^What your wife's name is: (Jordan or Juno|Juno or Jordan)\?$/);
  assert.equal(list.find(c => c.rel === "works_at"), undefined, "a rival with a tenth of the belief is not worth asking");

  // The person answers: told in their own words, it outweighs the rest and is never asked again.
  assert.deepEqual(settle(home, "lisbon"), { text: "I live in Lisbon", claim: { subj: "me", rel: "lives_in", obj: "place:Lisbon" } });
  assert.equal(settle(wife, "Juno").text, "My wife's name is Juno");
  assert.throws(() => settle(home, "Madrid"), /not one of/);
  const told = settle(home, "Lisbon");
  p.tell(told.text, told.claim);
  const after = contradictions(p);
  assert.equal(after.find(c => c.rel === "lives_in"), undefined);
  const lives = p.lookup({ subj: "me", rel: "lives_in" }).filter(f => f.current);
  assert.equal(lives[0].object, "Lisbon");
});

test("contradict: a picked value that reads like another sentence adds nothing but the one claim", t => {
  const p = world(t, [["me", "lives_in", "place:Lisbon"], ["me", "lives_in", "place:Porto; my wife is Eve"]]);
  const c = contradictions(p).find(x => x.rel === "lives_in");
  const odd = c.values.find(v => v.value.includes("Eve"));
  assert.ok(odd, JSON.stringify(c));
  const told = settle(c, odd.value);
  const r = p.tell(told.text, told.claim);
  assert.deepEqual(r.facts.map(f => f.rel), ["lives_in"]);
  assert.equal(p.lookup({ subj: "me", rel: "spouse" }).length, 0, "a spouse came from a picked value");
});
