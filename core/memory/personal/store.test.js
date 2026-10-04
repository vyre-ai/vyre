// @ts-check
// Personal facts over a store: read incrementally from Recall's turns, resolved into one entity
// per person, and derived the same way every time.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../../store/index.js";
import { seedRecall } from "../../../test/fixtures/corpus.js";
import { tempHome } from "../../../test/helpers.js";
import { fakeReachCall } from "../../../test/fixtures/fake-reach.js";
import { Personal } from "./store.js";
import memory from "../index.js";

const T0 = Date.parse("2026-09-01T09:00:00Z");
const DAY = 86_400_000;

let n = 0;
/** A fictional session: strings are user turns, { a: text } Claude's. */
const S = (turns, { start = T0, parent } = {}) => {
  const id = parent ? `${parent}/agent-${++n}` : `33333333-cccc-4000-8000-${String(++n).padStart(12, "0")}`;
  return { id, cwd: "/home/alex/Work/misc", start, parent,
    turns: turns.map(x => (typeof x === "string" ? { role: /** @type {"user"|"assistant"} */ ("user"), text: x } : { role: /** @type {"user"|"assistant"} */ ("assistant"), text: x.a })) };
};

function world(t, sessions) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, sessions);
  return { db, me: new Personal(db), add: list => seedRecall(db, list) };
}
const all = async me => { let r; do r = await me.pass(); while (r.more); return me.derive(); };
const dump = db => ({
  e: db.prepare("SELECT * FROM memory_me_entities ORDER BY id").all(),
  a: db.prepare("SELECT * FROM memory_me_aliases ORDER BY alias, entity").all(),
  f: db.prepare("SELECT * FROM memory_me_facts ORDER BY id").all(),
  v: db.prepare("SELECT * FROM memory_me_evidence ORDER BY fact, session, seq").all(),
});

test("personal store: my wife, Jordan and her are one person", async t => {
  const a = S(["I'm picking up my wife from the airport.", { a: "Safe travels!" }, "My wife Jordan says hi.", { a: "Hi Jordan!" }, "Her birthday is 14 March, remind me."]);
  const b = S(["My wife Jordan's birthday dinner is at Northwind Bakery.", "She works at Harlow Legal."], { start: T0 + DAY });
  const { db, me } = world(t, [a, b]);
  const r = await me.pass();
  assert.equal(r.turns, 7);
  assert.equal(r.more, false);
  assert.equal(me.derive().changed, true);

  const wife = me.entity("my wife");
  assert.equal(wife?.id, "kin:spouse");
  assert.equal(wife?.label, "Jordan");
  for (const x of ["wife", "Jordan", "jordan", "spouse", "kin:spouse"]) assert.equal(me.entity(x)?.id, "kin:spouse", x);
  const name = me.lookup({ subj: "my wife", rel: "name" });
  assert.equal(name[0].object, "Jordan");
  assert.equal(name[0].current, true);
  assert.equal(name[0].confidence, 0.99, "said in two conversations: 1 - 0.1 * 0.1");
  const bday = me.lookup({ subj: "Jordan", rel: "birthday" });
  assert.equal(bday[0].object, "14 March");
  assert.ok(bday[0].confidence >= 0.5);
  // "She works at Harlow Legal" came in the second session, whose first turn named her.
  assert.equal(me.lookup({ subj: "wife", rel: "works_at" })[0]?.object, "Harlow Legal");
  const about = me.about("my wife");
  assert.ok(about?.links.some(f => f.subj === "me" && f.rel === "spouse" && f.object === "Jordan"), JSON.stringify(about));
  assert.ok(me.evidence(name[0].id).some(e => e.session === a.id && e.seq === 2));
  const st = me.stats();
  assert.equal(st.turns, 7);
  assert.ok(st.facts >= 4 && st.entities >= 2, JSON.stringify(st));
  assert.ok(dump(db).f.every(f => f.subj === "me" || f.subj === "kin:spouse"), JSON.stringify(dump(db).f));
});

