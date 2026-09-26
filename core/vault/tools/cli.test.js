// @ts-check
// The CLI-facing vault tools inside a real vyred in a temp home: item metadata, resolving and
// rendering references, editing in place, the git credential helper's matching, and the SSH
// agent with a stub approver. Every test ends with the same promise as module.test.js: no value
// in events, logs, audit rows, listings, tool listings or MCP-visible output.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { start } from "../../daemon/index.js";
import { request, call } from "../../daemon/client.js";
import { tempHome, writeModule, present } from "../../../test/helpers.js";
import { parsePrivate } from "../ssh/keys.js";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const sha = v => crypto.createHash("sha256").update(v).digest("hex");

const PROBE = `export default { async start(ctx) {
  ctx.tool("probe.use", { input: { type: "object", properties: { name: { type: "string" } } },
    run: async ({ name }) => { try { const v = await ctx.vault.fetch(name); const c = await import("node:crypto");
      return { sha: c.createHash("sha256").update(v).digest("hex") }; } catch (e) { return { error: e.message }; } } });
  return { async stop() {} };
} };`;

async function boot(t, vault = { keystore: "file", ssh: { socket: "ssh/agent.sock" } }) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault }));
  writeModule(path.join(root, "modules"), "probe", { does: { tools: ["probe.use"] }, needs: { vault: ["per-item"] } }, PROBE);
  const lines = [];
  const d = await start({ presence: present, root, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  const handle = /** @type {any} */ (d.registry).modules.get("vault").handle;
  return { root, d, lines, handle, as: caller => (tool, input = {}) => call(tool, input, { root, caller }) };
}

/** Everything a value must never appear in, as text. */
async function surfaces({ root, d, lines, as }) {
  const cli = as("cli"), mcp = as("mcp");
  return [
    JSON.stringify(d.events.since(0, { limit: 5000 })), lines.join("\n"),
    JSON.stringify((await cli("vault.list")).data), JSON.stringify((await mcp("vault.list")).data),
    JSON.stringify((await cli("vault.audit", { limit: 1000 })).data),
    JSON.stringify((await cli("vault.ssh.keys")).data), JSON.stringify((await mcp("vault.ssh.keys")).data),
    JSON.stringify((await cli("vault.ssh.approvals")).data),
    JSON.stringify(await request("GET", "/v1/tools", undefined, { root, caller: "mcp" })),
    JSON.stringify(await request("GET", "/v1/tools", undefined, { root })),
  ];
}

test("vault tools: item, resolve and render; values reach only the caller or the file", async t => {
  const b = await boot(t);
  const cli = b.as("cli"), mcp = b.as("mcp");
  const token = fake("token"), pw = fake("pw"), dbUrl = fake("db");
  await cli("vault.put", { name: "api-token", kind: "api-key", value: token, hosts: ["https://api.example.com"] });
  await cli("vault.put", { name: "site-login", kind: "login", fields: { username: "alex@example.com", password: pw, totp: "JBSWY3DPEHPK3PXP" }, url: "https://mail.example.com" });
  await cli("vault.put", { name: "stack-env", kind: "env-set", fields: { DB_URL: dbUrl } });

  const item = (await mcp("vault.item", { name: "site-login" })).data.item;
  assert.equal(item.kind, "login");
  assert.equal(item.otp, true);
  assert.deepEqual(item.fields, ["username", "password", "totp"]);
  assert.match((await mcp("vault.item", { name: "nope" })).error.message, /no item named nope/);
  assert.deepEqual((await cli("vault.list", { kind: "login" })).data.items.map(i => i.name), ["site-login"]);
  assert.deepEqual((await cli("vault.list", { host: "api.example" })).data.items.map(i => i.name), ["api-token"]);

  // resolve: people only, never Claude.
  assert.equal((await mcp("vault.resolve", { refs: ["vault://api-token"] })).error.code, "denied");
  const v = (await cli("vault.resolve", { refs: ["vault://api-token", "vault://site-login/username", "vault://site-login/otp", "vault://stack-env/DB_URL"] })).data.values;
  assert.equal(v["vault://api-token"], token);
  assert.equal(v["vault://site-login/username"], "alex@example.com");
  assert.match(v["vault://site-login/otp"], /^\d{6}$/);
  assert.equal(v["vault://stack-env/DB_URL"], dbUrl);
  assert.match((await cli("vault.resolve", { refs: ["vault://stack-env"] })).error.message, /name the field/);
  assert.match((await cli("vault.resolve", { refs: ["vault://ghost/x"] })).error.message, /no item named ghost/);
  assert.match((await cli("vault.resolve", { refs: ["op://x/y"] })).error.message, /not a vault reference/);

  // render: vyred writes the file, 0600, and the reply carries no value.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-render-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, "app.env");
  const template = "TOKEN={{ vault://api-token }}\nUSER={{vault://site-login/username}}\nLITERAL=\\{{ vault://api-token }}\n";
  assert.equal((await mcp("vault.render", { template, out })).error.code, "denied");
  const r = await cli("vault.render", { template, out });
  assert.equal(r.data.refs, 2);
  assert.deepEqual(r.data.items, ["api-token", "site-login"]);
  assert.ok(!JSON.stringify(r).includes(token), "the render reply carries no value");
  assert.equal(fs.readFileSync(out, "utf8"), `TOKEN=${token}\nUSER=alex@example.com\nLITERAL={{ vault://api-token }}\n`);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  assert.match((await cli("vault.render", { template, out })).error.message, /already exists · --force/);
  assert.equal((await cli("vault.render", { template: "A={{ vault://api-token }}\n", out, force: true })).data.replaced, true);
  assert.equal(fs.readFileSync(out, "utf8"), `A=${token}\n`);
  assert.deepEqual(fs.readdirSync(dir), ["app.env"], "no temp file left behind");
  assert.match((await cli("vault.render", { template, out: "relative.env" })).error.message, /absolute/);

  // A tracked file gets a warning.
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "add", "app.env"]);
  assert.match((await cli("vault.render", { template, out, force: true })).data.warnings[0], /tracked by git/);
  const loose = path.join(dir, "loose.env");
  assert.match((await cli("vault.render", { template, out: loose })).data.warnings[0], /not ignored/);

  const audit = (await cli("vault.audit", { limit: 100 })).data.entries;
  assert.ok(audit.some(e => e.action === "resolve" && e.name === "api-token" && e.ok));
  assert.ok(audit.some(e => e.action === "render" && e.name === "api-token" && e.why === "to app.env"));

  const texts = await surfaces(b);
  for (const value of [token, pw, dbUrl]) for (const [i, text] of texts.entries()) assert.ok(!text.includes(value), `a value appeared in surface ${i}`);
});

