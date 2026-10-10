// @ts-check
// The sealing process (K3) against invariants 4, 5 and 6: a sealed value exists only inside the sealing process and the person's reveal view;
// it goes only to the record's own verified contact point or a document for it; reveal and delivery are human-only, with a hardware-signed
// proof over exactly this payload. Real child processes, temp folders, a real unix socket for the egress sink.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { startSealer } from "./client.js";
import { wipeSealDir } from "./wipe.js";
import { person, withAgent, chain, signer, tmp, property, randomSsn, luhnCard, enrolDevice, SPACE } from "./testing.js";

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
  const dir = tmp("seal"), s = startSealer({ dir, sinks, timeoutMs: 8000, dev: true, unattested: true }), alex = signer("per_alex");
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await enrolDevice(s, alex);
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
  const { dir, s, alex: owner } = await setup(t);
  const { ref } = await put(s, "123-45-6789");
  const f = path.join(dir, "values", `${ref.ref}.json`), j = JSON.parse(fs.readFileSync(f, "utf8"));
  const alex = person();
  const signed = signer("per_alex"); await enrolDevice(s, signed, { existing: owner });
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
  const bob = signer("per_bob"); await enrolDevice(s, bob);
  assert.equal(await code(go(bob.proof(ch, "seal.reveal", fields))), "unknown_key");
  const k = signer("per_alex"); await enrolDevice(s, k, { existing: alex }); await s.revoke({ chain: ch, key_id: k.key_id, proof: alex.proof(ch, "presence.revoke", { key_id: k.key_id }) });
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
  assert.deepEqual(r, { delivered: true, status: 202, recipient_verified: true });
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
  assert.equal(saved.ref.sealed, "US SSN"); for (const v of ["321-54-9876", "321549876", "9876"]) assert.ok(!JSON.stringify(saved).includes(v), `the saved answer carries ${v}`);   // (not the bare "321": a random id holds those three digits now and then)
  await s.endSession(ch, session);
  assert.equal(await code(s.save({ chain: ch, session, class: "us-ssn", n: 1, record: REC, field: "ssn" })), "not_found");
});

test("uniqueness at write time and the rate-limited human lookup are the only equality, and neither returns a value", async t => {
  const { s } = await setup(t);
  await put(s, "123-45-6789", { unique: true });
  assert.equal(await code(put(s, "123 45 6789", { unique: true })), "duplicate");
  assert.equal((await put(s, "321-54-9876", { unique: true })).ref.present, true);
  const look = i => s.lookup({ chain: person(), class: "us-ssn", field: "ssn", value: "123-45-6789" });
  assert.equal((await look()).refs.length, 1);
  for (let i = 0; i < 6; i++) await look();
  assert.equal(await code(look()), "rate_limited");
  assert.equal(await code(s.lookup({ chain: withAgent(), class: "us-ssn", field: "ssn", value: "123-45-6789" })), "human_only");
});