test("personal store: rival values share the belief, and the newest place is where the user lives", async t => {
  const { me } = world(t, [
    S(["I live in Portland."], { start: T0 }),
    S(["We moved to Seattle last spring."], { start: T0 + 30 * DAY }),
  ]);
  await all(me);
  const [first, second] = me.lookup({ subj: "me", rel: "lives_in" });
  assert.equal(first.object, "Seattle");
  assert.equal(first.current, true);
  assert.equal(second.object, "Portland");
  assert.equal(second.current, false);
  assert.ok(first.confidence >= 0.5 && second.confidence < first.confidence, JSON.stringify([first, second]));
});

test("personal store: a sold car no longer holds; a make alone is the model said elsewhere", async t => {
  const { me } = world(t, [
    S(["I own a Volvo XC90."], { start: T0 }),
    S(["The Volvo needs a service."], { start: T0 + DAY }),
    S(["We sold the Volvo and I drive a Tesla Model 3 now."], { start: T0 + 60 * DAY }),
  ]);
  await all(me);
  const owns = me.lookup({ subj: "me", rel: "owns" });
  const volvo = owns.find(f => f.object.startsWith("Volvo"));
  const tesla = owns.find(f => f.object === "Tesla Model 3");
  assert.equal(volvo?.object, "Volvo XC90");
  // Owned, serviced, and sold: selling it says it was the user's too.
  assert.equal(volvo?.mentions, 3, "the passing mention and the sale are the same car");
  assert.equal(volvo?.current, false);
  assert.equal(tesla?.current, true);
  assert.equal(me.entity("my car")?.id, "vehicle:Tesla Model 3");
});

test("personal store: someone else's facts stay out, and Claude's echo is weak", async t => {
  const { me } = world(t, [S(["Dana's birthday is 3 May.", "Dana Reyes works at Harlow Legal.", { a: "Your sister Juno lives in Denver, right?" }])]);
  await all(me);
  const facts = me.facts({ limit: 100 });
  assert.ok(!facts.some(f => f.object === "3 May"), JSON.stringify(facts));
  const juno = facts.find(f => f.rel === "name" && f.object === "Juno");
  assert.ok(!juno || juno.confidence < 0.5);
});

test("personal store: a subagent's brief is another agent's words and teaches nothing", async t => {
  const p = S(["My wife Jordan says hi."]);
  const sub = S(["My wife Jordan says hi."], { parent: p.id });
  const other = S(["My wife Jordan is at Harlow Legal today."], { start: T0 + DAY });
  const { me } = world(t, [p, sub, other]);
  await all(me);
  const f = me.lookup({ subj: "wife", rel: "name" })[0];
  assert.equal(f.mentions, 2);
  assert.equal(f.sessions, 2);
});

test("personal store: idempotent, incremental, and derive writes only on change", async t => {
  const s = S(["My wife Jordan says hi.", "Her birthday is 14 March."]);
  const { db, me, add } = world(t, [s]);
  await all(me);
  const before = dump(db);
  assert.equal(me.derive().changed, false, "nothing changed: no derive");
  assert.equal(me.derive({ force: true }).changed, false, "a forced derive over the same claims writes nothing");
  assert.equal((await me.pass()).turns, 0, "nothing new to read");
  assert.deepEqual(dump(db), before);
  // A fresh reader over the same store derives the same thing.
  const again = new Personal(db);
  assert.equal(again.derive().changed, false);
  // A grown session reads only its new turn, and carries "her" into it.
  db.prepare("INSERT INTO recall_turns (session, seq, role, ts, text) VALUES (?,?,?,?,?)").run(s.id, 2, "user", T0 + 5 * 60_000, "She lives in Seattle.");
  db.prepare("UPDATE recall_sessions SET turns = 3 WHERE id = ?").run(s.id);
  const r = await me.pass();
  assert.equal(r.turns, 1);
  me.derive();
  assert.equal(me.lookup({ subj: "Jordan", rel: "lives_in" })[0]?.object, "Seattle");
  add([S(["I live in Portland."])]);
  assert.equal((await me.pass()).turns, 1);
});

