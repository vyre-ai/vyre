// @ts-check
// The SSH agent against the real OpenSSH tools: keys made by ssh-keygen parse here, keys made here
// parse in ssh-keygen, `ssh-add -L` lists what the vault holds, and `ssh-keygen -Y sign` gets a
// signature that `ssh-keygen -Y verify` accepts. Throwaway keys in a temp folder only; ~/.ssh is
// never read, and SSH_AUTH_SOCK is set per child to this test's own socket.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { parsePrivate, serializePrivate, generateKey, sign, verify, fingerprint, publicFromBlob } from "./keys.js";
import { SshAgent, listen, describe, summarize } from "./agent.js";
import { Reader, str, u32, byte } from "./wire.js";
import { SCRATCH } from "../../../test/scratch.mjs";

const have = bin => { try { return fs.statSync(`/usr/bin/${bin}`).isFile() || fs.statSync(`/opt/homebrew/bin/${bin}`).isFile(); } catch { return false; } };
const OPENSSH = have("ssh-keygen") && have("ssh-add");

function tmp(t) {
  // Short, so the socket path fits the 104-byte unix limit.
  const d = fs.mkdtempSync(path.join(SCRATCH, "vssh-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** @returns {Promise<{ code: number, out: string, err: string }>} */
function run(bin, args, env = {}, input) {
  return new Promise(resolve => {
    const home = env.HOME || os.tmpdir();
    const p = execFile(bin, args, { env: { PATH: process.env.PATH, HOME: home, ...env }, encoding: "utf8" }, (e, out, err) =>
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out, err }));
    if (input !== undefined) p.stdin?.end(input); else p.stdin?.end();
  });
}

test("ssh keys: ssh-keygen's keys parse, and ours parse in ssh-keygen", { skip: !OPENSSH }, async t => {
  const d = tmp(t);
  for (const [type, args] of [["ed25519", ["-t", "ed25519"]], ["rsa", ["-t", "rsa", "-b", "2048"]], ["ecdsa", ["-t", "ecdsa", "-b", "256"]]]) {
    const f = path.join(d, `k-${type}`);
    assert.equal((await run("ssh-keygen", [...args, "-N", "", "-C", "alex@example.com", "-f", f, "-q"])).code, 0);
    const k = parsePrivate(fs.readFileSync(f, "utf8"));
    assert.equal(k.type, type);
    assert.equal(k.comment, "alex@example.com");
    const theirs = (await run("ssh-keygen", ["-l", "-E", "sha256", "-f", f + ".pub"])).out.split(" ")[1];
    assert.equal(k.fingerprint, theirs, `${type} fingerprint`);
    assert.equal(k.public.split(" ").slice(0, 2).join(" "), fs.readFileSync(f + ".pub", "utf8").split(" ").slice(0, 2).join(" "));
    // A signature over some data verifies with the public blob.
    const data = crypto.randomBytes(64);
    assert.ok(verify(k.blob, data, sign(k, data, 2)), `${type} signature`);

    // And the other way: our serialization is a file ssh-keygen reads.
    const mine = path.join(d, `m-${type}`);
    fs.writeFileSync(mine, generateKey(type, "dana@example.com"), { mode: 0o600 });
    const pub = await run("ssh-keygen", ["-y", "-f", mine]);
    assert.equal(pub.code, 0, pub.err);
    assert.equal(pub.out.trim().split(" ").slice(0, 2).join(" "), parsePrivate(fs.readFileSync(mine, "utf8")).public.split(" ").slice(0, 2).join(" "));
  }
  // Round trip without the tools.
  const again = parsePrivate(serializePrivate("ed25519", crypto.generateKeyPairSync("ed25519").privateKey, "x"));
  assert.equal(publicFromBlob(again.blob).type, "ed25519");
});

test("ssh keys: an encrypted key is refused with a way forward; RSA SHA-1 is refused", { skip: !OPENSSH }, async t => {
  const d = tmp(t);
  const f = path.join(d, "enc");
  await run("ssh-keygen", ["-t", "ed25519", "-N", "a long test phrase", "-f", f, "-q"]);
  assert.throws(() => parsePrivate(fs.readFileSync(f, "utf8")), /encrypted with a passphrase.*ssh-keygen -p/);
  assert.throws(() => parsePrivate("hello"), /not an OpenSSH private key/);
  const rsa = parsePrivate(generateKey("rsa"));
  assert.throws(() => sign(rsa, Buffer.from("x"), 0), /SHA-1/);
  assert.equal(new Reader(sign(rsa, Buffer.from("x"), 4)).text(), "rsa-sha2-512");
});

test("ssh agent: describe and summarize name the purpose, never key material", () => {
  const session = crypto.randomBytes(32);
  const login = Buffer.concat([str(session), byte(50), str("alex"), str("ssh-connection"), str("publickey"), byte(1), str("ssh-ed25519"), str("blob")]);
  const w = describe(login);
  assert.equal(w.kind, "login");
  assert.equal(summarize({ what: w, name: "deploy", host: "SHA256:abc", forwarded: false }), 'log in as alex to host SHA256:abc with ssh key "deploy"');
  const sshsig = Buffer.concat([Buffer.from("SSHSIG"), str("git"), str(""), str("sha512"), str(crypto.randomBytes(64))]);
  assert.equal(summarize({ what: describe(sshsig), name: "deploy", host: "unbound", forwarded: false }), 'sign a git commit (SSHSIG namespace git) with ssh key "deploy"');
  assert.equal(describe(Buffer.from([1, 2])).kind, "data");
});

/** An agent over the vault-shaped callbacks, with every approval and audit row recorded. */
function agentFor(keys, answer = true) {
  const asked = [], rows = [];
  const agent = new SshAgent({
    identities: async () => keys.map(k => ({ name: k.name, blob: k.key.blob, comment: k.name })),
    privateKey: async name => /** @type {any} */ (keys.find(k => k.name === name)).key,
    approve: async req => { asked.push(req); return typeof answer === "function" ? answer(req) : answer; },
    audit: (ok, name, host, why) => rows.push({ ok, name, host, why }),
  });
  return { agent, asked, rows };
}

/** One agent request over the socket, the way ssh does it. */
function ask(sock, body) {
  return new Promise((resolve, reject) => {
    const net = /** @type {any} */ (globalThis).__net;
    const c = net.createConnection(sock);
    let buf = Buffer.alloc(0);
    c.on("data", ch => { buf = Buffer.concat([buf, ch]); if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) { c.end(); resolve(buf.subarray(4, 4 + buf.readUInt32BE(0))); } });
    c.on("error", reject);
    c.write(Buffer.concat([u32(body.length), body]));
  });
}

