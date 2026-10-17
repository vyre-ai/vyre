// @ts-check
// The reviewed rows: each one names a remote address on the vendor's own host, how it signs in, the discovery result a
// probe read from the vendor's own metadata, and a verdict for Vyre. No network: this checks the file's shape and rules.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { urlKey } from "./mcp-catalog.js";

const FILE = JSON.parse(fs.readFileSync(new URL("./mcp-catalog.reviewed.json", import.meta.url), "utf8"));
const VERDICTS = ["one-click", "conditional", "blocked"];
const RESULTS = ["dcr-advertised", "needs-client", "no-oauth", "refused", "unprobed"];

test("every reviewed row is a complete snapshot entry with an https address", () => {
  assert.equal(FILE.v, 1);
  assert.ok(FILE.entries.length >= 15, "the first reviewed snapshot has real rows");
  const ids = new Set();
  for (const e of FILE.entries) {
    for (const k of ["id", "name", "vendor", "description", "category", "url", "transport", "auth", "headers", "verified", "basis", "sources", "probe", "verdict"]) assert.ok(k in e, `${e.id} has ${k}`);
    assert.ok(!ids.has(e.id), `${e.id} repeated`);
    ids.add(e.id);
    assert.equal(new URL(e.url).protocol, "https:", e.id);
    assert.ok(urlKey(e.url), `${e.id} url is a usable address`);
    assert.ok(VERDICTS.includes(e.verdict), e.id);
    assert.ok(RESULTS.includes(e.probe.result), e.id);
  }
});

test("a row is one-click only when Vyre can connect with no vendor registration: dcr-advertised with a verified sign-in", () => {
  for (const e of FILE.entries.filter(x => x.verdict === "one-click")) {
    const open = e.probe.result === "no-oauth" && e.auth === "none";
    assert.ok(e.probe.result === "dcr-advertised" || open, `${e.id}: one-click needs dcr-advertised, or no sign-in at all`);
    assert.equal(e.verified, true, `${e.id}: one-click needs a vendor-domain address`);
  }
});

test("a row whose vendor needs its own client is never one-click", () => {
  for (const e of FILE.entries.filter(x => x.probe.result === "needs-client")) assert.notEqual(e.verdict, "one-click", e.id);
});

test("Calendly is conditional until a probe passes its loopback redirect, and Figma is blocked by its vendor", () => {
  assert.equal(FILE.entries.find(e => e.id === "calendly").verdict, "conditional");
  assert.equal(FILE.entries.find(e => e.id === "figma").verdict, "blocked");
});
