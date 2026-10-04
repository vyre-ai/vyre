// @ts-check
// Tailnet Lock, read-only: parseLock on JSON shaped like `tailscale lock status --json`, and
// lockStatus against a fake binary that logs every argument list, so a test proves the one lock
// command Vyre runs is `lock status --json`. Nothing here reaches the real Tailscale.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";
import { parseLock, lockStatus } from "./tailscale.js";

const BOX_KEY = "tlpub:" + "b0".repeat(32);
const MAC_KEY = "tlpub:" + "a1".repeat(32);

const ON = {
  Enabled: true, Head: "0f".repeat(32), PublicKey: BOX_KEY, NodeKey: "nodekey:" + "c2".repeat(32), NodeKeySigned: true,
  TrustedKeys: [{ Key: MAC_KEY, Votes: 1 }, { Key: BOX_KEY, Votes: 1 }], FilteredPeers: [], StateID: 1,
};
const OFF = { Enabled: false, PublicKey: BOX_KEY, NodeKey: "nodekey:" + "c2".repeat(32), NodeKeySigned: false, TrustedKeys: null };

test("tailscale: parseLock reads on, off and a version that leaves fields out", () => {
  assert.deepEqual(parseLock(ON), { enabled: true, nodeKey: BOX_KEY, trusted: 2, signed: true, why: null });
  assert.deepEqual(parseLock({ ...ON, NodeKeySigned: false }).signed, false, "on, and this box still waits for a signature");
  assert.deepEqual(parseLock(OFF), { enabled: false, nodeKey: BOX_KEY, trusted: null, signed: null, why: null }, "off: the key is still there to hand to lock init");
  assert.deepEqual(parseLock({ Enabled: true }), { enabled: true, nodeKey: null, trusted: null, signed: null, why: null });
  assert.deepEqual(parseLock({}), { enabled: false, nodeKey: null, trusted: null, signed: null, why: null });
  assert.equal(parseLock(null).enabled, false);
  assert.equal(parseLock({ Enabled: "yes", PublicKey: "" }).enabled, false, "only a real true is on");
});

/** A fake tailscale that logs its arguments and prints `out`, exiting with `code`. */
function fake(t, out, code = 0) {
  const home = tempHome(t);
  const bin = path.join(home, "tailscale"), log = path.join(home, "args.log");
  fs.writeFileSync(bin, `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write(${JSON.stringify(out)});
process.exit(${code});
`, { mode: 0o755 });
  const prev = process.env.VYRE_TAILSCALE_BIN;
  process.env.VYRE_TAILSCALE_BIN = bin;
  t.after(() => { if (prev === undefined) delete process.env.VYRE_TAILSCALE_BIN; else process.env.VYRE_TAILSCALE_BIN = prev; });
  return () => fs.readFileSync(log, "utf8");
}

test("tailscale: lockStatus runs only `lock status --json` and reads its answer", async t => {
  const args = fake(t, JSON.stringify(ON));
  assert.deepEqual(await lockStatus(), { enabled: true, nodeKey: BOX_KEY, trusted: 2, signed: true, why: null });
  assert.equal(args(), "lock status --json\n");
});

test("tailscale: lockStatus says why when Tailscale gives no JSON, or is not there", async t => {
  fake(t, "tailscale: failed to connect to local tailscaled\n", 1);
  const r = await lockStatus();
  assert.equal(r.enabled, false);
  assert.equal(r.nodeKey, null);
  assert.equal(r.why, "tailscale: failed to connect to local tailscaled");

  process.env.VYRE_TAILSCALE_BIN = path.join(tempHome(t), "no-tailscale");
  assert.equal((await lockStatus()).why, "Tailscale is not installed");
});
