// @ts-check
// Contract test for team/contracts/one-yes.md (v1): lib/one-yes.js, the registry's hold and the covered mark on a real daemon, against the fixtures a consumer builds with.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../../core/daemon/index.js";
import { yes, momentOf, MOMENTS, YES_REASONS, MOMENT_OPS, REUSE_OPS, opFitsMoment } from "../../lib/one-yes.js";
import { coveredRide } from "../../core/modules/index.js";
import { COVERED } from "../../lib/covered.js";
import { tempHome, present, asOwner } from "../helpers.js";
import { moments, reasons, heldError, refusedError, manifestEntry, receiptKinds, yesResults, coveredMark, limits, shapeDiff } from "./one-yes.fixtures.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("one-yes v1: three moments, six reasons, and a yes is checked by the one verifier: real keys stand, a software key stands only where the build takes it, anything else is refused", async () => {
  assert.deepEqual([...MOMENTS], moments);
  assert.deepEqual([...YES_REASONS], reasons);
  const request = { op: "vault.reveal", fields: { name: "stripe" } };
  assert.deepEqual(await yes("vault", request, { sig: "x" }, { verify: async () => ({ ok: true, strength: "real" }) }), yesResults.ok);
  assert.deepEqual(await yes("vault", request, { sig: "x" }, { verify: async () => ({ ok: true, strength: "software" }), softwareOk: () => false }), yesResults.refused);
  assert.deepEqual(await yes("vault", request, { sig: "x" }, { verify: async () => ({ ok: true, strength: "software" }), softwareOk: () => true }), { ok: true, strength: "software" });
  assert.deepEqual(await yes("vault", request, { sig: "x" }, { verify: async () => "expired" }), { ok: false, reason: "expired" });
  assert.deepEqual(await yes("vault", request, { sig: "x" }, { verify: async () => { throw new Error("down"); } }), { ok: false, reason: "no_proof" }, "a verifier that fails closes the door");
  assert.deepEqual(await yes("vault", request, undefined, { verify: async () => null }), { ok: false, reason: "no_proof" });
  assert.deepEqual(await yes("elsewhere", request, { sig: "x" }, { verify: async () => null }), { ok: false, reason: "wrong_request" });
  assert.deepEqual(await yes("vault", { op: "Bad Op", fields: {} }, { sig: "x" }, { verify: async () => null }), { ok: false, reason: "wrong_request" });
});

test("one-yes v1: the moments cover an explicit list of tools, never a prefix; an outward tool is whatever a manifest marks outward", () => {
  assert.equal(momentOf("vault.reveal"), "vault");
  assert.equal(momentOf("presence.enroll"), "pair");
  assert.equal(momentOf("vault.delete"), "vault");
  assert.equal(momentOf("vault.list"), null, "a name that merely begins like a vault tool is no moment");
  assert.equal(momentOf("mail.send", n => n === "mail.send"), "outward");
  assert.equal(momentOf("mail.send"), null, "with no registry to ask, nothing is outward");
  assert.equal(momentOf("gate.approve"), "outward", "the Gate's own approve is a send as you");
  assert.equal(opFitsMoment("pair", "vault.reveal"), false);
  assert.ok(MOMENT_OPS.vault.includes("vault.reveal") && MOMENT_OPS.pair.includes("spaces.devices.lend"));
  assert.deepEqual([...REUSE_OPS], ["vault.reveal", "vault.copy", "vault.totp"]);
});

