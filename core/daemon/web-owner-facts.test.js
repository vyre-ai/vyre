// @ts-check
// The owner's ruling (19 Oct): with no presence device enrolled, the owner's own relay-paired web browser is the owner (callerFacts, by the same deviceIsOwner test an app device passes). With a key enrolled, or for a
// browser that is not the owner's, a removed one, or an agent label, it gets no person facts as before (PH-1). The facts are what the registry's no-device rule and the kernel's chain read.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { callerFacts } from "./index.js";

const OWNER = "per_" + "a".repeat(26), OTHER = "per_" + "b".repeat(26);
const k = { id: { owner: OWNER } };
const policy = { caller: "device:abcdefghijklmnop" };
const web = (/** @type {any} */ more = {}) => ({ kind: "web", removed: false, person: OWNER, ...more });

test("an owner's web browser gets the owner's facts only while no presence device is enrolled", () => {
  const f = callerFacts("cli", policy, undefined, k, false, web(), undefined, true);
  assert.ok(f && f.kind === "device" && f.person === OWNER && f.limited !== true, JSON.stringify(f));
  assert.equal(callerFacts("cli", policy, undefined, k, false, web()), null, "a key is enrolled (or unknown): no facts, as before");
  assert.equal(callerFacts("cli", policy, undefined, k, false, web(), undefined, false), null);
});

test("a web browser that is not the owner's, a removed one, an unknown one and an agent label never get facts", () => {
  assert.equal(callerFacts("cli", policy, undefined, k, false, web({ person: OTHER }), undefined, true), null, "another person's browser");
  assert.equal(callerFacts("cli", policy, undefined, k, false, web({ removed: true }), undefined, true), null, "removed");
  assert.equal(callerFacts("cli", policy, undefined, k, false, null, undefined, true), null, "no row for it");
  assert.equal(callerFacts("cli", policy, undefined, k, false, web({ kind: "setup" }), undefined, true), null, "a setup page");
  assert.equal(callerFacts("mcp:agent:kit", {}, undefined, k, false, null, undefined, true), null, "an agent has none from a flag");
});

test("a web browser's facts say so, and an app device's do not", () => {
  const webFacts = callerFacts("cli", policy, undefined, k, false, web(), undefined, true);
  assert.equal(webFacts && webFacts.web, true);
  const appFacts = callerFacts("cli", policy, undefined, k, false, web({ kind: "app" }), undefined, false);
  assert.ok(appFacts && appFacts.web === undefined, JSON.stringify(appFacts));
});
