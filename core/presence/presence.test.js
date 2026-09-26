// @ts-check
// Presence: every method proves a call once, for that tool and that input, and refuses the rest.
// Nothing here opens a dialog or writes to a real terminal: every OS touch point is a fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { Presence, HUMAN_ONLY, canonical, inputHash, parse } from "./index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { discover, Registry } from "../modules/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const charDev = (owner = uid, char = true) => ({ uid: owner, isCharacterDevice: () => char });

/** A Presence on a temp db, with a fake terminal that records what was written to it. */
function setup(t, opts = {}) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const events = new Events(db);
  const written = [];
  let clock = 1_000_000;
  const p = new Presence({
    db, events, platform: "linux", touchid: null, webauthn: null,
    who: async () => ["console", "ttys003", "pts/3"],
    statTty: () => charDev(),
    writeTty: (file, text) => { written.push({ file, text }); },
    now: () => clock,
    ...opts,
  });
  return { p, db, events, written, tick: ms => { clock += ms; }, now: () => clock };
}

const codeFrom = text => /command: ([A-Z0-9]{6})/.exec(text)[1];
const APPROVE = { tool: "gate.approve", input: { id: "a1" } };

test("presence: the floor's list holds every human-only tool", () => {
  for (const t of ["gate.approve", "gate.revise", "gate.reject", "threads.answer", "vault.put", "vault.approve", "vault.unlock",
    "vault.offboard", "learn.accept", "learn.retire", "presence.enroll", "presence.remove", "presence.code"]) assert.ok(HUMAN_ONLY.has(t), t);
  assert.ok(HUMAN_ONLY.size >= 13);
});

