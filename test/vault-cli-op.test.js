// @ts-check
// `vyre vault` as a 1Password `op` user would reach for it, against a real vyred in a temp home:
// --json on every command with exit codes, get and read, inject to a file vyred writes, run with
// an env file of references, edit, the SSH agent through the real ssh-add, and real
// `git credential fill` going through bin/git-credential-vyre.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exitFor } from "../core/cli/commands/vault.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(REPO, "bin", "vyre");
const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const sha = v => crypto.createHash("sha256").update(v).digest("hex");

/** Run a program with piped stdin, collecting both streams. */
function spawnIt(bin, args, env, input) {
  return new Promise(resolve => {
    const p = spawn(bin, args, { env });
    let out = "", err = "";
    p.stdout.on("data", c => { out += c; });
    p.stderr.on("data", c => { err += c; });
    p.on("close", code => resolve({ code, out, err, all: out + err }));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}
const vyre = (home, args, input) => spawnIt(process.execPath, [BIN, ...args], { ...process.env, VYRE_HOME: home, NO_COLOR: "1" }, input);

function home(t, config) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-test-"));
  if (path.resolve(h) === path.resolve(os.homedir(), ".vyre")) throw new Error("a test tried to use the real ~/.vyre");
  fs.writeFileSync(path.join(h, "config.json"), JSON.stringify(config));
  t.after(async () => { await vyre(h, ["down"]); fs.rmSync(h, { recursive: true, force: true }); });
  return h;
}

/** --json prints exactly one line on stdout, and it parses. */
function one(r) {
  const lines = r.out.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `expected one JSON line, got: ${r.out}`);
  return JSON.parse(lines[0]);
}