test("one-yes v1: a tool marked outward holds a model's call as a card, a retry with a card nobody approved is refused, and a tool that names what it files rides its card", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", modules: { disable: ["agents", "computers"] } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller = "cli", /** @type {any} */ meta) => d.registry.call(tool, input, caller, meta);

  const held = await call("mail.send", { to: "a@example.com", subject: "x", body: "y" }, "mcp:agent:kit");
  assert.equal(shapeDiff(held.error, heldError), "", JSON.stringify(held));
  assert.match(held.error.approval, /^ap_/); assert.match(held.error.group, /^gp_/);
  assert.match(held.error.message, /Nothing ran/);
  assert.ok(held.error.message.includes(held.error.approval), "the message tells the model what to retry with");
  // the same call again is the same card, not a second one
  const twice = await call("mail.send", { to: "a@example.com", subject: "x", body: "y" }, "mcp:agent:kit");
  assert.equal(twice.error.approval, held.error.approval);
  // a retry with a card nobody approved does not run, and says so in the shape the contract promises
  const retry = await call("mail.send", { to: "a@example.com", subject: "x", body: "y" }, "mcp:agent:kit", { approval: held.error.approval });
  assert.equal(shapeDiff(retry.error, { code: refusedError.code, message: refusedError.message }), "", JSON.stringify(retry));
  assert.equal(retry.error.code, "approval_refused");
  assert.equal((await call("mail.send", { to: "a@example.com", subject: "x", body: "y" }, "mcp:agent:kit", { approval: "ap_unknown" })).error.code, "approval_refused");
  // the card belongs to its asker: another asker's retry is refused, and the Gate's own tools answer only the Gate
  assert.equal((await call("mail.send", { to: "a@example.com", subject: "x", body: "y" }, "mcp:agent:juno", { approval: held.error.approval })).error.code, "approval_refused");
  assert.ok((await call("approvals.cover", { card: held.error.approval, tool: "mail.send", input_sha256: "a".repeat(32), asker: "mcp:agent:kit" }, "cli")).error, "only the Gate asks whether a card covers a send");
  assert.ok((await call("approvals.hold", { tool: "mail.send", fields: {}, from: "x" }, "cli")).error, "only the registry holds a call");

  // the manifests of the tools that file other outward tools say so, and the ride is the registry's own rule
  const entry = (/** @type {string} */ name) => d.registry.tools.get(name);
  assert.deepEqual(entry("comms.send").covers, manifestEntry.covers);
  assert.equal(entry("comms.send").outward, true);
  assert.deepEqual(entry("mail.send").covers, ["google.mail.send", "mcp.call"]);
  const docs = JSON.parse(fs.readFileSync(new URL("../../core/documents/module.json", import.meta.url), "utf8")).does.tools;
  assert.ok(docs.find((/** @type {any} */ x) => x.name === "documents.send").covers.includes("comms.send"), "Documents files its sends through Comms in the same act");
  for (const name of ["documents.send", "documents.send-signed"]) assert.deepEqual(docs.find((/** @type {any} */ x) => x.name === name).covers, ["comms.send", ...manifestEntry.covers], `${name} names the whole way out`);
  for (const [, def] of d.registry.tools) if (def.covers) assert.ok(def.covers.length <= limits.coversMax, `${def.name} names at most ${limits.coversMax} tools`);
  const tools = d.registry.tools;
  const cur = { [COVERED]: { ...coveredMark, via: [] } };
  const ride = coveredRide(tools, cur, "mail.send", "module:comms");
  assert.deepEqual(ride && ride.via, ["mail"], "the mark gains the module the nested tool belongs to");
  assert.equal(coveredRide(tools, cur, "mail.send", "module:other"), null, "only the covered tool's module (or one it passed the mark to) rides it");
  assert.equal(coveredRide(tools, cur, "gate.request", "module:comms"), null, "a tool the covered one did not name is held again");
});

test("one-yes v1.1: a Flow's spent task and a person's confirmed preview are receipts: only the registry records one, only a receipt's own kind of id, and the Gate uses it once for the tool, digest and asker it names", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", modules: { disable: ["agents", "computers"] } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const tool = (/** @type {string} */ name) => d.registry.tools.get(name);
  const mine = { tool: "comms.send", input_sha256: coveredMark.input_sha256, asker: "module:flows>deck" };
  const receipt = (/** @type {any} */ input, caller = "module:registry") => tool("approvals.receipt").run(input, { caller });
  const cover = (/** @type {any} */ input) => tool("approvals.cover").run(input, { caller: "module:gate" });

  // anyone but the registry is refused, through the registry's own call path too
  await assert.rejects(() => receipt({ card: receiptKinds.ok[0], ...mine }, "module:gate"), /only the registry/);
  assert.ok((await d.registry.call("approvals.receipt", { card: receiptKinds.ok[0], ...mine }, "cli")).error, "a client cannot record a receipt");
  assert.ok((await d.registry.call("approvals.receipt", { card: receiptKinds.ok[0], ...mine }, "mcp:agent:kit")).error, "a model cannot record a receipt");
  // only a receipt's own kind of id: a phone card's id, a short id, a made-up kind
  for (const card of receiptKinds.notReceipts) await assert.rejects(() => receipt({ card, ...mine }), /not a Flow task's or a confirmed preview's receipt/, card);
  // a recorded receipt covers exactly its tool, digest and asker, and only once
  for (const card of receiptKinds.ok) {
    assert.deepEqual(await receipt({ card, ...mine }), { ok: true });
    await assert.rejects(() => receipt({ card, ...mine }), /already recorded/, "the same receipt id is never recorded twice");
    assert.deepEqual(await cover({ card, ...mine, asker: "mcp:agent:juno" }), { ok: false }, "another asker is not covered");
    assert.deepEqual(await cover({ card, ...mine, tool: "mail.send" }), { ok: false }, "another tool is not covered");
    assert.deepEqual(await cover({ card, ...mine, input_sha256: "b".repeat(32) }), { ok: false }, "another input is not covered");
    assert.deepEqual(await cover({ card, ...mine }), { ok: true });
    assert.deepEqual(await cover({ card, ...mine }), { ok: false }, "one receipt, one send");
  }
  await assert.rejects(() => tool("approvals.cover").run({ card: receiptKinds.ok[0], ...mine }, { caller: "cli" }), /Gate/, "only the Gate uses one");
});

