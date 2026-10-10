// @ts-check
// The inference door against invariants 5 and 6: models see placeholders, a prompt holding a value the session resolved is refused (every
// disguise in the canary corpus), a reply or tool result that echoes one is refused, and only declared sinks reach the door.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startSealer } from "../seal/client.js";
import { createDoor, DoorRefusal } from "./door.js";
import { compact } from "../seal/normalise.js";
import { chain, person, withAgent, signer, tmp, property, randomSsn, luhnCard, enrolDevice } from "../seal/testing.js";

const REC = "vyre://spc_testspace0001/contact/c_jane";
async function world(t, over = {}) {
  const dir = tmp("door"), sealer = startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true }), alex = signer("per_alex"), events = [], seen = [];
  t.after(async () => { await sealer.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await enrolDevice(sealer, alex);
  const driver = { call: async i => { seen.push(i); return { content: over.reply ?? "ok", usage: { input_tokens: 1, output_tokens: 1 } }; } };
  const door = createDoor({ sealer, drivers: { fake: driver }, sinks: ["summaries"], emit: (type, p) => events.push({ type, p }), ...over.door });
  const call = (messages, extra = {}) => door.call({ chain: person(), purpose: "session", provider: "fake", model: "m", messages, ...extra });
  const reveal = async (value, session, cls = "us-ssn") => {
    const { ref } = await sealer.api.put({ chain: person(), record: REC, field: "f", class: cls, value });
    const ch = person(), fields = { ref: ref.ref, purpose: "read" };
    const r = await sealer.api.reveal({ chain: ch, ref: ref.ref, purpose: "read", proof: alex.proof(ch, "seal.reveal", fields), ledger_key: door.ledgerKey(person(), session) });
    door.note(person(), session, r.ledger);
  };
  return { door, call, seen, events, sealer, reveal, alex, driver };
}
const refusal = p => p.then(() => null, e => (e instanceof DoorRefusal ? e.refusal : e));

test("a prompt with a sealed-looking value reaches the model as a placeholder, in every message and in the reply", async t => {
  const w = await world(t, { reply: "I will use card 4111 1111 1111 1111 on file" });
  const out = await w.call([{ role: "system", content: "You help Harlow Legal." }, { role: "user", content: "Her SSN is 123-45-6789, call 415-555-0100." }, { role: "assistant", content: "Noted: 123 45 6789." }], { session: "s1" });
  assert.deepEqual(w.seen[0].messages.map(m => m.content), ["You help Harlow Legal.", "Her SSN is [sealed: US SSN #1], call 415-555-0100.", "Noted: [sealed: US SSN #1]."]);
  assert.equal(out.content, "I will use card [sealed: card number #1] on file");
  assert.ok(!JSON.stringify(w.seen).includes("6789") && !JSON.stringify(w.events).includes("6789"));
  assert.ok(w.events.some(e => e.type === "model.sanitized" && e.p.found[0].class === "us-ssn"));
});

test("a value the session revealed is refused at the door in any disguise, and the model is never called", async t => {
  const w = await world(t);
  await w.reveal("Ab-4471-Zk9", "s2", "passport"); // a free-shape class: the ledger is the only guard here
  for (const text of ["ab4471zk9", "AB 4471 ZK9", Buffer.from("Ab-4471-Zk9").toString("base64"), Buffer.from("Ab-4471-Zk9").toString("hex"), "a b 4 4 7 1 z k 9"]) {
    const r = await refusal(w.call([{ role: "user", content: `the passport is ${text}` }], { session: "s2" }));
    assert.deepEqual(r, { code: "ledger_hit", class: "passport" }, text);
  }
  assert.equal(w.seen.length, 0, "the driver was never reached");
  assert.ok(w.events.filter(e => e.type === "model.refused").length === 5 && !JSON.stringify(w.events).includes("4471"));
  // Another session has revealed nothing: the same words pass.
  assert.equal((await w.call([{ role: "user", content: "the passport is ab4471zk9" }], { session: "s-other" })).content, "ok");
});

test("a derived session inherits the ledger, the end of a session drops it", async t => {
  const w = await world(t);
  await w.reveal("Qq-5530-Rr1", "parent", "passport");
  assert.equal((await refusal(w.call([{ role: "user", content: "qq5530rr1" }], { session: "child", parent_session: "parent" }))).code, "ledger_hit");
  await w.door.endSession(person(), "parent");
  assert.equal((await w.call([{ role: "user", content: "qq5530rr1" }], { session: "fresh" })).content, "ok");
});

test("a tool result, a recalled memory or a reply that echoes a ledgered value is refused or sanitised before a model reads it", async t => {
  const w = await world(t, { reply: "the number is Qq-5530-Rr1" });
  await w.reveal("Qq-5530-Rr1", "s3", "passport");
  assert.equal((await refusal(w.door.result({ chain: person(), session: "s3", text: "site says: Qq5530Rr1 accepted" }))).code, "ledger_hit");
  assert.equal(await w.door.result({ chain: person(), session: "s3", text: "form 123-45-6789 filed" }), "form [sealed: US SSN #1] filed");
  assert.equal((await refusal(w.call([{ role: "user", content: "hi" }], { session: "s3" }))).code, "ledger_hit", "a reply holding the value is refused");
  assert.equal(await w.door.sanitize({ chain: person(), session: "s3", text: "persist 123-45-6789" }), "persist [sealed: US SSN #1]");
});

test("only declared sinks reach the door, and residency, budget and size are enforced before any scan", async t => {
  const w = await world(t, { door: { residency: ({ provider }) => (provider === "fake" ? null : "no"), budget: { reserve: i => (i.purpose === "embed" ? "ai_spend" : null) } } });
  const via = (kind, id) => ({ chain: chain([["person", "per_alex"], [kind, id]]), purpose: "summary", provider: "fake", model: "m", messages: [{ role: "user", content: "x" }] });
  assert.equal((await refusal(w.door.call(via("service", "notes")))).code, "not_a_sink");
  assert.equal((await w.door.call(via("service", "summaries"))).content, "ok");
  assert.equal((await w.door.call(via("agent", "intake"))).content, "ok");
  assert.deepEqual(await refusal(w.door.call({ ...via("agent", "x"), provider: "nowhere" })), { code: "residency", detail: "provider is not available" });
  assert.deepEqual(await refusal(w.call([{ role: "user", content: "x" }], { purpose: "embed" })), { code: "budget", meter: "ai_spend" });
  assert.equal((await refusal(w.call([{ role: "user", content: "x".repeat(2_100_000) }]))).code, "budget");
  assert.equal((await refusal(w.call([]))).code, "budget");
});

test("a ledgered prompt too large to scan is refused, not skipped", async t => {
  const w = await world(t);
  await w.reveal("Qq-5530-Rr1", "s4", "passport");
  const r = await refusal(w.call([{ role: "user", content: "word ".repeat(150_000) }], { session: "s4" }));
  assert.equal(r.code, "budget"); assert.equal(r.meter, "scan");
});

test("property: whatever the conversation, a model never receives a value the session revealed or one a detector can see", async t => {
  const w = await world(t);
  const WORDS = ["please", "review", "the", "file", "Harlow", "thanks", "4821"];
  const seeds = [];
  await (async () => {
    let n = 0;
    const runs = Number(process.env.RUNS) || 12;
    for (let i = 0; i < runs; i++) {
      const seed = (Number(process.env.SEED) || Date.now() % 1e9) + i; seeds.push(seed);
      const r = (await import("../seal/testing.js")).rng(seed), isCard = r.int(2) === 1;
      const v = isCard ? luhnCard(r) : randomSsn(r), session = `p${i}`;
      await w.reveal(isCard ? v.replace(/(\d{4})/g, "$1 ").trim() : `${v.slice(0, 3)}-${v.slice(3, 5)}-${v.slice(5)}`, session, isCard ? "card" : "us-ssn");
      const forms = [v, v.split("").join(" "), v.split("").join("-"), Buffer.from(v).toString("base64"), Buffer.from("x" + v).toString("base64"), Buffer.from(v).toString("hex"), encodeURIComponent(v.slice(0, 4) + " " + v.slice(4))];
      for (const f of forms) {
        const before = w.seen.length;
        const rf = await refusal(w.call([{ role: "user", content: `${Array.from({ length: r.int(8) }, () => r.pick(WORDS)).join(" ")} ${f} ${r.pick(WORDS)}` }], { session }));
        // Either the door refuses (the ledger), or a detector already swapped the value for a placeholder: never a pass with the value in it.
        if (rf) assert.equal(rf.code, "ledger_hit", `seed ${seed}`);
        else assert.ok(!compact(JSON.stringify(w.seen[w.seen.length - 1].messages)).includes(v.slice(0, 8)), `seed ${seed}: a driver got ${f}`);
        if (rf) assert.equal(w.seen.length, before);
        n++;
      }
    }
    assert.ok(n >= 12 * 7 || process.env.RUNS);
  })();
  assert.ok(!JSON.stringify(w.seen).match(/\d{9}/), "no nine-digit run reached a driver");
});

// ---- streaming ----
const streamDriver = (chunks, log = {}) => i => { log.input = i; return (async function* () { try { for (const c of chunks) { yield typeof c === "string" ? { text: c } : c; } yield { done: { usage: { input_tokens: 1, output_tokens: 1 } } }; } finally { log.closed = true; } })(); };
const run = async (w, chunks, log = {}, extra = {}) => { w.driver.stream = streamDriver(chunks, log); const out = []; for await (const e of w.door.stream({ chain: person(), purpose: "session", provider: "fake", model: "m", messages: [{ role: "user", content: "hi" }], ...extra })) out.push(e); return out; };
const texts = ev => ev.filter(e => e.type === "text").map(e => e.text).join("");

test("stream: clean text passes through whole, the first chunk at once when no number is near, and the same checks run on the request", async t => {
  const w = await world(t), words = "The consult is booked for Tuesday at the Harlow Legal office. ".split(" ").map(x => x + " ");
  const ev = await run(w, words); assert.equal(texts(ev), words.join("")); assert.equal(ev.at(-1).type, "done"); assert.equal(ev[0].text, words[0], "no holdback without a number");
  assert.equal(w.seen.length, 0, "call was never used");
  const bad = await refusal((async () => { for await (const _ of w.door.stream({ chain: person(), purpose: "session", provider: "nope", model: "m", messages: [{ role: "user", content: "x" }] })) { /* nothing */ } })());
  assert.equal(bad.code, "residency");
  const log = {}; await run(w, ["ok"], log, { messages: [{ role: "user", content: "SSN 123-45-6789" }] }); assert.equal(log.input.messages[0].content, "SSN [sealed: US SSN #1]", "the prompt is sanitised as in call");
});

test("stream: a sealed-looking value split across chunks is cut before any digit of it leaves, and the upstream is stopped", async t => {
  const w = await world(t), log = {};
  const ev = await run(w, ["Her number is 123", "-45", "-67", "89 and that is all."], log);
  assert.equal(ev.at(-1).type, "cut"); assert.equal(ev.at(-1).code, "sealed_shape"); assert.equal(ev.at(-1).class, "us-ssn");
  assert.ok(!/\d/.test(texts(ev)), "no digit of the value was released: " + texts(ev)); assert.equal(log.closed, true);
  assert.ok(w.events.some(e => e.type === "model.cut" && e.p.class === "us-ssn")); assert.ok(!JSON.stringify(w.events).includes("6789"));
  const words = await run(w, ["one two three four five six ", "seven eight nine"]); assert.equal(words.at(-1).type, "cut", "digit words too");
  const ok = await run(w, ["Call 415-555-0100 or see page 12 of the ", "file."]); assert.equal(ok.at(-1).type, "done"); assert.equal(texts(ok), "Call 415-555-0100 or see page 12 of the file.", "an ordinary number is released after the hold");
});

test("stream: a ledgered value split across chunks in any disguise is cut, with nothing of it released", async t => {
  const w = await world(t); await w.reveal("123-45-6789", "s1");
  for (const parts of [["The value is 1", "23456", "789 thanks"], ["see one two three, four five, six seven eight nine ok"], ["b64: ", Buffer.from("123456789").toString("base64").slice(0, 6), Buffer.from("123456789").toString("base64").slice(6), " end"]]) {
    const ev = await run(w, parts, {}, { session: "s1" }); assert.equal(ev.at(-1).type, "cut", JSON.stringify(parts)); assert.equal(ev.at(-1).code, "ledger_hit");
    assert.ok(!/6789|56789/.test(texts(ev)));
  }
  assert.equal((await run(w, ["nothing sensitive here, ", "just words."], {}, { session: "s1" })).at(-1).type, "done");
});

test("stream: a tool call is delivered only after its whole input is scanned, and one that carries a value is cut", async t => {
  const w = await world(t), log = {};
  const ok = await run(w, [{ tool_start: { id: "t1", name: "records.find" } }, { tool_delta: { id: "t1", json: '{"name":"Ja' } }, { tool_delta: { id: "t1", json: 'ne"}' } }, { tool_end: { id: "t1" } }]);
  assert.deepEqual(ok.find(e => e.type === "tool_call"), { type: "tool_call", id: "t1", name: "records.find", input: { name: "Jane" } });
  await w.reveal("123-45-6789", "s2");
  const bad = await run(w, [{ tool_start: { id: "t2", name: "email.send" } }, { tool_delta: { id: "t2", json: '{"body":"ssn 123 45 ' } }, { tool_delta: { id: "t2", json: '6789"}' } }, { tool_end: { id: "t2" } }], log, { session: "s2" });
  assert.equal(bad.find(e => e.type === "tool_call"), undefined); assert.equal(bad.at(-1).type, "cut"); assert.equal(log.closed, true);
});

test("stream: latency added per chunk is a few milliseconds and the first text is at once", async t => {
  const w = await world(t), chunks = Array.from({ length: 300 }, (_, i) => `word${i} `);
  const time = async (cs, extra = {}) => { w.driver.stream = streamDriver(cs); const t0 = performance.now(); let first = null, n = 0; for await (const e of w.door.stream({ chain: person(), purpose: "session", provider: "fake", model: "m", messages: [{ role: "user", content: "hi" }], ...extra })) if (e.type === "text") { first ??= performance.now() - t0; n++; } return { first, per: (performance.now() - t0) / cs.length, n }; };
  const plain = await time(chunks); await w.reveal("123-45-6789", "s3"); const ledgered = await time(chunks, { session: "s3" }); const numbers = await time(chunks.map((c, i) => (i % 5 === 0 ? `item ${i} costs ${i * 7} dollars ` : c)));
  console.log(`stream latency: no number ${plain.per.toFixed(2)} ms/chunk first ${plain.first.toFixed(1)} ms; ledger ${ledgered.per.toFixed(2)} ms/chunk first ${ledgered.first.toFixed(1)} ms; numbers ${numbers.per.toFixed(2)} ms/chunk first ${numbers.first.toFixed(1)} ms`);
  assert.ok(plain.first < 50 && plain.per < 5, "plain text"); assert.ok(numbers.per < 10 && ledgered.per < 10);
});

test("budget: a call that failed before the provider answered gives its reservation back; one the provider answered and a scan refused is charged its usage", async () => {
  const { createLimits } = await import("../core/limits.js");
  const { createEventLog } = await import("../core/events.js");
  const { createChainBuilder } = await import("../core/chain.js");
  const { createDoor } = await import("./door.js");
  const SPACE = "spc_testspace0001";
  const log = createEventLog({ space: SPACE });
  const L = createLimits({ space: SPACE, log });
  const budget = L.doorBudget({ limitOf: () => 1000, estimate: () => 600, cost: (i, u) => u.cost_micro });
  const sealer = { detect: async ({ text }) => ({ text, found: [], ledger: [] }), endSession: async () => {} };
  const chain = person();
  const call = d => createDoor({ sealer, sinks: [], budget, drivers: { fake: d } }).call({ chain, purpose: "t", provider: "fake", model: "m", messages: [{ role: "user", content: "hi" }] });
  await assert.rejects(() => call({ call: async () => { throw new Error("provider down"); } }), /provider down/);
  assert.deepEqual(L.used(chain.hops[0].actor.id, "ai_spend"), { settled: 0, reserved: 0 }, "nothing spent, nothing held");
  assert.equal((await call({ call: async () => ({ content: "ok", usage: { cost_micro: 250 } }) })).content, "ok");
  assert.deepEqual(L.used(chain.hops[0].actor.id, "ai_spend"), { settled: 250, reserved: 0 });
  // a refused scan after the provider answered: the money was spent
  const hostile = createDoor({ sealer: { detect: async ({ text }) => ({ text, found: [], ledger: [] }), endSession: async () => {} }, sinks: [], budget, drivers: { fake: { call: async () => ({ content: "x", usage: { cost_micro: 100 }, tool_calls: [{ input: 10n }] }) } } });
  await assert.rejects(() => hostile.call({ chain, purpose: "t", provider: "fake", model: "m", messages: [{ role: "user", content: "hi" }] }));
  assert.deepEqual(L.used(chain.hops[0].actor.id, "ai_spend"), { settled: 350, reserved: 0 }, "charged the 100 the provider reported");
});

test("D-1: a provider that reports no usage is charged what was reserved", async () => {
  const { createLimits } = await import("../core/limits.js");
  const { createEventLog } = await import("../core/events.js");
  const { createDoor } = await import("./door.js");
  const SPACE = "spc_testspace0001";
  const L = createLimits({ space: SPACE, log: createEventLog({ space: SPACE }) });
  const budget = L.doorBudget({ limitOf: () => 10_000, estimate: () => 600 });
  const chain = person();
  const door = createDoor({ sealer: { detect: async ({ text }) => ({ text, found: [], ledger: [] }), endSession: async () => {} }, sinks: [], budget, drivers: { fake: { call: async () => ({ content: "no usage reported" }) } } });
  await door.call({ chain, purpose: "t", provider: "fake", model: "m", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(L.used(chain.hops[0].actor.id, "ai_spend"), { settled: 600, reserved: 0 });
});

test("stream S-2: a tool input that grows past its cap, or too many open tools, cuts the stream", async t => {
  const w = await world(t), big = "x".repeat(100_000);
  const ev = await run(w, [{ tool_start: { id: "t", name: "n" } }, ...[1, 2, 3].map(() => ({ tool_delta: { id: "t", json: big } }))]);
  assert.equal(ev.at(-1).type, "cut"); assert.equal(ev.at(-1).code, "budget"); assert.equal(ev.at(-1).class, "tool_input");
  const many = await run(w, Array.from({ length: 70 }, (_, i) => ({ tool_start: { id: "t" + i, name: "n" } }))); assert.equal(many.at(-1).type, "cut");
});

test("listModels: the door asks the provider's driver for its model list and answers names only; a sink and a provider are each checked", async t => {
  const KEY = "fixture-key-0123456789abcdef";
  const driver = { call: async () => ({ content: "" }), models: async ({ account }) => [`m-${account.id}`, `echo-${KEY}`.slice(0, 5), 7, "x".repeat(300), ...Array.from({ length: 600 }, (_, i) => `n${i}`)] };
  const { door } = await world(t, { door: { drivers: { fake: driver, bare: { call: async () => ({}) } } } });
  const names = await door.listModels({ chain: person(), provider: "fake", account: { id: "a1" } });
  assert.equal(names.length, 500, "bounded");
  assert.equal(names[0], "m-a1");
  assert.ok(names.every(n => typeof n === "string" && n.length <= 120), "text only, cut");
  assert.ok(!JSON.stringify(names).includes(KEY));
  // a provider with no list, an unknown one and a service that is no declared sink are refused in words, before any driver runs
  for (const provider of ["bare", "nope"]) assert.match((await refusal(door.listModels({ chain: person(), provider, account: {} }))).detail, /no model list to ask for/);
  const svc = chain([["person", "per_alex"], ["service", "not-declared"]]);
  assert.equal((await refusal(door.listModels({ chain: svc, provider: "fake", account: {} }))).code, "not_a_sink");
  assert.deepEqual(await door.listModels({ chain: chain([["person", "per_alex"], ["service", "summaries"]]), provider: "fake", account: { id: "z" } }).then(n => n.slice(0, 1)), ["m-z"], "a declared sink may ask");
});

test("a message may carry a picture: the words are scanned, a PNG data URL goes through as it is, any other part is refused and the model is never called", async t => {
  const w = await world(t);
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
  await w.call([{ role: "user", content: [{ type: "text", text: "Her SSN is 123-45-6789, what is in this picture" }, { type: "image_url", image_url: { url: png } }] }]);
  const sent = w.seen[0].messages[0].content;
  assert.equal(sent[0].text, "Her SSN is [sealed: US SSN #1], what is in this picture");
  assert.deepEqual(sent[1], { type: "image_url", image_url: { url: png } });
  for (const bad of [{ type: "image_url", image_url: { url: "https://evil.example/x.png" } }, { type: "image_url", image_url: { url: "data:text/html;base64,PGI+" } }, { type: "file", file: "x" }]) {
    const r = await refusal(w.call([{ role: "user", content: [{ type: "text", text: "hi" }, bad] }]));
    assert.equal(r.code, "budget", JSON.stringify(bad));
  }
  assert.equal(w.seen.length, 1, "the refused ones never reached the model");
});
