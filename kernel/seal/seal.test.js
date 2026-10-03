import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CLASSES, luhn, aba, ssn, itin, iban } from "./classes.js";
import { normalize, normalized } from "./normalize.js";
import { detect, sanitize } from "./detect.js";
import { createSealClient, sealFlags } from "./client.js";
import { createSeal, SEAL_ACTIONS } from "./index.js";
import { createModelDoor, MODEL_ACTIONS } from "../model/door.js";
import { createAuthorizer } from "../core/authorize.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder, chainHash } from "../core/chain.js";
import { canonical, sha256 } from "../core/canonical.js";
import { createGateway } from "../gateway/index.js";
import { createMemoryStore } from "../store/memory.js";
import { CONTACT } from "../conformance/suite.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const SSN = "123-45-6789", REC = `vyre://${SPACE}/contact/0190c3f2-1111-4abc-8def-000000000001`, OTHER = `vyre://${SPACE}/contact/0190c3f2-1111-4abc-8def-000000000002`;
let T = 1_800_000_000_000;
const clock = () => ++T;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "seal-test-"));

// ---- classes, normaliser, detectors ----
test("classes: checksums accept real shapes and refuse near misses", () => {
  assert.ok(luhn("4111111111111111") && !luhn("4111111111111112"));
  assert.ok(aba("021000021") && !aba("021000022"));
  assert.ok(ssn("123456789") && !ssn("000456789") && !ssn("666456789") && !ssn("923456789") && !ssn("123006789") && !ssn("123450000"));
  assert.ok(itin("912701234") && !itin("912301234"));
  assert.ok(iban("GB82 WEST 1234 5698 7654 32") && !iban("GB82 WEST 1234 5698 7654 33"));
  assert.equal(CLASSES["us-ssn"].valid("123-45-6789"), true);
  assert.equal(CLASSES["us-ssn"].valid("111-11-111"), false);
  assert.equal(CLASSES["us-ein"].valid("12-3456789"), true);
  for (const c of ["us-ssn", "us-itin", "us-ein", "card", "bank-account", "routing-number", "iban", "passport", "tax-id", "medical", "free"]) assert.ok(CLASSES[c], c);
});

test("normalise: full-width, digit words and separators map to one form with spans back to the text", () => {
  assert.equal(normalized("１２３－４５－６７８９"), "123456789");
  assert.equal(normalized("one two three"), "123");
  assert.equal(normalized("Ab-12 . 3"), "ab123");
  const n = normalize("x one 2");
  assert.deepEqual([n.norm, n.start, n.end], ["x12", [0, 2, 6], [1, 5, 7]]);
  assert.equal(normalized("someone"), "someone", "a digit word inside a word is just letters");
});

