// @ts-check
// B8 (sec53 review): `unnamed` is set by the MCP hub only. Through the REAL registry on a real vyred, a model or a session
// caller that sends `unnamed` is refused as an undeclared key, so no caller can unblock a send by forging it, and no caller
// can make a named call look unnamed to the Gate. The hub (module:mcp) is the only one that sets it, and it can only add a hold.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { canonical } from "../../kernel/core/canonical.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
import path from "node:path";
import http from "node:http";

test("B8: gate.request refuses an `unnamed` key from a model, a session or the CLI, so only the hub can set it", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  writeFileSync(join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: stubPresence() });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const dev = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  const tokenOf = async (/** @type {any} */ c) => ({ token: (await K.surfaces.open(c, {})).token });
  const body = { kind: "send", via: "mail", to: "dana@harlowlegal.com", content: { subject: "Re: intake", body: "Hi." } };
  for (const caller of ["cli", "mcp", "mcp:agent:juno"]) {
    const r = await d.registry.call("gate.request", { ...body, unnamed: true }, caller, await tokenOf(dev(OWNER)));
    assert.ok(r.error, `${caller} sent unnamed and was not refused`);
    assert.equal(r.error.code, "bad_input", `${caller}: ${JSON.stringify(r.error)}`);
  }
  // Without the key the same request is an ordinary held send, so the refusal is about the key, not the call.
  const plain = await d.registry.call("gate.request", body, "cli", await tokenOf(dev(OWNER)));
  assert.ok(!plain.error, JSON.stringify(plain.error));
  assert.equal(plain.data.state, "held");
  void crypto; void canonical;
});
