// @ts-check
// [reviewed: trust] An MCP or harness result never contains a vault value, including after a tool runs.
// Lending (vault.request) is the path that injects a value. The registry scrubs every other result on the way out.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { scrubVaultResult } from "../core/modules/needs-you-hold.js";
import { lineOfOp } from "../lib/one-yes.js";

const SENTINEL = "VYRE-VAULT-SENTINEL-9f3a-horse";

test("scrubbing removes a vault value from an assistant result and leaves the person's", () => {
  const dirty = {
    data: {
      username: "alex",
      recoveryKey: SENTINEL,
      note: `keep ${SENTINEL} safe`,
      nested: { password: SENTINEL, ok: true },
      items: [{ apiKey: SENTINEL, name: "site" }],
    },
  };
  const mcp = scrubVaultResult("mcp", "onboard.person.create", dirty);
  assert.equal(JSON.stringify(mcp).includes(SENTINEL), false);
  assert.equal(mcp.data.username, "alex");
  assert.equal(mcp.data.nested.ok, true);
  assert.equal(mcp.data.recoveryKey, undefined);
  const cli = scrubVaultResult("cli", "onboard.person.create", dirty);
  assert.equal(cli.data.recoveryKey, SENTINEL);
  const lent = scrubVaultResult("mcp", "vault.request", { data: { status: 200, body: "ok", token: SENTINEL } });
  assert.equal(lent.data.token, undefined);
  assert.equal(lent.data.body, "ok");
});

test("no MCP tool result contains a vault value, and a device line names the device", async (t) => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  d.registry.tools.set("probe.vault", {
    module: "probe", description: "probe", input: { type: "object" }, effect: "read", callers: null, reach: "anyone",
    needsYou: false, internal: false, hook: false, presence: false, outward: null, defaulted: false,
    run: async () => ({ recoveryKey: SENTINEL, username: "alex", note: `keep ${SENTINEL} safe`, nested: { password: SENTINEL } }),
  });
  const mcp = await d.registry.call("probe.vault", {}, "mcp");
  assert.equal(JSON.stringify(mcp).includes(SENTINEL), false, JSON.stringify(mcp));
  assert.equal(mcp.data.username, "alex");
  const person = await d.registry.call("probe.vault", {}, "cli");
  assert.equal(person.data.recoveryKey, SENTINEL);
  for (const name of ["vault.reveal", "vault.copy", "vault.state", "vault.account.export-secret-key"]) {
    if (!d.registry.tools.has(name)) continue;
    const r = await d.registry.call(name, { name: "site" }, "mcp");
    assert.equal(JSON.stringify(r).includes(SENTINEL), false, name);
    assert.equal(r.data, undefined, name);
    assert.equal(r.error && r.error.code, "denied", name);
  }
  const line = lineOfOp("onboard.windows", { name: "Desk", type: "windows", fingerprint: "ab12cd34ef56", label: "Desk" }, "An assistant (mcp)");
  assert.match(line, /An assistant \(mcp\)/);
  assert.match(line, /Desk/);
  assert.match(line, /windows/);
  assert.match(line, /ab12cd34ef56/);
});
