// @ts-check
// What the identity state shows of each chain entry (entry-view.js). `via: "github"` and `confirmed: true` must pass through: a server's chain admission (core/relay/chain-admit.js limitedOf) reads them, and without
// them an unconfirmed GitHub-added device would be admitted as a FULL device.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { entryView } from "./entry-view.js";
import { limitedOf } from "../relay/chain-admit.js";

const T = 1_700_000_000_000, DAY = 86_400_000;
const base = { eid: "e".repeat(26), kind: "device", pub: "p", since: T - 9 * DAY, founder: false, addedBy: "x", secret: "never" };

test("the view carries the key, age and flags the door reads, and nothing else", () => {
  const v = entryView({ ...base, held: "web", alg: "webauthn-es256", rp: "vyre.run", enclave: "en", agree: "ag" });
  assert.deepEqual(Object.keys(v).sort(), ["agree", "alg", "eid", "enclave", "founder", "held", "kind", "pub", "rp", "since"]);
  assert.ok(!("secret" in v) && !("addedBy" in v));
});

test("via github passes through, and confirmed only when it is exactly true", () => {
  assert.equal(entryView({ ...base, via: "github" }).via, "github");
  assert.equal(entryView({ ...base, via: "github" }).confirmed, undefined);
  assert.equal(entryView({ ...base, via: "github", confirmed: true }).confirmed, true);
  assert.equal(entryView({ ...base, via: "github", confirmed: "yes" }).confirmed, undefined, "only a real true counts");
  assert.equal(entryView({ ...base, via: "other" }).via, undefined, "only the names the door knows");
});

test("an unconfirmed GitHub entry is limited and a confirmed one is full, through the view", () => {
  assert.equal(limitedOf(entryView({ ...base, via: "github" }), T), true);
  assert.equal(limitedOf(entryView({ ...base, via: "github", confirmed: true }), T), false);
  assert.equal(limitedOf(entryView(base), T), false);
});