test("detectors: find the common shapes after normalising, replace each with a numbered reference, keep the originals aside", () => {
  const r = sanitize(`My SSN is ${SSN} and card 4111 1111 1111 1111, routing 021000021.`);
  assert.equal(r.text, "My SSN is [sealed: US SSN #1] and card [sealed: card number #1], routing [sealed: routing number #1].");
  assert.deepEqual(r.originals.map(o => o.value), [SSN, "4111 1111 1111 1111", "021000021"]);
  assert.equal(sanitize("ssn: one two three, four five, six seven eight nine").text, "ssn: [sealed: US SSN #1]");
  assert.equal(sanitize("ssn １２３－４５－６７８９ ok").text, "ssn [sealed: US SSN #1] ok");
  assert.match(sanitize("IBAN GB82 WEST 1234 5698 7654 32 and EIN 12-3456789").text, /\[sealed: IBAN #1\].*\[sealed: US EIN #1\]/);
  assert.equal(sanitize("two people 123-45-6789 987-65-4321").detections, 2);
  assert.equal(sanitize("a 123-45-6789 b 123-45-6789").text, "a [sealed: US SSN #1] b [sealed: US SSN #2]");
});

test("detectors: ordinary numbers are left alone (and the limits are real: best effort, lookalikes are flagged)", () => {
  for (const t of ["call 415-555-0134", "on 2024-10-03", "order 20241003", "total 1,234,567.89", "id 12345678901", "version 1.2.3", "no digits at all"]) assert.equal(detect(t).length, 0, t);
  assert.equal(detect("a lookalike 123456780 is flagged").length, 1, "a valid-looking nine digits is flagged: said plainly in the product");
  assert.equal(detect("split 123 45 then later 6789").length, 0, "a number split across other text is a known miss");
});

// ---- the sealing process ----
test("process: put returns metadata only, the vault on disk holds no plaintext, and errors never carry a value", async () => {
  const dir = tmp(), c = createSealClient({ vault_key: Buffer.alloc(32, 9), dir, egress_dir: path.join(dir, "out") });
  const put = await c.put({ record: REC, field: "ssn", class: "us-ssn", value: SSN });
  assert.deepEqual(Object.keys(put.ref).sort(), ["present", "ref", "sealed", "set_at", "valid_format"]);
  assert.equal(put.ref.valid_format, true);
  assert.match(put.ref.ref, /^seal_[0-9a-f-]{36}$/);
  const bad = await c.put({ record: REC, field: "ssn", class: "us-ssn", value: "111-11-111" });
  assert.equal(bad.ref.valid_format, false);
  const hint = await c.put({ record: REC, field: "ssn", class: "us-ssn", value: SSN, hint_allowed: true });
  assert.equal(hint.ref.hint, "6789");
  assert.equal((await c.put({ record: REC, field: "ssn", class: "us-ssn", value: SSN })).ref.hint, undefined, "no hint unless the field allows it");
  await assert.rejects(() => c.put({ record: REC, field: "x", class: "nope", value: SSN }), e => e.code === "invalid_class" && !JSON.stringify(e).includes("6789"));
  await c.close();
  const disk = fs.readFileSync(path.join(dir, "vault.json"), "utf8");
  assert.ok(!disk.includes("123456789") && !disk.includes("123-45") && !disk.includes(SSN), "the vault file is ciphertext (a hint, where a field allows one, is metadata)");
});

test("process: a vault survives a restart under the same key and is unreadable under another", async () => {
  const dir = tmp();
  const a = createSealClient({ vault_key: Buffer.alloc(32, 1), dir });
  const { ref } = (await a.put({ record: REC, field: "ssn", class: "us-ssn", value: SSN })).ref ? { ref: (await a.put({ record: REC, field: "ssn", class: "us-ssn", value: SSN })).ref } : {};
  await a.close();
  const b = createSealClient({ vault_key: Buffer.alloc(32, 1), dir });
  assert.equal((await b.meta({ ref: ref.ref })).record, REC);
  assert.equal((await b.reveal({ ref: ref.ref, purpose: "check" })).value, SSN);
  await b.close();
  const c = createSealClient({ vault_key: Buffer.alloc(32, 2), dir });
  await assert.rejects(() => c.reveal({ ref: ref.ref, purpose: "check" }), { code: "unreadable" });
  await c.close();
});

test("process: use and reveal need the kernel's ticket; forged, changed, expired and replayed tickets are refused", async () => {
  const dir = tmp(), c = createSealClient({ vault_key: Buffer.alloc(32, 3), dir, ticket_ttl_ms: 50 });
  const { ref } = (await c.put({ record: REC, field: "ssn", class: "us-ssn", value: SSN })).ref ? { ref: (await c.put({ record: REC, field: "ssn", class: "us-ssn", value: SSN })).ref } : {};
  const args = { ref: ref.ref, purpose: "p" };
  await assert.rejects(() => c.raw("reveal", args), { code: "no_ticket" });
  await assert.rejects(() => c.raw("reveal", args, { nonce: "n", exp: Date.now() + 1e6, mac: "x" }), { code: "bad_ticket" });
  const good = c.ticket("reveal", args);
  await assert.rejects(() => c.raw("reveal", { ...args, purpose: "other" }, good), { code: "bad_ticket" }, "a ticket is bound to its exact arguments");
  await assert.rejects(() => c.raw("use", args, good), { code: "bad_ticket" }, "and to its operation");
  assert.equal((await c.raw("reveal", args, good)).value, SSN);
  await assert.rejects(() => c.raw("reveal", args, good), { code: "replayed" });
  const old = c.ticket("reveal", args);
  await new Promise(r => setTimeout(r, 80));
  await assert.rejects(() => c.raw("reveal", args, old), { code: "expired" });
  await c.close();
});

test("process: only the declared operations answer, and a dead process fails closed", async () => {
  const c = createSealClient({ vault_key: Buffer.alloc(32, 4) });
  for (const op of ["toString", "hasOwnProperty", "__proto__", "constructor", "nope", "init"]) await assert.rejects(() => c.raw(op, {}), e => ["bad_request", "already_init"].includes(e.code), op);
  c.kill();
  await new Promise(r => setTimeout(r, 100));
  await assert.rejects(() => c.put({ record: REC, field: "f", class: "free", value: "x" }), { code: "unavailable" });
});

test("process: it runs with no child processes, no workers and no read or write outside its folders (Node 22 has no network deny: a known gap, see docs/work/kernel.md)", () => {
  const dir = tmp();
  const probe = [
    "const out = {};",
    "try { require('node:child_process').execSync('id'); out.child = 'ran'; } catch (e) { out.child = e.code; }",
    "try { require('node:fs').readFileSync('/etc/hostname'); out.read = 'ran'; } catch (e) { out.read = e.code; }",
    "try { require('node:fs').writeFileSync('/tmp/seal-probe-' + process.pid, 'x'); out.write = 'ran'; } catch (e) { out.write = e.code; }",
    "try { new (require('node:worker_threads').Worker)('1', { eval: true }); out.worker = 'ran'; } catch (e) { out.worker = e.code; }",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const r = spawnSync(process.execPath, [...sealFlags({ dir }), "-e", probe], { encoding: "utf8" });
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.deepEqual(out, { child: "ERR_ACCESS_DENIED", read: "ERR_ACCESS_DENIED", write: "ERR_ACCESS_DENIED", worker: "ERR_ACCESS_DENIED" });
});

// ---- the API and the door ----
const key = Buffer.alloc(32, 7);
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key, clock, is_person: () => true });
const person = (session = "s1") => chains.fromFacts({ kind: "device", device_key_id: "d1", person: OWNER, session, path: "direct" });
const withService = (name, session) => chains.fromFacts({ kind: "module", module: name, first_party: true, inbound: person(session) });
const agentChain = () => chains.fromFacts({ kind: "agent_session", agent: "kit", session: "s1", thread: "t", vouched: true });
const actor = (kind, id) => ({ kind, id, space: SPACE });
let gid = 0;
const G = (subject, actions) => ({ id: `gr_${String(++gid).padStart(4, "0")}`, space: SPACE, subject: { kind: "actor", actor: subject }, actions, action_set_version: 9, resource: { prefix: `vyre://${SPACE}/*/*` }, conditions: {}, issuer: actor("person", OWNER), source: "test", status: "active", created_at: 0 });

async function rig({ approved = false, providers, sinks = ["summarize"] } = {}) {
  const dir = tmp(), egress = path.join(dir, "out");
  const client = createSealClient({ vault_key: key, dir: path.join(dir, "v"), egress_dir: egress, clock });
  const log = createEventLog({ space: SPACE, clock });
  const grants = [G(actor("person", OWNER), ["seal.*", "model.*", "records.*"]), G(actor("agent", "kit"), ["seal.*", "model.*"]), G(actor("service", "summarize"), ["model.*", "records.read"]), G(actor("service", "rogue"), ["model.*"])];
  const members = new Set([`person:${OWNER}`, "agent:kit", "service:summarize", "service:rogue"]);
  const authorizer = createAuthorizer({
    space: SPACE, actions: [...SEAL_ACTIONS, ...MODEL_ACTIONS], clock,
    grants: { forSubject: a => grants.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: () => undefined },
    members: { has: a => members.has(`${a.kind}:${a.id}`) },
    hasPresenceSession: () => true, verifyPresence: p => p.signature === "good",
  });
  const templates = async (urn, v) => (urn === `vyre://${SPACE}/template/welcome` && v === 1 ? { id: urn, version: 1, body: "Dear client, your SSN is {{ssn}}. Thanks.", slots: ["ssn"], headers: { subject: "Welcome" } } : urn === `vyre://${SPACE}/template/bad` ? { id: urn, version: 1, body: "x {{ssn}}", slots: ["ssn"], headers: { subject: "Your {{ssn}}" } } : null);
  const seal = createSeal({ space: SPACE, client, authorizer, log, clock, templates, approvedTask: () => approved, verifyPresence: p => p.signature === "good" });
  const calls = [];
  const door = createModelDoor({ space: SPACE, providers: providers || { ok: { call: async req => { calls.push(req); return { content: "fine", usage: { input_tokens: 3, output_tokens: 1 } }; } } }, sinks: new Set(sinks), seal: client, authorizer, log, clock });
  const sealed = (await seal.put({ chain: person(), record: REC, field: "ssn", class: "us-ssn", value: SSN })).ref;
  const proofFor = (chain, ref, purpose, over = {}) => ({ signer: "secure_enclave", key_id: "k", payload_hash: sha256(canonical({ op: "reveal", ref, purpose })), decision: "d", chain_hash: chainHash(chain), issued_at: T, expires_at: T + 1e6, nonce: `n${Math.random()}`, signature: "good", ...over });
  return { client, log, seal, door, calls, sealed, egress, proofFor, close: () => client.close() };
}
const everything = log => JSON.stringify(log.read());

test("seal.put: one event, no value anywhere in the log", async () => {
  const r = await rig();
  const ev = r.log.read({ type: "field.sealed" });
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].data.field, ev[0].data.class, ev[0].data.valid_format], ["ssn", "US SSN", true]);
  assert.equal(ev[0].red, "pii");
  assert.ok(!everything(r.log).includes("6789"));
  await r.close();
});

