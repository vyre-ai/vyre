// @ts-check
// A provider's session sign-in token, on the items Vyre already has (claude-setup-token and anthropic-api-key, made by core/onboard and chosen per session by sessions): the person
// sets, replaces and removes one with presence, the app learns "stored, added when" and never the value, and the session launcher reads it through a port taken once.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { takeCredentialsPort } from "./index.js";

const fake = l => `fixture-${l}-${crypto.randomBytes(14).toString("hex")}`;
async function daemon(t, vaultConfig = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file", ...vaultConfig } }));
  const logs = /** @type {string[]} */ ([]), d = await start({ root, presence: present, log: m => logs.push(String(m)) });
  t.after(() => d.stop());
  const reg = (tool, input = {}, caller = "cli", meta = {}) => d.registry.call(tool, input, caller, meta);
  return { root, d, reg, logs };
}
const everything = async (reg, logs) => JSON.stringify([logs, (await reg("vault.audit", {}, "cli")).data ?? null, (await reg("vault.list", {}, "cli")).data ?? null]);

test("only you, or the setup page for you, add, replace or remove the token; a module, an agent, a watcher and a hook are refused", async t => {
  const { reg } = await daemon(t), tok = fake("claude");
  for (const [who, caller, meta] of [["a module", "module:sessions", {}], ["the mcp hub", "module:mcp", {}], ["mcp", "mcp", {}], ["an agent", "mcp:agent:juno", { thread: "t-1", agent: "juno" }], ["a watcher", "module:watchers", {}], ["a webhook", "hook", {}]]) {
    assert.ok((await reg("vault.provider.set", { provider: "claude", token: tok }, caller, meta)).error, `${who} must be refused to set`);
    assert.ok((await reg("vault.put", { name: "claude-setup-token", kind: "secret", fields: { value: tok } }, caller, meta)).error, `${who} must be refused through vault.put`);
  }
  // The setup page (core/onboard) keeps making the item the way it does today; the person can then replace it.
  assert.ok(!(await reg("vault.put", { name: "claude-setup-token", kind: "secret", description: "from setup", value: fake("viaonboard"), grants: ["agents", "threads"] }, "module:onboard")).error, "onboard still stores it");
  assert.equal((await reg("vault.provider.set", { provider: "claude", token: tok }, "cli")).data.stored, true, "replaced by the person");
  for (const caller of ["module:sessions", "mcp", "module:watchers"]) assert.ok((await reg("vault.provider.remove", { provider: "claude" }, caller)).error, `${caller} may not remove`);
  assert.ok((await reg("vault.delete", { name: "claude-setup-token" }, "module:sessions")).error, "nor through vault.delete");
  assert.equal((await reg("vault.provider.remove", { provider: "claude" }, "cli")).data.stored, false);
  assert.deepEqual((await reg("vault.provider.status", {}, "cli")).data.tokens, []);
  for (const bad of [{ provider: "codex", token: tok }, { provider: "__proto__", token: tok }, { provider: "constructor", token: tok }, { provider: "toString", token: tok }, { provider: "claude", token: "has a space" }]) assert.ok((await reg("vault.provider.set", bad, "cli")).error, JSON.stringify(bad));
  assert.equal((await reg("vault.provider.set", { provider: "anthropic", token: fake("api") }, "cli")).data.stored, true, "the API key is the other provider item");
});

test("the app learns that one is stored and when, never the value; the logs, the audit and the list carry none, and none is on disk in the clear", async t => {
  const { root, reg, logs } = await daemon(t), tok = fake("claude");
  await reg("vault.provider.set", { provider: "claude", token: tok }, "cli");
  const st = (await reg("vault.provider.status", {}, "cli")).data.tokens; assert.equal(st.length, 1); assert.deepEqual([st[0].provider, st[0].item, st[0].stored], ["claude", "claude-setup-token", true]); assert.ok(st[0].added);
  assert.equal(JSON.stringify(st).includes(tok), false); assert.equal((await everything(reg, logs)).includes(tok), false);
  for (const f of fs.readdirSync(root, { recursive: true })) { const p = path.join(root, String(f)); if (fs.statSync(p).isFile() && fs.statSync(p).size < 50_000_000) assert.equal(fs.readFileSync(p).includes(Buffer.from(tok)), false, `sealed at rest: ${f}`); }
});

test("the credentials port: the daemon took it once, the launcher gets the environment for an agent provider in the shape lib/agent-sandbox.js reads, or nothing, and each use leaves an audit row without the value", async t => {
  const { d, reg, logs } = await daemon(t), tok = fake("claude"), key = fake("api");
  await reg("vault.put", { name: "claude-setup-token", kind: "secret", value: tok, grants: ["agents", "threads"] }, "module:onboard"); // as core/onboard makes it
  await reg("vault.provider.set", { provider: "anthropic", token: key }, "cli");
  // VP-2: the DAEMON took the port right after the vault started, so nothing else can: a second take fails.
  const port = d.registry.deps.credentialsPort; assert.ok(port, "the daemon holds the credentials port");
  assert.throws(() => takeCredentialsPort(), /already taken/, "nothing that imports the vault later can take it");
  assert.deepEqual(await port.credentials("claude"), { CLAUDE_CODE_OAUTH_TOKEN: tok, ANTHROPIC_API_KEY: key });
  assert.deepEqual(await port.credentials("codex"), {}); assert.deepEqual(await port.credentials("../x"), {}); for (const p of ["__proto__", "constructor", "toString"]) assert.deepEqual(await port.credentials(p), {}, p);
  assert.ok(Object.isFrozen(port)); assert.equal(Object.keys(port).join(), "credentials");
  const all = await everything(reg, logs); assert.equal(all.includes(tok) || all.includes(key), false); assert.match(all, /provider-token/);
  await reg("vault.provider.remove", { provider: "claude" }, "cli"); assert.deepEqual(await port.credentials("claude"), { ANTHROPIC_API_KEY: key }, "removed means gone");
});

test("launcherOnly: once it is on, no module is granted the token, and the person's own reveal still needs presence like any item", async t => {
  const { d, reg } = await daemon(t, { launcherOnly: true }), tok = fake("claude");
  await reg("vault.provider.set", { provider: "claude", token: tok }, "cli");
  for (const m of ["agents", "threads", "sessions"]) assert.ok((await reg("vault.grant", { name: "claude-setup-token", module: m }, "cli")).error, `${m} is not granted it`);
  assert.ok((await reg("vault.put", { name: "claude-setup-token", kind: "secret", value: fake("x"), grants: ["agents"] }, "module:onboard")).error, "onboard must stop attaching grants before this is switched on");
  assert.deepEqual(await d.registry.deps.credentialsPort.credentials("claude"), { CLAUDE_CODE_OAUTH_TOKEN: tok });
});
