// @ts-check
// Shared-browser vault sign-in: passwords never reach agent adapters (Claude, Grok, Codex shapes).

import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_ADAPTER_CALLER_SHAPES } from "../lib/computer-agent.js";
import { agentFill } from "../core/vault/agent-fill.js";

const SECRET = "SuperSecretPassw0rd!";
const USER = "alex@example.com";

function vaultStub() {
    const uses = /** @type {any[]} */ ([]);
  return {
    uses,
    row: () => ({ name: "example-login", kind: "login", url: "https://app.northwind.test/login", hosts: ["https://app.northwind.test"] }),
    fields: async () => ({ username: USER, password: SECRET }),
    agents: { recordUse: (u) => uses.push(u) },
    emit: () => {},
    clock: () => Date.now(),
    access: { allowed: async () => true },
  };
}

/** Minimal CDP that completes one sign-in page without echoing secrets outward. */
function cdpStub() {
  const sessionId = "sess-1";
  const targetId = "tgt-1";
  return {
    async connect() {},
    async close() {},
    async send(method, params, sid) {
      if (method === "Target.createBrowserContext") return { browserContextId: "ctx-fill" };
      if (method === "Target.createTarget") return { targetId };
      if (method === "Target.attachToTarget") return { sessionId };
      if (method === "Runtime.evaluate" && params.returnByValue) return { result: { value: "https://app.northwind.test" } };
      if (method === "Runtime.evaluate") return { result: { objectId: "obj-1" } };
      if (method === "Runtime.callFunctionOn") return {};
      if (method === "Input.insertText") return {};
      if (method === "Input.dispatchKeyEvent") return {};
      if (method === "Page.navigate") return {};
      return {};
    },
    on() { return () => {}; },
    waitFor: async () => ({}),
  };
}

test("vault.agent.fill: adapter caller shapes never see the password in events or errors", async () => {
  for (const shape of AGENT_ADAPTER_CALLER_SHAPES) {
    const caller = shape.replace("<name>", "kit");
    const events = [];
    const call = async (tool, input) => {
      if (tool === "computers.fill.begin") return { data: { fill: "f1", cdpUrl: "http://c/cdp", token: "t".repeat(43) } };
      if (tool === "computers.fill.end") { events.push({ tool, input }); return { data: { ended: true } }; }
      return { error: { message: "no" } };
    };
    const vault = vaultStub();
    const { uses } = vault;
    const r = await agentFill({ vault, call, makeCdp: () => cdpStub() }, { agent: "kit", item: "example-login", origin: "https://app.northwind.test" });
    assert.ok(r.filled.includes("password"), caller);
    const blob = JSON.stringify({ r, events, uses });
    assert.ok(!blob.includes(SECRET), `${caller} leaked the password`);
    assert.ok(!blob.includes(USER) || blob.includes("username"), `${caller} leaked username unexpectedly`);
  }
});
