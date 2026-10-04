// @ts-check
// The reader over a store, with a fake runner: no model is ever called.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../../store/index.js";
import { seedRecall } from "../../../test/fixtures/corpus.js";
import { tempHome } from "../../../test/helpers.js";
import { Personal } from "./store.js";
import { createReader, checkRead, ownOf, signal, turnHash, readerPrompt, parseReads, modelFor, SYSTEM, READER, VERIFY, claudeOnce, modelEnv } from "./reader.js";
import fs from "node:fs";

const T0 = Date.parse("2026-09-01T09:00:00Z");
const DAY = 86_400_000;

/**
 * A store seeded with sessions (one user turn each, then an assistant line), a fake runner that
 * answers from `answers` (text -> facts) and a clock.
 * @param {any} t @param {{ turns: string[], config?: any, threads?: any[], usd?: number, answers?: Record<string, any[]>, runner?: any, capped?: () => boolean }} o
 */
async function world(t, { turns, config = {}, threads = [], usd = 0.002, answers = {}, runner, capped } = /** @type {any} */ ({})) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, turns.map((x, i) => ({ id: `s-${i}`, cwd: "/home/alex/work", start: T0 + i * DAY, turns: [{ role: "user", text: x }, { role: "assistant", text: "Done." }] })));
  const personal = new Personal(db);
  const sent = [];
  const clock = { t: T0 + 100 * DAY };
  const fake = async r => {
    // The second look agrees with everything here.
    if (r.system === VERIFY) return { text: JSON.stringify({ v: r.prompt.split("<item ").slice(1).map(() => true) }), usd: 0 };
    sent.push(r);
    const blocks = r.prompt.replace(/^<known>[^\n]*<\/known>\n\n/, "").split(/\n\n(?=<turn )/);
    const reads = blocks.map((b, i) => ({ t: i, facts: Object.entries(answers).filter(([k]) => b.includes(k)).flatMap(([, f]) => f) })).filter(x => x.facts.length);
    return { text: JSON.stringify({ reads }), usd, tokens_in: 1000, tokens_out: 50 };
  };
  const recorded = [];
  const call = async (tool, input) => { if (tool === "spend.record") recorded.push(input); return tool === "threads.list" ? { data: threads } : { error: { code: "no_such_tool" } }; };
  // One reading per batch unless a test says otherwise: the counts below are per reading.
  const cfg = { ...config, memory: { ...(config.memory || {}), model: { passes: 1, ...(config.memory?.model || {}) } } };
  const reader = createReader({ db, personal, now: () => clock.t, call, config: cfg, runner: runner === undefined ? fake : runner, ...(capped ? { capped } : {}) });
  t.after(() => reader.stop());
  await personal.pass({});
  personal.derive();
  return { db, personal, reader, sent, recorded, clock, fact: (subj, rel) => personal.lookup({ subj, rel }).filter(f => f.current).map(f => f.object) };
}