test("vault op parity: --json and exit codes, get, read, inject, run --env-file, edit, rm", async t => {
  const h = home(t, { name: "owner-box", vault: { keystore: "file" } });
  assert.equal((await vyre(h, ["up"])).code, 0);
  const token = fake("token"), pw = fake("pw");
  assert.equal((await vyre(h, ["vault", "add", "api-token", "--kind", "api-key", "--host", "https://api.example.com"], token)).code, 0);
  const put = await vyre(h, ["call", "vault.put", JSON.stringify({ name: "mail", kind: "login", fields: { username: "alex@example.com", password: pw, totp: "JBSWY3DPEHPK3PXP" }, url: "https://mail.example.com" })]);
  assert.equal(put.code, 0, put.all);

  const list = one(await vyre(h, ["vault", "list", "--kind", "login", "--json"]));
  assert.deepEqual(list.data.items.map(i => i.name), ["mail"]);
  const got = await vyre(h, ["vault", "get", "mail", "--json"]);
  assert.equal(got.code, 0);
  assert.equal(one(got).data.item.otp, true);
  const human = await vyre(h, ["vault", "get", "mail"]);
  assert.match(human.out, /fields\s+username, password, totp/);
  assert.ok(!human.all.includes(pw));
  const missing = await vyre(h, ["vault", "get", "ghost", "--json"]);
  assert.equal(missing.code, 1);
  assert.equal(one(missing).error.code, "failed");
  const usage = await vyre(h, ["vault", "get", "--json"]);
  assert.equal(usage.code, 1);
  assert.equal(one(usage).error.code, "bad_input");

  // reveal prints the one field asked for (presence is not enforced on this registry yet); copy
  // under node --test refuses rather than touch the real clipboard, and never prints the value.
  const rev = await vyre(h, ["vault", "get", "mail", "--reveal", "--field", "password"]);
  assert.equal(rev.code, 0, rev.all);
  assert.ok(rev.out.includes(pw));
  const copy = await vyre(h, ["vault", "get", "mail", "--copy", "--json"]);
  assert.ok(one(copy).error, copy.all);
  assert.ok(!copy.all.includes(pw));
  assert.match((await vyre(h, ["vault", "get", "mail", "--otp"])).out, /\d{6}/);

  // read: the value alone, for $(...).
  assert.equal((await vyre(h, ["vault", "read", "vault://api-token"])).out, token + "\n");
  assert.equal((await vyre(h, ["vault", "read", "vault://mail/username", "--no-newline"])).out, "alex@example.com");
  assert.match((await vyre(h, ["vault", "read", "vault://mail/otp"])).out, /^\d{6}\n$/);
  assert.equal(one(await vyre(h, ["vault", "read", "vault://api-token", "--json"])).data.values["vault://api-token"], token);
  assert.equal((await vyre(h, ["vault", "read", "op://x/y"])).code, 1);

  // inject: -o is written by vyred, 0600, and refuses to overwrite without --force.
  const tpl = path.join(h, "app.env.tpl"), outFile = path.join(h, "app.env");
  fs.writeFileSync(tpl, "TOKEN={{ vault://api-token }}\nUSER={{ vault://mail/username }}\n");
  const w = await vyre(h, ["vault", "inject", "-i", tpl, "-o", outFile]);
  assert.equal(w.code, 0, w.all);
  assert.match(w.out, /wrote .*app\.env · 2 references · 0600/);
  assert.ok(!w.all.includes(token));
  assert.equal(fs.readFileSync(outFile, "utf8"), `TOKEN=${token}\nUSER=alex@example.com\n`);
  assert.equal(fs.statSync(outFile).mode & 0o777, 0o600);
  assert.equal((await vyre(h, ["vault", "inject", "-i", tpl, "-o", outFile])).code, 1);
  assert.equal(one(await vyre(h, ["vault", "inject", "-i", tpl, "-o", outFile, "--force", "--json"])).data.refs, 2);
  // Without -o, to a pipe (not a terminal), it prints the rendered text.
  assert.equal((await vyre(h, ["vault", "inject", "-i", tpl])).out, `TOKEN=${token}\nUSER=alex@example.com\n`);

  // run --env-file: references resolved into the child, scrubbed from its output.
  const envFile = path.join(h, "run.env");
  fs.writeFileSync(envFile, "API_TOKEN=vault://api-token\nMODE=test\nDSN=https://alex:{{ vault://mail/password }}@db.example.com\n");
  const shown = await vyre(h, ["vault", "run", "--env-file", envFile, "--", process.execPath, "-e", "console.log(process.env.API_TOKEN, process.env.MODE, process.env.DSN)"]);
  assert.equal(shown.code, 0, shown.all);
  assert.equal(shown.out.trim(), "<concealed by vyre> test https://alex:<concealed by vyre>@db.example.com");
  const hashed = await vyre(h, ["vault", "run", "--json", "--env-file", envFile, "--", process.execPath, "-e", "console.log(require('crypto').createHash('sha256').update(process.env.API_TOKEN).digest('hex'))"]);
  assert.equal(hashed.out.trim(), sha(token), "--json leaves run's output to the child");
  assert.equal((await vyre(h, ["vault", "run", "--env-file", envFile, "--", process.execPath, "-e", "process.exit(7)"])).code, 7);

  // edit: a field replaced from the hidden prompt (piped here), then a rename.
  const token2 = fake("token2");
  assert.equal((await vyre(h, ["vault", "edit", "api-token", "--field", "value", "--description", "billing"], token2)).code, 0);
  assert.equal((await vyre(h, ["vault", "read", "vault://api-token"])).out, token2 + "\n");
  const ren = await vyre(h, ["vault", "edit", "api-token", "--rename", "billing-token", "--host", "+https://api2.example.com", "--json"]);
  assert.equal(one(ren).data.renamedFrom, "api-token");
  assert.deepEqual(one(await vyre(h, ["vault", "get", "billing-token", "--json"])).data.item.hosts, ["https://api.example.com", "https://api2.example.com"]);
  assert.equal((await vyre(h, ["vault", "rm", "billing-token"])).code, 0);
  assert.equal(one(await vyre(h, ["vault", "list", "--json"])).data.items.length, 1);

  // Nothing printed a value it was not asked for.
  const audit = await vyre(h, ["vault", "audit", "--json"]);
  for (const v of [token, token2, pw]) assert.ok(!audit.out.includes(v));
});