test("seal.use: the module merges at the egress boundary and never sees the value; the output is a sealed derivative", async () => {
  const r = await rig();
  const dest = { kind: "contact_point", record: REC, contact: "jane@example.com", verified: true };
  const res = await r.seal.use({ chain: person(), ref: r.sealed.ref, template: `vyre://${SPACE}/template/welcome`, template_version: 1, slot: "ssn", destination: dest });
  assert.equal(res.merged, true);
  assert.ok(!JSON.stringify(res).includes("6789"));
  const file = path.join(r.egress, res.output_ref.split("/").pop() + ".out");
  assert.equal(fs.readFileSync(file, "utf8"), `Dear client, your SSN is ${SSN}. Thanks.`);
  assert.ok(!everything(r.log).includes("6789"));
  assert.equal(r.log.read({ type: "seal.used" })[0].data.destination, "contact_point");
  await r.close();
});

test("seal.use: another record's contact, an unverified contact, a header slot, an undeclared slot and an unknown template are refused", async () => {
  const r = await rig();
  const use = (over = {}) => r.seal.use({ chain: person(), ref: r.sealed.ref, template: `vyre://${SPACE}/template/welcome`, template_version: 1, slot: "ssn", destination: { kind: "contact_point", record: REC, contact: "j@x.com", verified: true }, ...over });
  await assert.rejects(() => use({ destination: { kind: "contact_point", record: OTHER, contact: "j@x.com", verified: true } }), { code: "needs_approval" });
  await assert.rejects(() => use({ destination: { kind: "contact_point", record: REC, contact: "j@x.com", verified: false } }), { code: "needs_approval" });
  await assert.rejects(() => use({ destination: { kind: "document", record: OTHER, document: `vyre://${SPACE}/doc/1` } }), { code: "needs_approval" });
  await assert.rejects(() => use({ template: `vyre://${SPACE}/template/bad` }), { code: "slot_not_in_body" });
  await assert.rejects(() => use({ slot: "dob" }), { code: "bad_slot" });
  await assert.rejects(() => use({ template: `vyre://${SPACE}/template/none` }), { code: "not_found" });
  assert.equal((await use({ destination: { kind: "document", record: REC, document: `vyre://${SPACE}/doc/1` } })).merged, true);
  assert.equal(fs.readdirSync(r.egress).length, 1, "only the allowed use wrote anything");
  await r.close();
});

