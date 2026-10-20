// @ts-check
// A joined member's profile photo through the path her app really takes (apps/app/src/state/profiles.ts): the member door's records rows (core/work/member-tools.js) on a real vyred with the kernel on.
// She uploads a photo and her profile names it, another member reads both, she changes it (a new photo, the profile names it, the old picture wiped) and removes it; another member cannot touch
// hers. Then the records module's sweep (photo-sweep.js) removes the photos no profile names, under its own service chain, and keeps the one that is named. SHIM(presence): `kernelPresence`
// accepts any proof for the owner's grants acts. Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { MEMBER_PHOTO, MEMBER_PROFILE } from "../../records/core-types.js";
import { createMemberTools } from "../work/member-tools.js";
import { sweepPhotos } from "./photo-sweep.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", ANA = "per_" + "bcdefghijklmnopqrstuvwxyza";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const PIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]).toString("base64");
const PIC2 = Buffer.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).toString("base64");
/** what the door answers for one record: the Store's `{ record }` */
const rec = (/** @type {any} */ r) => (r && r.record ? r.record : r);

test("a joined member uploads, changes and removes her photo through the member door; another member sees it; the sweep removes the photos no profile names", { timeout: 150_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner, space = K.id.space;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-own1", person: OWNER, path: "direct", session: "s" });
  for (const p of [BEN, ANA]) await K.gateway.grants.setRole(ownerChain, { person: p, role: "member" }, { presence: proof() });
  await K.gateway.records.define(ownerChain, { add_types: [MEMBER_PROFILE, MEMBER_PHOTO] }).catch(() => {});
  const door = /** @type {any} */ (createMemberTools({ space, kernel: K, registry: d.registry }));
  // a member of a team this box hosts reaches it over the relay: her own one-hop chain in this Space
  const member = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "relay" });
  const ana = member(ANA), ben = member(BEN);
  const code = (/** @type {Promise<any>} */ p) => p.then(() => null, (/** @type {any} */ e) => e && e.code);

  // she uploads: a photo record of hers, then her profile names it
  const first = rec(await door.records.create(ana, { type: "member-photo", data: { person: ANA, image: PIC, mime: "image/jpeg", bytes: 12 } }));
  assert.equal(first.data.person, ANA);
  const prof = rec(await door.records.create(ana, { type: "member-profile", data: { person: ANA, name: "Ana", photo: first.id } }));
  assert.equal(prof.data.photo, first.id);

  // another member reads her profile and her photo through the same door
  const seen = rec(await door.records.get(ben, { urn: first.urn }));
  assert.equal(seen.data.image, PIC, "Ben sees Ana's photo");
  assert.equal(rec(await door.records.get(ben, { urn: prof.urn })).data.photo, first.id, "and the profile that names it");
  // and cannot touch hers
  assert.notEqual(await code(door.records.update(ben, { urn: first.urn, patch: { image: PIC2 }, base_version: first.version })), null, "Ben changing Ana's photo");
  assert.notEqual(await code(door.records.update(ben, { urn: prof.urn, patch: { photo: "" }, base_version: prof.version })), null, "Ben taking it off her profile");

  // she changes it: a new photo, the profile names it, the old picture wiped
  const second = rec(await door.records.create(ana, { type: "member-photo", data: { person: ANA, image: PIC2, mime: "image/webp", bytes: 12 } }));
  const prof2 = rec(await door.records.update(ana, { urn: prof.urn, patch: { photo: second.id }, base_version: prof.version }));
  assert.equal(prof2.data.photo, second.id);
  const wiped = rec(await door.records.update(ana, { urn: first.urn, patch: { image: "", bytes: 0 }, base_version: first.version }));
  assert.equal(wiped.data.image, "", "the old picture is gone");
  assert.equal(rec(await door.records.get(ben, { urn: second.urn })).data.mime, "image/webp", "Ben sees the new one");

  // the kernel still holds her to one small picture through the door
  assert.notEqual(await code(door.records.create(ana, { type: "member-photo", data: { person: ANA, image: PIC, mime: "image/svg+xml" } })), null, "not a picture kind the app draws");

  // the sweep: the records module's own kernel handle, as the daemon starts it. A photo named by a profile stays; the wiped one goes.
  const manifest = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8"));
  const handle = K.kernelFor(manifest);
  const r1 = await sweepPhotos(handle, { graceMs: 0 });
  assert.deepEqual(r1.failed, [], JSON.stringify(r1.failed));
  assert.deepEqual(r1.removed, [first.id], "only the photo no profile names");
  assert.equal(await K.gateway.records.get(ownerChain, "member-photo", first.id).then((/** @type {any} */ x) => (x ? "there" : "gone"), () => "gone"), "gone");

  // she removes her photo: the profile names none, the picture is wiped, and the next sweep removes the record
  const prof3 = rec(await door.records.update(ana, { urn: prof.urn, patch: { photo: "" }, base_version: prof2.version }));
  assert.equal(prof3.data.photo ?? "", "");
  await door.records.update(ana, { urn: second.urn, patch: { image: "", bytes: 0 }, base_version: second.version });
  const r2 = await sweepPhotos(handle, { graceMs: 0 });
  assert.deepEqual(r2.removed, [second.id]);
  // and a sweep with the usual hour's grace leaves a photo made a moment ago (a save still on its way)
  const fresh = rec(await door.records.create(ana, { type: "member-photo", data: { person: ANA, image: PIC, mime: "image/jpeg", bytes: 12 } }));
  assert.deepEqual((await sweepPhotos(handle)).removed, [], "a photo made in the last hour stays");
  assert.ok(await K.gateway.records.get(ownerChain, "member-photo", fresh.id));

  // the records module's service may remove a photo and nothing else of a profile
  assert.notEqual(await code(K.gateway.records.remove(handle.serviceChain(), "member-profile", prof.id, prof3.version)), null, "the sweep's chain removing a profile");
  assert.notEqual(await code(K.gateway.records.update(handle.serviceChain(), "member-photo", fresh.id, { image: "" }, fresh.version)), null, "the sweep's chain changing a photo");
});