test("ssh agent: ssh-add -L lists the keys; ssh-keygen -Y sign asks every time and verifies", { skip: !OPENSSH }, async t => {
  globalThis.__net = (await import("node:net")).default;
  const d = tmp(t);
  const keys = ["ed25519", "rsa", "ecdsa"].map(type => ({ name: `deploy-${type}`, key: parsePrivate(generateKey(type, `deploy-${type}`)) }));
  const { agent, asked, rows } = agentFor(keys);
  const sock = path.join(d, "a", "agent.sock");
  const l = await listen(sock, agent);
  t.after(() => l.close());
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(sock)).mode & 0o777, 0o700);
  const env = { SSH_AUTH_SOCK: sock, HOME: d };

  const listed = await run("ssh-add", ["-L"], env);
  assert.equal(listed.code, 0, listed.err);
  const lines = listed.out.trim().split("\n");
  assert.deepEqual(lines.map(x => x.split(" ")[2]), keys.map(k => k.name));
  for (const k of keys) assert.ok(lines.includes(k.key.public));
  // Adding a key through the socket is refused.
  const extra = path.join(d, "extra");
  await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", extra, "-q"]);
  assert.notEqual((await run("ssh-add", [extra], env)).code, 0);

  // Commit signing: each signature asks, and the signature verifies.
  const msg = path.join(d, "commit.txt");
  fs.writeFileSync(msg, "tree 0000\n\na commit\n");
  for (const k of keys) {
    const pub = path.join(d, `${k.name}.pub`);
    fs.writeFileSync(pub, k.key.public + "\n");
    for (let i = 0; i < 2; i++) {
      fs.rmSync(msg + ".sig", { force: true });
      const s = await run("ssh-keygen", ["-Y", "sign", "-f", pub, "-n", "git", msg], env);
      assert.equal(s.code, 0, `${k.name}: ${s.err}`);
    }
    const allowed = path.join(d, "allowed");
    fs.writeFileSync(allowed, `alex@example.com ${k.key.public}\n`);
    const v = await run("ssh-keygen", ["-Y", "verify", "-f", allowed, "-I", "alex@example.com", "-n", "git", "-s", msg + ".sig"], env, fs.readFileSync(msg));
    assert.equal(v.code, 0, `${k.name}: ${v.err || v.out}`);
  }
  assert.equal(asked.length, 6, "SSHSIG is never leased: every signature asks");
  assert.equal(asked[0].summary, 'sign a git commit (SSHSIG namespace git) with ssh key "deploy-ed25519"');
  assert.equal(rows.filter(r => r.ok).length, 6);
  assert.ok(rows.every(r => r.host === "unbound"));
});