test("an error never carries input: every refusal is a stable code, and the process's output holds no value", async t => {
  const dir = tmp("seal"), out = [];
  const s = startSealer({ dir, timeoutMs: 8000, dev: true }); t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
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

test("a proof issued before the process started is refused (the used-nonce list does not survive a restart), and a sink name is not looked up through the prototype", async t => {
  const { Presence } = await import("./proof.js");
  let now = 1_000_000; const p = new Presence(() => now, { allowUnattested: true }), k = signer("per_alex"), e = k.enrolment, ch0 = person();
  const { token } = p.begin({ person: "per_alex", key_id: e.key_id, spki: e.spki });
  assert.deepEqual(p.enrol({ person: "per_alex", key_id: e.key_id, spki: e.spki, signer: e.signer, token, ctx: (await import("./wire.js")).chainCtx(ch0) }), { attested: false });
  const ch = person(), fields = { ref: "seal_x", purpose: "p" };
  const old = k.proof(ch, "seal.reveal", fields, { issued: now - 10_000, life: 60_000 });
  assert.equal(p.refuse(old, { op: "seal.reveal", space: ch.space, fields, ctx: (await import("./wire.js")).chainCtx(ch) }), "expired");
  const fresh = k.proof(ch, "seal.reveal", fields, { issued: now, life: 60_000 });
  assert.equal(p.refuse(fresh, { op: "seal.reveal", space: ch.space, fields, ctx: (await import("./wire.js")).chainCtx(ch) }), null);
  const { s, alex } = await setup(t, { mail: "/nonexistent.sock" });
  const { ref } = await put(s, "123-45-6789"), c = person();
  const out = await s.api.use({ chain: c, ref: ref.ref, slot: "ssn", body: "{{sealed:ssn}}", template: "t", template_version: 1, destination: dest() });
  for (const sink of ["constructor", "__proto__", "toString"]) assert.equal(await code(s.deliver({ chain: c, output_ref: out.output_ref, sink, envelope: {}, proof: alex.proof(c, "seal.deliver", { output_ref: out.output_ref, sink, envelope: {} }) })), "not_found", sink);
});

test("K3 item 1: `unique` and lookup are one person's, share one rate limit, and an agent's probe is refused", async t => {
  const { s } = await setup(t);
  await put(s, "123-45-6789");
  // An agent chain (or a service) probing for an existing value is refused with the same answer whether or not it exists.
  for (const ch of [withAgent(), chain([["person", "per_alex"], ["service", "mail"]])]) {
    assert.equal(await code(s.api.put({ chain: ch, record: REC, field: "ssn", class: "us-ssn", value: "123-45-6789", unique: true })), "human_only");
    assert.equal(await code(s.api.put({ chain: ch, record: REC, field: "ssn", class: "us-ssn", value: "999-99-9999", unique: true })), "human_only");
  }
  // A person's probes count against the same per-field limit as the lookup.
  let n = 0; while (n < 30 && !(await code(put(s, `1${String(n).padStart(2, "0")}-45-6789`, { unique: true })))) n++;
  assert.ok(n >= 8 && n <= 10, `rate limit after ${n}`);
  assert.equal(await code(s.lookup({ chain: person(), class: "us-ssn", field: "ssn", value: "123-45-6789" })), "rate_limited");
});

test("K3 item 4: a session belongs to one Space, and saving a detection is a person's act", async t => {
  const { s } = await setup(t);
  const a = person(), b = chain([["person", "per_alex"]], "deck", "spc_other0000001");
  await s.detect({ chain: a, session: "shared-name", text: "ssn 123-45-6789" });
  // The same session id from another Space is a different, empty session: the detection is not there to save.
  assert.equal(await code(s.save({ chain: b, session: "shared-name", class: "us-ssn", n: 1, record: "vyre://spc_other0000001/contact/c", field: "ssn" })), "not_found");
  // A model-originated chain cannot promote a detection, though the session and the number are right.
  assert.equal(await code(s.save({ chain: withAgent(), session: "shared-name", class: "us-ssn", n: 1, record: REC, field: "ssn" })), "human_only");
  assert.equal((await s.save({ chain: a, session: "shared-name", class: "us-ssn", n: 1, record: REC, field: "ssn" })).ref.present, true);
  await s.endSession(b, "shared-name"); // another Space ending its own session of that name leaves this one alone
  assert.equal((await s.save({ chain: a, session: "shared-name", class: "us-ssn", n: 1, record: REC, field: "ssn" })).ref.present, true);
});

test("K3 item 5: a device key is enrolled only through the ceremony, and a second device needs a proof from a first", async t => {
  const dir = tmp("enrol"), s = startSealer({ dir, timeoutMs: 8000, dev: true }); // not started to allow unattested keys
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const a = signer("per_alex"), e = a.enrolment, ch = person(), base = { chain: ch, person: "per_alex", key_id: e.key_id, spki: e.spki, signer: e.signer };
  assert.equal(await code(s.enrol({ ...base, token: "nope" })), "no_ceremony");
  assert.equal(await code(s.begin({ ...base, chain: withAgent() })), "chain_not_person");
  assert.equal(await code(s.begin({ ...base, chain: person("per_bob") })), "chain_not_person");
  // UY-2 (6410c6a): a phone's secure-chip key (secure_enclave, strongbox) enrols unattested on release, marked so (kernel/seal/unattested.test.js); any other unattested signer is refused unless the process allows it
  const tpm = { ...base, signer: "tpm" }, { token } = await s.begin(tpm);
  assert.equal(await code(s.enrol({ ...tpm, token })), "unattested", "a key nobody attested is refused unless the process allows it");
  assert.equal(await code(s.enrol({ ...tpm, token })), "no_ceremony", "the token is spent by any attempt");
  assert.equal((await s.health()).unattested_allowed, false);
  // A software key cannot claim to be a hardware key: the verifier decides the signer class.
  const verifiers = path.join(dir, "verifiers.mjs");
  fs.writeFileSync(verifiers, 'export default { fake: (att, spki) => (att.claims === "enclave" ? "secure_enclave" : null) };');
  const s2 = startSealer({ dir: tmp("enrol2"), timeoutMs: 8000, dev: true, verifiers }); t.after(() => s2.close());
  const tk = (await s2.begin(base)).token;
  assert.equal(await code(s2.enrol({ ...base, token: tk, attestation: { format: "fake", claims: "software" } })), "bad_attestation");
  assert.equal((await s2.enrol({ ...base, token: (await s2.begin(base)).token, attestation: { format: "fake", claims: "enclave" } })).attested, true);
  // A second device for the same person needs a proof from the first; someone else's key cannot vouch.
  const b = signer("per_alex"), eb = b.enrolment, ch2 = person();
  const bb = { chain: ch2, person: "per_alex", key_id: eb.key_id, spki: eb.spki, signer: eb.signer, attestation: { format: "fake", claims: "enclave" } };
  assert.equal(await code(s2.enrol({ ...bb, token: (await s2.begin(bb)).token })), "needs_presence");
  const fields = { key_id: eb.key_id, spki: (await import("./wire.js")).sha256b64(eb.spki), signer: eb.signer };
  assert.equal((await s2.enrol({ ...bb, token: (await s2.begin(bb)).token, proof: a.proof(ch2, "presence.enrol", fields) })).attested, true);
  // Revoking needs the owner's chain.
  assert.equal(await code(s2.revoke({ chain: person("per_bob"), key_id: eb.key_id })), "not_found");
  assert.equal(await code(s2.revoke({ chain: person("per_alex"), key_id: eb.key_id })), "needs_presence", "a chain alone cannot revoke");
  assert.equal(await code(s2.revoke({ chain: person("per_alex"), key_id: eb.key_id, proof: b.proof(person("per_alex"), "presence.revoke", { key_id: eb.key_id }) })), "needs_other_key", "a device cannot sign away the person's others by vouching for itself");
  assert.equal((await s2.revoke({ chain: person("per_alex"), key_id: eb.key_id, proof: a.proof(person("per_alex"), "presence.revoke", { key_id: eb.key_id }) })).revoked, true);
});

test("K3 item 10: swapping two sealed files in one Space does not make a reference open the other value", async t => {
  const { dir, s, alex } = await setup(t);
  const one = (await put(s, "111-22-3333")).ref.ref, two = (await put(s, "444-55-6666")).ref.ref;
  const f1 = path.join(dir, "values", `${one}.json`), f2 = path.join(dir, "values", `${two}.json`), b1 = fs.readFileSync(f1), b2 = fs.readFileSync(f2);
  fs.writeFileSync(f1, b2); fs.writeFileSync(f2, b1);
  const ch = person();
  assert.equal(await code(s.api.reveal({ chain: ch, ref: one, purpose: "p", proof: alex.proof(ch, "seal.reveal", { ref: one, purpose: "p" }) })), "not_found");
});

test("K3 item 6: the sealing process refuses to start on a desktop profile or as an agent's uid, and a loose master key file", async t => {
  const { hostCheck, fileMaster } = await import("./process.js");
  assert.doesNotThrow(() => hostCheck({ profile: "desktop", dev: false }), "a desktop uses the file master inside the Vyre home, no development switch");
  assert.throws(() => hostCheck({ profile: "mystery", dev: false, uid: 1000 }), /own user/, "an unknown profile is refused");
  assert.throws(() => hostCheck({ profile: "server", dev: false, uid: 2001 }), /own user/);
  assert.doesNotThrow(() => hostCheck({ profile: "server", dev: false, uid: 1000 }));
  assert.throws(() => hostCheck({ profile: "server", dev: false, uid: 5000, agentUids: "5000,5001" }), /own user/);
  const d = tmp("master"); fileMaster(d); fs.chmodSync(path.join(d, "master.key"), 0o644);
  assert.throws(() => fileMaster(d), /not private/);
  // Both profiles boot with no development variable at all, and say plainly where the key lives.
  for (const profile of [undefined, "desktop", "server"]) {
    const dir = tmp("seal"), s = startSealer({ dir, timeoutMs: 8000, ...(profile ? { profile } : {}) }); t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const h = await s.health(); assert.equal(h.ok, true, String(profile)); assert.equal(h.custody.master, "file"); assert.equal(h.custody.profile, profile ?? "desktop"); assert.match(h.custody.note, /key/);
    assert.equal(fs.statSync(path.join(dir, "master.key")).mode & 0o077, 0, "the master is private to the process's user");
  }
  const { custodyNote } = await import("./process.js");
  assert.match(custodyNote("desktop", "win32"), /only as protected as this PC's own Windows account/); assert.match(custodyNote("server", "linux"), /Root on this server, or a stolen disk/); assert.match(custodyNote("desktop", "darwin"), /sandboxed away from it/);
});

test("R-1: revoking every key leaves the person in recovery, never a first device, and enrolled keys survive a restart", async t => {
  const dir = tmp("r1"), opts = { dir, timeoutMs: 8000, dev: true, unattested: true };
  let s = startSealer(opts); t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const a = signer("per_alex"), ch = person(); await enrolDevice(s, a);
  // A restart keeps the key: a proof signed by it still works afterwards (and the used-nonce guard is fresh, proofs are issued after the start).
  await s.close(); s = startSealer(opts);
  const { ref } = await put(s, "123-45-6789");
  assert.equal((await s.api.reveal({ chain: ch, ref: ref.ref, purpose: "p", proof: a.proof(ch, "seal.reveal", { ref: ref.ref, purpose: "p" }) })).value, "123-45-6789");
  // The last key goes with the person's own proof; after that an attacker's phone is not a "first device".
  assert.equal((await s.revoke({ chain: ch, key_id: a.key_id, proof: a.proof(ch, "presence.revoke", { key_id: a.key_id }) })).revoked, true);
  const evil = signer("per_alex");
  assert.equal(await code(enrolDevice(s, evil)), "needs_recovery");
  const stranger = signer("per_zoe"); assert.equal((await enrolDevice(s, stranger)).enrolled, true);
});

test("R-2: recipient_verified covers to, cc and bcc, and a document destination has no recipient", async () => {
  const { recipientsVerified: ok } = await import("./process.js");
  const contact = { dest_kind: "contact_point", dest_contact: "Jane@Harlow.test" }, doc = { dest_kind: "document", dest_contact: null };
  assert.equal(ok(contact, { to: "jane@harlow.test" }), true);
  assert.equal(ok(contact, { to: ["jane@harlow.test"], cc: [], bcc: null }), true);
  assert.equal(ok(contact, { to: "jane@harlow.test", cc: "evil@x.test" }), false);
  assert.equal(ok(contact, { to: "jane@harlow.test", bcc: ["jane@harlow.test", "evil@x.test"] }), false);
  assert.equal(ok(contact, { subject: "no recipient at all" }), false);
  assert.equal(ok(doc, { subject: "a document, nobody to send to" }), true);
  assert.equal(ok(doc, { to: "jane@harlow.test" }), false);
  assert.equal(ok(doc, { bcc: "jane@harlow.test" }), false);
});

test("R-3: a delivered output is swept ten minutes later by anyone who starts the folder, not by a timer that a restart loses", async () => {
  const { SealStore } = await import("./store.js"), crypto = await import("node:crypto"), dir = tmp("sweep"), st = new SealStore(dir, crypto.randomBytes(32));
  const meta = { ref: st.newRef("out"), space: SPACE, record: REC, field: "output", class: "derived" };
  st.write("derived", meta, "text with a value"); st.markDelivered(meta.ref);
  st.sweepDelivered(600_000); assert.equal(fs.existsSync(path.join(dir, "derived", `${meta.ref}.json`)), true, "not yet");
  fs.writeFileSync(path.join(dir, "derived", `${meta.ref}.done`), String(Date.now() - 700_000));
  st.sweepDelivered(600_000); assert.deepEqual(fs.readdirSync(path.join(dir, "derived")), []);
});

test("R-7: the key list is MACed and anchored, so a deleted, edited, truncated or rolled-back file means recovery, never a first device", async t => {
  const dir = tmp("r7"), opts = { dir, timeoutMs: 8000, dev: true, unattested: true }, file = path.join(dir, "presence.json");
  let s = startSealer(opts); t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await s.health()).presence, "ok");
  const a = signer("per_alex"), ch = person(); await enrolDevice(s, a);
  const second = signer("per_alex"); await enrolDevice(s, second, { existing: a });
  const older = fs.readFileSync(file, "utf8");
  await s.close();
  // The owner's list is intact after a restart.
  s = startSealer(opts); assert.equal((await s.health()).presence, "ok");
  // 1. deleted
  await s.close(); fs.rmSync(file); s = startSealer(opts);
  assert.equal((await s.health()).presence, "recovery");
  assert.equal(await code(enrolDevice(s, signer("per_alex"))), "needs_recovery");
  assert.equal(await code(enrolDevice(s, signer("per_zoe"))), "needs_recovery", "while in recovery nothing is a first device");
});

test("R-7: a file edited to add a key fails its MAC, a rolled-back file is older than the anchor, a truncated file does not parse", async t => {
  for (const [name, mutate] of [
    ["edited", (f, other) => { const raw = JSON.parse(fs.readFileSync(f, "utf8")), b = JSON.parse(raw.body); b.keys.dk_evil = { person: "per_alex", signer: "secure_enclave", attested: true, spki: other }; fs.writeFileSync(f, JSON.stringify({ body: JSON.stringify(b), mac: raw.mac })); }],
    ["rolled back", (f, _o, older) => fs.writeFileSync(f, older)],
    ["truncated", f => fs.writeFileSync(f, fs.readFileSync(f, "utf8").slice(0, 40))],
    ["emptied", f => fs.writeFileSync(f, "")],
  ]) {
    const dir = tmp("r7b"), opts = { dir, timeoutMs: 8000, dev: true, unattested: true }, file = path.join(dir, "presence.json");
    let s = startSealer(opts); t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const a = signer("per_alex"); await enrolDevice(s, a);
    const older = fs.readFileSync(file, "utf8");
    await enrolDevice(s, signer("per_alex"), { existing: a });
    await s.close(); mutate(file, signer("per_alex").enrolment.spki, older); s = startSealer(opts);
    assert.equal((await s.health()).presence, "recovery", name);
    assert.equal(await code(enrolDevice(s, signer("per_alex"))), "needs_recovery", name);
  }
});

test("K-3: the kernel's MAC key lives in the sealing process: same key across restarts, purposes apart, tamper and a different home fail, the key is on no op", async t => {
  const dir = tmp("kmac"), opts = { dir, timeoutMs: 8000, dev: true };
  let s = startSealer(opts); t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const data = JSON.stringify({ grant: "gr_1", actions: ["records.read"] }), mac = await s.kernel.mac({ purpose: "grant-event", data });
  assert.match(mac, /^[A-Za-z0-9_-]{43}$/); assert.equal(await s.kernel.verify({ purpose: "grant-event", data, mac }), true);
  assert.equal(await s.kernel.verify({ purpose: "grant-event", data: data.replace("gr_1", "gr_2"), mac }), false, "tampered data");
  assert.equal(await s.kernel.verify({ purpose: "chain", data, mac }), false, "another purpose, another key");
  assert.equal(await s.kernel.verify({ purpose: "grant-event", data, mac: mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A") }), false);
  assert.equal(await code(s.kernel.mac({ purpose: "Bad Purpose", data })), "bad_input"); assert.equal(await code(s.kernel.mac({ purpose: "chain", data: 5 })), "bad_input");
  await s.close(); s = startSealer(opts); assert.equal(await s.kernel.verify({ purpose: "grant-event", data, mac }), true, "the same home, the same key");
  const other = startSealer({ dir: tmp("kmac2"), timeoutMs: 8000, dev: true }); t.after(() => other.close());
  assert.equal(await other.kernel.verify({ purpose: "grant-event", data, mac }), false, "another home's key does not verify it");
  for (const f of fs.readdirSync(dir, { recursive: true })) { const p = path.join(dir, String(f)); if (fs.statSync(p).isFile() && !p.endsWith("master.key")) assert.equal(fs.readFileSync(p).includes(mac), false); }
});

test("presence.check: the one verifier checks a task proof for the kernel, once, for task ops only", async t => {
  const { s, alex } = await setup(t);
  const ch = person("per_alex"), fields = { task: "t1", payload_hash: "ph", decision: "dec_1" };
  assert.equal(await s.presenceCheck({ chain: ch, op: "task.decide", fields, proof: alex.proof(ch, "task.decide", fields) }), null);
  const used = alex.proof(ch, "task.decide", fields);
  assert.equal(await s.presenceCheck({ chain: ch, op: "task.decide", fields, proof: used }), null);
  assert.equal(await s.presenceCheck({ chain: ch, op: "task.decide", fields, proof: used }), "replayed");
  assert.equal(await s.presenceCheck({ chain: ch, op: "task.decide", fields: { ...fields, payload_hash: "other" }, proof: alex.proof(ch, "task.decide", fields) }), "wrong_payload");
  assert.equal(await s.presenceCheck({ chain: withAgent(), op: "task.decide", fields, proof: alex.proof(withAgent(), "task.decide", fields) }), "chain_not_person", "an assistant in the chain");
  assert.equal(await s.presenceCheck({ chain: ch, op: "seal.reveal", fields, proof: alex.proof(ch, "seal.reveal", fields) }), "bad_input", "not a task op: no path to a seal op");
});

test("teardown: closing the client ends the sealing process, and a parent that dies takes it with it", async () => {
  const s = startSealer({ dir: tmp("tear"), timeoutMs: 8000, dev: true });
  await s.health();
  const pid = s.pid;
  assert.doesNotThrow(() => process.kill(pid, 0));
  await s.close();
  await new Promise(r => setTimeout(r, 100));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("service credentials: a kernel module's key is sealed in the process, read back at the point of use, rotated in place, listed by name, and on no disk in the clear", async t => {
  const dir = tmp("svc"), opts = { dir, timeoutMs: 8000, dev: true };
  let s = startSealer(opts); t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const key = "twenty-key-" + "A1b2C3".repeat(8), next = "twenty-key-" + "Z9y8X7".repeat(8);
  assert.equal((await s.service.put({ name: "twenty.spc_harlow.key", value: key })).stored, true);
  assert.equal(await s.service.get({ name: "twenty.spc_harlow.key" }), key);
  await s.service.put({ name: "twenty.spc_harlow.key", value: next }); assert.equal(await s.service.get({ name: "twenty.spc_harlow.key" }), next, "a rotation lands in place");
  await s.service.put({ name: "twenty.spc_other.key", value: key });
  assert.deepEqual(await s.service.list(), ["twenty.spc_harlow.key", "twenty.spc_other.key"]);
  for (const f of fs.readdirSync(dir, { recursive: true })) { const p = path.join(dir, String(f)); if (fs.statSync(p).isFile() && !p.endsWith("master.key")) for (const v of [key, next]) assert.equal(fs.readFileSync(p).includes(Buffer.from(v)), false, `no plaintext in ${f}`); }
  await s.close(); s = startSealer(opts); assert.equal(await s.service.get({ name: "twenty.spc_harlow.key" }), next, "it survives a restart");
  assert.equal(await code(s.service.get({ name: "twenty.spc_nobody.key" })), "not_found");
  for (const bad of ["x", "Has Space", "../etc", "A.B"]) assert.equal(await code(s.service.put({ name: bad, value: "v" })), "bad_input", bad);
  assert.equal(await code(s.service.put({ name: "twenty.spc_harlow.key", value: "" })), "bad_input");
  assert.equal((await s.service.delete({ name: "twenty.spc_harlow.key" })).deleted, true); assert.equal(await code(s.service.get({ name: "twenty.spc_harlow.key" })), "not_found");
  const other = startSealer({ dir: tmp("svc2"), timeoutMs: 8000, dev: true }); t.after(() => other.close()); assert.equal(await code(other.service.get({ name: "twenty.spc_other.key" })), "not_found", "another home does not have it");
  // An existing 0600 file is moved in once and shredded.
  const file = path.join(dir, "..", `adopt-${Date.now()}.key`); fs.writeFileSync(file, key + "\n", { mode: 0o600 });
  assert.equal((await s.service.adopt({ name: "twenty.spc_adopted.key", file })).adopted, true); assert.equal(fs.existsSync(file), false); assert.equal(await s.service.get({ name: "twenty.spc_adopted.key" }), key);
});

test("found against the real chains: a member on a paired device reveals with a hardware proof, a daemon speaking for them in a session does not", async t => {
  const { s } = await setup(t), bob = signer("per_bob"); await enrolDevice(s, bob);
  const dev = person("per_bob"), { ref } = await s.api.put({ chain: dev, record: REC, field: "ssn", class: "us-ssn", value: "123-45-6789" });
  assert.equal(dev.hops[0].via.device, "device:d_per_bob", "the kernel's device chain has a device and no surface"); assert.equal(dev.hops[0].via.surface, undefined);
  assert.equal((await s.api.reveal({ chain: dev, ref: ref.ref, purpose: "p", proof: bob.proof(dev, "seal.reveal", { ref: ref.ref, purpose: "p" }) })).value, "123-45-6789");
  // SHIM(session-person-chain): the kernel's `session_person` door (a daemon speaking for a person, no passkey shown) is built here by hand-made facts through chain(); a person's own chain from it must not reveal.
  const { createChainBuilder } = await import("../core/chain.js"), { createKernelSeal } = await import("../core/seal.js");
  const sp = createChainBuilder({ space: SPACE, owner: "per_alex", owner_uid: 501, seal: createKernelSeal({ key: Buffer.alloc(32, 3) }), clock: Date.now, is_person: () => true }).fromFacts({ kind: "session_person", person: "per_bob", session: "x", vouched: true });
  assert.equal(await code(s.api.reveal({ chain: sp, ref: ref.ref, purpose: "p", proof: bob.proof(sp, "seal.reveal", { ref: ref.ref, purpose: "p" }) })), "human_only");
});

const FIRST = { module: "memory", first_party: true };
test("seal.detect: yes or no for one candidate, first-party modules only, rate limited, nothing returned but the answer", async t => {
  const { s } = await setup(t);
  await put(s, "123-45-6789");
  const ask = (value, over = {}) => s.detectValue({ chain: person(), caller: FIRST, value, canRead: async () => true, ...over });
  const yes = await ask("123 45 6789");
  assert.deepEqual(Object.keys(yes).sort(), ["event", "match"]);
  assert.equal(yes.match, true);
  assert.deepEqual(yes.event, { type: "seal.detect", module: "memory", count: 1 });
  assert.equal((await ask("321-54-9876")).match, false);
  assert.ok(!JSON.stringify(yes).includes("6789"));
  // Not a first-party module, a model in the chain, a value too short to mean anything.
  assert.equal(await code(ask("123-45-6789", { caller: { module: "memory" } })), "first_party_only");
  assert.equal(await code(ask("123-45-6789", { caller: undefined })), "first_party_only");
  assert.equal(await code(ask("123-45-6789", { chain: withAgent() })), "human_only");
  assert.equal(await code(ask("12")), "bad_input");
  // Five a minute per module: two answered above, three more, then refused (refusals before the bucket do not spend it).
  await ask("111-22-3333"); await ask("111-22-3334"); await ask("111-22-3335");
  assert.equal(await code(ask("111-22-3336")), "rate_limited");
});

test("reset with wipe (host, daemon stopped): the master key goes first, the folder is emptied, and a fresh start opens none of the old values and makes a new Space key", async t => {
  const dir = tmp("seal"), mk = () => startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true });
  let s = mk(); t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await enrolDevice(s, signer("per_alex"));
  await put(s, "123-45-6789");
  const pub1 = (await s.spaceKey.pub({ chain: person() })).pub;
  assert.ok(fs.existsSync(path.join(dir, "master.key")));
  await s.close();
  const r = wipeSealDir(dir);
  assert.equal(r.master_destroyed, true); assert.ok(r.removed > 0);
  assert.deepEqual(fs.readdirSync(dir), [], "the folder is empty");
  s = mk();
  await enrolDevice(s, signer("per_alex"));
  assert.notEqual((await s.spaceKey.pub({ chain: person() })).pub, pub1, "a new Space checkpoint key");
  assert.equal((await put(s, "123-45-6789", { unique: true })).ref.present, true, "the old value is not remembered as a duplicate");
  assert.equal(diskHolds(dir, "123-45-6789"), null);
});

test("seal.detect (SD-1, SD-2): a value sealed only in a record the person cannot read answers no, canRead is required, and the day counts survive a restart", async t => {
  const dir = tmp("seal"), mk = () => startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true });
  let s = mk(); t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await enrolDevice(s, signer("per_alex"));
  const OTHER = "vyre://spc_testspace0001/contact/c_other";
  await put(s, "123-45-6789");                                        // in REC
  await put(s, "321-54-9876", { record: OTHER });                     // only in OTHER
  const ask = (value, canRead) => s.detectValue({ chain: person(), caller: FIRST, value, canRead });
  const readsRec = async r => r === REC;
  assert.equal((await ask("123-45-6789", readsRec)).match, true);
  assert.equal((await ask("321-54-9876", readsRec)).match, false, "sealed only where the person cannot read: no");
  assert.equal((await ask("321-54-9876", async () => true)).match, true);
  assert.equal(await code(s.detectValue({ chain: person(), caller: FIRST, value: "123-45-6789" })), "bad_input");
  // The same value in both records: one the person reads is enough.
  await put(s, "123-45-6789", { record: OTHER });
  assert.equal((await ask("123-45-6789", async r => r === OTHER)).match, true);
  assert.equal((await ask("999-88-7777", async () => true)).event.count, 5, "five answered today for this module");
  // A restart does not give the day back.
  await s.close(); s = mk();
  assert.equal((await s.detectValue({ chain: person(), caller: FIRST, value: "111-22-3333", canRead: async () => true })).event.count, 6);
});

test("BL-2 anchor: the log's latest (seq, head) moves only forward, a split is refused, it survives a restart, and a Space sees only its own", async t => {
  const dir = tmp("seal"), mk = () => startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true });
  let s = mk(); t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const A = { space: SPACE }, h = c => c.repeat(20);
  assert.equal(await s.anchor.read(A), null);
  assert.deepEqual(await s.anchor.advance({ ...A, seq: 10, head: h("a") }), { seq: 10, head: h("a") });
  assert.equal((await s.anchor.advance({ ...A, seq: 10, head: h("a") })).seq, 10, "the same again is fine");
  assert.equal(await code(s.anchor.advance({ ...A, seq: 9, head: h("b") })), "anchor_behind");
  assert.equal(await code(s.anchor.advance({ ...A, seq: 10, head: h("c") })), "anchor_split");
  assert.equal((await s.anchor.advance({ ...A, seq: 25, head: h("d") })).seq, 25);
  assert.equal(await code(s.anchor.advance({ ...A, seq: -1, head: h("d") })), "bad_input");
  assert.equal(await s.anchor.read({ space: "spc_otherspace0001" }), null);
  await s.close(); s = mk();
  assert.deepEqual(await s.anchor.read(A), { seq: 25, head: h("d") });
  assert.equal(diskHolds(dir, h("d")), null, "the head is not on disk in the clear");
});

