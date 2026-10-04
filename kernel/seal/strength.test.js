import "../../scripts/mac-test-guard.mjs";
// @ts-check
// PW-1: presence has a strength and the SERVER decides it. A software key is accepted for a presence-required act only where a dev switch is on, marked method software; on a release-kind server it is refused with one
// code (software_key) for every act; a client that claims hardware without an attestation is enrolled as software; one rule (strength.js) serves the sealing process and the registry's presence option.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startSealer } from "./client.js";
import { strengthOf, strengthRefusal, methodOf, strengthOfMethod, SOFTWARE_KEY } from "./strength.js";
import { person, signer, tmp, enrolDevice } from "./testing.js";

const code = (/** @type {Promise<any>} */ p) => p.then(() => null, e => e.code);

test("the one rule: hardware always satisfies presence, software only behind a dev switch, and the marks are fixed", () => {
  assert.equal(strengthOf(true), "hardware"); assert.equal(strengthOf(false), "software"); assert.equal(strengthOf(undefined), "software");
  assert.equal(strengthRefusal("hardware", false), null); assert.equal(strengthRefusal("software", true), null);
  assert.equal(strengthRefusal("software", false), SOFTWARE_KEY); assert.equal(strengthRefusal("anything-else", false), SOFTWARE_KEY, "an unknown strength is software");
  assert.deepEqual([methodOf("hardware"), methodOf("software")], ["attested", "software"]);
});

test("a client's claim of hardware changes nothing: the key is enrolled as software, and says so", async t => {
  const dir = tmp("str1"), s = startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true });
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const sg = signer("per_alex"), ch = person("per_alex"), e = sg.enrolment;
  const { token } = await s.begin({ chain: ch, person: "per_alex", key_id: e.key_id, spki: e.spki });
  const r = await s.enrol({ chain: ch, person: "per_alex", key_id: e.key_id, spki: e.spki, signer: e.signer, token, attested: true, hardware: true, strength: "hardware", storage: "secure_enclave" });
  assert.deepEqual([r.attested, r.strength], [false, "software"]);
});

test("dev: a software key satisfies an invite and a role change and the use is marked method software; release: the same proofs are refused with software_key, whatever the act", async t => {
  const fsx = fs, root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/%20/g, " ")), "..", "..");
  const dir = tmp("str2"), dev = startSealer({ dir, timeoutMs: 8000, dev: true, software: true });
  const alex = signer("per_alex", undefined, "software"), ch = person("per_alex");
  await enrolDevice(dev, alex);
  await dev.health(); await new Promise(r => setTimeout(r, 50));
  const acts = [["grant.invite", { resource: "vyre://spc_aaaaaaaaaaaa/invite/new", input_hash: "h1" }], ["grant.role", { resource: "vyre://spc_aaaaaaaaaaaa/member/per_bob", input_hash: "h2" }], ["grant.host", { resource: "vyre://spc_aaaaaaaaaaaa/host/here", input_hash: "h3" }], ["task.decide", { task: "t1", payload_hash: "ph", decision: "d" }]];
  for (const [op, fields] of acts) assert.deepEqual(await dev.presenceProve({ chain: ch, op, fields, proof: alex.proof(ch, op, fields) }), { ok: true, method: "software", strength: "software" }, op);
  await dev.close();
  // a release-stamped copy of the tree, the same seal folder (the key is on disk), the dev switches forwarded
  const copy = fsx.mkdtempSync(path.join(os.tmpdir(), "relstr-")); t.after(() => { fsx.rmSync(copy, { recursive: true, force: true }); fsx.rmSync(dir, { recursive: true, force: true }); });
  for (const d of ["kernel", "lib"]) fsx.cpSync(path.join(root, d), path.join(copy, d), { recursive: true, filter: f => !/\.test\.js$/.test(f) });
  fsx.writeFileSync(path.join(copy, "package.json"), '{"type":"module"}');
  fsx.writeFileSync(path.join(copy, "lib", "build-kind.js"), 'export const BUILD_KIND = "release";\n');
  const { startSealer: startCopy } = await import(pathToFileURL(path.join(copy, "kernel", "seal", "client.js")).href);
  const rel = startCopy({ dir, timeoutMs: 8000, dev: true, software: true, unattested: true });
  t.after(async () => { await rel.close(); });
  await rel.health(); await new Promise(r => setTimeout(r, 50));
  for (const [op, fields] of acts) assert.equal((await rel.presenceProve({ chain: ch, op, fields, proof: alex.proof(ch, op, fields) })).code, SOFTWARE_KEY, op);
  assert.equal(await code(rel.anchor.reset({ chain: ch, proof: alex.proof(ch, "anchor.reset", {}) })), SOFTWARE_KEY, "anchor.reset too: every presence-required act uses the same check");
});