test("vault tools: edit merges, renames with grants, and changes hosts", async t => {
  const b = await boot(t);
  const cli = b.as("cli"), mcp = b.as("mcp");
  const pw = fake("pw"), pw2 = fake("pw2");
  await cli("vault.put", { name: "site-login", kind: "login", fields: { username: "alex", password: pw }, url: "https://mail.example.com" });
  await cli("vault.grant", { name: "site-login", module: "probe" });
  assert.equal((await mcp("vault.edit", { name: "site-login", description: "x" })).error.code, "denied");

  const e = (await cli("vault.edit", { name: "site-login", fields: { password: pw2 }, description: "mail", addHosts: ["https://webmail.example.com"] })).data;
  assert.deepEqual(e.fields, ["username", "password"]);
  const it = (await cli("vault.item", { name: "site-login" })).data.item;
  assert.equal(it.description, "mail");
  assert.deepEqual(it.hosts, ["https://mail.example.com", "https://webmail.example.com"]);
  assert.equal((await cli("probe.use", { name: "site-login" })).data.sha, sha(pw2), "the new password, the username kept");

  const renamed = (await cli("vault.edit", { name: "site-login", rename: "mail-login", removeHosts: ["https://mail.example.com"] })).data;
  assert.equal(renamed.renamedFrom, "site-login");
  assert.equal((await cli("vault.item", { name: "site-login" })).error.code, "failed");
  const moved = (await cli("vault.item", { name: "mail-login" })).data.item;
  assert.deepEqual(moved.grants, [{ module: "probe" }], "grants follow a rename");
  assert.deepEqual(moved.hosts, ["https://webmail.example.com"]);
  assert.equal((await cli("probe.use", { name: "mail-login" })).data.sha, sha(pw2));
  await cli("vault.put", { name: "other", value: fake("o") });
  assert.match((await cli("vault.edit", { name: "mail-login", rename: "other" })).error.message, /already exists/);
  assert.equal((await cli("vault.edit", { name: "mail-login", removeFields: ["username"] })).data.fields.join(), "password");

  const texts = await surfaces(b);
  for (const value of [pw, pw2]) for (const [i, text] of texts.entries()) assert.ok(!text.includes(value), `a value appeared in surface ${i}`);
});

