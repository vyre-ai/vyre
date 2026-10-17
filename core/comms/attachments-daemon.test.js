// @ts-check
// The roadmap test for email (0.6 item 8) on a real vyred with the kernel on: a real Flow runs a real Documents step (the template is filed in the real Drive and filled), then its email step goes out with
// CC, BCC, a file from Files and that document. The Flow asks the person before the outward step and the test answers with a presence proof (as core/appmods/docuseal-live.test.js). The real Gate holds it, a person approves it, the real hash and access checks run at the
// release; only the outside provider is a stand-in (lib/http.js testHooks.fetch, which only a test process may set). The hand-off from the Flow's own yes to the Gate's hold and the attachment checks is the seam this test covers. The held message and the sent request show everything, the file bytes are only in the one request that sends, and a file changed after approval stops the send.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { docx } from "../documents/testing/docx.js";
import { canonical } from "../../kernel/core/canonical.js";
import { testHooks } from "../../lib/http.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
/** The owner's presence for a test box: the proof must name this op and these exact fields, once (as core/appmods/docuseal-live.test.js). */
const stubPresence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; };
const until = async (/** @type {() => any} */ fn, /** @type {string} */ what, ms = 30_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 50)); } };
const b64 = (/** @type {Buffer | Uint8Array} */ b) => Buffer.from(b).toString("base64");

