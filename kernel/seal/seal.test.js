// @ts-check
// The sealing process (K3) against invariants 4, 5 and 6: a sealed value exists only inside the sealing process and the person's reveal view;
// it goes only to the record's own verified contact point or a document for it; reveal and delivery are human-only, with a hardware-signed
// proof over exactly this payload. Real child processes, temp folders, a real unix socket for the egress sink.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { startSealer } from "./client.js";
import { person, withAgent, chain, signer, tmp, property, randomSsn, luhnCard, SPACE } from "./testing.js";

const REC = "vyre://spc_testspace0001/contact/c_jane";
const dest = (over = {}) => ({ kind: "contact_point", record: REC, contact: "jane@harlow.test", verified: true, ...over });

/** Every byte the process wrote to disk, as text in the forms a value could take. */
function diskHolds(dir, value) {
  const forms = [value, value.replace(/\D/g, ""), Buffer.from(value).toString("base64"), Buffer.from(value).toString("hex")];
  for (const d of fs.readdirSync(dir, { recursive: true })) {
    const f = path.join(dir, String(d)); if (!fs.statSync(f).isFile() || f.endsWith("master.key")) continue;
    const t = fs.readFileSync(f); if (forms.some(x => x.length >= 6 && t.includes(x))) return f;
  }
  return null;
}
async function setup(t, sinks = {}) {
  const dir = tmp("seal"), s = startSealer({ dir, sinks, timeoutMs: 8000 }), alex = signer("per_alex");
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await s.enrol(alex.enrolment);
  return { dir, s, alex };
}
const put = (s, value, over = {}) => s.api.put({ chain: person(), record: REC, field: "ssn", class: "us-ssn", value, ...over });
const code = p => p.then(() => null, e => e.code);

test("put: a placeholder comes back, nothing about the value is in the reference, and the folder holds no plaintext", async t => {
  const { dir, s } = await setup(t);
  const { ref } = await put(s, "123-45-6789", { hint_allowed: false });
  assert.deepEqual(Object.keys(ref).sort(), ["present", "ref", "sealed", "set_at", "valid_format"]);
  assert.equal(ref.sealed, "US SSN"); assert.equal(ref.valid_format, true);
  assert.equal(diskHolds(dir, "123-45-6789"), null);
  assert.equal((await put(s, "000-00-0000")).ref.valid_format, false);
  assert.equal((await put(s, "123-45-6789", { hint_allowed: true })).ref.hint, "last4 6789");
});

test("a sealed file does not open under another reference, record, field, Space or after a flipped bit", async t => {
  const { dir, s } = await setup(t);
  const { ref } = await put(s, "123-45-6789");
  const f = path.join(dir, "values", `${ref.ref}.json`), j = JSON.parse(fs.readFileSync(f, "utf8"));
  const alex = person();
  const signed = signer("per_alex"); await s.enrol(signed.enrolment);
  const reveal = (r, ch = alex) => s.api.reveal({ chain: ch, ref: r, purpose: "check", proof: signed.proof(ch, "seal.reveal", { ref: r, purpose: "check" }) });
  assert.equal((await reveal(ref.ref)).value, "123-45-6789");
  // Another record's AAD, another field, a flipped bit: the file no longer opens, and the answer is the same as for a value that never existed.
  const bad = [{ ...j, record: "vyre://spc_testspace0001/contact/c_other" }, { ...j, field: "dob" }, { ...j, ct: Buffer.from(j.ct, "base64").map((b, i) => i ? b : b ^ 1).toString("base64") }];
  for (const b of bad) { fs.writeFileSync(f, JSON.stringify(b)); assert.equal(await code(reveal(ref.ref)), "not_found"); }
  fs.writeFileSync(f, JSON.stringify(j)); assert.equal((await reveal(ref.ref)).value, "123-45-6789");
  // A reference from another Space is absent, and so is one that never existed or is not a reference at all.
  const other = chain([["person", "per_alex"]], "deck", "spc_other0000001");
  assert.equal(await code(reveal(ref.ref, other)), "not_found");
  assert.equal(await code(reveal("seal_" + "0".repeat(30))), "not_found");
  assert.equal(await code(reveal("../../etc/passwd")), "not_found");
});

