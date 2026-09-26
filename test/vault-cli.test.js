// @ts-check
// The Vault as people use it: the `vyre vault` CLI against two real vyred processes in two temp
// homes, one the owner of a credential and one a teammate it is shared with. The teammate uses
// the credential through a relayed pass, loses it the moment the pass is revoked, and when
// offboarded leaves behind exactly one thing to rotate: the item they were sent sealed.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { writeModule } from "./helpers.js";
import { totp } from "../core/vault/totp.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "vyre");
const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const sha = v => crypto.createHash("sha256").update(v).digest("hex");

/** Run `vyre` as a person would, with piped stdin when given. */
function vyre(home, args, input) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: home, NO_COLOR: "1" } });
    let out = "", err = "";
    p.stdout.on("data", c => { out += c; });
    p.stderr.on("data", c => { err += c; });
    p.on("close", code => resolve({ code, out, err, all: out + err }));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}

const PROBE = `export default { async start(ctx) {
  ctx.tool("probe.use", { input: { type: "object", properties: { name: { type: "string" } } },
    run: async ({ name }) => { const v = await ctx.vault.fetch(name);
      const c = await import("node:crypto"); return { sha: c.createHash("sha256").update(v).digest("hex") }; } });
  return { async stop() {} };
} };`;

/**
 * A temp home whose vyred is stopped before the folder goes. tempHome's own cleanup would remove
 * the folder first, and `vyre down` with no pid file leaves the daemon running.
 */
function home(t, config) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-test-"));
  if (path.resolve(h) === path.resolve(os.homedir(), ".vyre")) throw new Error("a test tried to use the real ~/.vyre");
  fs.writeFileSync(path.join(h, "config.json"), JSON.stringify(config));
  t.after(async () => { await vyre(h, ["down"]); fs.rmSync(h, { recursive: true, force: true }); });
  return h;
}

test("vault cli: put, grant to a module, run, TOTP, generate and a 1Password import", async t => {
  const owner = home(t, { name: "owner-box", vault: { keystore: "file" } });
  writeModule(path.join(owner, "modules"), "probe", { does: { tools: ["probe.use"] }, needs: { vault: ["api-token"] } }, PROBE);
  assert.equal((await vyre(owner, ["up"])).code, 0);
  const token = fake("token");

  const argv = await vyre(owner, ["vault", "put", "api-token", token]);
  assert.equal(argv.code, 1);
  assert.match(argv.all, /never taken on the command line/);

  const put = await vyre(owner, ["vault", "put", "api-token", "--kind", "api-key", "--description", "billing API", "--host", "https://api.example.com"], token + "\n");
  assert.equal(put.code, 0, put.all);
  assert.match(put.all, /stored api-token/);
  const list = await vyre(owner, ["vault", "list"]);
  assert.match(list.out, /api-token\s+api-key/);
  assert.ok(!list.all.includes(token));

  assert.match((await vyre(owner, ["vault", "grant", "api-token", "probe"])).out, /granted api-token to probe/);
  const used = await vyre(owner, ["call", "probe.use", '{"name":"api-token"}']);
  assert.equal(JSON.parse(used.out).sha, sha(token));

  // run: the child has the value; its output does not.
  const shown = await vyre(owner, ["vault", "run", "API_TOKEN=api-token", "--", process.execPath, "-e", "console.log('token is ' + process.env.API_TOKEN)"]);
  assert.equal(shown.code, 0);
  assert.equal(shown.out.trim(), "token is <concealed by vyre>");
  const hashed = await vyre(owner, ["vault", "run", "api-token", "--", process.execPath, "-e", "console.log(require('crypto').createHash('sha256').update(process.env.API_TOKEN).digest('hex'))"]);
  assert.equal(hashed.out.trim(), sha(token), "the child did not receive the value");
  assert.equal((await vyre(owner, ["vault", "run", "api-token", "--", process.execPath, "-e", "process.exit(3)"])).code, 3);

  // A fictional 1Password export. The file is left alone and the user is told to delete it.
  const csvPassword = fake("pw") + ',"quoted"';
  const csv = path.join(owner, "fixture-export.csv");
  const body = `Title,Website,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\n` +
    `Example Mail,https://mail.example.com,alex@example.com,"${csvPassword.replace(/"/g, '""')}",otpauth://totp/Example:alex@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example,false,false,work,\n` +
    `Example Bank,https://bank.example.com,alex,${fake("bank")},,false,false,,a note\n`;
  fs.writeFileSync(csv, body);
  const imp = await vyre(owner, ["vault", "import", csv]);
  assert.equal(imp.code, 0, imp.all);
  assert.match(imp.out, /2 items added from 1password-csv/);
  assert.match(imp.out, /Delete .*fixture-export\.csv now/);
  assert.equal(fs.readFileSync(csv, "utf8"), body, "import must not touch the file");
  assert.ok(!imp.all.includes(csvPassword));
  const again = await vyre(owner, ["vault", "import", csv]);
  assert.match(again.out, /0 items added.*2 already here/);

  const code = await vyre(owner, ["vault", "totp", "example-mail"]);
  const now = Date.now();
  const want = [totp("JBSWY3DPEHPK3PXP", { at: now }).code, totp("JBSWY3DPEHPK3PXP", { at: now - 30_000 }).code];
  assert.ok(want.includes(code.out.trim().split(/\s+/)[0]), code.out);

  const gen = await vyre(owner, ["vault", "generate", "--words", "5", "wifi-pass"]);
  assert.match(gen.out, /stored wifi-pass · 95 bits/);
  assert.match((await vyre(owner, ["vault", "list", "wifi"])).out, /wifi-pass\s+secret/);
  assert.match((await vyre(owner, ["vault", "generate", "--length", "20"])).out.trim(), /^\S{20}$/);

  const audit = await vyre(owner, ["vault", "audit", "api-token"]);
  assert.match(audit.out, /release\s+api-token by module:probe\s+ok/);
  assert.match(audit.out, /inject\s+api-token by cli\s+ok/);
  assert.ok(!audit.all.includes(token));
});