test("personal store: a rewritten session is read again from the start", async t => {
  const s = S(["My wife Jordan says hi.", "I live in Portland."]);
  const { db, me } = world(t, [s]);
  await all(me);
  assert.equal(me.lookup({ subj: "me", rel: "lives_in" })[0]?.object, "Portland");
  db.prepare("DELETE FROM recall_turns WHERE session = ?").run(s.id);
  db.prepare("INSERT INTO recall_turns (session, seq, role, ts, text) VALUES (?,?,?,?,?)").run(s.id, 0, "user", T0, "Compacted: I live in Denver.");
  db.prepare("UPDATE recall_sessions SET turns = 1 WHERE id = ?").run(s.id);
  me.reset(s.id);
  await all(me);
  assert.deepEqual(me.lookup({ subj: "me", rel: "lives_in" }).map(f => f.object), ["Denver"]);
  assert.equal(me.entity("my wife"), null);
  // A shrunk session is noticed without being told.
  db.prepare("DELETE FROM recall_turns WHERE session = ?").run(s.id);
  db.prepare("UPDATE recall_sessions SET turns = 0 WHERE id = ?").run(s.id);
  await all(me);
  assert.deepEqual(me.facts(), []);
});

test("personal store: bounded batches, and claims a model adds later", async t => {
  const turns = Array.from({ length: 50 }, (_, i) => (i === 42 ? "My dog Kit is sick." : `Run the tests for module ${i}.`));
  const { me } = world(t, [S(turns)]);
  const r1 = await me.pass({ limit: 20 });
  assert.deepEqual([r1.turns, r1.more], [20, true]);
  const r2 = await me.pass({ limit: 20 });
  const r3 = await me.pass({ limit: 20 });
  assert.deepEqual([r2.turns, r3.turns, r3.more], [20, 10, false]);
  me.derive();
  assert.equal(me.entity("my dog")?.label, "Kit");
  assert.equal(me.addClaims("x", 0, T0, [{ subj: "kin:dog", rel: "birthday", obj: "lit:1 April" }]), 1);
  me.derive();
  const b = me.lookup({ subj: "Kit", rel: "birthday" })[0];
  assert.equal(b.object, "1 April");
  assert.equal(b.confidence, 0.75);
});

test("personal store: stopped mid-pass keeps its place", async t => {
  const { me } = world(t, [S(["I live in Portland."]), S(["I work at Northwind Bakery."])]);
  let calls = 0;
  const r = await me.pass({ stopped: () => ++calls > 1 });
  assert.equal(r.more, true);
  assert.equal(r.turns, 1);
  await all(me);
  assert.equal(me.stats().turns, 2);
});

test("personal store: 20,000 turns read in bounded batches", async t => {
  const sessions = [];
  for (let s = 0; s < 200; s++) {
    sessions.push(S(Array.from({ length: 100 }, (_, i) =>
      i === 7 ? "My wife Jordan says hi. Her birthday is 14 March." : i % 2 ? { a: "Done. The tests pass and the PR is ready for review." } : `Refactor module ${i} and run the tests.`), { start: T0 + s * DAY }));
  }
  const { me } = world(t, sessions);
  const t0 = performance.now();
  let turns = 0, r;
  do { r = await me.pass({ limit: 2000 }); turns += r.turns; } while (r.more);
  const read = performance.now() - t0;
  const t1 = performance.now();
  me.derive();
  const derive = performance.now() - t1;
  console.log(`# personal store: ${turns} turns read in ${Math.round(read)} ms, derived in ${Math.round(derive)} ms`);
  assert.equal(turns, 20000);
  const f = me.lookup({ subj: "my wife", rel: "birthday" })[0];
  assert.equal(f.sessions, 200);
  assert.ok(f.confidence > 0.99);
});