test("seal.use from a model's plan is always an Ask; a checker's approval of that exact payload lets it through", async () => {
  const dest = { kind: "contact_point", record: REC, contact: "j@x.com", verified: true };
  const call = r => r.seal.use({ chain: agentChain(), ref: r.sealed.ref, template: `vyre://${SPACE}/template/welcome`, template_version: 1, slot: "ssn", destination: dest, task: "task_1" });
  const no = await rig({ approved: false });
  await assert.rejects(() => call(no), e => e.code === "needs_approval" && e.class === "US SSN" && e.decision.startsWith("dec_"));
  assert.equal(fs.readdirSync(no.egress).length, 0);
  await no.close();
  const yes = await rig({ approved: true });
  assert.equal((await call(yes)).merged, true);
  await yes.close();
});

test("seal.reveal is human-only: one person, a proof over this reveal, never twice", async () => {
  const r = await rig();
  const ref = r.sealed.ref, purpose = "confirm with client";
  const p = person();
  await assert.rejects(() => r.seal.reveal({ chain: agentChain(), ref, purpose, proof: r.proofFor(agentChain(), ref, purpose) }), { code: "chain_not_person" });
  await assert.rejects(() => r.seal.reveal({ chain: withService("summarize"), ref, purpose, proof: r.proofFor(withService("summarize"), ref, purpose) }), { code: "chain_not_person" });
  await assert.rejects(() => r.seal.reveal({ chain: p, ref, purpose, proof: undefined }), { code: "needs_presence" });
  await assert.rejects(() => r.seal.reveal({ chain: p, ref, purpose, proof: r.proofFor(p, ref, "a different purpose") }), { code: "needs_presence" });
  await assert.rejects(() => r.seal.reveal({ chain: p, ref, purpose, proof: r.proofFor(agentChain(), ref, purpose) }), { code: "needs_presence" }, "a proof for another chain");
  await assert.rejects(() => r.seal.reveal({ chain: p, ref, purpose, proof: r.proofFor(p, ref, purpose, { expires_at: 1 }) }), { code: "needs_presence" });
  await assert.rejects(() => r.seal.reveal({ chain: p, ref, purpose, proof: r.proofFor(p, ref, purpose, { signature: "forged" }) }), { code: "needs_presence" });
  await assert.rejects(() => r.seal.reveal({ chain: p, ref, purpose: " ", proof: r.proofFor(p, ref, " ") }), { code: "bad_input" });
  const proof = r.proofFor(p, ref, purpose);
  const res = await r.seal.reveal({ chain: p, ref, purpose, proof });
  assert.equal(res.value, SSN);
  await assert.rejects(() => r.seal.reveal({ chain: p, ref, purpose, proof }), { code: "needs_presence" }, "a proof is single use");
  const ev = r.log.read({ type: "field.revealed" });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.purpose, purpose);
  assert.equal(ev[0].red, "privileged");
  assert.ok(!everything(r.log).includes("6789"));
  await r.close();
});