test("vault cli: a relayed pass between two vyreds, revoked at once; offboarding lists what to rotate", async t => {
  // A stand-in for a real API. It accepts only the owner's token, and echoes the Authorization
  // header back, the way badly behaved servers do, so scrubbing is tested too.
  const token = fake("token");
  const api = http.createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${token}`;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok, echoed: req.headers.authorization, path: req.url }));
  });
  await new Promise(r => api.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => api.close());
  const apiOrigin = `http://127.0.0.1:${/** @type {any} */ (api.address()).port}`;

  const owner = home(t, { name: "owner-box", vault: { keystore: "file", relay: { host: "127.0.0.1", port: 0 } } });
  const mate = home(t, { name: "teammate-box", vault: { keystore: "file" } });
  assert.equal((await vyre(owner, ["up"])).code, 0);
  assert.equal((await vyre(mate, ["up"])).code, 0);

  await vyre(owner, ["vault", "put", "api-token", "--kind", "api-key", "--host", apiOrigin], token);
  const dbPassword = fake("db");
  await vyre(owner, ["vault", "put", "db-password"], dbPassword);

  const shownCard = await vyre(mate, ["vault", "card"]);
  const card = shownCard.out.split("\n").find(l => l.startsWith("vyre-card:v2:"));
  assert.ok(card, "the teammate has no card");
  const mateFp = /fingerprint\s+((?:[0-9A-Z]{4} ){4}[0-9A-Z]{4})/.exec(shownCard.out)?.[1];
  assert.ok(mateFp, shownCard.out);

  // Relayed: the value never leaves the owner's box.
  const created = await vyre(owner, ["vault", "pass", "create", "teammate", "api-token", "--card", card, "--note", "for the billing sync"]);
  assert.equal(created.code, 0, created.all);
  const ticket = created.out.split("\n").find(l => l.startsWith("vyre-pass:v2:"));
  const passId = /pass (p_\S+)/.exec(created.out)?.[1];
  assert.ok(ticket && passId, created.out);
  assert.ok(!ticket.includes(token) && !Buffer.from(ticket.slice(13), "base64url").toString().includes(token), "a ticket carries no secret");

  // Tickets are signed: an edited one and an old unsigned one are refused, in words.
  const body = JSON.parse(Buffer.from(ticket.slice(13), "base64url").toString());
  const edited = "vyre-pass:v2:" + Buffer.from(JSON.stringify({ ...body, relay: "https://relay.acme.test" })).toString("base64url");
  const forged = await vyre(mate, ["vault", "pass", "accept", edited]);
  assert.equal(forged.code, 1);
  assert.match(forged.all, /signature does not match/);
  const old = "vyre-pass:v1:" + Buffer.from(JSON.stringify({ pass: body.pass, owner: "owner-box", relay: body.relay, ownerSign: body.ownerSign, holder: "teammate", items: body.items, mode: "relayed", expires: null })).toString("base64url");
  assert.match((await vyre(mate, ["vault", "pass", "accept", old])).all, /older Vyre and is not signed/);

  assert.match((await vyre(mate, ["vault", "pass", "accept", ticket])).out, /accepted relayed pass from owner-box: api-token/);
  // Accepting pinned the owner; the owner pinned the teammate from --card; both see the same words.
  assert.match((await vyre(mate, ["vault", "people"])).out, /owner-box\s+(?:[0-9A-Z]{4} ){4}[0-9A-Z]{4}\s+pinned/);
  const words = s => /\n\s+([a-z]{6}(?: [a-z]{6}){3})\n/.exec(s)?.[1];
  const ownerView = await vyre(owner, ["vault", "fingerprint", "teammate"]);
  const mateView = await vyre(mate, ["vault", "fingerprint", "owner-box"]);
  assert.ok(words(ownerView.out) && words(ownerView.out) === words(mateView.out), ownerView.out + mateView.out);
  assert.match(ownerView.out, new RegExp("theirs\\s+" + mateFp));
  assert.match((await vyre(owner, ["vault", "people", "verify", "teammate", "0000 0000 0000 0000 0000"])).all, /does not match/);
  assert.match((await vyre(owner, ["vault", "people", "verify", "teammate", ...mateFp.toLowerCase().split(" ")])).out, /verified teammate/);

  const used = await vyre(mate, ["vault", "relay", "api-token", `${apiOrigin}/v1/charges`, "--header", "Authorization: Bearer {{vault}}"]);
  assert.equal(used.code, 0, used.all);
  const reply = JSON.parse(used.out);
  assert.equal(reply.ok, true, "the owner's box did not add the credential");
  assert.equal(reply.echoed, "Bearer <concealed by vyre>", "the echoed credential was not scrubbed");

  // The pass cannot aim the credential anywhere else, not even another port on the same host.
  const other = http.createServer((req, res) => { res.end(String(req.headers.authorization)); });
  await new Promise(r => other.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => other.close());
  const elsewhere = await vyre(mate, ["vault", "relay", "api-token", `http://127.0.0.1:${/** @type {any} */ (other.address()).port}/`, "--header", "Authorization: Bearer {{vault}}"]);
  assert.equal(elsewhere.code, 1);
  assert.match(elsewhere.all, /may only be sent to/);
  const inUrl = await vyre(mate, ["vault", "relay", "api-token", `${apiOrigin}/?k={{vault}}`]);
  assert.equal(inUrl.code, 1);

  // Revoke ends it at once.
  assert.match((await vyre(owner, ["vault", "pass", "revoke", passId])).out, /revoked/);
  const after = await vyre(mate, ["vault", "relay", "api-token", `${apiOrigin}/v1/charges`, "--header", "Authorization: Bearer {{vault}}"]);
  assert.equal(after.code, 1);
  assert.match(after.all, /revoked/);

  // A second relayed pass, and a sealed one for offline use; then the teammate leaves.
  const second = await vyre(owner, ["vault", "pass", "create", "teammate", "api-token"]);
  await vyre(mate, ["vault", "pass", "accept", second.out.split("\n").find(l => l.startsWith("vyre-pass:v2:"))]);
  const sealed = await vyre(owner, ["vault", "pass", "create", "teammate", "db-password", "--sealed"]);
  assert.match(sealed.out, /revoking this pass means rotating/);
  await vyre(mate, ["vault", "pass", "accept", sealed.out.split("\n").find(l => l.startsWith("vyre-pass:v2:"))]);
  assert.match((await vyre(mate, ["vault", "list"])).out, /db-password\s+secret/);
  assert.equal(JSON.parse((await vyre(mate, ["vault", "relay", "api-token", `${apiOrigin}/`, "--header", "Authorization: Bearer {{vault}}"])).out).ok, true);

  const off = await vyre(owner, ["vault", "offboard", "teammate"]);
  assert.equal(off.code, 0, off.all);
  assert.match(off.out, /offboarded teammate · 2 passes revoked/);
  assert.match(off.out, /rotate: db-password/);
  assert.ok(!off.out.includes("api-token"), "a relayed item never left, so it needs no rotating");
  assert.match((await vyre(owner, ["vault", "list"])).out, /db-password\s+secret\s+rotate/);
  const gone = await vyre(mate, ["vault", "relay", "api-token", `${apiOrigin}/`, "--header", "Authorization: Bearer {{vault}}"]);
  assert.equal(gone.code, 1);
  assert.match((await vyre(owner, ["vault", "pass", "create", "teammate", "api-token"])).all, /no card for teammate/);

  // Rotating clears the mark.
  await vyre(owner, ["vault", "put", "db-password"], fake("db2"));
  assert.doesNotMatch((await vyre(owner, ["vault", "list"])).out, /rotate/);

  // The relayed token never reached the teammate's disk; the sealed item is ciphertext there.
  for (const dir of [mate, owner]) {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.isFile() ? [path.join(d, e.name)] : []);
    for (const f of walk(dir)) {
      if (f.endsWith(".csv")) continue;
      const bytes = fs.readFileSync(f);
      assert.ok(!bytes.includes(Buffer.from(token)), `the token is in plain text in ${path.basename(f)}`);
      assert.ok(!bytes.includes(Buffer.from(dbPassword)), `the db password is in plain text in ${path.basename(f)}`);
    }
  }
});

