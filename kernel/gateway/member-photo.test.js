// A person's profile photo in a Space (records/core-types.js MEMBER_PHOTO, kernel/gateway/ownership.js): the same rule as the profile. The person keeps their own; another member, the owner, an admin,
// a module, a Flow and an agent cannot make or change one; an owner or an admin may remove one; every member reads it. And it is one small picture: at most 200 KB of base64, WebP, JPEG or PNG.
// Real kernel, real members.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";
import { MEMBER_PHOTO, MEMBER_PROFILE } from "../../records/core-types.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", ADMIN = "per_admin", BOB = "per_bob", DAN = "per_dan";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  for (const [p, role] of [[ADMIN, "admin"], [BOB, "member"], [DAN, "member"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  await k.gateway.records.define(owner, { add_types: [MEMBER_PROFILE, MEMBER_PHOTO] });
  const as = (/** @type {string} */ id) => k.chains.fromFacts({ kind: "device", device_key_id: `d-${id}`, person: id, path: "direct", session: "s" });
  return { k, owner, as, R: k.gateway.records };
}
const code = p => p.then(() => null, e => e && e.code);
const T = "member-photo";
// a few bytes that stand for a picture: the kernel checks the shape and the size, the app makes the picture
const PIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]).toString("base64");

test("a member keeps her own photo and names it from her profile; another member reads it and cannot touch it", async () => {
  const { as, R } = await rig();
  assert.equal(await code(R.create(as(BOB), T, { person: DAN, image: PIC, mime: "image/jpeg", bytes: 12 })), "not_allowed", "a photo for someone else");
  const pic = await R.create(as(BOB), T, { person: BOB, image: PIC, mime: "image/jpeg", bytes: 12 });
  const prof = await R.create(as(BOB), "member-profile", { person: BOB, name: "Bob", photo: pic.id });
  assert.equal((await R.get(as(DAN), T, pic.id)).data.image, PIC, "another member reads the photo");
  assert.equal((await R.get(as(DAN), "member-profile", prof.id)).data.photo, pic.id, "and the profile that names it");
  assert.equal(await code(R.update(as(DAN), T, pic.id, { image: "" }, pic.version)), "not_allowed", "another member wiping it");
  assert.equal(await code(R.update(as(DAN), "member-profile", prof.id, { photo: "" }, prof.version)), "not_allowed", "another member taking it off her profile");
  const wiped = await R.update(as(BOB), T, pic.id, { image: "", bytes: 0 }, pic.version);
  assert.equal(wiped.data.image, "", "she wipes her own");
});

test("the owner and an admin cannot make or change someone's photo; they may remove one", async () => {
  const { owner, as, R } = await rig();
  const bobs = await R.create(as(BOB), T, { person: BOB, image: PIC, mime: "image/jpeg", bytes: 12 });
  assert.equal(await code(R.create(owner, T, { person: BOB, image: PIC, mime: "image/jpeg" })), "not_allowed", "the owner making one for her");
  assert.equal(await code(R.update(owner, T, bobs.id, { image: PIC }, bobs.version)), "not_allowed", "the owner");
  assert.equal(await code(R.update(as(ADMIN), T, bobs.id, { image: "" }, bobs.version)), "not_allowed", "an admin");
  assert.equal(await code(R.remove(as(ADMIN), T, bobs.id, bobs.version)), null, "an admin removes a photo");
});

test("a module, a Flow and an agent cannot make or change the person's photo", async () => {
  const { k, owner, as, R } = await rig();
  const mine = await R.create(as(BOB), T, { person: BOB, image: PIC, mime: "image/jpeg", bytes: 12 });
  const viaModule = k.chains.fromFacts({ kind: "module", inbound: as(BOB), module: "some-module", first_party: true });
  assert.notEqual(await code(R.create(viaModule, T, { person: BOB, image: PIC, mime: "image/jpeg" })), null, "a module's create");
  assert.notEqual(await code(R.update(viaModule, T, mine.id, { image: "" }, mine.version)), null, "a module's update");
  const flow = k.chains.forFlow({ flow: "f_photo", approver: owner, run: "run_1" });
  assert.equal(await code(R.create(flow, T, { person: OWNER, image: PIC, mime: "image/jpeg" })), "not_allowed", "a Flow's create, as the owner");
  const agent = k.chains.fromFacts({ kind: "agent_session", vouched: true, person: BOB, agent: "assistant", session: "s1" });
  assert.notEqual(await code(R.update(agent, T, mine.id, { image: "" }, mine.version)), null, "an agent acting for her");
  assert.equal((await R.get(as(BOB), T, mine.id)).data.image, PIC, "unchanged");
});

test("a photo is one small picture: over 200 KB, not base64, or not WebP, JPEG or PNG is refused", async () => {
  const { as, R } = await rig();
  const big = "A".repeat(Math.ceil((200 * 1024) / 3) * 4 + 4);
  assert.equal(await code(R.create(as(BOB), T, { person: BOB, image: big, mime: "image/jpeg" })), "not_allowed", "too large");
  assert.equal(await code(R.create(as(BOB), T, { person: BOB, image: "not base64!", mime: "image/jpeg" })), "not_allowed", "not base64");
  assert.equal(await code(R.create(as(BOB), T, { person: BOB, image: PIC, mime: "image/svg+xml" })), "not_allowed", "a picture that can carry a script");
  const ok = await R.create(as(BOB), T, { person: BOB, image: "A".repeat(Math.ceil((200 * 1024) / 3) * 4), mime: "image/webp" });
  assert.equal(ok.data.mime, "image/webp", "200 KB is the limit, not over it");
  assert.equal(await code(R.update(as(BOB), T, ok.id, { mime: "text/html" }, ok.version)), "not_allowed", "changed to another kind");
});

test("the records module's own sweep may remove a photo, and nothing else: not a profile, not a change; another service with the same grant may not", async () => {
  const { k, as, R } = await rig();
  const grants = [{ prefix: "*/*", actions: ["records.read"] }, { prefix: "member-photo/*", actions: ["records.read", "records.remove", "records.update"] }, { prefix: "member-profile/*", actions: ["records.read", "records.remove", "records.update"] }];
  const records = k.kernelFor({ name: "records", needs: { kernel: { grants } } });
  const other = k.kernelFor({ name: "notes", needs: { kernel: { grants } } });
  // each module's grant is written as it is made: a call through its handle waits for it (the rule, not a missing grant, is what is tested here)
  for (const h of [records, other]) await h.records.query(h.serviceChain(), "member-profile", { page: { limit: 1 } });
  const pic = await R.create(as(BOB), T, { person: BOB, image: PIC, mime: "image/jpeg", bytes: 12 });
  const prof = await R.create(as(BOB), "member-profile", { person: BOB, name: "Bob" });
  assert.equal(await code(R.update(records.serviceChain(), T, pic.id, { image: "" }, pic.version)), "not_allowed", "a change");
  assert.equal(await code(R.remove(records.serviceChain(), "member-profile", prof.id, prof.version)), "not_allowed", "a profile");
  assert.equal(await code(R.remove(other.serviceChain(), T, pic.id, pic.version)), "not_allowed", "another service");
  assert.equal(await code(records.records.remove(records.serviceChain(), T, pic.id, pic.version)), null, "the sweep removes a photo");
});
