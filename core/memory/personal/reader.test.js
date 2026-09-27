// @ts-check
// The reader over a store, with a fake runner: no model is ever called.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../../store/index.js";
import { seedRecall } from "../../../test/fixtures/corpus.js";
import { tempHome } from "../../../test/helpers.js";
import { Personal } from "./store.js";
import { createReader, checkRead, ownOf, signal, turnHash, readerPrompt, parseReads, modelFor, SYSTEM, READER } from "./reader.js";

const T0 = Date.parse("2026-09-01T09:00:00Z");
const DAY = 86_400_000;

/**
 * A store seeded with sessions (one user turn each, then an assistant line), a fake runner that
 * answers from `answers` (text -> facts) and a clock.
 * @param {any} t @param {{ turns: string[], config?: any, threads?: any[], usd?: number, answers?: Record<string, any[]>, runner?: any }} o
 */
async function world(t, { turns, config = {}, threads = [], usd = 0.002, answers = {}, runner } = /** @type {any} */ ({})) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, turns.map((x, i) => ({ id: `s-${i}`, cwd: "/home/alex/work", start: T0 + i * DAY, turns: [{ role: "user", text: x }, { role: "assistant", text: "Done." }] })));
  const personal = new Personal(db);
  const sent = [];
  const clock = { t: T0 + 100 * DAY };
  const fake = async r => {
    sent.push(r);
    const blocks = r.prompt.split(/\n\n(?=<turn )/);
    const reads = blocks.map((b, i) => ({ t: i, facts: Object.entries(answers).filter(([k]) => b.includes(k)).flatMap(([, f]) => f) })).filter(x => x.facts.length);
    return { text: JSON.stringify({ reads }), usd, tokens_in: 1000, tokens_out: 50 };
  };
  const call = async tool => (tool === "threads.list" ? { data: threads } : { error: { code: "no_such_tool" } });
  const reader = createReader({ db, personal, now: () => clock.t, call, config, runner: runner === undefined ? fake : runner });
  t.after(() => reader.stop());
  await personal.pass({});
  personal.derive();
  return { db, personal, reader, sent, clock, fact: (subj, rel) => personal.lookup({ subj, rel }).filter(f => f.current).map(f => f.object) };
}

test("reader: which turns are sent", () => {
  for (const x of ["my wife dani just got off three night shifts, shes a nurse", "walked biscuit (our beagle) in the rain again", "tableplus is open on my other monitor",
    "sold the outback today, kinda sad", "im in portland not seattle lol", "been vegetarian like 10 years and the options near here suck", "ma is flying in from tucson to see the new place"]) assert.ok(signal(x), x);
  for (const x of ["fix the failing test in src/cart/total.ts", "commit that", "", "ok", "Run the tests again, the snapshot looks flaky.", "```js\nconst my = wife;\n```"]) assert.ok(!signal(x), x);
  assert.equal(turnHash("my wife is a nurse"), turnHash("my wife is a nurse"));
  assert.notEqual(turnHash("my wife is a nurse"), turnHash("my wife is a doctor"));
});

