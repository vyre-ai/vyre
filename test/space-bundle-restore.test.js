// @ts-check
// R031-83 (#108), on REAL daemons: a Space comes back on a fresh box with its records, its members and its sealed values, from the files a backup carries plus the Space bundle. The new box has its OWN
// sealing keys: nothing of the old box's keys is in the bundle, and the sealed values are re-sealed under the new ones with the same references.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { startSealer } from "../kernel/seal/client.js";
import { enrol, exportBundle, restoreBundle, RESTORE_FILE } from "../lib/space-bundle.js";
import { canonical, sha256 } from "../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const used = new Set();
const presence = { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const CODE = "abcdefghijklmnopqrstuvwxyz";

test("a Space is restored on a fresh box: its records, its members and its sealed values, under the new box's own keys", { timeout: 240_000 }, async t => {
  const A = tempHome(t), B = tempHome(t);
  const a = await start({ root: A, log: () => {}, kernel: true, kernelPresence: presence });
  const space = a.kernel.id.space, owner = a.kernel.id.owner;
  const ownerChain = a.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const BOB = "per_" + "b".repeat(26);
  await a.kernel.gateway.grants.setRole(ownerChain, { person: BOB, role: "member" }, { presence: proof("grants.role", { person: BOB, role: "member" }, `vyre://${space}/member/${BOB}`) });
  const client = await a.kernel.gateway.records.create(ownerChain, "organization", { name: "Northwind Bakery" });
  const row = await a.kernel.gateway.records.create(ownerChain, "task", { title: "Call Northwind about the lease", status: "ready" }).catch(() => null);
  const put = await a.kernel.sealer.api.put({ chain: ownerChain, record: client.urn, field: "ein", class: "us-ssn", value: "123-45-6789" });
  const ref = put.ref.ref;

  // a member's chat (its people and ring are in the grants state)
  const chat = await a.kernel.gateway.grants.chats.create(ownerChain, { people: [BOB] });
  // enrol once with the recovery code, then export with no further asking
  const sp = a.kernel.kernelFor({ name: "spaces", needs: { kernel: { bundle: true } } });
  await enrol(sp.bundle, space, CODE);
  const out = await exportBundle({ root: A, id: { space, owner }, k: sp.bundle });
  assert.ok(out.sealed >= 1);
  const bundle = fs.readFileSync(out.file);
  const oldMaster = fs.readFileSync(path.join(A, "kernel", "seal", "master.key"));
  assert.ok(!bundle.includes(oldMaster) && !bundle.includes(oldMaster.toString("hex")) && !bundle.includes(oldMaster.toString("base64")), "no key of the old box is in the bundle");
  assert.ok(!bundle.toString("latin1").includes("123-45-6789") && !bundle.toString("latin1").includes("Northwind"), "nothing readable in the bundle");
  await a.stop();

  // the fresh box: what a restored backup carries (the store, the config) but none of the old box's kernel keys, plus the bundle
  for (const f of fs.readdirSync(A)) if (f !== "kernel") fs.cpSync(path.join(A, f), path.join(B, f), { recursive: true });
  fs.mkdirSync(path.join(B, "kernel"), { recursive: true, mode: 0o700 });
  await assert.rejects(() => restoreBundle({ root: B, code: "bcdefghijklmnopqrstuvwxyza", startSealer: dir => startSealer({ dir, dev: true, unattested: true }) }), { code: "bad_code" }, "the wrong code opens nothing");
  const r = await restoreBundle({ root: B, code: CODE, startSealer: dir => startSealer({ dir, dev: true, unattested: true }) });
  assert.deepEqual([r.space, r.owner, r.sealed >= 1], [space, owner, true]);
  assert.ok(fs.existsSync(path.join(B, RESTORE_FILE)));

  const b = await start({ root: B, log: () => {}, kernel: true, kernelPresence: presence });
  t.after(() => b.stop());
  const tok = (await b.kernel.surfaces.open(b.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s9" }), {})).token;
  const st = await b.registry.call("spaces.bundle.status", {}, "cli", { token: tok });
  assert.equal(st.data && st.data.enrolled, true, "the restored Space keeps the bundle key, so the next export needs no code: " + JSON.stringify(st));
  assert.equal(b.kernel.id.space, space, "the same Space id: every urn stays valid");
  assert.equal(b.kernel.id.owner, owner);
  assert.equal(fs.existsSync(path.join(B, RESTORE_FILE)), false, "the restore is done once");
  assert.equal(b.kernel.grants.roleOf({ kind: "person", id: BOB, space }), "member", "the members are back");
  const ownerB = b.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const bobB = b.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct", session: "sb" });
  assert.ok(b.kernel.gateway.grants.chats.read(bobB, chat.id), "a member's chat is back, and they are in it");
  const back = await b.kernel.gateway.records.get(ownerB, "organization", client.id);
  assert.equal(back && back.data.name, "Northwind Bakery", "the client record is back");
  if (row) assert.equal((await b.kernel.gateway.records.get(ownerB, "task", row.id)).data.title, "Call Northwind about the lease", "and the planner row");
  assert.ok(b.kernel.log.read({ type: "space.restored" }).length === 1, "the log says it was restored, with the old head");
  // the sealed value is there under the same reference, under the NEW box's keys
  const bk = crypto.randomBytes(32);
  const dump = await b.kernel.sealer.spaceDump({ space, bk });
  assert.ok(dump.items.some((/** @type {any} */ i) => i.meta.ref === ref), "the same reference");
  const newMaster = fs.readFileSync(path.join(B, "kernel", "seal", "master.key"));
  assert.notDeepEqual(newMaster, oldMaster, "the new box has its own keys");
});