test("reveal is human only: it needs one person, a human surface, a hardware proof over this payload, fresh, used once", async t => {
  const { s, alex } = await setup(t);
  const { ref } = await put(s, "123-45-6789");
  const ch = person(), fields = { ref: ref.ref, purpose: "read it to the bank" };
  const go = (proof, c = ch, purpose = fields.purpose) => s.api.reveal({ chain: c, ref: ref.ref, purpose, proof });
  const good = alex.proof(ch, "seal.reveal", fields);
  assert.equal((await go(good)).value, "123-45-6789");
  assert.equal(await code(go(good)), "replayed");
  assert.equal(await code(go(null)), "needs_presence");
  assert.equal(await code(go(alex.proof(ch, "seal.reveal", fields, { tamper: true }))), "bad_signature");
  assert.equal(await code(go(alex.proof(ch, "seal.reveal", { ...fields, purpose: "other" }))), "wrong_payload");
  assert.equal(await code(go(alex.proof(ch, "seal.use", fields))), "wrong_decision");
  assert.equal(await code(go(alex.proof(ch, "seal.reveal", fields, { issued: Date.now() - 200_000, life: 60_000 }))), "expired");
  assert.equal(await code(go(alex.proof(ch, "seal.reveal", fields, { life: 600_000 }))), "expired");
  // Not exactly one person, an agent hop, a surface an assistant can read: all refused before the proof is looked at.
  const proofFor = c => alex.proof(c, "seal.reveal", fields);
  for (const c of [withAgent(), chain([["person", "per_alex"], ["service", "mail"]]), person("per_alex", "mcp"), person("per_alex", "cli"), chain([["agent", "intake"]])]) assert.equal(await code(go(proofFor(c), c)), "human_only");
  // Someone else's key cannot sign for Alex, and a revoked key signs nothing.
  const bob = signer("per_bob"); await s.enrol(bob.enrolment);
  assert.equal(await code(go(bob.proof(ch, "seal.reveal", fields))), "unknown_key");
  const k = signer("per_alex"); await s.enrol(k.enrolment); await s.revoke(k.key_id);
  assert.equal(await code(go(k.proof(ch, "seal.reveal", fields))), "unknown_key");
});

test("reveal returns the event for the log without the value, and ledger entries only when asked", async t => {
  const { s, alex } = await setup(t);
  const { ref } = await put(s, "123-45-6789"), ch = person();
  const r = await s.api.reveal({ chain: ch, ref: ref.ref, purpose: "p", proof: alex.proof(ch, "seal.reveal", { ref: ref.ref, purpose: "p" }), ledger_key: Buffer.alloc(32, 7).toString("base64") });
  assert.equal(r.event.type, "field.revealed"); assert.ok(r.ledger.length > 10);
  assert.ok(!JSON.stringify({ ...r, value: undefined }).includes("123-45-6789"));
  assert.ok(!JSON.stringify(r.ledger).includes("6789"));
});

test("use: a template slot is merged into a derivative for the record's own verified contact point, and the caller learns only that it happened", async t => {
  const { dir, s, alex } = await setup(t);
  const { ref } = await put(s, "123-45-6789"), body = "Hello Jane. Your SSN on file is {{sealed:ssn}}.";
  const base = { chain: person(), ref: ref.ref, slot: "ssn", body, template: "vyre://spc_testspace0001/template/welcome", template_version: 3 };
  const r = await s.api.use({ ...base, destination: dest() });
  assert.equal(r.merged, true); assert.match(r.output_ref, /^vyre:\/\/spc_testspace0001\/sealed-output\/out_/);
  assert.ok(!JSON.stringify(r).includes("123-45-6789"));
  assert.equal(r.sealed_slots[0].class, "us-ssn");
  const derived = fs.readdirSync(path.join(dir, "derived"));
  assert.equal(derived.length, 1); assert.equal(diskHolds(dir, "123-45-6789"), null, "the merged output is sealed on disk too");
  // The slots in the body are exactly the bound ones; a value that looks like a slot cannot inject into another.
  assert.equal(await code(s.api.use({ ...base, body: "no slots here", destination: dest() })), "slot_mismatch");
  assert.equal(await code(s.api.use({ ...base, body: body + " {{sealed:other}}", destination: dest() })), "slot_mismatch");
  const tricky = (await put(s, "x-{{sealed:b}}-y", { class: "free" })).ref, b = (await put(s, "SECOND-VALUE", { class: "free", field: "b" })).ref;
  const two = await s.api.use({ ...base, body: "{{sealed:a}} {{sealed:b}}", bindings: [{ slot: "a", ref: tricky.ref }, { slot: "b", ref: b.ref }], destination: dest() });
  const derivedRead = await s.revealDerived({ chain: person(), output_ref: two.output_ref, purpose: "check", proof: alex.proof(person(), "seal.reveal_derived", { ref: two.output_ref, purpose: "check" }) });
  assert.equal(derivedRead.value, "x-{{sealed:b}}-y SECOND-VALUE");
});

