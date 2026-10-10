// @ts-check
// An agent that rides a person's surface label (`cli:agent:kit`, `local:agent:kit`) only ASKS in the Vault, as Claude's own session does: a grant, an agent login, a pass accepted or made and a trusted card wait
// for a person, and the values and keys a person's surface gives are not taken from it. Before, the check stopped at the label "mcp", so these labels made an ACTIVE grant and a module then read the secret.
// Found by test/model-label-matrix (12 cells). A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present, asOwner } from "./helpers.js";
import { isAsker } from "../core/vault/asker.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

test("who only asks: Claude, any agent label on any surface, a guest and an unknown label; not a person's surface or a module", () => {
  for (const c of ["mcp", "mcp:agent:kit", "cli:agent:kit", "local:agent:kit", "tailnet:agent:kit", "agent:kit", "cli:agent:", "harness", "tailnet-guest", "anonymous", "unknown"]) assert.equal(isAsker(c), true, c);
  for (const c of ["cli", "local", "deck", "capsule", "module:voice", "tailnet:owner"]) assert.equal(isAsker(c), false, c);
});

test("a grant asked by an agent label waits for a person: no module can read the secret until the person approves", { timeout: 180_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller) => d.registry.call(tool, input, caller, {});
  assert.ok(!(await call("vault.put", { name: "deepgram", kind: "secret", fields: { value: "fixture-0123456789abcdef0123" } }, "cli")).error);
  const release = () => d.registry.call("vault.release", { name: "deepgram" }, "module:voice", { door: true });
  for (const who of ["cli:agent:kit", "local:agent:kit", "mcp:agent:kit"]) {
    const g = await call("vault.grant", { name: "deepgram", module: "voice" }, who);
    assert.equal(g.data && g.data.grant.status, "pending", `${who}: the grant waits`);
    assert.match((await release()).error.message, /not granted/, `${who}: the module reads nothing yet`);
  }
  // the person's own surface grants at once, and only then does the module read it
  assert.equal((await call("vault.grant", { name: "deepgram", module: "voice" }, "cli")).data.grant.status, "active");
  assert.equal(typeof (await release()).data.value, "string");
});