test("presence: canonical JSON sorts keys at every depth, and the hash follows it", () => {
  assert.equal(canonical({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" }, 10: 1, 2: 2 }), '{"10":1,"2":2,"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
  assert.equal(inputHash({ a: 1, b: 2 }), inputHash({ b: 2, a: 1 }));
  assert.notEqual(inputHash({ id: "a" }), inputHash({ id: "b" }));
  assert.match(inputHash({}), /^[A-Za-z0-9_-]{43}$/);
});

test("presence: the header parses into a method and fields, and garbage is null", () => {
  assert.deepEqual(parse("tty id=abc code=XYZ234"), { method: "tty", id: "abc", code: "XYZ234" });
  assert.deepEqual(parse("touchid"), { method: "touchid" });
  for (const bad of [undefined, "", "magic id=1", "tty id", "tty id=1 id=2", "tty method=code", "tty ID=1"]) assert.equal(parse(bad), null, String(bad));
});

test("presence: required is the floor's list plus what a tool declares, never less", t => {
  const { p } = setup(t);
  assert.equal(p.required("gate.approve", { presence: false }), true);
  assert.equal(p.required("notes.add", {}), false);
  assert.equal(p.required("notes.wipe", { presence: true }), true);
});

test("presence: a summary cannot smuggle terminal escapes, and falls back when the owner's throws", async t => {
  const { p } = setup(t);
  const evil = { presence: { summary: async () => "Send \u001b[2J\u001b]0;pwned\u0007 to a@example.com\r\nfake line‮" } };
  const s = await p.summary("gate.approve", {}, evil);
  assert.doesNotMatch(s, /[\u0000-\u001f\u007f-\u009f‮]/);
  assert.match(s, /to a@example\.com fake line/);
  const broken = { presence: { summary: async () => { throw new Error("no"); } } };
  assert.equal(await p.summary("gate.approve", { id: "a1" }, broken), 'gate.approve {"id":"a1"}');
  assert.ok((await p.summary("x.y", { text: "a".repeat(500) }, {})).length <= 160);
});

test("presence: tty writes the summary and a code to a login terminal, and the code proves that one call once", async t => {
  const { p, written, events } = setup(t);
  const c = await p.challenge({ ...APPROVE, method: "tty", tty: "/dev/ttys003", def: { presence: { summary: async () => "Send email to a@example.com" } } });
  assert.ok(c.challenge);
  assert.equal(written[0].file, "/dev/ttys003");
  assert.match(written[0].text, /Vyre · Send email to a@example\.com/);
  const code = codeFrom(written[0].text);
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
  const ok = await p.verify({ ...APPROVE, caller: "cli", proof: { method: "tty", id: c.challenge, code: code.toLowerCase() } });
  assert.deepEqual(ok, { ok: true, method: "tty", keyId: null });
  const again = await p.verify({ ...APPROVE, caller: "cli", proof: { method: "tty", id: c.challenge, code } });
  assert.equal(again.ok, false, "a tty proof was used twice");
  const ev = events.since(0).filter(e => e.source === "presence");
  assert.deepEqual(ev.map(e => e.type), ["presence.proved", "presence.refused"]);
  assert.deepEqual(ev[0].payload, { tool: "gate.approve", method: "tty", caller: "cli" });
  assert.ok(!JSON.stringify(ev).includes(code), "an event carried the code");
});

test("presence: a tty proof is bound to its tool and input, and expires", async t => {
  const { p, written, tick } = setup(t);
  const c = await p.challenge({ ...APPROVE, method: "tty", tty: "/dev/pts/3" });
  const code = codeFrom(written[0].text);
  assert.equal((await p.verify({ tool: "gate.reject", input: APPROVE.input, caller: "cli", proof: { method: "tty", id: c.challenge, code } })).ok, false);
  assert.equal((await p.verify({ tool: "gate.approve", input: { id: "b2" }, caller: "cli", proof: { method: "tty", id: c.challenge, code } })).ok, false);
  tick(121_000);
  const r = await p.verify({ ...APPROVE, caller: "cli", proof: { method: "tty", id: c.challenge, code } });
  assert.equal(r.ok, false);
  assert.equal(r.code, "presence_required");
  assert.ok(r.methods.includes("tty"));
});

test("presence: three wrong codes and the tty challenge is gone", async t => {
  const { p, written } = setup(t);
  const c = await p.challenge({ ...APPROVE, method: "tty", tty: "/dev/ttys003" });
  const code = codeFrom(written[0].text);
  const wrong = code === "AAAAAA" ? "BBBBBB" : "AAAAAA";
  for (let i = 0; i < 3; i++) assert.equal((await p.verify({ ...APPROVE, caller: "cli", proof: { method: "tty", id: c.challenge, code: wrong } })).ok, false);
  assert.equal((await p.verify({ ...APPROVE, caller: "cli", proof: { method: "tty", id: c.challenge, code } })).ok, false, "the right code worked after three wrong ones");
});

test("presence: tty refuses a bad path, a terminal that is not ours, one that is not a device, and one who does not list", async t => {
  const { p, written } = setup(t);
  assert.equal((await p.challenge({ ...APPROVE, method: "tty", tty: "/dev/../etc/passwd" })).error.code, "bad_input");
  assert.equal((await p.challenge({ ...APPROVE, method: "tty", tty: "/tmp/ttys003" })).error.code, "bad_input");
  assert.equal((await p.challenge({ ...APPROVE, method: "tty", tty: "/dev/ttys009" })).error.code, "denied", "a terminal who does not list");
  const other = setup(t, { statTty: () => charDev(uid + 1) });
  assert.match((await other.p.challenge({ ...APPROVE, method: "tty", tty: "/dev/ttys003" })).error.message, /another user/);
  const file = setup(t, { statTty: () => charDev(uid, false) });
  assert.equal((await file.p.challenge({ ...APPROVE, method: "tty", tty: "/dev/ttys003" })).error.code, "denied");
  assert.equal(written.length + other.written.length + file.written.length, 0, "wrote to a terminal it should have refused");
  assert.equal((await p.challenge({ ...APPROVE, method: "capsule" })).error.code, "bad_input");
});

/** An Ed25519 Capsule key, enrolled, and a signer for calls. */
function capsuleKey(p) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const { id } = p.enroll({ kind: "capsule", name: "Capsule", public_key: pub });
  const sign = (tool, input, ts, nonce = crypto.randomBytes(12).toString("base64url")) => ({
    method: "capsule", key: id, ts: String(ts), nonce,
    sig: crypto.sign(null, Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`), privateKey).toString("base64url"),
  });
  return { id, sign, privateKey };
}

test("presence: a Capsule signature proves one call, within 60 seconds, with a fresh nonce", async t => {
  const { p, db, now } = setup(t);
  const k = capsuleKey(p);
  const proof = k.sign(APPROVE.tool, APPROVE.input, now());
  assert.deepEqual(await p.verify({ ...APPROVE, caller: "capsule", proof }), { ok: true, method: "capsule", keyId: k.id });
  assert.ok(db.prepare("SELECT last_used FROM presence_keys WHERE id = ?").get(k.id).last_used);
  assert.match((await p.verify({ ...APPROVE, caller: "capsule", proof })).message, /nonce was already used/);
  assert.match((await p.verify({ ...APPROVE, caller: "capsule", proof: k.sign(APPROVE.tool, APPROVE.input, now() - 61_000) })).message, /too old/);
  assert.equal((await p.verify({ tool: "gate.approve", input: { id: "b2" }, caller: "capsule", proof: k.sign(APPROVE.tool, APPROVE.input, now()) })).ok, false, "a signature for a1 approved b2");
  const forged = { ...k.sign(APPROVE.tool, APPROVE.input, now()), sig: crypto.randomBytes(64).toString("base64url") };
  assert.match((await p.verify({ ...APPROVE, caller: "capsule", proof: forged })).message, /does not check out/);
  assert.match((await p.verify({ ...APPROVE, caller: "capsule", proof: { ...k.sign(APPROVE.tool, APPROVE.input, now()), key: "nope" } })).message, /not enrolled/);
});

test("presence: enrolling checks the key, and listing never shows it", async t => {
  const { p } = setup(t);
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  assert.throws(() => p.enroll({ kind: "capsule", public_key: rsa }), /Ed25519/);
  assert.throws(() => p.enroll({ kind: "capsule", public_key: "bm90IGEga2V5" }), /SPKI/);
  assert.throws(() => p.enroll({ kind: "passkey", public_key: rsa, alg: -7, rp_id: "example.com", credential_id: "credential-1" }), /needs a ec key/);
  p.enroll({ kind: "passkey", name: "Phone", public_key: rsa, alg: -257, rp_id: "example.com", credential_id: "credential-1" });
  const k = capsuleKey(p);
  assert.throws(() => p.enroll({ kind: "passkey", public_key: rsa, alg: -257, rp_id: "example.com", credential_id: "credential-1" }), /already enrolled/);
  const list = p.keys();
  assert.ok(list.some(r => r.id === "credential-1") && list.some(r => r.id === k.id));
  assert.ok(list.every(r => !("public_key" in r)));
  assert.equal(p.remove(k.id), true);
  assert.equal(p.remove(k.id), false);
});

test("presence: a passkey assertion proves one call, over vyred's challenge, and the counter must move forward", async t => {
  const seen = [];
  let count = 5;
  const webauthn = { verifyAssertion: async a => { seen.push(a); return a.signature === "good" ? { ok: true, signCount: count } : { ok: false, reason: "bad signature" }; } };
  const { p, db } = setup(t, { webauthn });
  assert.match((await p.challenge({ ...APPROVE, method: "passkey" })).error.message, /no passkey is enrolled/);
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  p.enroll({ kind: "passkey", name: "Phone", public_key: ec, alg: -7, rp_id: "box.example.com", credential_id: "cred-0001" });
  const c = await p.challenge({ ...APPROVE, method: "passkey" });
  assert.equal(c.webauthn.rpId, "box.example.com");
  assert.equal(c.webauthn.userVerification, "required");
  assert.deepEqual(c.webauthn.allowCredentials, [{ type: "public-key", id: "cred-0001" }]);
  const proof = { method: "passkey", id: c.challenge, cred: "cred-0001", ad: "AA", cd: "BB", sig: "good" };
  assert.deepEqual(await p.verify({ ...APPROVE, caller: "deck", proof }), { ok: true, method: "passkey", keyId: "cred-0001" });
  assert.equal(seen[0].challenge, c.webauthn.challenge);
  assert.equal(seen[0].publicKey, ec);
  assert.equal(seen[0].alg, -7);
  assert.equal(db.prepare("SELECT sign_count FROM presence_keys").get().sign_count, 5);
  assert.equal((await p.verify({ ...APPROVE, caller: "deck", proof })).ok, false, "a passkey challenge was used twice");

  const wrongInput = await p.challenge({ ...APPROVE, method: "passkey" });
  assert.equal((await p.verify({ tool: "gate.approve", input: { id: "b2" }, caller: "deck", proof: { ...proof, id: wrongInput.challenge } })).ok, false);
  const bad = await p.challenge({ ...APPROVE, method: "passkey" });
  assert.match((await p.verify({ ...APPROVE, caller: "deck", proof: { ...proof, id: bad.challenge, sig: "forged" } })).message, /does not check out/);
  const back = await p.challenge({ ...APPROVE, method: "passkey" });
  count = 3;
  assert.match((await p.verify({ ...APPROVE, caller: "deck", proof: { ...proof, id: back.challenge } })).message, /counter went backwards/);
  const zero = await p.challenge({ ...APPROVE, method: "passkey" });
  count = 0;
  assert.equal((await p.verify({ ...APPROVE, caller: "deck", proof: { ...proof, id: zero.challenge } })).ok, true, "a synced passkey sends 0");
});

test("presence: Touch ID shows the summary, one dialog at a time, and cools down after a cancel", async t => {
  const reasons = [];
  let answer = { ok: true };
  let release = () => {};
  const touchid = { available: async () => true, authenticate: async reason => { reasons.push(reason); await new Promise(r => { release = r; }); return answer; } };
  const { p, tick } = setup(t, { platform: "darwin", touchid });
  const first = p.verify({ ...APPROVE, caller: "cli", proof: { method: "touchid" }, def: { presence: { summary: async () => "Send email to a@example.com" } } });
  await new Promise(r => setImmediate(r));
  const second = await p.verify({ ...APPROVE, caller: "cli", proof: { method: "touchid" } });
  assert.match(second.message, /already open/);
  release();
  assert.deepEqual(await first, { ok: true, method: "touchid", keyId: null });
  assert.deepEqual(reasons, ["Vyre: Send email to a@example.com"]);

  answer = { ok: false, reason: "cancelled" };
  const cancelled = p.verify({ ...APPROVE, caller: "cli", proof: { method: "touchid" } });
  await new Promise(r => setImmediate(r));
  release();
  assert.equal((await cancelled).ok, false);
  answer = { ok: true };
  assert.match((await p.verify({ ...APPROVE, caller: "cli", proof: { method: "touchid" } })).message, /try again in 30s/);
  assert.equal(reasons.length, 2, "a dialog was shown during the cool-down");
  tick(30_001);
  const later = p.verify({ ...APPROVE, caller: "cli", proof: { method: "touchid" } });
  await new Promise(r => setImmediate(r));
  release();
  assert.equal((await later).ok, true);
});

test("presence: the methods offered follow the machine and what is enrolled", async t => {
  const mac = setup(t, { platform: "darwin", touchid: { available: async () => true, authenticate: async () => ({ ok: true }) } });
  assert.deepEqual((await mac.p.verify({ ...APPROVE, caller: "cli", proof: null })).methods, ["touchid", "tty"]);
  capsuleKey(mac.p);
  assert.deepEqual((await mac.p.verify({ ...APPROVE, caller: "cli", proof: null })).methods, ["touchid", "tty", "capsule"]);
  const linux = setup(t, { touchid: { available: async () => true, authenticate: async () => ({ ok: true }) } });
  assert.deepEqual((await linux.p.verify({ ...APPROVE, caller: "cli", proof: null })).methods, ["tty"]);
  assert.equal((await linux.p.verify({ ...APPROVE, caller: "cli", proof: { method: "touchid" } })).ok, false);
});

test("presence: a one-time code enrolls and does nothing else, once, for 10 minutes", async t => {
  const { p, tick } = setup(t);
  const { code, expires } = p.mintCode();
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/);
  assert.ok(expires > 0);
  assert.equal((await p.verify({ ...APPROVE, caller: "deck", proof: { method: "code", code } })).ok, false, "a code approved a gate item");
  assert.equal((await p.verify({ tool: "presence.enroll", input: {}, caller: "deck", proof: { method: "code", code: "WRONG234" } })).ok, false);
  assert.deepEqual(await p.verify({ tool: "presence.enroll", input: {}, caller: "deck", proof: { method: "code", code } }), { ok: true, method: "code", keyId: null });
  assert.equal((await p.verify({ tool: "presence.enroll", input: {}, caller: "deck", proof: { method: "code", code } })).ok, false, "a code was used twice");
  const late = p.mintCode();
  tick(10 * 60_000 + 1);
  assert.equal((await p.verify({ tool: "presence.enroll", input: {}, caller: "deck", proof: { method: "code", code: late.code } })).ok, false);
});

test("presence: through the registry, every claimed caller needs a proof, and only a module is exempt", async t => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "gate", { does: { tools: ["gate.approve"] } },
    `export default { async start(ctx) { ctx.tool("gate.approve", { input: { type: "object" }, run: async i => ({ approved: i.id }) }); return {}; } };`);
  writeModule(root, "chat", { requires: ["gate"], does: { tools: ["chat.press"] } },
    `export default { async start(ctx) { ctx.tool("chat.press", { run: async i => (await ctx.call("gate.approve", i)).data }); return {}; } };`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const events = new Events(db);
  const presence = new Presence({ db, events, platform: "linux", touchid: null, webauthn: null, who: async () => [], statTty: () => charDev(), writeTty: () => {} });
  const reg = new Registry({ db, events, config: { role: "local" }, log: () => {}, presence });
  await reg.start(discover([root]), { role: "local" });
  for (const caller of ["cli", "capsule", "deck", "local", "mcp", "mcp:agent:assistant", "unknown"]) {
    const r = await reg.call("gate.approve", { id: "a1" }, caller);
    assert.equal(r.error && r.error.code, "presence_required", `${caller} approved without a proof`);
    assert.ok(r.error.methods.includes("tty"));
  }
  assert.equal((await reg.call("gate.approve", { id: "a1" }, "cli", { proof: { method: "tty", id: "made-up", code: "ABCDEF" } })).error.code, "presence_required");
  // chat.press is not presence-gated itself, and its inner call is made by module:chat.
  assert.deepEqual(await reg.call("chat.press", { id: "a1" }, "cli"), { data: { approved: "a1" } });
  assert.ok(reg.listTools().find(x => x.name === "gate.approve").presence);
  assert.equal(reg.listTools().find(x => x.name === "chat.press").presence, undefined);
});

test("presence: on the box a terminal proves presence only to enroll the first passkey", async t => {
  const { p } = setup(t);
  p.role = "box";
  assert.ok((await p.methods()).includes("tty"), "before any passkey, the terminal bootstraps one");
  assert.equal((await p.challenge({ ...APPROVE, method: "tty", tty: "/dev/pts/3" })).error.code, "denied", "never for an approval");
  assert.equal((await p.verify({ ...APPROVE, caller: "cli", proof: { method: "tty", id: "x", code: "y" } })).ok, false);
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  p.enroll({ kind: "passkey", name: "Phone", public_key: ec, alg: -7, rp_id: "box.example.com", credential_id: "cred-0002" });
  assert.ok(!(await p.methods()).includes("tty"), "after one, passkeys only");
  assert.equal((await p.challenge({ tool: "presence.enroll", input: {}, method: "tty", tty: "/dev/pts/3" })).error.code, "denied");
});
