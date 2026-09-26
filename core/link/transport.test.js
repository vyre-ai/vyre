// @ts-check
// The link's Tailscale calls under tests: never the user's real Tailscale, always the fake a
// test names in VYRE_TAILSCALE_BIN.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { tailscaleBin, whois, tailnetPeers, REAL_APP } from "./transport.js";

/** Run fn with these env vars set (undefined removes one), then put them back. */
async function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { return await fn(); } finally { for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

test("transport: under node --test the real Tailscale is never resolved without an opt-in", async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, "this runs under node --test");
  await withEnv({ VYRE_TAILSCALE_BIN: undefined, VYRE_TEST_REAL_TAILSCALE: undefined }, async () => {
    assert.equal(tailscaleBin(), null);
    assert.notEqual(tailscaleBin(), REAL_APP);
    // Every caller degrades to "no tailscale here" rather than reaching for the real one.
    assert.equal(await whois("100.64.0.1"), null);
    assert.deepEqual(await tailnetPeers(), []);
  });
});

test("transport: VYRE_TAILSCALE_BIN is used for whois and status", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-ts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "tailscale");
  const whoisJson = JSON.stringify({ Node: { StableID: "nBOX", Name: "box.example.ts.net.", Tags: [] }, UserProfile: { LoginName: "owner@example.com" } });
  const statusJson = JSON.stringify({ Peer: { a: { ID: "nBOX", HostName: "box", DNSName: "box.example.ts.net.", Online: true, TailscaleIPs: ["100.64.0.2"] },
    b: { ID: "nOFF", HostName: "off", DNSName: "off.example.ts.net.", Online: false, TailscaleIPs: ["100.64.0.3"] } } });
  fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = whois ]; then echo '${whoisJson}'; else echo '${statusJson}'; fi\n`, { mode: 0o755 });
  await withEnv({ VYRE_TAILSCALE_BIN: bin }, async () => {
    assert.equal(tailscaleBin(), bin);
    assert.deepEqual(await whois("100.64.0.2"), { stableId: "nBOX", node: "box.example.ts.net", login: "owner@example.com", tagged: false });
    assert.deepEqual(await tailnetPeers(), [{ ip: "100.64.0.2", dns: "box.example.ts.net", stableId: "nBOX", host: "box" }]);
  });
});
