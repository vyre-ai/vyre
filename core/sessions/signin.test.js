// @ts-check
import "../../scripts/mac-test-guard.mjs";
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

import { signinAddressOk } from "./signin.js";

test("signin: hostile addresses are never on a provider's host, and its own are", () => {
  const bad = [
    "http://auth.openai.com/device", "https://auth.openai.com.evil.com/device", "https://evilopenai.com/device", "https://openai.com@evil.com/device",
    "https://user:pw@auth.openai.com/device", "https://auth.openai.com\\@evil.com/", "https://evil.com/?https://openai.com", "//openai.com/device",
    "javascript:alert(1)//openai.com", "data:text/html,https://openai.com", "https://openai.com.:443@evil.com/", "https://auth.openai.com:8443@evil.com/",
    "https://openai.com.evil.com/", "https://0.0.0.0/", "https://[::1]/", "https://127.0.0.1/openai.com", "https://auth.openai.com%2f@evil.com/",
    "https://notopenai.com/", "https://openai.com.cn/", "https://xn--openai-9d0b.com/", "ftp://auth.openai.com/device", "https:/\\auth.evil.com/", "https://evil.com#@openai.com/",
    "https://evil.com/@openai.com", "https://openai.com\u0000.evil.com/", "https:// openai.com/", "not a url",
  ];
  for (const u of bad) assert.equal(signinAddressOk("codex", u), false, u);
  for (const u of ["https://auth.openai.com/device", "https://chatgpt.com/auth/device", "https://openai.com/login", "https://auth.openai.com/device?login_hint=alex%40harlow.example", "https://auth.openai.com/device?login_hint=alex@harlow.example&x=1", "https://auth.openai.com/log@in"]) assert.equal(signinAddressOk("codex", u), true, u);
  assert.equal(signinAddressOk("grok", "https://auth.openai.com/device"), false, "another provider's host is not grok's");
  assert.equal(signinAddressOk("gemini", "https://auth.openai.com/device"), false, "no provider, no hosts");
});

test("signin: a docs link printed first is not the address; the one whose path says device, login or auth is", async t => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "login-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const script = 'console.log("Docs: https://openai.com/docs/codex"); console.log("Open https://auth.openai.com/codex/device and enter ABCD-1234"); setTimeout(() => {}, 400)';
  const s = new Signins({ spawn: () => spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] }) });
  t.after(() => s.stop());
  const r = await s.start({ provider: "codex", account: { id: "d" } });
  assert.deepEqual([r.step, r.url, r.code], ["code", "https://auth.openai.com/codex/device", "ABCD-1234"]);
});

test("signin: a sign-in nobody finishes ends at its time limit and says onDone false, so the row it created can be removed", async t => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "login-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const s = new Signins({ ttl: 150, spawn: () => spawn(FAKE, [], { env: { ...process.env, HOME: home, FAKE_LOGIN: "device", FAKE_LOGIN_MS: "60000" }, stdio: ["pipe", "pipe", "pipe"] }) });
  t.after(() => s.stop());
  const done = [];
  const first = await s.start({ provider: "codex", account: { id: "a1" }, onDone: ok => done.push(ok) });
  assert.equal(first.step, "code");
  for (let i = 0; i < 50 && !done.length; i++) await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(done, [false], "ended unfinished");
  assert.equal(s.status(first.flow).step, "failed");
});

test("signin: a code pasted after the command closed its input is not a crash (EPIPE on its stdin is handled)", async t => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "login-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Prints claude's sign-in address, closes its own stdin, and stays alive: a write to it fails with EPIPE.
  const script = 'console.log("Open https://claude.ai/oauth/authorize?code=true and paste the code"); require("fs").closeSync(0); setTimeout(() => {}, 1500)';
  const s = new Signins({ spawn: () => spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] }) });
  t.after(() => s.stop());
  const r = await s.start({ provider: "claude", account: { id: "e" } });
  assert.deepEqual([r.step, r.paste], ["url", true], JSON.stringify(r));
  let crashed = null;
  const onCrash = e => { crashed = e; };
  process.on("uncaughtException", onCrash);
  t.after(() => process.off("uncaughtException", onCrash));
  for (let i = 0; i < 3; i++) { s.submit(r.flow, "ABCDEF123456"); await new Promise(res => setTimeout(res, 80)); }
  await new Promise(res => setTimeout(res, 300));
  assert.equal(crashed, null, crashed ? String(crashed.code || crashed.message) : "");
});

test("signin: Claude's pasted code has the form <code>#<state> and is taken; spaces, control characters and an oversize paste are not", async t => {
  const { s } = world(t, "paste");
  const r = await s.start({ provider: "claude", account: { id: "a1" } });
  assert.equal(r.step, "url");
  // A real-shaped paste: a long URL-safe authorization code, a "#", then the 43-character state.
  const code = "Zk3Lw9QmT7vXc2RbN8yHdA1sUe5gPjKo4WiFxVtBnC6lMqY0rEzSaD-hGu_JfOpIkTw9";
  const state = "q7Fv3nYc0bLx-Re5TgHa8uIoMzPk2WdSj9N_ArEiC6s";
  const paste = `${code}#${state}`;
  assert.equal(paste.length > 100, true);
  for (const bad of ["no space allowed#abc", "code#state\r\nmore", "code\u0000#state", "code#st ate", "a".repeat(513), "ab#", ""]) {
    assert.throws(() => s.submit(r.flow, bad), /does not look like/, JSON.stringify(bad).slice(0, 30));
  }
  assert.deepEqual(s.submit(r.flow, `${paste}\n`), { flow: r.flow, step: "waiting" }, "a trailing newline from the paste is trimmed, not refused");
  assert.equal(/^[A-Za-z0-9_.~#%=+\/-]{6,512}$/.test("a".repeat(512)), true, "512 is the limit");
});
