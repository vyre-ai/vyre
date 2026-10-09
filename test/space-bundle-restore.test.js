// @ts-check
// R031-83 (#108), on REAL daemons: every Space a box holds comes back on a fresh box, each with its own owner's recovery code: the home Space and a hosted Space, with their records, members and sealed values,
// under the new box's OWN sealing keys. A Space whose owner gave no code is left out and named. A member's own device opens their chat's ring again afterwards, with no help from the restore.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { startSealer } from "../kernel/seal/client.js";
import { enrol, exportBundle, restoreAll, bundlesIn, bundleFile } from "../lib/space-bundle.js";
import { createRing, openRing } from "../lib/keywrap.js";
import { newDeviceKey, fingerprint } from "../lib/keywrap.js";
import { canonical, sha256 } from "../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const used = new Set();
const presence = { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const CODE = "abcdefghijklmnopqrstuvwxyz", CODE2 = "bcdefghijklmnopqrstuvwxyza";
const sealerOf = (/** @type {string} */ dir) => startSealer({ dir, dev: true, unattested: true });

test("every Space on a box comes back on a fresh one, each with its own owner's code; a member's device opens their own data again", { timeout: 300_000 }, async t => {
  const A = tempHome(t), B = tempHome(t);
  const a = await start({ root: A, log: () => {}, kernel: true, kernelPresence: presence });
  const space = a.kernel.id.space, owner = a.kernel.id.owner;
  const ownerChain = a.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const BOB = "per_" + "b".repeat(26), HARBOR_OWNER = "per_" + "c".repeat(26);
  await a.kernel.gateway.grants.setRole(ownerChain, { person: BOB, role: "member" }, { presence: proof("grants.role", { person: BOB, role: "member" }, `vyre://${space}/member/${BOB}`) });
  const client = await a.kernel.gateway.records.create(ownerChain, "organization", { name: "Northwind Bakery" });
  const row = await a.kernel.gateway.records.create(ownerChain, "task", { title: "Call Northwind about the lease", status: "ready" }).catch(() => null);
  const ref = (await a.kernel.sealer.api.put({ chain: ownerChain, record: client.urn, field: "ein", class: "us-ssn", value: "123-45-6789" })).ref.ref;
  // a member's chat, its ring wrapped to the member's own device key
  const bobDevice = newDeviceKey(), bobHolder = fingerprint(bobDevice.publicJwk), chatId = `chat_${crypto.randomUUID()}`, ring = createRing(chatId, { [bobHolder]: bobDevice.publicJwk });
  const chat = await a.kernel.gateway.grants.chats.create(ownerChain, { people: [BOB], id: chatId, ring: ring.doc });
  // a hosted Space (a team's) with its own owner, store and sealed value
  const harbor = await a.kernel.spaces.host({ owner: HARBOR_OWNER, name: "Harbor" });
  const hid = harbor.space;
  const harborOwner = harbor.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-h", person: HARBOR_OWNER, path: "direct", session: "s" });
  const firm = await harbor.gateway.records.create(harborOwner, "organization", { name: "Harbor Law Client" });
  const hRef = (await a.kernel.sealer.api.put({ chain: harbor.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-h", person: HARBOR_OWNER, path: "direct", session: "s", space: hid }), record: firm.urn, field: "ein", class: "us-ssn", value: "078-05-1120" }).catch(() => null));
  // a third Space nobody turned backups on for
  const quiet = await a.kernel.spaces.host({ owner: "per_" + "d".repeat(26), name: "Quiet" });

  // each owner gives their own code once; then the export is unattended
  const sp = a.kernel.kernelFor({ name: "spaces", needs: { kernel: { bundle: true } } });
  await enrol(sp.bundle.of(space), space, CODE);
  await enrol(sp.bundle.of(hid), hid, CODE2);
  const home = await exportBundle({ root: A, id: { space, owner }, k: sp.bundle.of(space), home: true });
  const hosted = await exportBundle({ root: A, id: { space: hid, owner: HARBOR_OWNER, name: "Harbor" }, k: sp.bundle.of(hid), home: false });
  assert.ok(home.sealed >= 1 && hosted.bytes > 1000);
  await assert.rejects(() => exportBundle({ root: A, id: { space: quiet.space, owner: "per_" + "d".repeat(26) }, k: sp.bundle.of(quiet.space), home: false }), { code: "not_enrolled" });
  const oldMaster = fs.readFileSync(path.join(A, "kernel", "seal", "master.key"));
  for (const f of [home.file, hosted.file]) { const b = fs.readFileSync(f); assert.ok(!b.includes(oldMaster) && !b.includes(oldMaster.toString("hex")) && !b.includes(oldMaster.toString("base64")), "no key of the old box is in a bundle"); assert.ok(!b.toString("latin1").includes("Northwind") && !b.toString("latin1").includes("Harbor Law"), "nothing readable in a bundle"); }
  await a.stop();

  // the fresh box: what a restored backup carries (the store, the config, space-bundles/) and none of the old kernel folder
  for (const f of fs.readdirSync(A)) if (f !== "kernel") fs.cpSync(path.join(A, f), path.join(B, f), { recursive: true });
  fs.mkdirSync(path.join(B, "kernel"), { recursive: true, mode: 0o700 });
  assert.deepEqual(bundlesIn(B).map(b => b.space).sort(), [space, hid].sort());
  await assert.rejects(() => restoreAll({ root: B, codes: () => CODE2.split("").reverse().join(""), startSealer: sealerOf }), { code: "bad_code" }, "the wrong code opens nothing");
  const r = await restoreAll({ root: B, codes: s => (s === space ? CODE : s === hid ? CODE2 : undefined), startSealer: sealerOf });
  assert.deepEqual(r.restored.map(x => x.space).sort(), [space, hid].sort());
  assert.ok(fs.existsSync(path.join(B, bundleFile(space))));

  const b = await start({ root: B, log: () => {}, kernel: true, kernelPresence: presence });
  t.after(() => b.stop());
  assert.equal(b.kernel.id.space, space, "the same Space id: every urn stays valid");
  assert.equal(b.kernel.grants.roleOf({ kind: "person", id: BOB, space }), "member", "the members are back");
  const ownerB = b.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  assert.equal((await b.kernel.gateway.records.get(ownerB, "organization", client.id)).data.name, "Northwind Bakery", "the client record is back");
  if (row) assert.equal((await b.kernel.gateway.records.get(ownerB, "task", row.id)).data.title, "Call Northwind about the lease", "and the planner row");
  assert.equal(b.kernel.log.read({ type: "space.restored" }).length, 1, "the log says it was restored, with the old head");
  const dump = await b.kernel.sealer.spaceDump({ space, bk: crypto.randomBytes(32) });
  assert.ok(dump.items.some((/** @type {any} */ i) => i.meta.ref === ref), "the same sealed reference");
  assert.notDeepEqual(fs.readFileSync(path.join(B, "kernel", "seal", "master.key")), oldMaster, "the new box has its own keys");

  // the hosted Space is back: its store, its owner, its sealed value
  const harborB = b.kernel.spaces.for(hid);
  const harborOwnerB = harborB.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-h", person: HARBOR_OWNER, path: "direct", session: "s" });
  assert.equal((await harborB.gateway.records.get(harborOwnerB, "organization", firm.id)).data.name, "Harbor Law Client", "the team's record is back");
  assert.equal(harborB.kernel.log.read({ type: "space.restored" }).length, 1);
  if (hRef) assert.ok((await b.kernel.sealer.spaceDump({ space: hid, bk: crypto.randomBytes(32) })).items.some((/** @type {any} */ i) => i.meta.ref === hRef.ref.ref), "the team's sealed value is back under the same reference");
  assert.equal(b.kernel.spaces.list().includes(quiet.space), false, "the Space nobody enrolled is not there, and was named as left out");

  // a member opens their own chat's ring with their own device, as before: the restore never held it
  const bobB = b.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct", session: "sb" });
  const back = b.kernel.gateway.grants.chats.read(bobB, chat.id);
  assert.ok(back && back.ring, "the member's chat and its ring are back");
  const opened = await openRing(back.ring, bobHolder, bobDevice.privateJwk);
  assert.deepEqual(Buffer.from(opened.nameKey), Buffer.from(ring.keys.nameKey), "their device unwraps the same key, with nothing from the restore");
});
