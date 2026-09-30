// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Signins } from "./signin.js";
import { SCRATCH } from "../../test/scratch.mjs";

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "testing", "fake-login.js");
const world = (t, mode) => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "login-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const s = new Signins({ spawn: () => spawn(FAKE, [], { env: { ...process.env, HOME: home, FAKE_LOGIN: mode }, stdio: ["pipe", "pipe", "pipe"] }) });
  t.after(() => s.stop());
  return { s, home };
};

test("signin: the device code and address are read from the command's own output, and it finishes when the person approves", async t => {
  const { s, home } = world(t, "device");
  const first = await s.start({ provider: "codex", account: { id: "a1" } });
  assert.deepEqual([first.step, first.url, first.code], ["code", "https://auth.openai.com/device", "WXYZ-1234"]);
  for (let i = 0; i < 50 && s.status(first.flow).step !== "done"; i++) await new Promise(r => setTimeout(r, 40));
  assert.equal(s.status(first.flow).step, "done");
  assert.ok(fs.existsSync(path.join(home, ".fake", "auth.json")), "the command wrote its own token in the account's HOME");
});

test("signin: a login that ends badly says what the command said, and a paste-back login takes the code on stdin", async t => {
  const bad = world(t, "fail");
  const f = await bad.s.start({ provider: "codex", account: { id: "a2" } });
  assert.equal(f.step, "failed");
  assert.match(String(f.message), /expired_token/);
  const p = world(t, "paste");
  const r = await p.s.start({ provider: "claude", account: { id: "a3" } });
  assert.deepEqual([r.step, r.paste], ["url", true]);
  assert.match(String(r.url), /^https:\/\/claude\.ai\/oauth/);
  assert.throws(() => p.s.submit(r.flow, "no!"), /does not look like/);
  p.s.submit(r.flow, "good-code-123");
  for (let i = 0; i < 50 && p.s.status(r.flow).step !== "done"; i++) await new Promise(x => setTimeout(x, 40));
  assert.equal(p.s.status(r.flow).step, "done");
  assert.throws(() => p.s.submit(r.flow, "good-code-123"), /not waiting/);
});

test("signin: a provider Vyre has no login for is refused, and a second start for one account replaces the first", async t => {
  const { s } = world(t, "device");
  assert.throws(() => s.start({ provider: "gemini", account: { id: "x" } }), /no sign-in/);
  const a = await s.start({ provider: "codex", account: { id: "same" } });
  const b = await s.start({ provider: "codex", account: { id: "same" } });
  assert.notEqual(a.flow, b.flow);
  assert.throws(() => s.status("nope"), { code: "not_found" });
});

test("signin: an address on any host but the provider's own is never handed on", async t => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "login-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Grok's hosts (x.ai, grok.com) do not include the address the fake prints.
  const s = new Signins({ spawn: () => spawn(FAKE, [], { env: { ...process.env, HOME: home, FAKE_LOGIN_MS: "200" }, stdio: ["pipe", "pipe", "pipe"] }) });
  t.after(() => s.stop());
  const r = await s.start({ provider: "grok", account: { id: "h" } });
  assert.notEqual(r.step, "code", "no address, no code shown");
  assert.ok(!r.url);
});