test("personal store: memory.me through the module, for the user and never for an agent", async t => {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  const s = S(["My wife Jordan says hi.", "Her birthday is 14 March.", "I live in Portland."]);
  seedRecall(db, [s]);
  const tools = new Map(), handlers = new Map();
  const ctx = {
    name: "memory", config: {}, paths: {}, store: { db, migrate: () => {} }, log: () => {},
    events: { on: (type, fn) => { handlers.set(type, fn); return () => {}; }, emit: () => {}, since: () => [], prune: () => 0 },
    call: async (tool, input) => fakeReachCall(tool, input, { agents: [{ name: "kit", projects: ["northwind"] }] }),
    tool: (name, def) => tools.set(name, def),
  };
  const handle = await memory.start(ctx);
  t.after(() => handle.stop());
  const call = async (name, input, caller) => {
    try { return { data: await tools.get(name).run(input, { caller }) }; } catch (e) { return { error: /** @type {Error} */ (e).message, code: /** @type {any} */ (e).code || "failed" }; }
  };
  const cur = await call("memory.curate", {}, "cli");
  assert.equal(cur.data.personal?.turns >= 0, true, JSON.stringify(cur));
  const me = (await call("memory.me", { about: "my wife" }, "cli")).data;
  assert.equal(me.about.id, "kin:spouse");
  assert.equal(me.about.label, "Jordan");
  assert.ok(me.facts.some(f => f.rel === "birthday" && f.object === "14 March"), JSON.stringify(me));
  assert.ok(me.facts.some(f => f.subj === "me" && f.rel === "spouse"));
  const top = (await call("memory.me", {}, "tailnet:alex@example.com")).data;
  assert.ok(top.facts.some(f => f.rel === "lives_in" && f.object === "Portland"));
  assert.equal((await call("memory.me", {}, "cli agent:kit")).code, "denied");
  assert.equal((await call("memory.me", {}, "mcp")).code, "denied");
  assert.equal((await call("memory.me", {}, "tailnet:agent:kit")).code, "denied");
  assert.ok((await call("memory.stats", {}, "cli")).data.personal.facts >= 3);
  // A rewritten transcript is dropped here too, and read again.
  db.prepare("DELETE FROM recall_turns WHERE session = ?").run(s.id);
  db.prepare("INSERT INTO recall_turns (session, seq, role, ts, text) VALUES (?,?,?,?,?)").run(s.id, 0, "user", T0, "I live in Denver.");
  db.prepare("UPDATE recall_sessions SET turns = 1 WHERE id = ?").run(s.id);
  handlers.get("session.indexed")?.({ payload: { session: s.id, rewritten: true } });
  await call("memory.curate", {}, "cli");
  const after = (await call("memory.me", {}, "cli")).data.facts;
  assert.deepEqual(after.filter(f => f.rel === "lives_in").map(f => f.object), ["Denver"]);
  assert.equal((await call("memory.me", { about: "my wife" }, "cli")).data.about, null);
});

test("personal store: a lowercase name is confirmed by another turn using it as a name", async t => {
  const { me } = world(t, [
    S(["my partner jordan says the logo looks too corporate"], { start: T0 }),
    S(["jordan and i are off to denver so i need this done by fri"], { start: T0 + DAY }),
    S(["my son sam snapped my pencil"], { start: T0 + 2 * DAY }),
  ]);
  await all(me);
  const jordan = me.lookup({ subj: "my partner", rel: "name" })[0];
  assert.equal(jordan?.object, "Jordan");
  assert.equal(jordan?.confidence, 0.9, "confirmed by 'jordan and i'");
  // Said once, never used as a name elsewhere: a maybe, not a fact.
  const sam = me.lookup({ subj: "my son", rel: "name" })[0];
  assert.equal(sam?.object, "Sam");
  assert.ok(sam.confidence < 0.5, JSON.stringify(sam));
});

