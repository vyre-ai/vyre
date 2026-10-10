// @ts-check
// The vendor policy, end to end on a real daemon: a chat on a vendor the person's settings leave out starts nothing, for Claude, Codex and Grok alike, whichever way the account signs in.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "./testing/boot.js";

delete process.env.VYRE_LEGACY_DIRECT_MODEL;

/** A stand-in `grok` and `codex-acp` first on PATH, as in login-direct.test.js. */
const withAcp = (/** @type {any} */ t, /** @type {any} */ w) => {
  const bin = path.join(w.root, "shim");
  fs.mkdirSync(bin, { recursive: true });
  const fake = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp.js");
  for (const name of ["grok", "codex-acp"]) fs.symlinkSync(fake, path.join(bin, name));
  const saved = { PATH: process.env.PATH, FAKE_ACP_STORE: process.env.FAKE_ACP_STORE };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_ACP_STORE = path.join(w.root, "acp-store");
  fs.mkdirSync(process.env.FAKE_ACP_STORE, { recursive: true });
  process.env.FAKE_ACP_LOG = path.join(w.root, "acp.log");
  Object.assign(process.env, { FAKE_ACP_EXTRA_MODE: "workspace-write", FAKE_ACP_START_MODE: "agent" });
  t.after(() => { for (const k of ["FAKE_ACP_EXTRA_MODE", "FAKE_ACP_START_MODE", "FAKE_ACP_LOG"]) delete process.env[k]; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
};

for (const provider of ["codex", "grok"]) {
  test(`${provider}: a login account on a vendor the policy leaves out starts nothing and says why; allowed again, it runs`, async t => {
    const w = await boot(t, { driver: "cli" });
    withAcp(t, w);
    assert.equal((await w.tool("sessions.accounts.add", { provider, label: "Mine", kind: "login" })).error, undefined);
    assert.equal((await w.tool("settings.set", { key: "threads.vendors.allow", value: ["claude"], confirm: true })).error, undefined);
    const r = await w.tool("threads.start", { cwd: w.work, provider, prompt: "hello", surface: "deck" });
    assert.ok(r.error, "refused");
    assert.match(String(r.error.message), /do not allow/);
    assert.equal(w.acpPrompts().length, 0, "nothing reached the CLI");
    assert.equal((await w.tool("settings.set", { key: "threads.vendors.allow", value: [provider, "claude"], confirm: true })).error, undefined);
    const th = (await w.tool("threads.start", { cwd: w.work, provider, prompt: "hello", surface: "deck" })).data;
    await w.finished(th.id);
    const said = await w.said(th.id);
    assert.ok(said.length === 1 && said[0].endsWith("hello"), "the allowed vendor ran");
  });
}

test("claude: a chat on Claude is held to the same policy, at its start and at each turn", async t => {
  const w = await boot(t, { driver: "cli" });
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
  await w.finished(th.id);
  assert.equal((await w.tool("settings.set", { key: "threads.vendors.allow", value: ["grok"], confirm: true })).error, undefined);
  const again = await w.tool("threads.send", { thread: th.id, text: "and more", surface: "deck" });
  assert.ok(again.error && /do not allow/.test(String(again.error.message)), JSON.stringify(again.error));
  const fresh = await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" });
  assert.ok(fresh.error && /do not allow/.test(String(fresh.error.message)), JSON.stringify(fresh.error));
});