test("software signer (ruling 4): a development-kind process takes a software key and names every use method \"software\"; a process started without it refuses the key; a release-kind build never starts it on", async t => {
  const fsx = await import("node:fs"), osx = await import("node:os"), { devSwitch } = await import("../devbuild.js");
  // started with software allowed (a development checkout, VYRE_SEAL_SOFTWARE=1)
  const dir = tmp("soft"), s = startSealer({ dir, timeoutMs: 8000, dev: true, software: true });
  t.after(async () => { await s.close(); fsx.rmSync(dir, { recursive: true, force: true }); });
  const alex = signer("per_alex", undefined, "software"), ch = person("per_alex");
  assert.equal((await enrolDevice(s, alex)).attested, false, "a software key is not attested");
  const fields = { k: "v" };
  const r = await s.presenceProve({ chain: ch, op: "task.decide", fields, proof: alex.proof(ch, "task.decide", fields) });
  assert.deepEqual(r, { ok: true, method: "software", strength: "software" });
  // a process started without it refuses the same key, and a key enrolled earlier stops proving
  const dir2 = tmp("soft2"), s2 = startSealer({ dir: dir2, timeoutMs: 8000, dev: true, unattested: true });
  t.after(async () => { await s2.close(); fsx.rmSync(dir2, { recursive: true, force: true }); });
  await assert.rejects(() => enrolDevice(s2, signer("per_alex", undefined, "software")), { code: "software_refused" });
  // a release-kind (packaged) build never turns it on: the one switch the process reads says no for a packaged root, with the variable set
  const pkg = fsx.mkdtempSync(path.join(osx.tmpdir(), "pkg-"));
  t.after(() => fsx.rmSync(pkg, { recursive: true, force: true }));
  fsx.mkdirSync(path.join(pkg, "lib"), { recursive: true });
  fsx.writeFileSync(path.join(pkg, "lib", "build-kind.js"), 'export const BUILD_KIND = "release";\n');
  assert.equal(devSwitch("1", pkg), false, "release-kind: refused");
  assert.equal(devSwitch("1"), true, "this development checkout: allowed");
});

