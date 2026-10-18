// @ts-check
// When a key is taken away from a plugin's MCP server, the Vault tells the hub at once (mcp.sweep) instead of leaving it to the hub's own 30-second look: a grant revoked, an item deleted, a member who leaves.
// Run it on a test box.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { start } from "../core/daemon/index.js";
import { tempHome, present, asOwner } from "./helpers.js";

test("the Vault calls mcp.sweep when a grant is revoked, an item is deleted and a member leaves", { timeout: 90_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(`${root}/config.json`, JSON.stringify({ vault: { keystore: "file" }, recall: { every: 0, vectors: false } }));
  const d = await start({ root, log: () => {}, presence: present, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  /** @type {any[]} */ const swept = [];
  const orig = d.registry.call.bind(d.registry);
  d.registry.call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ meta) => { if (tool === "mcp.sweep") swept.push({ input, caller }); return orig(tool, input, caller, meta); };
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await d.registry.call(tool, input, "cli"); if (r.error) throw new Error(`${tool}: ${r.error.message}`); return r.data; };
  const until = async (/** @type {() => any} */ f, /** @type {string} */ what) => { for (let i = 0; i < 100; i++) { if (f()) return; await new Promise(r => setTimeout(r, 50)); } assert.fail(what); };

  await call("vault.put", { name: "notes-key", kind: "secret", value: "fixture-not-a-real-key-123456" });
  await call("vault.grant", { name: "notes-key", module: "mcp", watcher: "p-notes-notes.NOTES_API_KEY" });
  await call("vault.revoke", { name: "notes-key", module: "mcp", watcher: "p-notes-notes.NOTES_API_KEY" });
  await until(() => swept.some(s => s.input && s.input.item === "notes-key"), "a revoked grant did not reach the hub");
  assert.equal(swept[0].caller, "module:vault", "and it is the Vault's own call");

  swept.length = 0;
  await call("vault.delete", { name: "notes-key" });
  await until(() => swept.some(s => s.input && s.input.item === "notes-key"), "a deleted item did not reach the hub");

  swept.length = 0;
  d.registry.deps.events.emit("kernel", "member.removed", { person: "per_" + "c".repeat(26) });
  await until(() => swept.length > 0, "a member who left did not reach the hub");
});