test("vault cli: autofill through a paired extension, and a backup restored into another vyred", async t => {
  const owner = home(t, { name: "owner-box", vault: { keystore: "file", fill: { host: "127.0.0.1", port: 0 } } });
  const spare = home(t, { name: "spare-box", vault: { keystore: "file" } });
  assert.equal((await vyre(owner, ["up"])).code, 0);
  assert.equal((await vyre(spare, ["up"])).code, 0);
  const password = fake("pw");
  const token = fake("token");
  await vyre(owner, ["vault", "put", "example-mail", "--kind", "login", "--username", "alex@example.com", "--url", "https://mail.example.com"], password);
  await vyre(owner, ["vault", "put", "api-token"], token);
  assert.equal((await vyre(owner, ["vault", "unlock-passphrase"], "a long unlock phrase\n")).code, 0);

  // The extension's side, as HTTP from an extension origin.
  const paired = await vyre(owner, ["vault", "pair", "--name", "laptop chrome"]);
  const code = /pairing code\s+(\S+)/.exec(paired.out)?.[1];
  const fillUrl = /fill address\s+(\S+)/.exec(paired.out)?.[1];
  assert.ok(code && fillUrl, paired.out);
  const ext = { "content-type": "application/json", origin: "chrome-extension://abcdefghijklmnop" };
  const post = async (route, body, headers = {}) => {
    const r = await fetch(`${fillUrl}/v1/fill/${route}`, { method: "POST", headers: { ...ext, ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const dev = await post("pair", { code: code.replace("-", ""), name: "laptop chrome" });
  assert.equal(dev.status, 200, JSON.stringify(dev.body));
  const auth = { authorization: `Bearer ${dev.body.data.token}` };
  const page = await fetch(`${fillUrl}/v1/fill/match`, { method: "POST", headers: { ...auth, "content-type": "application/json", origin: "https://mail.example.com" }, body: "{}" });
  assert.equal(page.status, 403, "a web page must not reach the fill listener");
  assert.equal((await post("fill", { name: "example-mail", url: "https://mail.example.com/" }, auth)).status, 401, "no session, no fill");
  const session = await post("unlock", { passphrase: "a long unlock phrase" }, auth);
  assert.equal(session.status, 200, JSON.stringify(session.body));
  const s = { ...auth, "x-vyre-session": session.body.data.session };
  assert.deepEqual((await post("match", { url: "https://mail.example.com/inbox" }, auth)).body.data.logins.map(l => l.name), ["example-mail"]);
  const filled = await post("fill", { name: "example-mail", url: "https://mail.example.com/login" }, s);
  assert.equal(filled.body.data.password, password);
  assert.equal(filled.body.data.username, "alex@example.com");
  assert.equal((await post("fill", { name: "example-mail", url: "https://mail.example.com.evil.test/" }, s)).status, 403);
  const devices = await vyre(owner, ["vault", "devices"]);
  assert.match(devices.out, /laptop chrome\s+unlocked/);
  await vyre(owner, ["vault", "devices", "revoke", dev.body.data.device]);
  assert.notEqual((await post("fill", { name: "example-mail", url: "https://mail.example.com/login" }, s)).status, 200, "a revoked device fills nothing");
  const audit = (await vyre(owner, ["vault", "audit", "example-mail"])).out;
  assert.ok(!audit.includes(password) && !audit.includes(dev.body.data.token));

  // Backup, then restore into a vyred with a different master key.
  const file = path.join(owner, "fixture.vyrebackup");
  const short = await vyre(owner, ["vault", "backup", file], "too short\n");
  assert.equal(short.code, 1);
  const b = await vyre(owner, ["vault", "backup", file], "a long backup phrase\n");
  assert.equal(b.code, 0, b.all);
  assert.match(b.out, /backed up 2 items/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const blob = fs.readFileSync(file);
  assert.ok(!blob.includes(Buffer.from(password)) && !blob.includes(Buffer.from(token)));
  const wrong = await vyre(spare, ["vault", "restore", file], "not the phrase\n");
  assert.equal(wrong.code, 1);
  assert.match(wrong.all, /does not open this backup/);
  const r = await vyre(spare, ["vault", "restore", file], "a long backup phrase\n");
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /restored 2 items/);
  const hashed = await vyre(spare, ["vault", "run", "api-token", "--", process.execPath, "-e", "console.log(require('crypto').createHash('sha256').update(process.env.API_TOKEN).digest('hex'))"]);
  assert.equal(hashed.out.trim(), sha(token));
});