test("one-yes v1.1: one real cycle with the real verifier: a model's call is held, the person's key signs the card's exact words, the retry runs once, and the same card is spent", { timeout: 180_000 }, async t => {
  // No stub verifier: the sealing process checks a real signature from an enrolled key (a software key, which a development build takes under VYRE_SEAL_SOFTWARE). The home is seeded once with the key, the way the
  // walk seeds its first act, because no production path enrols an unattested key; the daemon then boots on it with its own sealing process and the same checks.
  const was = process.env.VYRE_SEAL_SOFTWARE; process.env.VYRE_SEAL_SOFTWARE = "1"; t.after(() => { if (was === undefined) delete process.env.VYRE_SEAL_SOFTWARE; else process.env.VYRE_SEAL_SOFTWARE = was; });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", modules: { disable: ["agents", "computers"] } }));
  const { homeIdentity, bootHomeKernel } = await import("../../kernel/home.js");
  const { startSealer } = await import("../../kernel/seal/client.js");
  const { signer } = await import("../../kernel/seal/testing.js");
  const { open } = await import("../../core/store/index.js");
  const config = await import("../../core/config/index.js");
  const pp = config.ensure(root), db = open(pp.db), idf = homeIdentity(root);
  const sealer = startSealer({ dir: path.join(idf.dir, "seal"), dev: true, unattested: true });
  await sealer.health();
  const sk = await bootHomeKernel({ db, root, log: () => {}, isFirstParty: () => false, sealer });
  const sg = signer(idf.owner);
  const atDeck = sk.chains.fromFacts({ kind: "socket", surface: "deck", uid: process.getuid ? process.getuid() : 0 });
  const begun = await sealer.begin({ chain: atDeck, person: idf.owner, key_id: sg.enrolment.key_id, spki: sg.enrolment.spki });
  await sealer.enrol({ chain: atDeck, person: idf.owner, key_id: sg.enrolment.key_id, spki: sg.enrolment.spki, signer: sg.enrolment.signer, token: begun.token });
  const phone = sk.chains.fromFacts({ kind: "device", device_key_id: "dphonepaired00001", person: idf.owner, path: "relay", session: "ps_1" });
  await sk.stop(); await sealer.close(); db.close();

  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ meta) => d.registry.call(tool, input, caller, meta);
  const facts = { kind: "device", device_key_id: "dphonepaired00001", person: idf.owner, path: "relay", session: "ps_1" };
  // the owner's paired phone, as the relay lists it: the daemon takes a call's person from the device it proved, never from what a caller says
  d.registry.deps.db.prepare("INSERT OR IGNORE INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, ?, 'p', 1, 'app', 0, NULL)").run("dphonepaired00001", "phone");
  const input = { to: "a@example.com", subject: "x", body: "y" };
  const held = await call("mail.send", input, "mcp:agent:kit");
  assert.equal(held.error.code, "held_for_approval", JSON.stringify(held));
  const card = (await call("approvals.pending", {}, "cli", { kernelFacts: facts })).data.approvals.find((/** @type {any} */ c) => c.id === held.error.approval);
  assert.ok(card && card.sign, "the card says exactly what the key signs");
  // a proof that is not the person's key (another key, same words) does not stand
  const stranger = signer(idf.owner);
  const bad = await call("approvals.answer", { id: card.id, approve: true }, "cli", { kernelFacts: facts, kernel_proof: stranger.proof(phone, card.sign.op, card.sign.fields) });
  assert.ok(bad.error, "a key nobody enrolled cannot say yes: " + JSON.stringify(bad));
  const ok = await call("approvals.answer", { id: card.id, approve: true }, "cli", { kernelFacts: facts, kernel_proof: sg.proof(phone, card.sign.op, card.sign.fields) });
  assert.equal(ok.data && ok.data.answered, "approved", JSON.stringify(ok));
  // the retry carries the card: it is redeemed for exactly this call, runs, and the card is spent
  const ran = await call("mail.send", input, "mcp:agent:kit", { approval: card.id });
  assert.ok(!ran.error || !["held_for_approval", "approval_refused"].includes(ran.error.code), "the approved call was let through: " + JSON.stringify(ran));
  assert.equal((await call("mail.send", input, "mcp:agent:kit", { approval: card.id })).error.code, "approval_refused", "a card is used once");
  // and it is for this call only: a changed input needs a card of its own
  assert.equal((await call("mail.send", { ...input, to: "b@example.com" }, "mcp:agent:kit")).error.code, "held_for_approval");
});
