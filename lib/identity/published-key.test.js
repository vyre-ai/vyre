// @ts-check
// The published-key check fails closed: a bad id, a missing chain, a key that is not on the list, and a directory that cannot be reached.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { assertPublishedKey, devicePubs, publishedDeviceKeys } from "./published-key.js";

const PERSON = `per_${"a".repeat(26)}`;
const state = { entries: [{ kind: "device", pub: "FULL" }, { kind: "device", pub: "PASS", alg: "webauthn-es256" }, { kind: "device", pub: "WEB", held: "web" }, { kind: "code", pub: "CODE" }] };

test("a full device key is the install-code set, and a passkey still counts for a phone", () => {
  assert.deepEqual(publishedDeviceKeys(state), ["FULL"]);
  assert.deepEqual(devicePubs(state), ["FULL", "PASS", "WEB"]);
});

test("the check adopts nothing: a miss, a bad id and an unreachable directory each refuse", async () => {
  const dir = { resolveById: async (id) => (id === PERSON ? state : Promise.reject(Object.assign(new Error("no"), { code: "not_found" }))) };
  assert.equal((await assertPublishedKey(dir, PERSON, "FULL", { fullDevice: true })).entries.length, 4);
  assert.equal((await assertPublishedKey(dir, PERSON, "PASS")).entries.length, 4);
  await assert.rejects(() => assertPublishedKey(dir, PERSON, "PASS", { fullDevice: true }), (/** @type {any} */ e) => e.code === "denied" && /published/.test(e.message));
  await assert.rejects(() => assertPublishedKey(dir, "alex"), (/** @type {any} */ e) => e.code === "denied" && /person id/.test(e.message));
  await assert.rejects(() => assertPublishedKey(dir, `per_${"b".repeat(26)}`), (/** @type {any} */ e) => e.code === "denied" && /published key/.test(e.message));
  await assert.rejects(() => assertPublishedKey({ resolveById: async () => { throw Object.assign(new Error("down"), { code: "unreachable" }); } }, PERSON), (/** @type {any} */ e) => e.code === "unavailable" && /directory/.test(e.message));
});