test("vault tools: git credentials by exact origin, store keeps history, erase marks stale", async t => {
  const b = await boot(t);
  const cli = b.as("cli"), mcp = b.as("mcp");
  const pw = fake("git"), other = fake("other"), next = fake("next");
  await cli("vault.put", { name: "git-example", kind: "login", fields: { username: "alex", password: pw }, url: "https://git.example.com" });
  await cli("vault.put", { name: "lookalike", kind: "login", fields: { username: "alex", password: other }, url: "https://git.example.com.evil.test" });
  const git = (action, request) => cli("vault.git", { action, request });
  assert.equal((await mcp("vault.git", { action: "get", request: "protocol=https\nhost=git.example.com\n" })).error.code, "denied");

  const got = (await git("get", "protocol=https\nhost=git.example.com\n\n")).data;
  assert.equal(got.response, `username=alex\npassword=${pw}\n`);
  assert.equal((await git("get", "protocol=https\nhost=evil.test\n")).data.response, "");
  assert.equal((await git("get", "protocol=http\nhost=git.example.com\n")).data.response, "", "http is another origin");

  // A second login for the same origin: ambiguous without a username, chosen with one.
  await cli("vault.put", { name: "git-example-dana", kind: "login", fields: { username: "dana", password: other }, url: "https://git.example.com" });
  const amb = (await git("get", "protocol=https\nhost=git.example.com\n")).data;
  assert.equal(amb.response, "");
  assert.match(amb.why, /2 logins match/);
  assert.equal((await git("get", "protocol=https\nhost=git.example.com\nusername=dana\n")).data.response, `username=dana\npassword=${other}\n`);

  // store: the same is a no-op; a new password keeps the old one in sealed history.
  assert.equal((await git("store", `protocol=https\nhost=git.example.com\nusername=alex\npassword=${pw}\n`)).data.same, true);
  assert.equal((await git("store", `protocol=https\nhost=git.example.com\nusername=alex\npassword=${next}\n`)).data.stored, true);
  assert.deepEqual((await cli("vault.item", { name: "git-example" })).data.item.fields, ["username", "password", "history"]);
  const hist = JSON.parse((await cli("vault.resolve", { refs: ["vault://git-example/history"] })).data.values["vault://git-example/history"]);
  assert.equal(hist[0].password, pw);
  const created = (await git("store", `protocol=https\nhost=code.example.com\nusername=alex\npassword=${other}\n`)).data;
  assert.equal(created.created, true);
  assert.equal(created.name, "code.example.com");

  // erase: marks, never deletes; a stale login is not offered again.
  const erased = (await git("erase", `protocol=https\nhost=git.example.com\nusername=alex\npassword=${next}\n`)).data;
  assert.deepEqual(erased.marked, ["git-example"]);
  const stale = (await cli("vault.item", { name: "git-example" })).data.item;
  assert.equal(stale.stale, true);
  assert.equal((await git("get", "protocol=https\nhost=git.example.com\nusername=alex\n")).data.response, "");
  await git("store", `protocol=https\nhost=git.example.com\nusername=alex\npassword=${pw}\n`);
  assert.equal((await cli("vault.item", { name: "git-example" })).data.item.stale, undefined, "a fresh store clears the mark");

  const texts = await surfaces(b);
  for (const value of [pw, other, next]) for (const [i, text] of texts.entries()) assert.ok(!text.includes(value), `a value appeared in surface ${i}`);
});