test("reader: which turns are sent", () => {
  for (const x of ["my wife dani just got off three night shifts, shes a nurse", "walked biscuit (our beagle) in the rain again", "tableplus is open on my other monitor",
    "sold the outback today, kinda sad", "im in portland not seattle lol", "been vegetarian like 10 years and the options near here suck", "ma is flying in from tucson to see the new place",
    "wife's bday is the 14th, any gift ideas"]) assert.equal(signal(x), 2, x);
  // Everything else of a few words is read too, after the personal turns, and only its start.
  for (const x of ["fix the failing test in src/cart/total.ts", "Run the tests again, the snapshot looks flaky."]) assert.equal(signal(x), 1, x);
  assert.equal(signal("priya asked if the bakery app is slow", new Set(["priya"])), 2, "a name memory knows");
  for (const x of ["commit that", "", "ok", "```js\nconst my = wife;\n```"]) assert.equal(signal(x), 0, x);
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
  // A role the turn does not say, in a turn about family: the model saw the batch, so it stands, lower.
  assert.equal(checkRead({ subj: "kin:mother", rel: "role", obj: "lit:nurse", q: "shes a nurse", conf: 0.9 }, own).claims?.[0].conf, 0.6);
  assert.equal(checkRead({ subj: "kin:mother", rel: "role", obj: "lit:nurse", q: "fix the build", conf: 0.9 }, ownOf("fix the build before lunch")).error, "subject not in the turn", "no family in the turn");
  assert.equal(checkRead({ subj: "kin:mother", rel: "role", obj: "lit:nurse", q: "the nurse app", conf: 0.9 }, ownOf("the nurse app needs a login page")).error, "subject not in the turn");
  assert.equal(checkRead({ subj: "kin:spouse", rel: "role", obj: "lit:worked a double", q: "worked a double", conf: 0.9 }, ownOf("the wife worked a double")).error, "not an occupation");
  assert.equal(checkRead({ subj: "kin:spouse", rel: "birthday", obj: "lit:14th", q: "bday is the 14th", conf: 0.9 }, ownOf("wife's bday is the 14th")).error, "no month");
  assert.equal(ok({ subj: "me", rel: "role", obj: "lit:nurse", q: "shes a nurse", conf: 0.3 }), "too unsure");
  assert.equal(ok({ subj: "me", rel: "shoe_size", obj: "lit:x", q: "shes a nurse" }), "unknown relation");
  const car = ownOf("BOUGHT THE TRUCK. blue ford maverick hybrid. and sold the outback to a kid");
  const c = f => checkRead(f, car).claims?.map(x => `${x.subj}|${x.rel}|${x.obj}`) || checkRead(f, car).error;
  assert.deepEqual(c({ subj: "me", rel: "owns", obj: "vehicle:Ford Maverick Hybrid", q: "blue ford maverick hybrid", conf: 0.9 }), ["me|owns|vehicle:Ford Maverick"]);
  assert.deepEqual(c({ subj: "vehicle:ford maverick", rel: "color", obj: "lit:Blue", q: "blue ford maverick", conf: 0.9 }), ["vehicle:Ford Maverick|color|lit:blue"]);
  assert.deepEqual(c({ subj: "me", rel: "sold", obj: "vehicle:outback", q: "sold the outback", conf: 0.9 }), ["me|ended:owns|vehicle:Subaru Outback"]);
  const move = ownOf("boxes everywhere, the move from portland is friday. i grew up in denver");
  assert.equal(checkRead({ subj: "me", rel: "from", obj: "place:Portland", q: "the move from portland", conf: 0.9 }, move).error, "not where they are from");
  assert.deepEqual(checkRead({ subj: "me", rel: "from", obj: "place:denver", q: "i grew up in denver", conf: 0.9 }, move).claims?.map(x => x.obj), ["place:Denver"]);
  const demo = ownOf("make a seed persona sofia who is married to diego and has one dog named rocket");
  assert.equal(checkRead({ subj: "me", rel: "spouse", obj: "name:Diego", q: "married to diego", conf: 0.9 }, demo).error, "made-up text");
  const hypo = ownOf("if we ever have a second kid we'd need a bigger place. my daughter luna is 4");
  assert.equal(checkRead({ subj: "me", rel: "child", obj: "kin:child", q: "have a second kid", conf: 0.9 }, hypo).error, "not real");
  assert.deepEqual(checkRead({ subj: "me", rel: "daughter", obj: "name:Luna", q: "my daughter luna", conf: 0.9 }, hypo).claims?.length, 2, "the next sentence is real");
  // A person memory knows, named in the turn, says their role: "dani's bday" is the wife's.
  const people = new Map([["dani", "spouse"], ["luna", "daughter"]]);
  const bday = ownOf("dani's bday is march 14, remind me", people);
  assert.deepEqual(checkRead({ subj: "kin:spouse", rel: "birthday", obj: "lit:14 March", q: "dani's bday is march 14", conf: 0.9 }, bday).claims?.map(x => `${x.subj}|${x.obj}@${x.conf}`), ["kin:spouse|lit:14 March@0.8", "me|kin:spouse@0.8"]);
  assert.equal(checkRead({ subj: "kin:son", rel: "age", obj: "lit:4", q: "luna just turned 4", conf: 0.9 }, ownOf("luna just turned 4", people)).claims?.[0].conf, 0.8, "a daughter's name says a child");
  assert.match(readerPrompt([{ text: "my wife is on nights again" }], people), /^<known>people the user has mentioned before: Dani \(spouse\), Luna \(daughter\)<\/known>/);
  const van = ownOf("theo's van is a white ford transit, he drives it everywhere. my truck is blue");
  assert.equal(checkRead({ subj: "me", rel: "owns", obj: "vehicle:Ford Transit", q: "theo's van is a white ford transit", conf: 0.9 }, van).error, "not the user's vehicle");
  assert.equal(checkRead({ subj: "me", rel: "drives", obj: "vehicle:Ford Transit", q: "he drives it everywhere", conf: 0.9 }, van).error, "not the user's vehicle");
  // Who someone is needs the second look: a no drops it, no look at all keeps it only as a maybe.
  const wife = ownOf("my wife dani is on nights");
  assert.equal(checkRead({ subj: "me", rel: "spouse", obj: "name:Dani", q: "my wife dani", conf: 0.9, verified: false }, wife).error, "the second look said no");
  assert.equal(checkRead({ subj: "me", rel: "spouse", obj: "name:Dani", q: "my wife dani", conf: 0.9 }, wife).claims?.[0].conf, 0.45);
  assert.equal(checkRead({ subj: "me", rel: "spouse", obj: "name:Dani", q: "my wife dani", conf: 0.9, verified: true }, wife).claims?.[0].conf, 0.8);
  // Someone else's family, kept as theirs.
  assert.deepEqual(checkRead({ subj: "name:rhodri", rel: "spouse", obj: "name:seren", q: "his wife seren", conf: 0.9, verified: true }, ownOf("rhodri needs a page, his wife seren does the admin")).claims,
    [{ subj: "name:Rhodri", rel: "spouse", obj: "name:Seren", conf: 0.8 }]);
  const theirs = ownOf("theo's kids sam and mia are coming over, my kid luna is thrilled");
  assert.equal(checkRead({ subj: "kin:child", rel: "name", obj: "lit:Sam", q: "theo's kids sam and mia", conf: 0.9 }, theirs).error, "someone else's family");
  assert.equal(checkRead({ subj: "kin:child", rel: "name", obj: "lit:Luna", q: "my kid luna", conf: 0.9 }, theirs).claims?.[0].obj, "lit:Luna");
  const pet = ownOf("walked biscuit (our beagle) in the rain");
  assert.deepEqual(checkRead({ subj: "name:biscuit", rel: "breed", obj: "lit:Beagle", q: "biscuit (our beagle)", conf: 0.9 }, pet).claims?.map(x => x.obj), ["lit:beagle"]);
  assert.equal(checkRead({ subj: "me", rel: "breed", obj: "lit:beagle", q: "our beagle", conf: 0.9 }, pet).error, "a breed is a pet's");
});

