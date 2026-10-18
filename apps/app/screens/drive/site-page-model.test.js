// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { siteAddress, unpublished } from "./site-page-model.js";

const dep = (/** @type {string} */ id, /** @type {number} */ version, /** @type {any} */ over = {}) => ({ id, version, url: null, domains: [], ...over });

test("a connected domain is the address; else the live url; the frame falls back to the private preview of a draft", () => {
  const live = dep("a", 2, { url: "https://x.vyre.run", domains: [{ host: "juniper.studio", status: "verified" }] });
  assert.deepEqual(siteAddress({ name: "j", live, current: live }), { url: "https://juniper.studio", preview: "https://juniper.studio" });
  assert.equal(siteAddress({ name: "j", live: dep("a", 1, { url: "https://x.vyre.run", domains: [{ host: "p.example", status: "pending" }] }), current: live }).url, "https://x.vyre.run", "a domain still waiting for its DNS record is not the address");
  assert.deepEqual(siteAddress({ name: "d", live: null, current: dep("b", 1, { url: "https://prev.vyre.run" }) }), { url: null, preview: "https://prev.vyre.run" });
  assert.deepEqual(siteAddress({ name: "n", live: null, current: dep("c", 1) }), { url: null, preview: null });
});

test("changes wait to be published only when a newer version sits beside a live one", () => {
  const a = dep("a", 1), b = dep("b", 2);
  assert.equal(unpublished({ name: "s", live: a, current: b }), true);
  assert.equal(unpublished({ name: "s", live: a, current: a }), false);
  assert.equal(unpublished({ name: "s", live: null, current: b }), false, "a draft that never went live is a draft, not a change");
});