test("the door: a value the session revealed cannot go to a model in any form, and the provider is never called", async () => {
  const r = await rig();
  const p = person("sess-A"), ref = r.sealed.ref;
  await r.seal.reveal({ chain: p, ref, purpose: "look", proof: r.proofFor(p, ref, "look") });
  const ask = (text, chain = withService("summarize", "sess-A")) => r.door.call({ chain, purpose: "summary", provider: "ok", model: "m", messages: [{ role: "user", content: text }] });
  for (const text of [`the ssn is ${SSN}`, "the ssn is 123456789", "ssn 123 45 6789", "ssn １２３－４５－６７８９", "ssn one two three four five six seven eight nine", "SSN=123.45.6789!"]) {
    await assert.rejects(() => ask(text), { code: "ledger_hit" }, text);
  }
  assert.equal(r.calls.length, 0);
  assert.equal((await ask("hello there")).content, "fine");
  assert.equal((await r.door.call({ chain: withService("summarize", "sess-B"), purpose: "summary", provider: "ok", model: "m", messages: [{ role: "user", content: SSN }] })).content, "fine", "another session did not resolve it (the detector still replaces it)");
  const refusals = r.log.read({ type: "model.refused" });
  assert.equal(refusals.length, 6);
  assert.ok(!everything(r.log).includes("6789"), "a refusal names the class, never the text");
  await r.client.endSession({ session: "sess-A" });
  assert.equal((await ask("123456789")).content, "fine", "the ledger ended with the session");
  await r.close();
});