test("SW-2: a real sealing child from a release-stamped copy ignores VYRE_SEAL_DEV, VYRE_SEAL_UNATTESTED and VYRE_SEAL_SOFTWARE: unattested and software keys are refused", async t => {
  const fsx = await import("node:fs"), osx = await import("node:os"), { pathToFileURL } = await import("node:url");
  const here = path.dirname(new URL(import.meta.url).pathname), root = path.resolve(here, "..", "..");
  const copy = fsx.mkdtempSync(path.join(osx.tmpdir(), "rel-"));
  t.after(() => fsx.rmSync(copy, { recursive: true, force: true }));
  for (const d of ["kernel", "lib"]) fsx.cpSync(path.join(root, d), path.join(copy, d), { recursive: true, filter: f => !/\.test\.js$/.test(f) });
  fsx.writeFileSync(path.join(copy, "package.json"), '{"type":"module"}');
  fsx.writeFileSync(path.join(copy, "lib", "build-kind.js"), 'export const BUILD_KIND = "release";\n');
  const { startSealer: startCopy } = await import(pathToFileURL(path.join(copy, "kernel", "seal", "client.js")).href);
  const dir = tmp("rel"), s = startCopy({ dir, timeoutMs: 8000, dev: true, unattested: true, software: true });
  t.after(async () => { await s.close(); fsx.rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await s.health()).unattested_allowed, false, "the release build ignores VYRE_SEAL_UNATTESTED");
  await assert.rejects(() => enrolDevice(s, signer("per_alex", undefined, "software")), { code: "software_refused" });
  await assert.rejects(() => enrolDevice(s, signer("per_alex", undefined, "tpm")), { code: "unattested" }, "any other unattested signer is refused too (a phone's secure_enclave or strongbox key enrols unattested, UY-2)");
  // UY-2, on the release-stamped tree: a phone's unattested secure-chip key enrols and says yes, marked unattested (and never attested)
  const phone = signer("per_bob"), got = await enrolDevice(s, phone), pch = person("per_bob");
  assert.deepEqual([got.attested, got.strength], [false, "unattested"]);
  assert.deepEqual(await s.presenceProve({ chain: pch, op: "task.decide", fields: { k: "v" }, proof: phone.proof(pch, "task.decide", { k: "v" }) }), { ok: true, method: "unattested", strength: "unattested" });
});

