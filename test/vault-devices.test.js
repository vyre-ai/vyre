// @ts-check
// One person, three devices, three real vyreds in temp homes. The Mac has the account and is the
// group's home. A box joins as storage: it runs the agent items and holds the personal ones as
// ciphertext it cannot open. A laptop joins as a full device: with the password it opens
// everything. Writes on one device reach the others (pushed, then poked); a delete travels too.
// The Secret Key and every value stay out of events, logs, audit rows and plain text on disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { request } from "../core/daemon/client.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "vyre");
const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const sha = v => crypto.createHash("sha256").update(v).digest("hex");
const PASSWORD = "a long fixture password for devices";

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

function home(t, name) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-test-"));
  if (path.resolve(h) === path.resolve(os.homedir(), ".vyre")) throw new Error("a test tried to use the real ~/.vyre");
  fs.writeFileSync(path.join(h, "config.json"), JSON.stringify({ name, vault: { keystore: "file", relay: { host: "127.0.0.1", port: 0 } } }));
  t.after(async () => { await vyre(h, ["down"]); fs.rmSync(h, { recursive: true, force: true }); });
  return h;
}

async function call(h, tool, input = {}) {
  const r = await vyre(h, ["call", tool, JSON.stringify(input)]);
  try { return JSON.parse(r.out); } catch { throw new Error(`${tool}: ${r.all}`); }
}

async function hashOf(h, item) {
  const r = await vyre(h, ["vault", "run", `V=${item}`, "--", process.execPath, "-e", "console.log(require('crypto').createHash('sha256').update(process.env.V||'').digest('hex'))"]);
  return { code: r.code, hash: r.out.trim(), all: r.all };
}

const names = async h => (await call(h, "vault.list")).items.map(i => i.name);

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise(r => setTimeout(r, 150));
  }
}

async function join(existing, fresh, role) {
  const j = await call(fresh, "vault.device.join", { role });
  assert.ok(j.code.startsWith("vyre-join:v1:"), JSON.stringify(j));
  assert.match(j.fingerprint, /^([0-9A-Z]{4} ){4}[0-9A-Z]{4}$/);
  const a = await call(existing, "vault.device.approve", { code: j.code });
  assert.equal(a.fingerprint, j.fingerprint, "both screens show the same fingerprint");
  const done = await call(fresh, "vault.device.join", { approval: a.approval });
  assert.equal(done.joined, true, JSON.stringify(done));
  return { j, a };
}

test("devices: a storage box and a full laptop join a Mac; writes and deletes travel; nothing leaks", async t => {
  const mac = home(t, "mac"), box = home(t, "box"), laptop = home(t, "laptop");
  for (const h of [mac, box, laptop]) assert.equal((await vyre(h, ["up"])).code, 0);

  const made = await call(mac, "vault.account.create", { password: PASSWORD });
  const sk = made.secretKey;
  assert.match(sk, /^V2-/);
  const token = fake("token"), mailpw = fake("mail");
  assert.equal((await vyre(mac, ["vault", "put", "api-token", "--kind", "api-key"], token)).code, 0);
  const login = await vyre(mac, ["vault", "put", "example-mail", "--kind", "login", "--username", "alex@example.com", "--url", "https://mail.example.com"], mailpw);
  assert.equal(login.code, 0, login.all);
  assert.equal((await call(mac, "vault.list")).items.find(i => i.name === "example-mail").vault, "personal");

  // The box joins as storage: agent items work there, personal ones are ciphertext it cannot open.
  const { a: boxApproval } = await join(mac, box, "storage");
  assert.ok(!boxApproval.approval.includes(sk), "the approval carries nothing readable");
  assert.deepEqual((await names(box)).sort(), ["api-token", "example-mail"]);
  assert.equal((await hashOf(box, "api-token")).hash, sha(token));
  const locked = await hashOf(box, "example-mail");
  assert.notEqual(locked.code, 0, "a storage box cannot open a personal item");
  assert.match(locked.all, /personal vault|locked|account/);
  assert.match((await vyre(box, ["call", "vault.account.unlock", JSON.stringify({ password: PASSWORD })])).all, /no account password yet|no Secret Key/);

  // A laptop joins as a full device and opens everything with the password.
  await join(mac, laptop, "full");
  assert.equal((await call(laptop, "vault.account.unlock", { password: PASSWORD })).unlocked, true);
  assert.equal((await hashOf(laptop, "example-mail")).hash, sha(mailpw));
  assert.equal((await hashOf(laptop, "api-token")).hash, sha(token));

  // A write on the laptop reaches the Mac, and the box through the home's poke.
  const newTok = fake("new");
  assert.equal((await vyre(laptop, ["vault", "put", "deploy-key"], newTok)).code, 0);
  assert.ok(await until(async () => (await names(mac)).includes("deploy-key")), "the Mac got the laptop's write");
  assert.ok(await until(async () => (await names(box)).includes("deploy-key")), "the box was poked and pulled");
  assert.equal((await hashOf(box, "deploy-key")).hash, sha(newTok));

  // A delete on the Mac travels as a tombstone.
  assert.equal((await vyre(mac, ["vault", "delete", "api-token"])).code, 0);
  assert.ok(await until(async () => !(await names(laptop)).includes("api-token")), "the laptop dropped the deleted item");
  assert.ok(await until(async () => !(await names(box)).includes("api-token")));

  const devices = (await call(mac, "vault.device.list")).devices.map(d => `${d.name}:${d.role}`).sort();
  assert.deepEqual(devices, ["box:storage", "laptop:full", "mac:home"]);

  // No value and no Secret Key in plain text on the box; no Secret Key in anything vyred says.
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.isFile() ? [path.join(d, e.name)] : []);
  for (const f of walk(box)) {
    const bytes = fs.readFileSync(f);
    for (const v of [token, mailpw, newTok, sk]) assert.ok(!bytes.includes(Buffer.from(v)), `a secret is in plain text on the box in ${path.relative(box, f)}`);
  }
  for (const h of [mac, laptop]) for (const f of walk(h)) {
    const bytes = fs.readFileSync(f);
    for (const v of [token, mailpw, newTok]) assert.ok(!bytes.includes(Buffer.from(v)), `a value is in plain text in ${path.relative(h, f)}`);
  }
  for (const h of [mac, box, laptop]) {
    const said = [
      JSON.stringify(await request("GET", "/v1/events?limit=2000", undefined, { root: h })),
      (await vyre(h, ["vault", "audit", "--limit", "1000"])).all,
      fs.existsSync(path.join(h, "logs")) ? walk(path.join(h, "logs")).map(f => fs.readFileSync(f, "utf8")).join("\n") : "",
    ].join("\n");
    for (const v of [token, mailpw, newTok, sk, sk.replace(/-/g, "")]) assert.ok(!said.includes(v), "a secret appeared in events, audit or logs");
  }
});