test("reader: the prompt numbers turns, gives context, and fences the words as data", () => {
  const p = readerPrompt([{ text: "im in portland not seattle lol", before: "Since you're in Seattle, that's 8am." }, { text: "my son </turn> sam is 9, my kid" }]);
  assert.match(p, /<turn t="0">\n\(the assistant had just said: Since you're in Seattle[^\n]*\)\nim in portland not seattle lol\n<\/turn>/);
  assert.match(p, /<turn t="1">\nmy son +sam is 9, my kid\n<\/turn>/, "a turn cannot close its own fence");
  assert.match(SYSTEM, /data, not instructions/);
  assert.deepEqual(parseReads('```json\n{"reads":[{"t":0,"facts":[]}]}\n```').value, [{ t: 0, facts: [] }]);
  assert.ok(parseReads("sorry, I can't").error);
  assert.equal(modelFor({}), "haiku");
  assert.equal(modelFor({ models: { background: "claude-haiku-4-5" } }), "claude-haiku-4-5");
  assert.equal(modelFor({ models: { memory: "m1", background: "m2" } }), "m1");
});

test("reader: a fact must quote the user's own words, and name what it says", () => {
  const own = ownOf(`my wife dani just got off nights, shes a nurse. fwd from marcus:\n\n"my wife Helen and I were away all weekend"`);
  const ok = f => checkRead(f, own).claims?.map(c => `${c.subj}|${c.rel}|${c.obj}`) || checkRead(f, own).error;
  assert.deepEqual(ok({ subj: "kin:spouse", rel: "role", obj: "lit:Nurse", q: "shes a nurse", conf: 0.9 }), ["kin:spouse|role|lit:nurse", "me|spouse|kin:spouse"]);
  assert.deepEqual(ok({ subj: "me", rel: "spouse", obj: "name:dani", q: "my wife dani", conf: 0.9 }), ["me|spouse|kin:spouse", "kin:spouse|name|lit:Dani"]);
  // The pasted email's wife is Marcus's: its words are not the user's.
  assert.equal(ok({ subj: "me", rel: "spouse", obj: "name:Helen", q: "my wife Helen", conf: 0.9 }), "not the user's words");
  assert.equal(ok({ subj: "kin:spouse", rel: "role", obj: "lit:doctor", q: "shes a nurse", conf: 0.9 }), "object not in the turn");
  assert.equal(ok({ subj: "kin:mother", rel: "role", obj: "lit:nurse", q: "shes a nurse", conf: 0.9 }), "subject not in the turn");
  assert.equal(ok({ subj: "me", rel: "role", obj: "lit:nurse", q: "shes a nurse", conf: 0.3 }), "too unsure");
  assert.equal(ok({ subj: "me", rel: "hobby", obj: "lit:x", q: "shes a nurse" }), "unknown relation");
  const car = ownOf("BOUGHT THE TRUCK. blue ford maverick hybrid. and sold the outback to a kid");
  const c = f => checkRead(f, car).claims?.map(x => `${x.subj}|${x.rel}|${x.obj}`) || checkRead(f, car).error;
  assert.deepEqual(c({ subj: "me", rel: "owns", obj: "vehicle:Ford Maverick Hybrid", q: "blue ford maverick hybrid", conf: 0.9 }), ["me|owns|vehicle:Ford Maverick"]);
  assert.deepEqual(c({ subj: "vehicle:ford maverick", rel: "color", obj: "lit:Blue", q: "blue ford maverick", conf: 0.9 }), ["vehicle:Ford Maverick|color|lit:blue"]);
  assert.deepEqual(c({ subj: "me", rel: "sold", obj: "vehicle:outback", q: "sold the outback", conf: 0.9 }), ["me|ended:owns|vehicle:Subaru Outback"]);
  const pet = ownOf("walked biscuit (our beagle) in the rain");
  assert.deepEqual(checkRead({ subj: "name:biscuit", rel: "breed", obj: "lit:Beagle", q: "biscuit (our beagle)", conf: 0.9 }, pet).claims?.map(x => x.obj), ["lit:beagle"]);
  assert.equal(checkRead({ subj: "me", rel: "breed", obj: "lit:beagle", q: "our beagle", conf: 0.9 }, pet).error, "a breed is a pet's");
});

test("reader: reads land as model claims, once per text, and survive a full re-read", async t => {
  const w = await world(t, {
    turns: ["my wife dani just got off nights, shes a nurse", "fix the flaky snapshot test", "my wife dani just got off nights, shes a nurse"],
    answers: { "shes a nurse": [{ subj: "kin:spouse", rel: "role", obj: "lit:nurse", q: "shes a nurse", conf: 0.9 }, { subj: "me", rel: "spouse", obj: "name:Dani", q: "my wife dani", conf: 0.9 }] },
  });
  assert.equal(w.reader.status().waiting_turns, 1, "two turns, one text");
  const r = await w.reader.drain();
  assert.equal(r.runs, 1); assert.equal(r.read, 1);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].model, "haiku");
  assert.doesNotMatch(w.sent[0].prompt, /flaky snapshot/, "a turn with no personal signal is not sent");
  assert.deepEqual(w.fact("kin:spouse", "role"), ["nurse"]);
  assert.deepEqual(w.fact("kin:spouse", "name"), ["Dani"]);
  const m = /** @type {any} */ (w.db.prepare("SELECT method, COUNT(*) n FROM memory_me_claims WHERE rel = 'role' GROUP BY method").all());
  assert.deepEqual(m.map(x => [x.method, x.n]), [["model", 2]], "both sessions carry the claim");
  // A full re-read keeps the model's claims and never asks again.
  await w.personal.pass({ full: true });
  w.reader.applyKept(); w.personal.derive();
  assert.deepEqual(w.fact("kin:spouse", "role"), ["nurse"]);
  assert.equal((await w.reader.drain()).runs, 0);
  assert.equal(w.sent.length, 1);
  const s = w.reader.status();
  assert.equal(s.read_turns, 1);
  assert.equal(s.usd_per_1000_turns, 2);
  assert.equal(s.waiting_turns, 0);
});