test("reseal: a sealed value moves to another Space's namespace inside the process, for the same person only, and the old Space's chain cannot open the new ref", async t => {
  const { dir, s, alex } = await setup(t);
  const { ref } = await put(s, "123-45-6789");
  const SPACE2 = "spc_testspace0002", REC2 = `vyre://${SPACE2}/contact/c_jane`;
  const from = person(), to = person("per_alex", "deck", SPACE2);
  const moved = await s.api.reseal({ chain: from, to_chain: to, ref: ref.ref, to_record: REC2, field: "ssn" });
  assert.notEqual(moved.ref.ref, ref.ref, "a new reference in the target");
  assert.deepEqual(Object.keys(moved.ref).sort(), ["present", "ref", "sealed", "set_at", "valid_format"], "a placeholder, no value");
  assert.equal(diskHolds(dir, "123-45-6789"), null, "no plaintext on disk");
  // The target reveals it to the person with a proof; the source's chain does not open the new ref.
  const proof = alex.proof(to, "seal.reveal", { ref: moved.ref.ref, purpose: "check" });
  assert.equal((await s.api.reveal({ chain: to, ref: moved.ref.ref, purpose: "check", proof })).value, "123-45-6789");
  assert.equal(await code(s.api.reveal({ chain: from, ref: moved.ref.ref, purpose: "check", proof: alex.proof(from, "seal.reveal", { ref: moved.ref.ref, purpose: "check" }) })), "not_found");
  // Refused: another person on either end, a model on either end, the same Space, a ref that is not the source's.
  assert.equal(await code(s.api.reseal({ chain: from, to_chain: person("per_zoe", "deck", SPACE2), ref: ref.ref, to_record: REC2, field: "ssn" })), "human_only");
  assert.equal(await code(s.api.reseal({ chain: withAgent(), to_chain: to, ref: ref.ref, to_record: REC2, field: "ssn" })), "human_only");
  assert.equal(await code(s.api.reseal({ chain: from, to_chain: from, ref: ref.ref, to_record: REC, field: "ssn" })), "human_only");
  assert.equal(await code(s.api.reseal({ chain: to, to_chain: from, ref: ref.ref, to_record: REC, field: "ssn" })), "not_found");
});