test("personal store: partner and husband are one person unless names or genders differ", async t => {
  const { me } = world(t, [
    S(["my partner jordan says hi", "jordan's picking up the kids"], { start: T0 }),
    S(["hubby's cooking tonight", "need a gift for my husband, his birthday's the 2nd of june"], { start: T0 + DAY }),
  ]);
  await all(me);
  assert.equal(me.entity("my husband")?.id, me.entity("my partner")?.id);
  assert.equal(me.entity("hubby")?.label, "Jordan");
  assert.equal(me.lookup({ subj: "jordan", rel: "birthday" })[0]?.object, "2 June");

  const two = world(t, [S(["My wife Jordan says hi.", "My boyfriend Sam is visiting."])]);
  await all(two.me);
  assert.notEqual(two.me.entity("my wife")?.id, two.me.entity("my boyfriend")?.id, "two names: two people");
});

test("personal store: a fact only Claude's words support stays under 0.5", async t => {
  const { me } = world(t, [
    S(["draft the family law copy", { a: "Your partner and your children come first." }], { start: T0 }),
    S(["shorter", { a: "Your partner and your children matter most." }], { start: T0 + DAY }),
    S(["again", { a: "We help you, your partner and your children." }], { start: T0 + 2 * DAY }),
  ]);
  await all(me);
  for (const f of me.facts({ limit: 50 })) assert.ok(f.confidence < 0.5, JSON.stringify(f));
});

test("personal store: a person at one of the user's own clients is their contact there", async t => {
  const { me } = world(t, [
    S(["my two clients right now are harlow legal and northwind bakery"], { start: T0 }),
    S(["dana from harlow legal emailed again about the photos", "a guy from denver bought the old car"], { start: T0 + DAY }),
  ]);
  await all(me);
  const dana = me.about("dana");
  assert.ok(dana?.facts.some(f => f.rel === "works_at" && f.object === "Harlow Legal"), JSON.stringify(dana));
  assert.ok(dana?.links.some(f => f.subj === "me" && f.rel === "contact"));
  // Only the user's own organisations: nobody is placed at "denver bought the old car".
  assert.ok(!me.facts({ limit: 50 }).some(f => f.rel === "works_at" && /denver/i.test(f.object)));
});

test("personal store: lowercase moves, and the newest place is where the user lives", async t => {
  const { me } = world(t, [
    S(["packing boxes all week, the move from portland is friday"], { start: T0 }),
    S(["the wifi in the new place in seattle is awful"], { start: T0 + 5 * DAY }),
    S(["still getting used to seattle, everything is further"], { start: T0 + 9 * DAY }),
  ]);
  await all(me);
  const [now, was] = me.lookup({ subj: "me", rel: "lives_in" });
  assert.equal(now.object, "Seattle");
  assert.equal(now.current, true);
  assert.ok(now.confidence >= 0.5, JSON.stringify(now));
  assert.equal(was.object, "Portland");
  assert.equal(was.current, false);
});

test("personal store: a lowercase car bought, the old one sold", async t => {
  const { me } = world(t, [
    S(["our green outback failed the inspection lol"], { start: T0 }),
    S(["just picked up the new car!! blue volvo xc40, bye bye outback"], { start: T0 + 10 * DAY }),
    S(["sold the subaru to a guy from denver today"], { start: T0 + 12 * DAY }),
    S(["parked the xc40 at the station"], { start: T0 + 20 * DAY }),
  ]);
  await all(me);
  assert.equal(me.entity("my car")?.id, "vehicle:Volvo XC40");
  const outback = me.lookup({ subj: "me", rel: "owns" }).find(f => f.object === "Subaru Outback");
  assert.equal(outback?.current, false);
  assert.equal(me.lookup({ subj: "vehicle:Volvo XC40", rel: "color" })[0]?.object, "blue");
});