test("the door: detectors replace what they find, the provider sees only the sanitised text, and only the log of the call is kept", async () => {
  const r = await rig();
  const res = await r.door.call({ chain: withService("summarize", "s9"), purpose: "summary", provider: "ok", model: "m", messages: [{ role: "system", content: "be brief" }, { role: "user", content: `client says ${SSN} and card 4111 1111 1111 1111` }] });
  assert.equal(res.content, "fine");
  assert.deepEqual(r.calls[0].messages.map(m => m.content), ["be brief", "client says [sealed: US SSN #1] and card [sealed: card number #1]"]);
  assert.equal((await r.client.stashed({ session: "s9" })).n, 2);
  const ev = r.log.read({ type: "model.called" })[0];
  assert.equal(ev.data.detections, 2);
  assert.ok(!everything(r.log).includes("4111") && !everything(r.log).includes("6789") && !everything(r.log).includes("be brief"));
  // what a detector took out of a prompt is now the session's: it cannot come back in a later message
  await assert.rejects(() => r.door.call({ chain: withService("summarize", "s9"), purpose: "summary", provider: "ok", model: "m", messages: [{ role: "user", content: `again: ${SSN}` }] }), { code: "ledger_hit" });
  await r.client.endSession({ session: "s9" });
  assert.equal((await r.client.stashed({ session: "s9" })).n, 0, "what the detectors took is erased with the session");
  await r.close();
});

test("the door: a service that is not a declared sink, a provider the Space does not allow, and a hand-made chain are refused", async () => {
  const r = await rig();
  const call = (chain, provider = "ok") => r.door.call({ chain, purpose: "summary", provider, model: "m", messages: [{ role: "user", content: "hi" }] });
  await assert.rejects(() => call(withService("rogue")), { code: "not_a_sink" });
  assert.equal((await call(person())).content, "fine");
  assert.equal((await call(withService("summarize"))).content, "fine");
  await assert.rejects(() => call(withService("summarize"), "elsewhere"), { code: "residency" });
  await assert.rejects(() => call({ hops: [], space: SPACE }), { code: "bad_input" });
  assert.equal(r.calls.length, 2);
  const closed = createModelDoor({ space: SPACE, providers: { ok: { call: async () => ({ content: "x" }) } }, sinks: new Set(["summarize"]), seal: r.client, authorizer: createAuthorizer({ space: SPACE, actions: MODEL_ACTIONS, grants: { forSubject: () => [G(actor("person", OWNER), ["model.*"])], get: () => undefined }, members: { has: () => true }, clock }), log: r.log, residency: { providers: ["other"] }, clock });
  await assert.rejects(() => closed.call({ chain: person(), purpose: "other", provider: "ok", model: "m", messages: [] }), { code: "residency" });
  await r.close();
});

test("a summary button on a record with a sealed SSN sends a placeholder: a declared sink or a model in the chain never gets the reference", async () => {
  const store = createMemoryStore({ clock });
  const log = createEventLog({ space: SPACE, clock });
  const grants = [G(actor("person", OWNER), ["records.*"]), G(actor("service", "summarize"), ["records.read"]), G(actor("agent", "kit"), ["records.read"])];
  const members = new Set([`person:${OWNER}`, "service:summarize", "agent:kit"]);
  const gw = createGateway({ space: SPACE, store, log, chains, clock, sinks: new Set(["summarize"]), grants: { forSubject: a => grants.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: () => undefined }, members: { has: a => members.has(`${a.kind}:${a.id}`) }, hasPresenceSession: () => true });
  await gw.records.define(person(), { add_types: [CONTACT] });
  const ref = { sealed: "US SSN", ref: "seal_x", present: true, valid_format: true, set_at: 1 };
  const c = await gw.records.create(person(), "contact", { name: "Jane", ssn: ref });
  assert.equal((await gw.records.get(person(), "contact", c.id)).data.ssn.ref, "seal_x");
  const viaSink = await gw.records.get(withService("summarize"), "contact", c.id);
  assert.deepEqual(viaSink.data.ssn, { sealed: "US SSN", present: true, valid_format: true });
  const viaAgent = await gw.records.get(agentChain(), "contact", c.id);
  assert.equal("ref" in viaAgent.data.ssn, false);
  const listed = await gw.records.query(withService("summarize"), "contact", { page: { limit: 5 } });
  assert.equal("ref" in listed.rows[0].data.ssn, false);
});
