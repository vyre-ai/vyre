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
import { provideOnce } from "../modules/index.js";

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
  assert.ok(!(await reg("vault.put", { name: "claude-setup-token", kind: "secret", description: "from setup", value: fake("viaonboard") }, "module:onboard")).error, "onboard still stores it");
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

test("the credentials port: the vault provided it once, the launcher gets the token for a provider item, or null, and each use leaves an audit row without the value", async t => {
  const { d, reg, logs } = await daemon(t), tok = fake("claude"), key = fake("api");
  await reg("vault.put", { name: "claude-setup-token", kind: "secret", value: tok }, "module:onboard"); // as core/onboard makes it
  await reg("vault.provider.set", { provider: "anthropic", token: key }, "cli");
  // VP-2: the vault provided the port to the registry once, at its own start, and the daemon gave it to the sandbox; no import of the vault is involved, and nothing can take it later.
  const port = d.registry.deps.credentialsPort; assert.ok(port, "the registry holds the credentials port the vault provided");
  // VP-4: the vault may provide again after a restart and the new port replaces the old one; nobody else can provide at all.
  const before = d.registry.deps.credentialsPort, fresh = Object.freeze({ credentials: async () => "fresh" });
  provideOnce(d.registry.deps, "vault", "credentialsPort", fresh); assert.equal(d.registry.deps.credentialsPort, fresh, "the restarted vault's port replaced the old one");
  provideOnce(d.registry.deps, "vault", "credentialsPort", null); assert.equal(d.registry.deps.credentialsPort, null, "a stopped vault clears its port");
  provideOnce(d.registry.deps, "vault", "credentialsPort", before); assert.equal(d.registry.deps.credentialsPort, before);
  for (const [mod, name] of [["sessions", "credentialsPort"], ["agents", "credentialsPort"], ["vault", "sandbox"], ["mcp", "credentialsPort"]]) assert.throws(() => provideOnce({}, mod, name, {}), /may not provide/, `${mod} ${name}`);
  assert.equal(await port.credentials("claude"), tok); assert.equal(await port.credentials("anthropic"), key);
  assert.equal(await port.credentials("codex"), null); assert.equal(await port.credentials("../x"), null); for (const p of ["__proto__", "constructor", "toString"]) assert.equal(await port.credentials(p), null, p);
  assert.ok(Object.isFrozen(port)); assert.equal(Object.keys(port).join(), "credentials");
  const all = await everything(reg, logs); assert.equal(all.includes(tok) || all.includes(key), false); assert.match(all, /provider-token/);
  await reg("vault.provider.remove", { provider: "claude" }, "cli"); assert.equal(await port.credentials("claude"), null, "removed means gone"); assert.equal(await port.credentials("anthropic"), key);
});

test("launcherOnly (on by default): onboard stores the token without grants, no module is granted it, and `vault.launcherOnly: false` turns it off", async t => {
  const { d, reg } = await daemon(t), tok = fake("claude");
  assert.ok(!(await reg("vault.put", { name: "claude-setup-token", kind: "secret", value: fake("y") }, "module:onboard")).error, "onboard stores it without grants");
  await reg("vault.provider.set", { provider: "claude", token: tok }, "cli");
  for (const m of ["agents", "threads", "sessions"]) assert.ok((await reg("vault.grant", { name: "claude-setup-token", module: m }, "cli")).error, `${m} is not granted it`);
  assert.ok((await reg("vault.put", { name: "claude-setup-token", kind: "secret", value: fake("x"), grants: ["agents"] }, "module:onboard")).error, "a grant attached on put is refused");
  assert.equal(await d.registry.deps.credentialsPort.credentials("claude"), tok);
  const off = await daemon(t, { launcherOnly: false });
  await off.reg("vault.provider.set", { provider: "claude", token: tok }, "cli");
  assert.ok(!(await off.reg("vault.grant", { name: "claude-setup-token", module: "agents" }, "cli")).error, "with launcherOnly false a grant is allowed again");
});