test("vault op parity: exit 4 when locked, and exit 3 for presence", async t => {
  const h = home(t, { name: "locked-box", vault: { keystore: "passphrase" } });
  assert.equal((await vyre(h, ["up"])).code, 0);
  assert.equal((await vyre(h, ["vault", "unlock"], "a long test passphrase\n")).code, 0);
  await vyre(h, ["vault", "add", "api-token"], fake("t"));
  await vyre(h, ["vault", "lock"]);
  const r = await vyre(h, ["vault", "read", "vault://api-token", "--json"]);
  assert.equal(r.code, 4, r.all);
  assert.match(one(r).error.message, /locked/);
  assert.equal((await vyre(h, ["vault", "inject", "-i", "/dev/null", "-o", path.join(h, "x")])).code, 0, "a template without references needs no key");
  assert.equal(exitFor({ error: { code: "presence_required", message: "a person must approve this" } }), 3);
  assert.equal(exitFor({ error: { code: "locked", message: "x" } }), 4);
  assert.equal(exitFor({ data: {} }), 0);
});

test("vault op parity: the ssh agent through ssh-add, and git credential fill through the helper", async t => {
  const h = home(t, { name: "dev-box", vault: { keystore: "file", ssh: { socket: "ssh/agent.sock" } } });
  assert.equal((await vyre(h, ["up"])).code, 0);

  const gen = one(await vyre(h, ["vault", "ssh", "generate", "deploy", "--json"]));
  assert.match(gen.data.key.public, /^ssh-ed25519 /);
  const line = await vyre(h, ["vault", "ssh", "agent-line"]);
  assert.equal(line.code, 0, line.all);
  const sock = /^IdentityAgent "(.+)"$/.exec(line.out.trim())?.[1];
  assert.equal(sock, path.join(h, "ssh", "agent.sock"));
  const listed = await spawnIt("ssh-add", ["-L"], { PATH: process.env.PATH, HOME: h, SSH_AUTH_SOCK: sock });
  assert.equal(listed.code, 0, listed.err);
  assert.equal(listed.out.trim(), gen.data.key.public);
  assert.match((await vyre(h, ["vault", "ssh", "keys"])).out, /deploy\s+ed25519\s+SHA256:/);
  assert.match((await vyre(h, ["vault", "ssh", "approvals"])).out, /no ssh approvals/);

  // git, in a temp repo, with a temp global config naming bin/git-credential-vyre.
  const pw = fake("git");
  await vyre(h, ["call", "vault.put", JSON.stringify({ name: "git-example", kind: "login", fields: { username: "alex", password: pw }, url: "https://git.example.com" })]);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-git-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const gitconfig = path.join(repo, "gitconfig");
  fs.writeFileSync(gitconfig, `[credential]\n\thelper = ${path.join(REPO, "bin", "git-credential-vyre")}\n`);
  const env = { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: repo, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", VYRE_HOME: h, NO_COLOR: "1" };
  const git = (args, input) => spawnIt("git", ["-C", repo, ...args], env, input);
  assert.equal((await git(["init", "-q"])).code, 0);
  const fill = await git(["credential", "fill"], "protocol=https\nhost=git.example.com\n\n");
  assert.equal(fill.code, 0, fill.err);
  assert.match(fill.out, /^protocol=https\nhost=git\.example\.com\nusername=alex\npassword=(.+)\n$/);
  assert.ok(fill.out.includes(`password=${pw}\n`));
  const none = await git(["credential", "fill"], "protocol=https\nhost=elsewhere.example.com\n\n");
  assert.notEqual(none.code, 0, "no match: git would prompt, and prompting is off");
  assert.ok(!none.all.includes(pw));

  // reject (erase) marks the login stale, never deletes it; approve (store) saves a new one.
  await git(["credential", "reject"], `protocol=https\nhost=git.example.com\nusername=alex\npassword=${pw}\n\n`);
  const item = one(await vyre(h, ["vault", "get", "git-example", "--json"])).data.item;
  assert.equal(item.stale, true);
  const next = fake("next");
  await git(["credential", "approve"], `protocol=https\nhost=git.example.com\nusername=alex\npassword=${next}\n\n`);
  const again = await git(["credential", "fill"], "protocol=https\nhost=git.example.com\n\n");
  assert.ok(again.out.includes(`password=${next}\n`), again.all);
  assert.equal(one(await vyre(h, ["vault", "get", "git-example", "--json"])).data.item.stale, undefined);
});