test("export and import: a sealed value moves to a Space on another server wrapped to its key; the plaintext is in neither folder nor in the blob, and only the person's proof and the target's own key open it", async t => {
  const a = await setup(t), b = await setup(t);
  const { ref } = await put(a.s, "123-45-6789");
  const SPACE2 = "spc_testspace0002", REC2 = `vyre://${SPACE2}/contact/c_jane`;
  const from = person(), to = person("per_alex", "deck", SPACE2);
  const key = (await b.s.api.wrapKey({ chain: to })).key;
  assert.equal((await b.s.api.wrapKey({ chain: to })).key, key, "the same key each time");
  const fields = { ref: ref.ref, record: REC, field: "ssn", target_key: key };
  assert.equal(await code(a.s.api.export({ chain: from, ...fields })), "needs_presence", "export needs the person's own proof, as a reveal does");
  assert.equal(await code(a.s.api.export({ chain: withAgent(), ...fields, proof: a.alex.proof(withAgent(), "seal.export", fields) })), "human_only");
  const { blob } = await a.s.api.export({ chain: from, ...fields, proof: a.alex.proof(from, "seal.export", fields) });
  assert.ok(!JSON.stringify(blob).includes("123-45-6789") && !JSON.stringify(blob).includes(Buffer.from("123-45-6789").toString("base64")), "the blob is wrapped");
  const moved = await b.s.api.import({ chain: to, blob, record: REC, field: "ssn" });
  assert.equal(await code(b.s.api.import({ chain: to, blob, record: REC2, field: "ssn" })), "bad_input", "a blob is bound to its record and field");
  // The record's urn changes with the Space: an export may name the target's urn, and then only that one opens it.
  const f2 = { ...fields, to_record: REC2 };
  const w2 = await a.s.api.export({ chain: from, ...f2, proof: a.alex.proof(from, "seal.export", f2) });
  assert.equal(await code(b.s.api.import({ chain: to, blob: w2.blob, record: REC, field: "ssn" })), "bad_input");
  assert.ok((await b.s.api.import({ chain: to, blob: w2.blob, record: REC2, field: "ssn" })).ref.ref);
  assert.equal(await code(a.s.api.import({ chain: from, blob, record: REC, field: "ssn" })), "bad_input", "another server's process cannot open it");
  assert.equal(await code(b.s.api.import({ chain: withAgent(), blob, record: REC, field: "ssn" })), "human_only");
  assert.deepEqual(Object.keys(moved.ref).sort(), ["present", "ref", "sealed", "set_at", "valid_format"]);
  assert.equal(diskHolds(a.dir, "123-45-6789"), null);
  assert.equal(diskHolds(b.dir, "123-45-6789"), null, "no plaintext on the target's disk");
  const proof = b.alex.proof(to, "seal.reveal", { ref: moved.ref.ref, purpose: "check" });
  assert.equal((await b.s.api.reveal({ chain: to, ref: moved.ref.ref, purpose: "check", proof })).value, "123-45-6789", "the target reads it for the person");
});