test("vault tools: the ssh agent signs for vault keys after approval; private keys never leave", async t => {
  const b = await boot(t);
  const cli = b.as("cli"), mcp = b.as("mcp");
  const asked = [];
  let answer = true;
  b.handle.ssh.setApprover(async req => { asked.push(req); return answer; });

  // Claude may generate a key (public half back), never into an existing name.
  const gen = (await mcp("vault.ssh.generate", { name: "deploy", type: "ed25519" })).data.key;
  assert.match(gen.fingerprint, /^SHA256:/);
  assert.match(gen.public, /^ssh-ed25519 \S+ deploy$/);
  assert.match((await mcp("vault.ssh.generate", { name: "deploy" })).error.message, /already exists/);
  assert.equal((await mcp("vault.ssh.add", { name: "x", file: "/dev/null" })).error.code, "denied");

  // Add an existing key from a file vyred reads itself.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vssh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, "id_test");
  execFileSync("ssh-keygen", ["-t", "ecdsa", "-b", "256", "-N", "", "-C", "ci", "-f", keyFile, "-q"]);
  const privateText = fs.readFileSync(keyFile, "utf8");
  const seedCanary = parsePrivate(privateText).key.export({ format: "jwk" }).d;
  const added = (await cli("vault.ssh.add", { name: "ci-key", file: keyFile })).data;
  assert.equal(added.key.fingerprint, execFileSync("ssh-keygen", ["-l", "-E", "sha256", "-f", keyFile + ".pub"], { encoding: "utf8" }).split(" ")[1]);

  const listed = (await cli("vault.list", { kind: "ssh-key" })).data.items;
  assert.deepEqual(listed.map(i => i.name), ["ci-key", "deploy"]);
  assert.equal(listed[1].ssh.fingerprint, gen.fingerprint);
  // The private half is refused to every reader, a module with a grant included.
  assert.match((await cli("vault.resolve", { refs: ["vault://deploy/private"] })).error.message, /never leaves vyred/);
  assert.match((await cli("vault.resolve", { refs: ["vault://deploy"] })).error.message, /never leaves vyred/);
  await cli("vault.grant", { name: "deploy", module: "probe" });
  assert.match((await cli("probe.use", { name: "deploy" })).data.error, /ssh key/);
  assert.match((await cli("vault.inject", { items: [{ name: "deploy", field: "private" }] })).error.message, /ssh key/);

  const keys = (await mcp("vault.ssh.keys")).data;
  assert.equal(keys.socket, path.join(b.root, "ssh", "agent.sock"));
  assert.equal(fs.statSync(keys.socket).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(keys.socket)).mode & 0o777, 0o700);

  const env = { PATH: process.env.PATH, HOME: dir, SSH_AUTH_SOCK: keys.socket };
  const run = (bin, args) => new Promise(resolve => execFile(bin, args, { env, encoding: "utf8" }, (e, out, err) => resolve({ code: e ? e.code : 0, out, err })));
  const l = await run("ssh-add", ["-L"]);
  assert.equal(l.code, 0, l.err);
  assert.deepEqual(l.out.trim().split("\n").map(x => x.split(" ").slice(0, 2).join(" ")).sort(),
    [gen.public, added.key.public].map(x => x.split(" ").slice(0, 2).join(" ")).sort());

  // Commit signing asks each time; a refusal is audited and signs nothing.
  const pub = path.join(dir, "deploy.pub");
  fs.writeFileSync(pub, gen.public + "\n");
  const msg = path.join(dir, "msg");
  fs.writeFileSync(msg, "a commit\n");
  assert.equal((await run("ssh-keygen", ["-Y", "sign", "-f", pub, "-n", "git", msg])).code, 0);
  answer = false;
  fs.rmSync(msg + ".sig");
  assert.notEqual((await run("ssh-keygen", ["-Y", "sign", "-f", pub, "-n", "git", msg])).code, 0);
  assert.equal(asked.length, 2);
  assert.equal(asked[1].summary, 'sign a git commit (SSHSIG namespace git) with ssh key "deploy"');
  const waiting = (await cli("vault.ssh.approvals")).data.waiting;
  assert.equal(waiting.length, 1);
  assert.equal((await mcp("vault.ssh.approvals")).error.code, "denied");
  const trail = (await cli("vault.audit", { name: "deploy" })).data.entries.filter(e => e.action === "ssh-sign");
  assert.deepEqual(trail.map(e => e.ok), [false, true]);
  assert.ok(trail.every(e => e.who === "ssh:unbound"));

  // A person approves the waiting request: a lease for that key and host. Forget ends it.
  const lease = (await cli("vault.ssh.approve", { id: waiting[0].id })).data.lease;
  assert.equal(lease.host, "unbound");
  assert.equal((await cli("vault.ssh.approvals")).data.leases.length, 1);
  assert.equal((await mcp("vault.ssh.forget", {})).data.ended, 1, "taking access away needs no one");
  assert.ok(b.d.events.since(0, { limit: 1000 }).some(e => e.type === "vault.ssh-approved"));

  // The production default, without a stub, refuses and logs that approval is needed.
  const plain = await boot(t);
  await plain.as("cli")("vault.ssh.generate", { name: "deploy" });
  const pk = (await plain.as("cli")("vault.ssh.keys")).data;
  fs.writeFileSync(pub, pk.keys[0].public + "\n");
  fs.rmSync(msg + ".sig", { force: true });
  const denied = await new Promise(resolve => execFile("ssh-keygen", ["-Y", "sign", "-f", pub, "-n", "git", msg], { env: { ...env, SSH_AUTH_SOCK: pk.socket } }, e => resolve(e ? 1 : 0)));
  assert.equal(denied, 1);
  assert.ok(plain.lines.some(x => /approval needed to sign a git commit/.test(x)));

  const texts = [...await surfaces(b), JSON.stringify(gen), JSON.stringify(added), l.out];
  const b64 = Buffer.from(privateText).toString("base64");
  for (const value of [privateText.split("\n")[1], seedCanary, b64.slice(20, 60)]) {
    for (const [i, text] of texts.entries()) assert.ok(!text.includes(value), `private key material appeared in surface ${i}`);
  }
});

test("vault tools: no ssh agent unless configured, and never outside the Vyre home", async t => {
  const b = await boot(t, { keystore: "file" });
  assert.equal((await b.as("cli")("vault.ssh.keys")).data.socket, null);
  assert.ok(!fs.existsSync(path.join(b.root, "ssh")));
  const bad = await boot(t, { keystore: "file", ssh: { socket: "../elsewhere.sock" } });
  assert.equal(bad.d.registry.status().find(m => m.name === "vault")?.state, "failed");
});