test("ssh agent: a bound login is leased per host, a refusal signs nothing, forwarding always asks", async t => {
  globalThis.__net = (await import("node:net")).default;
  const d = tmp(t);
  const k = { name: "deploy", key: parsePrivate(generateKey("ed25519", "deploy")) };
  let answer = true;
  const { agent, asked, rows } = agentFor([k], () => answer);
  const sock = path.join(d, "agent.sock");
  const l = await listen(sock, agent);
  t.after(() => l.close());

  const host = parsePrivate(generateKey("ed25519", "host"));
  const bindAndSign = async (session, { forwarding = false, sameConn = true, badSig = false } = {}) => {
    const net = /** @type {any} */ (globalThis).__net;
    const c = net.createConnection(sock);
    const replies = [];
    let buf = Buffer.alloc(0);
    const want = 2;
    const done = new Promise(resolve => c.on("data", ch => {
      buf = Buffer.concat([buf, ch]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) { replies.push(buf.subarray(4, 4 + buf.readUInt32BE(0))); buf = buf.subarray(4 + buf.readUInt32BE(0)); }
      if (replies.length >= want) { c.end(); resolve(replies); }
    }));
    const sig = badSig ? sign(host, crypto.randomBytes(32), 0) : sign(host, session, 0);
    const bind = Buffer.concat([byte(27), str("session-bind@openssh.com"), str(host.blob), str(session), str(sig), byte(forwarding ? 1 : 0)]);
    const data = Buffer.concat([str(sameConn ? session : crypto.randomBytes(32)), byte(50), str("alex"), str("ssh-connection"), str("publickey"), byte(1), str("ssh-ed25519"), str(k.key.blob)]);
    const signReq = Buffer.concat([byte(13), str(k.key.blob), str(data), u32(0)]);
    c.write(Buffer.concat([u32(bind.length), bind, u32(signReq.length), signReq]));
    return /** @type {Buffer[]} */ (await done);
  };

  const s1 = crypto.randomBytes(32);
  let [b, r] = await bindAndSign(s1);
  assert.equal(b[0], 6, "session-bind answered SUCCESS");
  assert.equal(r[0], 14, "signed");
  const sigBlob = new Reader(r.subarray(1)).string();
  const data = Buffer.concat([str(s1), byte(50), str("alex"), str("ssh-connection"), str("publickey"), byte(1), str("ssh-ed25519"), str(k.key.blob)]);
  assert.ok(verify(k.key.blob, data, sigBlob));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].summary, `log in as alex to host ${host.fingerprint} with ssh key "deploy"`);

  // Same host again: leased, no question.
  [b, r] = await bindAndSign(crypto.randomBytes(32));
  assert.equal(r[0], 14);
  assert.equal(asked.length, 1, "the lease covers the second login");
  assert.equal(agent.approvals().leases[0].host, host.fingerprint);

  // A signature over another session than the bound one is refused, as is a forged bind.
  [b, r] = await bindAndSign(crypto.randomBytes(32), { sameConn: false });
  assert.equal(r[0], 5);
  [b, r] = await bindAndSign(crypto.randomBytes(32), { badSig: true });
  assert.equal(b[0], 5, "a bind that does not verify is refused");
  assert.equal(asked[asked.length - 1].host, "unbound", "and the login that follows is not treated as bound");

  // Forwarded: asks every time, even with a lease.
  answer = false;
  [b, r] = await bindAndSign(crypto.randomBytes(32), { forwarding: true });
  assert.equal(r[0], 5, "refused");
  assert.match(asked[asked.length - 1].summary, /forwarded from another machine/);
  assert.equal(agent.approvals().waiting.length, 1, JSON.stringify(agent.approvals().waiting));

  // Forgetting ends the lease; the next login asks again and is refused.
  assert.equal(agent.forget({ name: "deploy" }), 2, "the host's lease and the unbound one");
  [b, r] = await bindAndSign(crypto.randomBytes(32));
  assert.equal(r[0], 5);
  assert.ok(rows.some(x => !x.ok && /not approved/.test(x.why)));

  // Unknown key and lock requests fail.
  assert.equal((await ask(sock, Buffer.concat([byte(13), str(host.blob), str("x"), u32(0)])))[0], 5);
  assert.equal((await ask(sock, Buffer.concat([byte(22), str("pw")])))[0], 5);
  const unknownExt = await ask(sock, Buffer.concat([byte(27), str("query")]));
  assert.equal(unknownExt[0], 5);
  // Audit rows name the key and host only.
  for (const x of rows) assert.deepEqual(Object.keys(x).sort(), ["host", "name", "ok", "why"]);
  assert.equal(fingerprint(k.key.blob), k.key.fingerprint);
});
