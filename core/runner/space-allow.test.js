// @ts-check
// The Space's allow (G01): a plain member lends their own computer (their side), and the Space lets its members run sessions on their own computers with ONE offer an owner or admin makes for member "*". With it a
// member's own chat is placed on their own computer; without it, or after the owner takes it back, it runs on the server.
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import { rig, SPACE, OWNER, CAROL, proof } from "./testing/lent-rig.js";

test("the Space's allow: no allow, no placement on a plain member's computer; the owner's offer for every member lets Carol's own chat run on her own computer; taking it back ends that", { timeout: 60_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const r = await rig(t);
  const carolChain = r.k.chains.fromFacts({ kind: "device", device_key_id: "dev_carol", person: CAROL, path: "direct" });
  const mk = (/** @type {any} */ chain, /** @type {any} */ x) => r.g.offers.offer(chain, x, { presence: proof("grants.offer", x, `vyre://${SPACE}/offer/new`) });
  // Carol's own yes: she lends her computer (her side only: she is a plain member)
  await mk(carolChain, { side: "member_accepts", member: CAROL, device: "dev_carol", device_key: "KEY_CAROL" });
  const q = { member: CAROL, device: "dev_carol", device_key: "KEY_CAROL" };
  assert.deepEqual(r.g.offers.active(q), { spaceAllows: false, memberAccepts: true }, "her yes alone is not the Space's");
  // only an owner or an admin makes the Space's allow, and only a member of the Space is covered by it
  const all = { side: "space_allows", member: "*", device: null };
  await assert.rejects(mk(carolChain, all), (/** @type {any} */ e) => e.code === "not_allowed", "a plain member cannot allow the Space");
  await assert.rejects(mk(r.owner, { side: "space_allows", member: "*", device: "dev_carol" }), (/** @type {any} */ e) => ["bad_input", "not_found"].includes(e.code), "the allow for every member names no computer");
  const placeFor = async () => { const c = r.as(CAROL, "dev_carol"); await c.vault.lease().catch(() => null); await r.home.status(carolChain, { device_key: "KEY_CAROL" }).catch(() => null); await c.beat({ sessions: [], well: true }).catch(() => null); return r.home.placeNew({ session: "s_allow_1", person: CAROL }); };
  assert.equal((await placeFor()).where, "box", "no allow: the chat runs on the server");
  const on = await mk(r.owner, all);
  assert.deepEqual(r.g.offers.active(q), { spaceAllows: true, memberAccepts: true });
  assert.equal(r.g.offers.active({ member: "per_stranger", device: "dev_x" }).spaceAllows, false, "someone who is not a member is not covered");
  assert.equal((await placeFor()).where, "mac", "allowed: Carol's own chat runs on Carol's own computer");
  // the owner takes the allow back: the next chat runs on the server, and the computer is no longer one the Space allows
  await r.g.offers.unoffer(r.owner, on.id, { presence: proof("grants.unoffer", { revoke: on.id }, `vyre://${SPACE}/offer/${on.id}`) });
  assert.equal(r.g.offers.active(q).spaceAllows, false);
  assert.equal(r.home.placeNew({ session: "s_allow_2", person: CAROL }).where, "box", "taken back: the next chat runs on the server");
  void OWNER;
});