test("reader: reads land as model claims, once per text, and survive a full re-read", async t => {
  const w = await world(t, {
    turns: ["my wife dani just got off nights, shes a nurse", "fix the flaky snapshot test", "my wife dani just got off nights, shes a nurse"],
    answers: { "shes a nurse": [{ subj: "kin:spouse", rel: "role", obj: "lit:nurse", q: "shes a nurse", conf: 0.9 }, { subj: "me", rel: "spouse", obj: "name:Dani", q: "my wife dani", conf: 0.9 }] },
  });
  assert.equal(w.reader.status().waiting_turns, 2, "three turns, two texts");
  const r = await w.reader.drain();
  assert.equal(r.runs, 1); assert.equal(r.read, 2);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].model, "haiku");
  assert.ok(w.sent[0].prompt.indexOf("shes a nurse") < w.sent[0].prompt.indexOf("flaky snapshot"), "the personal turn goes first");
  assert.deepEqual(w.fact("kin:spouse", "role"), ["nurse"]);
  assert.deepEqual(w.fact("kin:spouse", "name"), ["Dani"]);
  const m = /** @type {any} */ (w.db.prepare("SELECT COUNT(*) n FROM memory_me_claims WHERE rel = 'role' AND method = 'model'").get());
  assert.equal(m.n, 2, "both sessions carry the model's claim");
  // A full re-read keeps the model's claims and never asks again.
  await w.personal.pass({ full: true });
  w.reader.applyKept(); w.personal.derive();
  assert.deepEqual(w.fact("kin:spouse", "role"), ["nurse"]);
  assert.equal((await w.reader.drain()).runs, 0);
  assert.equal(w.sent.length, 1);
  const s = w.reader.status();
  assert.equal(s.read_turns, 2);
  assert.equal(s.usd_per_1000_turns, 1);
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
  assert.equal(w.reader.status().today_usd, 0.004, "a drain tries a bad answer three more times, and each try is charged");
  const x = await world(t, { turns: ["my dog is a corgi"], runner: async () => { throw new Error("offline"); } });
  assert.equal((await x.reader.drain()).waiting, "the model failed");
  assert.equal(x.reader.status().last?.status, "failed");
});