test("use: any other destination, or a plan a model started, needs fresh presence that names the destination", async t => {
  const { s, alex } = await setup(t);
  const { ref } = await put(s, "123-45-6789"), body = "SSN {{sealed:ssn}}";
  const mk = (over, ch = person()) => ({ chain: ch, ref: ref.ref, slot: "ssn", body, template: "vyre://spc_testspace0001/template/t", template_version: 1, destination: dest(), ...over });
  const fields = d => ({ refs: [ref.ref], destination: d, template: "vyre://spc_testspace0001/template/t", template_version: 1 });
  // Not the record's own contact point, unverified, or another record's document.
  for (const d of [dest({ record: "vyre://spc_testspace0001/contact/c_other" }), dest({ verified: false }), { kind: "document", record: "vyre://spc_testspace0001/contact/c_other", document: "vyre://spc_testspace0001/doc/d1" }]) {
    assert.equal(await code(s.api.use(mk({ destination: d }))), "needs_presence", JSON.stringify(d));
    assert.ok((await s.api.use(mk({ destination: d, proof: alex.proof(person(), "seal.use", fields(d)) }))).merged);
  }
  // A model-originated chain needs presence even for the right destination, and presence for a different destination does not carry over.
  const agent = withAgent();
  const approver = person();
  assert.equal(await code(s.api.use(mk({}, agent))), "needs_presence");
  assert.equal((await s.api.use(mk({ approver_chain: approver, proof: alex.proof(approver, "seal.use", fields(dest())) }, agent))).merged, true);
  assert.equal(await code(s.api.use(mk({ approver_chain: approver, proof: alex.proof(approver, "seal.use", fields(dest({ contact: "evil@x.test" }))) }, agent))), "wrong_payload");
  assert.equal(await code(s.api.use(mk({ approver_chain: approver, proof: alex.proof(approver, "seal.reveal", fields(dest())) }, agent))), "wrong_decision");
  // The approval must be one person: an approver chain with an assistant in it is refused.
  assert.equal(await code(s.api.use(mk({ approver_chain: agent, proof: alex.proof(agent, "seal.use", fields(dest())) }, agent))), "chain_not_person");
});

/** An egress sink: a unix socket that records the delivery and replies, optionally echoing what it was given. */
function sink(t, echo) {
  const sock = path.join(tmp("sink"), "s.sock"), got = [];
  const srv = net.createServer(c => { let b = ""; c.on("data", d => { b += d; if (b.endsWith("\n")) { const m = JSON.parse(b); got.push(m); c.end(JSON.stringify({ ok: true, status: 202, echo: echo ? m.body : undefined })); } }); });
  srv.listen(sock); t.after(() => srv.close());
  return { sock, got };
}
test("deliver: the sealing process hands the merged body to the egress sink as approved; only a status comes back", async t => {
  const k = sink(t, true), { s, alex } = await setup(t, { mail: k.sock });
  const { ref } = await put(s, "123-45-6789"), ch = person();
  const out = await s.api.use({ chain: ch, ref: ref.ref, slot: "ssn", body: "SSN {{sealed:ssn}}", template: "vyre://spc_testspace0001/template/t", template_version: 1, destination: dest() });
  const envelope = { to: "jane@harlow.test", subject: "Welcome" }, fields = { output_ref: out.output_ref, sink: "mail", envelope };
  assert.equal(await code(s.deliver({ chain: ch, output_ref: out.output_ref, sink: "mail", envelope })), "needs_presence");
  assert.equal(await code(s.deliver({ chain: ch, output_ref: out.output_ref, sink: "mail", envelope: { ...envelope, to: "evil@x.test" }, proof: alex.proof(ch, "seal.deliver", fields) })), "wrong_payload");
  assert.equal(await code(s.deliver({ chain: ch, output_ref: out.output_ref, sink: "nowhere", envelope, proof: alex.proof(ch, "seal.deliver", { ...fields, sink: "nowhere" }) })), "not_found");
  const r = await s.deliver({ chain: ch, output_ref: out.output_ref, sink: "mail", envelope, proof: alex.proof(ch, "seal.deliver", fields) });
  assert.deepEqual(r, { delivered: true, status: 202 });
  assert.equal(k.got.length, 1); assert.equal(k.got[0].body, "SSN 123-45-6789"); assert.deepEqual(k.got[0].envelope, envelope);
});