test("personal store: a friend is their own person, and their things stay theirs", async t => {
  const { me } = world(t, [
    S(["my buddy kai just got a rivian r1s and won't stop talking about it"], { start: T0 }),
    S(["kai's wife mara had twins, buying baby stuff"], { start: T0 + DAY }),
    S(["my friend Sam lives in Denver."], { start: T0 + 2 * DAY }),
  ]);
  await all(me);
  const friends = me.lookup({ subj: "me", rel: "friend" });
  const kai = friends.find(f => f.object === "Kai");
  assert.equal(kai?.confidence, 0.9, "a lowercase friend's name, confirmed by 'kai's' in another turn");
  assert.ok(friends.some(f => f.object === "Sam"));
  assert.equal(me.entity("kai")?.id, "name:Kai");
  // Kai's car, and Sam's city, are not the user's.
  assert.ok(!me.lookup({ subj: "me", rel: "owns" }).length);
  assert.ok(!me.lookup({ subj: "me", rel: "lives_in" }).length);
  assert.equal(me.lookup({ subj: "sam", rel: "lives_in" })[0]?.object, "Denver");
  assert.ok(!me.lookup({ subj: "me", rel: "spouse" }).length, "Kai's wife is not the user's");
});

test("personal store: a relative's job and home, a pet's breed, and the user's diet", async t => {
  const { me } = world(t, [
    S(["my wife ren is a nurse", "my mom lives in tucson"], { start: T0 }),
    S(["walked pepper (our corgi) in the rain", "i'm vegetarian so skip the bacon"], { start: T0 + DAY }),
    S(["ma keeps phoning from tucson lol", "went vegan last month, going ok"], { start: T0 + 5 * DAY }),
  ]);
  await all(me);
  assert.equal(me.lookup({ subj: "my wife", rel: "role" })[0]?.object, "nurse");
  const mom = me.lookup({ subj: "my mom", rel: "lives_in" })[0];
  assert.equal(mom?.object, "Tucson");
  assert.ok(mom.confidence >= 0.5, JSON.stringify(mom));
  assert.ok(!me.lookup({ subj: "me", rel: "lives_in" }).length, "the mother's home is not the user's");
  assert.equal(me.lookup({ subj: "my dog", rel: "breed" })[0]?.object, "corgi");
  assert.equal(me.entity("pepper")?.id, "kin:dog");
  // Diet changes over a life: the newest wins.
  const [diet] = me.lookup({ subj: "me", rel: "diet" });
  assert.equal(diet?.object, "vegan");
  assert.equal(diet?.current, true);
});

test("personal store: a correction said in chat wins its slot; the old value is history, and plain talk corrects nothing", async t => {
  const { db, me } = world(t, [
    S(["biscuit (my beagle) needs the vet on friday.", "Biscuit is my beagle, he snores."], { start: T0 }),
    S(["I drive a Honda Jazz to the office."], { start: T0 + DAY }),
    S(["no, biscuit's a corgi not a beagle, fix the notes."], { start: T0 + 10 * DAY }),
    S(["actually I drive a Kia Niro, not the Jazz."], { start: T0 + 11 * DAY }),
    S(["our cat is a siamese.", "actually it's a ragdoll"], { start: T0 + 12 * DAY }),
    S(["I live in Denver, not far from Boulder."], { start: T0 + 13 * DAY }),
  ]);
  await all(me);
  const breed = me.lookup({ subj: "Biscuit", rel: "breed" });
  const now = breed.find(f => f.current), was = breed.find(f => !f.current);
  assert.equal(now?.object, "corgi");
  assert.equal(was?.object, "beagle", "the old value is kept, as history");
  assert.ok(Number(now?.confidence) >= 0.5, String(now?.confidence));
  assert.equal(me.lookup({ subj: "me", rel: "drives" }).find(f => f.current)?.object, "Kia Niro");
  assert.equal(me.lookup({ subj: "kin:cat", rel: "breed" }).find(f => f.current)?.object, "ragdoll");
  // "not far from" names no rival value: a plain statement, not a correction.
  const kinds = db.prepare("SELECT rel, obj, method FROM memory_me_claims WHERE obj = 'place:Denver'").all();
  assert.deepEqual(kinds.map(r => String(r.method)), ["rule"]);
});
