// @ts-check
// R031-83: a Space's sealed values travel in a bundle under a bundle key, never under this process's keys, and a fresh sealing process (another master) takes them back with the same references, so no record is rewritten.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startSealer } from "./client.js";
import { person, signer, tmp, enrolDevice, SPACE } from "./testing.js";

const REC = `vyre://${SPACE}/contact/c_jane`;
const boot = async (/** @type {import("node:test").TestContext} */ t, /** @type {string} */ name) => {
  const dir = tmp(name), s = startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true }), alex = signer("per_alex");
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await enrolDevice(s, alex);
  return { dir, s, alex };
};

test("dump seals every value under the bundle key; restore on a fresh process opens them under its own keys, with the same references and a working uniqueness check", async t => {
  const a = await boot(t, "seal-a"), b = await boot(t, "seal-b");
  const put = (/** @type {any} */ s, /** @type {string} */ value, /** @type {any} */ over = {}) => s.api.put({ chain: person(), record: REC, field: "ssn", class: "us-ssn", value, ...over });
  const one = (await put(a.s, "123-45-6789", { unique: true })).ref, two = (await put(a.s, "078-05-1120", { field: "ssn2" })).ref;
  const bk = crypto.randomBytes(32);
  const { items } = await a.s.spaceDump({ space: SPACE, bk });
  assert.equal(items.length, 2);
  const text = JSON.stringify(items);
  assert.ok(!text.includes("123-45-6789") && !text.includes("078-05-1120"), "no plaintext in the dump");
  const master = fs.readFileSync(path.join(a.dir, "master.key"));
  assert.ok(!text.includes(master.toString("base64")) && !text.includes(master.toString("hex")), "no master key in the dump");
  // a wrong key restores nothing
  await assert.rejects(() => b.s.spaceRestore({ space: SPACE, bk: crypto.randomBytes(32), items }), { code: "bad_input" });
  assert.deepEqual(await b.s.spaceRestore({ space: SPACE, bk, items }), { restored: 2 });
  // the same references open on the new process (a human reveal under a device proof)
  const signed = signer("per_alex"); await enrolDevice(b.s, signed, { existing: b.alex });
  const alex = person();
  const reveal = (/** @type {string} */ r) => b.s.api.reveal({ chain: alex, ref: r, purpose: "check", proof: signed.proof(alex, "seal.reveal", { ref: r, purpose: "check" }) });
  assert.equal((await reveal(one.ref)).value, "123-45-6789");
  assert.equal((await reveal(two.ref)).value, "078-05-1120");
  // the uniqueness check works again under the new master: the same value is a duplicate
  await assert.rejects(() => put(b.s, "123-45-6789", { unique: true }), { code: "duplicate" });
  // only onto a process with no values of that Space
  await assert.rejects(() => b.s.spaceRestore({ space: SPACE, bk, items }), { code: "not_empty" });
});
