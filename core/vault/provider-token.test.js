// @ts-check
// A provider's session sign-in token (the long-lived one `claude setup-token` makes) held in the vault for the session launcher: the person's own, sealed, added, replaced and
// removed only by a person with presence, shown to the app as "stored, added when" and never as a value, and handed to the launcher through a port that can be taken once.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { takeCredentialsPort } from "./index.js";

const fake = l => `fixture-${l}-${crypto.randomBytes(14).toString("hex")}`;
async function daemon(t, config = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" }, ...config }));
  const logs = /** @type {string[]} */ ([]), d = await start({ root, presence: present, log: m => logs.push(String(m)) });
  t.after(() => d.stop());
  const reg = (tool, input = {}, caller = "cli", meta = {}) => d.registry.call(tool, input, caller, meta);
  return { root, d, reg, logs };
}
const everything = async (root, reg, logs) => JSON.stringify([logs, (await reg("vault.audit", {}, "cli")).data ?? null, (await reg("vault.list", {}, "cli")).data ?? null]);

test("only a person's own surface adds, replaces or removes the token; a module, an agent, a watcher and a hook are refused", async t => {
  const { reg } = await daemon(t), tok = fake("claude");
  for (const [who, caller, meta] of [["a module", "module:sessions", {}], ["the mcp hub", "module:mcp", {}], ["mcp", "mcp", {}], ["an agent", "mcp:agent:juno", { thread: "t-1", agent: "juno" }], ["a watcher", "module:watchers", {}], ["a webhook", "hook", {}]]) {
    assert.ok((await reg("vault.provider.set", { provider: "claude", token: tok }, caller, meta)).error, `${who} must be refused to add`);
    assert.ok((await reg("vault.put", { name: "provider-token.claude", kind: "provider-token", fields: { provider: "claude", token: tok } }, caller, meta)).error, `${who} must be refused through vault.put`);
  }
  assert.equal((await reg("vault.provider.set", { provider: "claude", token: tok }, "cli")).data.stored, true);
  const replaced = fake("claude2"); assert.equal((await reg("vault.provider.set", { provider: "claude", token: replaced }, "cli")).data.stored, true);
  for (const caller of ["module:sessions", "mcp", "module:watchers"]) assert.ok((await reg("vault.provider.remove", { provider: "claude" }, caller)).error, `${caller} may not remove`);
  assert.ok((await reg("vault.delete", { name: "provider-token.claude" }, "module:sessions")).error, "a module cannot delete it through vault.delete either");
  assert.equal((await reg("vault.provider.remove", { provider: "claude" }, "cli")).data.stored, false);
  assert.deepEqual((await reg("vault.provider.status", {}, "cli")).data.tokens, []);
  for (const bad of [{ provider: "Claude", token: tok }, { provider: "claude", token: "has a space" }, { provider: "c", token: tok }]) assert.ok((await reg("vault.provider.set", bad, "cli")).error, JSON.stringify(bad));
  assert.ok((await reg("vault.put", { name: "provider-token.other", kind: "provider-token", fields: { provider: "claude", token: tok } }, "cli")).error, "the name is the provider's");
  assert.ok((await reg("vault.put", { name: "team/provider-token.claude", kind: "provider-token", fields: { provider: "claude", token: tok } }, "cli")).error, "never in a shared vault");
});

test("the app learns that one is stored and when, never the value: status, list, reveal, copy, release, inject, a grant, an emergency escrow all refuse or omit it", async t => {
  const { root, reg, logs } = await daemon(t), tok = fake("claude");
  await reg("vault.provider.set", { provider: "claude", token: tok }, "cli");
  const st = (await reg("vault.provider.status", {}, "cli")).data.tokens; assert.equal(st.length, 1); assert.equal(st[0].provider, "claude"); assert.equal(st[0].stored, true); assert.ok(st[0].added);
  assert.equal(JSON.stringify(st).includes(tok), false);
  for (const [tool, input] of [["vault.reveal", { name: "provider-token.claude" }], ["vault.copy", { name: "provider-token.claude" }], ["vault.inject", { items: ["provider-token.claude"] }], ["vault.release", { name: "provider-token.claude" }], ["vault.grant", { name: "provider-token.claude", module: "sessions" }]]) {
    const r = await reg(tool, input, "cli"); assert.ok(r.error || !JSON.stringify(r).includes(tok), `${tool} must not hand it out`); assert.equal(JSON.stringify(r).includes(tok), false, tool);
  }
  assert.equal((await everything(root, reg, logs)).includes(tok), false, "no value in the audit, the list or the logs");
  // Not on disk in the clear.
  for (const f of fs.readdirSync(root, { recursive: true })) { const p = path.join(root, String(f)); if (fs.statSync(p).isFile() && fs.statSync(p).size < 50_000_000) assert.equal(fs.readFileSync(p).includes(Buffer.from(tok)), false, `sealed at rest: ${f}`); }
});

test("the credentials port: the launcher gets the token for a provider, or nothing; it can be taken only once; and using it leaves an audit row without the value", async t => {
  const { reg, root, logs } = await daemon(t), tok = fake("claude");
  await reg("vault.provider.set", { provider: "claude", token: tok }, "cli");
  const port = takeCredentialsPort();
  assert.equal(await port.credentials("claude"), tok); assert.equal(await port.credentials("codex"), null, "a provider with no token gets nothing"); assert.equal(await port.credentials("../x"), null);
  assert.throws(() => takeCredentialsPort(), /already taken/, "a module that imports the vault later cannot take it");
  assert.equal(Object.keys(port).join(), "credentials"); assert.ok(Object.isFrozen(port));
  assert.equal((await everything(root, reg, logs)).includes(tok), false); assert.match(JSON.stringify((await reg("vault.audit", {}, "cli")).data ?? ""), /provider-token/);
  await reg("vault.provider.remove", { provider: "claude" }, "cli"); assert.equal(await port.credentials("claude"), null, "removed means gone");
});
