// @ts-check
// G03: a member's own AI key on the team's server. On a real daemon with an owner and members: the member puts a key, names it for an account, starts a turn on it; the owner and another member can
// neither see it, name it, share it nor remove it; its value reaches only the child of its owner's turn; a member who leaves can no longer use it. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "core", "switchboard", "testing", "fake-claude.js");
fs.chmodSync(FAKE, 0o755);
const BOB = "per_" + "b".repeat(26), EVE = "per_" + "e".repeat(26);
const KEY = "sk-ant-fixture-" + "k7Qp2Zr9".repeat(4);
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };

test("a member's key: theirs alone, usable in their own turn, gone when they leave", { timeout: 240_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  const log = path.join(root, "claude.log");
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG, VYRE_SESSION_SANDBOX_OFF: process.env.VYRE_SESSION_SANDBOX_OFF };
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_LOG: log, VYRE_SESSION_SANDBOX_OFF: "1" });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] }, projectsDir: path.join(root, "projects") }));
  const logs = /** @type {string[]} */ ([]);
  const d = await start({ root, presence: present, log: m => logs.push(String(m)), kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev-" + person.slice(4, 10), person, path: "direct", session: "s" });
  const as = async (/** @type {string} */ person, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(chainOf(person), {})).token });
  for (const p of [BOB, EVE]) await d.kernel.gateway.grants.setRole(chainOf(owner), { person: p, role: "member" }, { presence: { method: "stand-in" } });

  // Bob puts a key: the answer carries no value, and he alone lists it
  const put = await as(BOB, "vault.member.put", { kind: "api-key", label: "Bob's key", value: KEY });
  assert.ok(!put.error, JSON.stringify(put.error));
  assert.ok(!JSON.stringify(put).includes(KEY), "no value in the answer");
  assert.match(put.data.item, /^member:mk_/);
  assert.equal((await as(BOB, "vault.member.list")).data.keys.length, 1);
  assert.equal((await as(owner, "vault.member.list")).data.keys.length, 0, "the owner sees none");
  assert.equal((await as(EVE, "vault.member.list")).data.keys.length, 0, "nor does another member");
  assert.equal((await as(owner, "vault.member.remove", { id: put.data.id })).error?.code, "not_found", "the owner cannot remove it");
  assert.equal((await as(EVE, "vault.member.remove", { id: put.data.id })).error?.code, "not_found");
  const vlist = JSON.stringify((await as(owner, "vault.list")).data || {});
  assert.ok(!vlist.includes(put.data.id) && !vlist.includes(KEY), "the vault's own list shows nothing of it");
  // a call with no person behind it puts nothing; the sessions-only tools refuse everyone else
  assert.ok((await d.registry.call("vault.member.put", { kind: "api-key", value: KEY }, "cli", {})).error, "no person, no key");
  assert.equal((await d.registry.call("vault.member.release", { id: put.data.id, person: BOB }, "module:vyred")).error?.code, "denied", "only the threads module releases a value");
  assert.equal((await d.registry.call("vault.member.put-for", { person: EVE, kind: "api-key", value: KEY }, "module:vyred")).error?.code, "denied");

  // the account naming it: Bob's only
  const acct = await as(BOB, "sessions.accounts.add", { provider: "claude", label: "Bob key", kind: "api-key", vault_item: put.data.item });
  assert.ok(!acct.error, JSON.stringify(acct.error));
  assert.equal((await as(EVE, "sessions.accounts.add", { provider: "claude", label: "Eve takes Bob's", kind: "api-key", vault_item: put.data.item })).error?.code, "denied", "another member cannot name it");
  assert.equal((await as(owner, "sessions.accounts.add", { provider: "claude", label: "Owner takes Bob's", kind: "api-key", vault_item: put.data.item })).error?.code, "denied", "nor can the owner");
  assert.equal((await as(BOB, "sessions.accounts.add", { provider: "claude", label: "Bob takes the owner's", kind: "api-key", vault_item: "anthropic-api-key" })).error?.code, "denied", "a member names only a key of their own");

  // Bob's turn runs on it: the child gets an api-key credential; the value is in no log line
  const th = await d.registry.call("threads.launch", { prompt: "hello", account: acct.data.id, person: BOB, name: "bob-chat", cwd: root }, "module:vyred");
  assert.ok(!th.error, JSON.stringify(th.error));
  const line = await until(async () => { try { return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)).find(l => l.auth === "api-key"); } catch { return null; } }, "a launch on an api-key credential");
  assert.ok(line, "the turn was started with the member's key");
  assert.ok(!fs.readFileSync(log, "utf8").includes(KEY) && !logs.join("\n").includes(KEY), "the value is in no log");
  // and the owner cannot start a turn on Bob's account
  const stolen = await d.registry.call("threads.launch", { prompt: "hello", account: acct.data.id, person: owner, name: "owner-chat", cwd: root }, "module:vyred");
  assert.ok(stolen.error, "an account that serves Bob serves no one else");

  // Bob leaves: the key is no longer used, and the account says so
  await d.kernel.gateway.grants.removeMember(chainOf(owner), { person: BOB }, { presence: { method: "stand-in" } });
  const rel = await d.registry.call("vault.member.release", { id: put.data.id, person: BOB }, "module:threads");
  assert.equal(rel.error?.code, "not_found");
  assert.match(rel.error.message, /no longer a member/);
});