test("reader: repeated failures back off, so a broken model isn't paid for on every turn", async t => {
  let calls = 0;
  const w = await world(t, { turns: ["my dog is a corgi"], config: { memory: { model: { batch: 1 } } },
    runner: async () => { calls++; throw new Error("offline"); } });
  assert.equal((await w.reader.pump()).waiting, "the model failed");
  w.clock.t += 61_000;
  assert.equal((await w.reader.pump()).waiting, "the model failed");
  w.clock.t += 61_000;
  assert.equal((await w.reader.pump()).waiting, "the model failed");
  assert.equal(calls, 3, "three tries, each its own charge-eligible run");
  // A fourth attempt, even after the usual minute apart, backs off instead of paying to fail again.
  w.clock.t += 61_000;
  assert.equal((await w.reader.pump()).waiting, "backing off after repeated failures");
  assert.equal(calls, 3, "no model call while backing off");
  w.clock.t += 2 * 60_000;
  assert.equal((await w.reader.pump()).waiting, "backing off after repeated failures", "still inside the 5-minute wait");
  assert.equal(calls, 3);
  // Once the wait since the last failure has passed, it tries again (and a success resets the streak).
  w.clock.t += 2 * 60_000;
  assert.equal((await w.reader.pump()).waiting, "the model failed");
  assert.equal(calls, 4);
});

