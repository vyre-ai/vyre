// @ts-check
// An MCP or harness agent must not relay through onboard as the person: onboard.person.status reaches identity through relay, and every login-able adapter is refused.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { loginAdapters, sessionCaller } from "../lib/agent-adapters.js";

const PASS = "correct horse battery";

test("onboard relay: every login-able adapter agent is refused on a write that would relay identity.create, a tool that takes the master password", async (t) => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const input = { username: "alex", password: PASS, confirm: PASS };
  for (const id of loginAdapters(d.registry.providers.keys())) {
    for (const agent of [id, "kit", "juno"]) {
      const caller = sessionCaller(id, { agent });
      const r = await d.registry.call("onboard.person.create", input, caller);
      assert.ok(r.error, `${caller} must not create identity: ${JSON.stringify(r.data)}`);
      assert.equal(r.error.code, "denied", `${caller}: ${r.error.code} ${r.error.message}`);
      assert.ok(!JSON.stringify(r).includes(PASS), `${caller} must not see the password back`);
      assert.ok(!JSON.stringify(r).includes("recoveryKey"), `${caller} must not see recovery material`);
    }
  }
});