test("export under one approval: the person's proof once over the move's list, then each listed ref once, to that key only, no proof of its own", async t => {
  const a = await setup(t), b = await setup(t);
  const one = await put(a.s, "123-45-6789"), two = await put(a.s, "987-65-4321", { record: `${REC}2` });
  const SPACE2 = "spc_testspace0002", REC2 = `vyre://${SPACE2}/contact/c_jane`;
  const from = person(), to = person("per_alex", "deck", SPACE2);
  const key = (await b.s.api.wrapKey({ chain: to })).key, other = (await b.s.api.wrapKey({ chain: person("per_alex", "deck", "spc_testspace0003") })).key;
  const call = (ref, over = {}) => a.s.api.export({ chain: from, ref, record: REC, to_record: REC2, field: "ssn", target_key: key, plan_hash: "up1", ...over });
  assert.equal(await code(call(one.ref.ref)), "needs_presence", "no approval yet: no export");
  const refs = [one.ref.ref, two.ref.ref].sort(), fields = { plan_hash: "up1", target_key: key, refs };
  assert.equal(await code(a.s.api.exportApprove({ chain: from, ...fields })), "needs_presence", "the approval is the person's own proof");
  assert.equal(await code(a.s.api.exportApprove({ chain: withAgent(), ...fields, proof: a.alex.proof(withAgent(), "seal.export_approve", fields) })), "human_only");
  assert.equal((await a.s.api.exportApprove({ chain: from, ...fields, proof: a.alex.proof(from, "seal.export_approve", fields) })).approved, 2);
  assert.equal(await code(call(one.ref.ref, { target_key: other })), "needs_presence", "only the approved key");
  assert.equal(await code(call("seal_notonthelist")), "needs_presence", "only a ref on the list");
  assert.equal(await code(call(one.ref.ref, { plan_hash: "up2" })), "needs_presence", "only that move");
  assert.equal(await code(a.s.api.export({ chain: withAgent(), ref: one.ref.ref, record: REC, to_record: REC2, field: "ssn", target_key: key, plan_hash: "up1" })), "human_only");
  const { blob } = await call(one.ref.ref);
  assert.equal(await code(call(one.ref.ref)), "needs_presence", "each ref once");
  assert.ok((await b.s.api.import({ chain: to, blob, record: REC2, field: "ssn" })).ref.ref);
  assert.ok((await call(two.ref.ref)).blob, "the other listed ref still goes");
  assert.equal(diskHolds(b.dir, "123-45-6789"), null);
});