test("reader: two readings of a batch keep the union of what they found", async t => {
  let n = 0;
  const runner = async r => {
    if (r.system === VERIFY) return { text: JSON.stringify({ v: r.prompt.split("<item ").slice(1).map(() => true) }), usd: 0 };
    n++;
    const f = n === 1 ? { subj: "kin:dog", rel: "breed", obj: "lit:corgi", q: "my dog is a corgi", conf: 0.9 } : { subj: "me", rel: "pet", obj: "kin:dog", q: "my dog", conf: 0.9 };
    return { text: JSON.stringify({ reads: [{ t: 0, facts: [f] }] }), usd: 0.001 };
  };
  const w = await world(t, { turns: ["my dog is a corgi"], runner, config: { memory: { model: { passes: 2 } } } });
  await w.reader.drain();
  assert.equal(n, 2);
  assert.deepEqual(w.fact("kin:dog", "breed"), ["corgi"]);
  assert.equal(w.reader.status().today_usd, 0.002, "both readings are charged");
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

test("reader: model calls run on the Claude login, never API dollars, unless billing is api", async t => {
  const env = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-fixture", ANTHROPIC_AUTH_TOKEN: "tok-fixture", HOME: "/tmp/x" };
  const plan = modelEnv(env, undefined);
  assert.equal(plan.ANTHROPIC_API_KEY, undefined);
  assert.equal(plan.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(plan.HOME, "/tmp/x");
  assert.equal(plan.MAX_THINKING_TOKENS, "0");
  assert.equal(modelEnv(env, "plan").ANTHROPIC_API_KEY, undefined);
  assert.equal(modelEnv(env, "api").ANTHROPIC_API_KEY, "sk-fixture");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-fixture", "the caller's environment is not changed");
  // Through claudeOnce: a fake claude reports whether it saw a key.
  const dir = tempHome(t), bin = path.join(dir, "fake-claude");
  fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ result: process.env.ANTHROPIC_API_KEY ? "key" : "login", total_cost_usd: 0 })));\n`, { mode: 0o755 });
  const ask = billing => claudeOnce({ bin, cwd: dir, env: { ...process.env, ANTHROPIC_API_KEY: "sk-fixture" }, billing: () => billing })({ system: "s", prompt: "p", model: "haiku", maxUsd: 0.01 });
  assert.equal((await ask(undefined)).text, "login");
  assert.equal((await ask("api")).text, "key");
});

test("reader: the person's plan share sets the daily cap; an explicit figure in config still wins", async t => {
  const cap = async config => (await world(t, { turns: ["hi"], config })).reader.status().cap_usd;
  assert.equal(await cap({}), READER.dailyUsd, "medium by default");
  assert.equal(await cap({ memory: { model: { share: "small" } } }), 0.1);
  assert.equal(await cap({ memory: { model: { share: "large" } } }), 1);
  assert.equal(await cap({ memory: { model: { share: "large", dailyUsd: 0.3 } } }), 0.3);
});

test("reader: its dollars go to the one ledger, and it waits while the provider's cap is reached", async t => {
  let capped = false;
  const w = await world(t, { turns: ["my wife dani just got off nights, shes a nurse"], usd: 0.003, capped: () => capped,
    answers: { "shes a nurse": [{ subj: "kin:spouse", rel: "role", obj: "lit:nurse", q: "shes a nurse", conf: 0.9 }] } });
  capped = true;
  const held = await w.reader.drain();
  assert.equal(held.runs, 0, "no model run at the cap");
  assert.equal(w.sent.length, 0);
  capped = false;
  const r = await w.reader.drain();
  assert.equal(r.runs, 1);
  assert.ok(w.recorded.length >= 1);
  assert.deepEqual([w.recorded[0].provider, w.recorded[0].purpose, w.recorded[0].usd], ["claude", "memory.read", 0.003]);
});

test("reader: a model binary that exits before reading its prompt fails that read cleanly, and never crashes the process (EPIPE)", async t => {
  const dir = tempHome(t), bin = path.join(dir, "dead-claude");
  // Says why it cannot run and exits at once, without touching its stdin: the prompt write meets a closed pipe.
  fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.stderr.write("not logged in: run claude login\\n"); process.exit(1);\n`, { mode: 0o755 });
  let crashed = null;
  const onCrash = e => { crashed = e; };
  process.on("uncaughtException", onCrash);
  t.after(() => process.off("uncaughtException", onCrash));
  const big = "x".repeat(4 * 1024 * 1024);
  const run = claudeOnce({ bin, cwd: dir, env: { ...process.env } });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(run({ system: "s", prompt: big, model: "haiku", maxUsd: 0.01 }), e => /not logged in/.test(e.message), "the binary's own words are the failure");
  }
  await new Promise(r => setTimeout(r, 200));
  assert.equal(crashed, null, crashed ? String(crashed.code || crashed.message) : "");
  // A binary that says nothing still fails the read, naming the closed input.
  const mute = path.join(dir, "mute-claude");
  fs.writeFileSync(mute, `#!/usr/bin/env node\nprocess.exit(2);\n`, { mode: 0o755 });
  await assert.rejects(claudeOnce({ bin: mute, cwd: dir, env: { ...process.env } })({ system: "s", prompt: big, model: "haiku", maxUsd: 0.01 }), e => /exit 2/.test(e.message));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(crashed, null);
});