test("a Flow sends CC, BCC, a file from Files and a document its Documents step made, through the real Gate and Drive", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  /** @type {any[]} */ const posted = [];
  testHooks.fetch = async (url, init) => { posted.push({ url: String(url), body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ id: "re_msg_1" }), { status: 200, headers: { "content-type": "application/json" } }); };
  t.after(() => { testHooks.fetch = null; });
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: stubPresence() });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  const owner = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: (await K.surfaces.open(ownerChain, {})).token });
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await owner(tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };

  // the sending service the Space connected (its key is in the Vault, granted to Comms), the template in the Drive, and a file in Files
  await ok("vault.put", { name: "comms-sending", kind: "env-set", fields: { service: "resend", api_key: "re_live_TEST_KEY_0001", from: "Harlow Law <hello@harlow.example>", domain: "harlow.example" } });
  await ok("vault.grant", { name: "comms-sending", module: "comms" });
  await ok("documents.template.add", { name: "Letter", base64: b64(docx(["Dear {client.name},", "Your engagement letter is attached."])) });
  const rota = Buffer.from("%PDF-ROTA-WEEK-1");
  await ok("files.drive.upload", { path: "Rota/week1.pdf", base64: b64(rota) });

  // the Flow, turned on: a real Documents step, then the email, whose files are a path in Files and the path the Documents step made. The person's one yes is given here, when the Flow is approved
  // (its steps, its destinations and its limits); runs then ask nothing.
  const baseInput = { to: "dana@northwind-bakery.example", cc: ["ops@harlow.example"], bcc: ["alex@harlow.example"], subject: "Your engagement letter and the rota", text: "Both are attached.",
    attachments: [{ path: "Rota/week1.pdf", name: "Rota week 1.pdf" }, { path: { expr: "steps.letter.path" } }] };
  const step = (/** @type {any} */ extra = {}) => ({ id: "mail", kind: "call", action: "comms.email", resource: "vyre://space/comms", input: baseInput, ...extra });
  const letter = { id: "letter", kind: "call", action: "documents.generate", resource: "vyre://space/documents", input: { template: "Letter", name: "Engagement letter", values: { client: { name: "Dana Harlow" } } } };
  const host = () => /** @type {any} */ (d.registry.deps).flowsHost.get(K.id.space);
  const turnOn = async (/** @type {string} */ name, /** @type {any} */ mail) => {
    const def = await ok("flows.define", { flow: { format: 1, name, label: name, authorship: "human", trigger: { on: "manual" }, steps: [letter, mail] } });
    assert.ok(def.ok, JSON.stringify(def.errors || def));
    await host().flows.tools["flows.approve"](host().personChain(), { id: def.id, version: def.version, hash: def.hash });
    return def;
  };
  const admin = ownerChain;
  const questions = async () => (await K.gateway.ask.list(admin, { state: ["needs_check"] })).filter((/** @type {any} */ x) => x.form && x.form.kind === "held_act");
  const startRun = async (/** @type {any} */ def) => { const r = await ok("flows.start", { id: def.id }); return String(r.id || (r.run && r.run.id) || r.run); };
  const finalState = async (/** @type {string} */ run) => until(async () => { const r = (await ok("flows.run", { run })).run; return ["done", "failed"].includes(r.state) ? r : null; }, "the run to finish");

  // run one, a turned-on Flow: it sends with no question at all, to the destinations the person turned it on with
  const on = await turnOn("engagement_letter", step());
  const run1 = await startRun(on);
  const done = await finalState(run1);
  assert.equal(done.state, "done", JSON.stringify(done.error || done));
  assert.deepEqual(await questions(), [], "a turned-on Flow's outward step asks nobody");
  assert.equal(posted.length, 1, "the email went out");
  assert.deepEqual(await ok("gate.held"), [], "and nothing waits at the Gate");
  const body = posted[0].body;
  assert.deepEqual([body.cc, body.bcc], [["ops@harlow.example"], ["alex@harlow.example"]], "CC and BCC go out");
  const docPath = String(done.steps.letter.output.path);
  assert.match(docPath, /^Documents\/general\/engagement-letter-[0-9a-f]{8}\.docx$/, "the file the Documents step made");
  const docBytes = Buffer.from(await K.gateway.drive.get(ownerChain, docPath));
  assert.deepEqual(body.attachments, [{ filename: "Rota week 1.pdf", content: b64(rota) }, { filename: docPath.split("/").pop(), content: b64(docBytes) }], "both files go out, byte for byte");
  const logged = d.registry.deps.events.since(0, { limit: 5000 }).find((/** @type {any} */ e) => e.type === "comms.sent");
  assert.deepEqual(logged.payload.files.map((/** @type {any} */ f) => [f.name, f.size, f.sha256]), [["Rota week 1.pdf", rota.length, crypto.createHash("sha256").update(rota).digest("hex")], [docPath.split("/").pop(), docBytes.length, crypto.createHash("sha256").update(docBytes).digest("hex")]], "the log shows names, sizes and hashes of what was sent");

  // a recipient the person did not turn the Flow on for asks, even in a turned-on Flow: CC counts as a destination
  const sneaky = await turnOn("sneaky_cc", step({ input: { to: "dana@northwind-bakery.example", cc: { expr: "trigger.cc" }, subject: "s", text: "t" } }));
  await startRun(sneaky);
  await until(async () => (await questions()).length === 1, "the question for a CC that is not on the allow list");
  assert.equal(posted.length, 1, "nothing went out for it");

  // a step the author marked as needing approval asks once, with the files on the card, and a file that changed before the yes stops the send
  const marked = await turnOn("approve_each", step({ approve: true }));
  const run3 = await startRun(marked);
  const card = await until(async () => (await questions()).find((/** @type {any} */ x) => x.form.step === "mail" && x.form.run === run3), "the author's own question");
  const shown = card.form.input;
  assert.deepEqual(shown.attachments.map((/** @type {any} */ a) => [a.name, a.size]), [["Rota week 1.pdf", rota.length], [docPath.split("/").pop(), docBytes.length]], "the card names the files and their sizes");
  assert.ok(shown.attachments.every((/** @type {any} */ a) => /^[0-9a-f]{64}$/.test(a.sha256)), "and carries their hashes");
  await ok("files.drive.upload", { path: "Rota/week1.pdf", base64: b64(Buffer.from("%PDF-ROTA-WEEK-2-EDITED")), base: 1 });
  const row = await K.gateway.ask.get(admin, card.id);
  await K.gateway.ask.decide(admin, card.id, { outcome: "approved", proof: { op: "task.decide", fields: { task: card.id, payload_hash: row.payload.payload_hash, decision: row.payload.decision }, n: Math.random() } });
  const failed = await finalState(run3);
  assert.equal(failed.state, "failed");
  assert.match(JSON.stringify(failed), /Rota week 1\.pdf changed after you approved this message, so nothing was sent\. Approve it again\./);
  assert.equal(posted.length, 1, "nothing more went out");
});
