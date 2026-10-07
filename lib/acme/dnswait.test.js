// @ts-check
// The DNS-01 wait (lib/acme/dnswait.js). 0.2.9 and 0.2.10 told the CA to look two seconds after writing the record, before the zone carried it, and every issue failed with
// NXDOMAIN on _acme-challenge. The wait reads the record back from public resolvers first.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitTxt } from "./dnswait.js";

const clock = () => { let t = 0; return { now: () => t, sleep: async (/** @type {number} */ ms) => { t += ms; } }; };

test("waitTxt: waits until every resolver shows the value, then settles", async () => {
  const c = clock();
  /** @type {Record<string, number>} */ const visibleAt = { a: 6000, b: 9000 };
  const resolve = async (/** @type {string} */ s) => (c.now() >= visibleAt[s] ? [["other"], ["tok", "en"]] : []);
  const ok = await waitTxt("_acme-challenge.alex.vyre.run", "token", { servers: ["a", "b"], resolve, ...c, everyMs: 3000, settleMs: 5000 });
  assert.equal(ok, true);
  assert.equal(c.now(), 9000 + 5000, "asked until both resolvers carried it, then the settle");
});

test("waitTxt: a resolver that errors or never shows it ends at the deadline with false, not a throw", async () => {
  const c = clock();
  const resolve = async (/** @type {string} */ s) => { if (s === "a") throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); return [["token"]]; };
  const ok = await waitTxt("_acme-challenge.alex.vyre.run", "token", { servers: ["a", "b"], resolve, ...c, timeoutMs: 30_000, everyMs: 3000 });
  assert.equal(ok, false);
  assert.ok(c.now() >= 30_000);
});