test("VP-5: every grant on a put is checked before anything is written: a refused grant leaves no new item and no changed value", async t => {
  const { reg } = await daemon(t), mod = "module:onboard";
  const bad = { grants: ["bad name!"] };
  const r = await reg("vault.put", { name: "onboard.thing", kind: "secret", value: fake("new"), ...bad }, mod); assert.ok(r.error, "an invalid grant is refused");
  assert.equal((await reg("vault.list", {}, "cli")).data.items.some(i => i.name === "onboard.thing"), false, "no item was made");
  assert.ok(!(await reg("vault.put", { name: "onboard.thing", kind: "secret", value: fake("first"), grants: ["agents"] }, mod)).error);
  const rows = async () => (await reg("vault.audit", { limit: 1000 }, "cli")).data.entries;
  const count = async () => (await rows()).length;
  const n0 = await count();
  assert.ok((await reg("vault.put", { name: "onboard.thing", kind: "secret", value: fake("second"), ...bad }, mod)).error, "refused on an existing item too");
  const after = await rows(); assert.equal(after.length, n0 + 1, "exactly one audit row for the refused call");
  const newest = after[0]; assert.equal(newest.action, "put"); assert.equal(newest.ok, false); assert.match(String(newest.why), /^refused:/, "the newest row says the put was refused, and nothing else was written");
  for (const g of ["../x", "", 5, "UPPER"]) assert.ok((await reg("vault.put", { name: "onboard.other", kind: "secret", value: fake("z"), grants: [g] }, mod)).error, String(g));
});

test("VP-6: a packaged build keeps launcherOnly on whatever config.json says; a development build honours false", async t => {
  const { Vault, MIGRATIONS } = await import("./vault.js"), { open, migrate } = await import("../store/index.js"), { SCRATCH } = await import("../../test/scratch.mjs");
  const mk = (buildKind, vault) => {
    const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-vp6-")), db = open(path.join(home, "vyre.db")); migrate(db, "vault", MIGRATIONS);
    t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
    return new Vault({ db, dir: path.join(home, "vault"), config: { name: "box", vault: { keystore: "file", ...vault } }, emit: () => {}, log: () => {}, buildKind });
  };
  assert.equal(mk("release", { launcherOnly: false }).launcherOnly, true, "a release ignores false");
  assert.equal(mk("development", { launcherOnly: false }).launcherOnly, false, "a development tree honours it");
  assert.equal(mk("development", {}).launcherOnly, true); assert.equal(mk("release", {}).launcherOnly, true);
});

test("a refused attempt to attach a grant to a provider sign-in token is a record of its own: who, which item, why, never a value", async t => {
  const { d, reg } = await daemon(t), tok = fake("claude");
  await reg("vault.provider.set", { provider: "claude", token: tok }, "cli");
  const since = d.events.since(0, { limit: 1000 }).length;
  assert.ok((await reg("vault.grant", { name: "claude-setup-token", module: "agents" }, "cli")).error);
  assert.ok((await reg("vault.put", { name: "claude-setup-token", kind: "secret", value: fake("evil"), grants: ["agents"] }, "module:onboard")).error);
  const refused = d.events.since(0, { limit: 1000 }).slice(since).filter(e => e.type === "vault.refused");
  assert.equal(refused.length, 2, "one event per refusal, not one per write");
  const [grant, put] = refused.map(e => e.data ?? e.payload ?? e); assert.deepEqual([grant.action, grant.name, grant.who], ["grant", "claude-setup-token", "cli"]); assert.deepEqual([put.action, put.name, put.who], ["put", "claude-setup-token", "module:onboard"]);
  for (const e of refused) { assert.match(JSON.stringify(e), /provider sign-in token/); assert.equal(JSON.stringify(e).includes(tok) || JSON.stringify(e).includes("evil"), false, "never a value"); }
  const trail = (await reg("vault.audit", { name: "claude-setup-token", limit: 10 }, "cli")).data.entries.filter(e => /^refused:/.test(String(e.why)));
  assert.equal(trail.length, 2); assert.ok(trail.every(e => e.ok === false));
  assert.equal(await d.registry.deps.credentialsPort.credentials("claude"), tok, "and the token is unchanged");
});

test("a provider sign-in token is never put or moved into a shared vault, where a team could use it", async t => {
  const { reg } = await daemon(t), tok = fake("claude");
  await reg("vault.provider.set", { provider: "claude", token: tok }, "cli");
  const put = await reg("vault.put", { name: "team/claude-setup-token", kind: "secret", value: tok }, "cli"); assert.match(put.error?.message ?? "", /never put in a shared vault/);
  const moved = await reg("vault.move", { name: "claude-setup-token", to: "team" }, "cli"); assert.match(moved.error?.message ?? "", /never moved into a shared vault/);
  assert.equal((await reg("vault.audit", { limit: 50 }, "cli")).data.entries.filter(e => /^refused:/.test(String(e.why)) && /claude-setup-token/.test(String(e.name))).length, 2, "both refusals are recorded");
});