test("detect: values in text become numbered placeholders, the same value keeps its number, and a session's originals can be saved or are gone", async t => {
  const { dir, s } = await setup(t);
  const ch = person(), session = "ses_1", key = Buffer.alloc(32, 9).toString("base64");
  const a = await s.detect({ chain: ch, session, text: "SSN 123-45-6789 and card 4111 1111 1111 1111.", ledger_key: key });
  assert.equal(a.text, "SSN [sealed: US SSN #1] and card [sealed: card number #1].");
  const b = await s.detect({ chain: ch, session, text: "again 123 45 6789, and a new one 321-54-9876" });
  assert.equal(b.text, "again [sealed: US SSN #1], and a new one [sealed: US SSN #2]");
  assert.ok(a.ledger.length > 20 && b.ledger.length === 0);
  assert.equal(diskHolds(dir, "123-45-6789"), null, "originals are held in memory, not on disk, until saved");
  const saved = await s.save({ chain: ch, session, class: "us-ssn", n: 2, record: REC, field: "ssn" });
  assert.equal(saved.ref.sealed, "US SSN"); assert.ok(!JSON.stringify(saved).includes("321"));
  await s.endSession(session);
  assert.equal(await code(s.save({ chain: ch, session, class: "us-ssn", n: 1, record: REC, field: "ssn" })), "not_found");
});

test("uniqueness at write time and the rate-limited human lookup are the only equality, and neither returns a value", async t => {
  const { s } = await setup(t);
  await put(s, "123-45-6789", { unique: true });
  assert.equal(await code(put(s, "123 45 6789", { unique: true })), "duplicate");
  assert.equal((await put(s, "321-54-9876", { unique: true })).ref.present, true);
  const look = i => s.lookup({ chain: person(), class: "us-ssn", field: "ssn", value: "123-45-6789" });
  assert.equal((await look()).refs.length, 1);
  for (let i = 0; i < 9; i++) await look();
  assert.equal(await code(look()), "rate_limited");
  assert.equal(await code(s.lookup({ chain: withAgent(), class: "us-ssn", field: "ssn", value: "123-45-6789" })), "human_only");
});

test("an error never carries input: every refusal is a stable code, and the process's output holds no value", async t => {
  const dir = tmp("seal"), out = [];
  const s = startSealer({ dir, timeoutMs: 8000 }); t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const secret = "QWERTY-secret-98765";
  const errs = [];
  for (const p of [s.api.put({ chain: person(), record: REC, field: "f", class: "nope", value: secret }), s.api.put({ chain: person(), record: 5, field: "f", class: "free", value: secret }),
    s.api.use({ chain: person(), ref: secret, slot: "x", body: secret, template: "t", template_version: 1, destination: dest() }), s.api.reveal({ chain: person(), ref: secret, purpose: secret, proof: { key_id: secret } }),
    s.detect({ chain: person(), session: null, text: secret })]) errs.push(await p.then(() => "ok", e => `${e.code}|${e.message}`));
  for (const e of errs) { assert.ok(!e.includes(secret), e); assert.match(e, /^[a-z_]+\|[a-z_]+$/); }
  out.push(...errs);
});

test("property: whatever the sequence of puts, uses and detects, no plaintext is on disk and none is in any answer but a reveal", async t => {
  const { dir, s } = await setup(t);
  const seen = [], values = [];
  property("no plaintext outside reveal", 12, r => { /* generated below, awaited in the outer loop */ void r; }, 1);
  const rnd = (await import("./testing.js")).rng(Number(process.env.SEED) || 7);
  for (let i = 0; i < 40; i++) {
    const v = rnd.pick([() => randomSsn(rnd), () => luhnCard(rnd)])(), cls = v.length === 9 ? "us-ssn" : "card"; values.push(v);
    const fmt = cls === "us-ssn" ? `${v.slice(0, 3)}-${v.slice(3, 5)}-${v.slice(5)}` : v.replace(/(\d{4})/g, "$1 ").trim();
    seen.push(JSON.stringify(await put(s, fmt, { class: cls, field: "f" + i })));
    seen.push(JSON.stringify(await s.detect({ chain: person(), session: "s" + (i % 5), text: `x ${fmt} y` })));
    const ref = JSON.parse(seen[seen.length - 2]).ref.ref;
    seen.push(JSON.stringify(await s.api.use({ chain: person(), ref, slot: "v", body: "{{sealed:v}}", template: "t", template_version: 1, destination: dest() }).catch(e => e.code)));
  }
  const blob = seen.join("\n");
  for (const v of values) { assert.ok(!blob.includes(v), "an answer held a value"); assert.equal(diskHolds(dir, v), null, "the disk held a value"); }
});