test("each dev switch admits only its own kind of key: VYRE_SEAL_SOFTWARE a software-class key and nothing else, VYRE_SEAL_UNATTESTED an unattested hardware-class key and nothing else", async t => {
  const dir = tmp("str3"), both = startSealer({ dir, timeoutMs: 8000, dev: true, software: true, unattested: true });
  const soft = signer("per_alex", undefined, "software"), hw = signer("per_alex", undefined, "secure_enclave"), ch = person("per_alex");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await enrolDevice(both, soft);
  await enrolDevice(both, hw, { existing: soft });
  await both.close();
  const fields = { k: "v" }, op = "task.decide";
  const ask = async (/** @type {any} */ o, /** @type {any} */ sg) => { const s = startSealer({ dir, timeoutMs: 8000, dev: true, ...o }); try { await s.health(); await new Promise(r => setTimeout(r, 50)); return await s.presenceProve({ chain: ch, op, fields, proof: sg.proof(ch, op, fields) }); } finally { await s.close(); } };
  assert.equal((await ask({ software: true }, soft)).ok, true, "software switch: the software key");
  assert.equal((await ask({ software: true }, hw)).code, SOFTWARE_KEY, "software switch: an unattested hardware-class key is refused");
  assert.equal((await ask({ unattested: true }, hw)).ok, true, "unattested switch: the unattested hardware-class key");
  assert.equal((await ask({ unattested: true }, soft)).code, SOFTWARE_KEY, "unattested switch: a software-class key is refused");
  assert.equal((await ask({}, soft)).code, SOFTWARE_KEY); assert.equal((await ask({}, hw)).code, SOFTWARE_KEY, "no switch: neither");
});

test("by method (the registry's presence): the methods that need a person's gesture count as hardware, a device-method file key and anything unknown are software", () => {
  for (const m of ["touchid", "capsule", "passkey", "tty", "code"]) { assert.equal(strengthOfMethod(m), "hardware", m); assert.equal(strengthRefusal(strengthOfMethod(m), false), null, m); }
  for (const m of ["device", "grant", "", "whatever"]) { assert.equal(strengthOfMethod(m), "software", m); assert.equal(strengthRefusal(strengthOfMethod(m), false), SOFTWARE_KEY, m); assert.equal(strengthRefusal(strengthOfMethod(m), true), null, `${m} on dev`); }
});

test("a presence session inherits the method that opened it: touchid or the terminal code keep satisfying presence; a device-opened session is software (refused on release, accepted on dev); an old session with no opener is software", () => {
  for (const opener of ["touchid", "capsule", "passkey", "tty", "code"]) { assert.equal(strengthOfMethod("session", opener), "hardware", opener); assert.equal(strengthRefusal(strengthOfMethod("session", opener), false), null, `session opened by ${opener}`); }
  assert.equal(strengthOfMethod("session", "device"), "software"); assert.equal(strengthRefusal(strengthOfMethod("session", "device"), false), SOFTWARE_KEY, "release"); assert.equal(strengthRefusal(strengthOfMethod("session", "device"), true), null, "dev");
  for (const none of [undefined, null, "", "session", "unknown"]) { assert.equal(strengthOfMethod("session", /** @type {any} */ (none)), "software", `opener ${String(none)}`); assert.equal(strengthRefusal(strengthOfMethod("session", /** @type {any} */ (none)), false), SOFTWARE_KEY); }
});
