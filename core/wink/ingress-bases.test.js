// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { tellIngressBase, BASE_TOOLS } from "./ingress-bases.js";

test("the public address reaches share links, the Vault MCP and the outside agents' MCP, and one that is missing or throws stops none of the others", async () => {
  /** @type {[string, any][]} */ const calls = [];
  tellIngressBase((tool, input) => { calls.push([tool, input]); }, "https://harlow.vyre.run");
  assert.deepEqual(calls, [["artifacts.public.base", { base: "https://harlow.vyre.run" }], ["vault.mcp.base", { base: "https://harlow.vyre.run" }], ["outside.mcp.base", { base: "https://harlow.vyre.run" }]]);
  assert.deepEqual(BASE_TOOLS, calls.map(c => c[0]));
  /** @type {string[]} */ const reached = [];
  tellIngressBase(tool => { reached.push(tool); if (tool === "vault.mcp.base") throw new Error("no such tool"); if (tool === "artifacts.public.base") return Promise.reject(new Error("denied")); }, null);
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(reached, [...BASE_TOOLS], "all three were asked even though the first rejected and the second threw");
});
