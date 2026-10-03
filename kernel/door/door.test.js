// @ts-check
// The inference door against invariants 5 and 6: models see placeholders, a prompt holding a value the session resolved is refused (every
// disguise in the canary corpus), a reply or tool result that echoes one is refused, and only declared sinks reach the door.
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
  return { door, call, seen, events, sealer, reveal, alex };
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
