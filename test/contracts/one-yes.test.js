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
import { moments, reasons, heldError, refusedError, manifestEntry, yesResults, coveredMark, shapeDiff } from "./one-yes.fixtures.js";

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
  const docs = JSON.parse(fs.readFileSync(new URL("../../core/documents/module.json", import.meta.url), "utf8")).does.tools;
  assert.ok(docs.find((/** @type {any} */ x) => x.name === "documents.send").covers.includes("comms.send"), "Documents files its sends through Comms in the same act");
  const tools = d.registry.tools;
  const cur = { [COVERED]: { ...coveredMark, via: [] } };
  const ride = coveredRide(tools, cur, "mail.send", "module:comms");
  assert.deepEqual(ride && ride.via, ["mail"], "the mark gains the module the nested tool belongs to");
  assert.equal(coveredRide(tools, cur, "mail.send", "module:other"), null, "only the covered tool's module (or one it passed the mark to) rides it");
  assert.equal(coveredRide(tools, cur, "gate.request", "module:comms"), null, "a tool the covered one did not name is held again");
});