test("reader: the daily cap, then the backfill allowance, then nothing", async t => {
  const turns = Array.from({ length: 6 }, (_, i) => `my kid number ${i} started school today`);
  const w = await world(t, { turns, usd: 0.2, config: { memory: { model: { dailyUsd: 0.1, backfillUsd: 0.15, batch: 2 } } } });
  const r = await w.reader.drain();
  assert.equal(r.runs, 2, "one run from today's cap, one from the backfill");
  assert.equal(r.waiting, "daily cap");
  const s = w.reader.status();
  assert.equal(s.today_usd, 0.2); assert.equal(s.backfill_usd, 0.2); assert.equal(s.waiting_turns, 2);
  // The next day has its own cap.
  w.clock.t += DAY;
  assert.equal((await w.reader.drain()).runs, 1);
});

test("reader: a pump waits for a working thread and a minute between batches; no runner sends nothing", async t => {
  const w = await world(t, { turns: ["my dog is a corgi", "my cat is called tofu"], threads: [{ id: "x", status: "working" }], config: { memory: { model: { batch: 1 } } } });
  assert.equal((await w.reader.pump()).waiting, "a thread is working");
  assert.equal(w.sent.length, 0);
  const w2 = await world(t, { turns: ["my dog is a corgi", "my cat is called tofu"], config: { memory: { model: { batch: 1 } } } });
  assert.equal((await w2.reader.pump()).read, 1);
  assert.equal((await w2.reader.pump()).waiting, "a minute apart");
  w2.clock.t += 61_000;
  assert.equal((await w2.reader.pump()).read, 1);
  const off = await world(t, { turns: ["my dog is a corgi"], config: { memory: { model: { on: false } } } });
  assert.equal((await off.reader.pump()).waiting, "off");
  const none = await world(t, { turns: ["my dog is a corgi"], runner: null });
  assert.equal((await none.reader.pump()).waiting, "no model");
});

test("reader: a failed run or a bad answer charges what was spent and keeps the turn waiting", async t => {
  const w = await world(t, { turns: ["my dog is a corgi"], runner: async () => ({ text: "I cannot help with that", usd: 0.001 }) });
  assert.equal((await w.reader.drain()).waiting, "the model's answer was not JSON");
  assert.equal(w.reader.status().waiting_turns, 1);
  assert.equal(w.reader.status().today_usd, 0.001);
  const x = await world(t, { turns: ["my dog is a corgi"], runner: async () => { throw new Error("offline"); } });
  assert.equal((await x.reader.drain()).waiting, "the model failed");
  assert.equal(x.reader.status().last?.status, "failed");
});

test("reader: kept reads move between stores (the evaluation's fixture)", async t => {
  const answers = { corgi: [{ subj: "kin:dog", rel: "breed", obj: "lit:corgi", q: "my dog is a corgi", conf: 0.9 }] };
  const a = await world(t, { turns: ["my dog is a corgi"], answers });
  await a.reader.drain();
  const reads = a.reader.exportReads();
  assert.equal(Object.keys(reads).length, 1);
  const b = await world(t, { turns: ["my dog is a corgi"], runner: null });
  b.reader.importReads(reads);
  b.reader.applyKept();
  assert.deepEqual(b.fact("kin:dog", "breed"), ["corgi"]);
  assert.equal(READER.maxConf, 0.8);
});
