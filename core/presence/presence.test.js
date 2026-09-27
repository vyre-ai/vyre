// @ts-check
// Presence: every method proves a call once, for that tool and that input, and refuses the rest.
// Nothing here opens a dialog or writes to a real terminal: every OS touch point is a fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { Presence, HUMAN_ONLY, PERSON_ONLY, canonical, inputHash, parse } from "./index.js";
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
  for (const t of ["gate.revise", "gate.reject", "threads.answer"]) assert.ok(!HUMAN_ONLY.has(t), `${t}: sends nothing, needs no proof`);
  for (const t of ["gate.approve", "vault.put", "vault.approve", "vault.unlock",
    "vault.offboard", "learn.skill-install", "presence.enroll", "presence.remove", "presence.code"]) assert.ok(HUMAN_ONLY.has(t), t);
  assert.ok(HUMAN_ONLY.size >= 10);
  // The owner's own actions ask no proof (no nagging), but stay off a model's shell (PERSON_ONLY).
  for (const t of ["threads.answer", "term.open", "gate.revise", "gate.reject", "agents.create", "agents.update", "agents.resume", "computers.takeover", "learn.accept", "learn.retire", "learn.relax"]) assert.ok(!HUMAN_ONLY.has(t) && PERSON_ONLY.has(t), t);
  assert.ok(!HUMAN_ONLY.has("memory.correct"));
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

test("presence: the box never takes a terminal code; its first passkey comes from a one-time code", async t => {
  const { p } = setup(t);
  p.role = "box";
  assert.ok(!(await p.methods()).includes("tty"));
  assert.equal((await p.challenge({ ...APPROVE, method: "tty", tty: "/dev/pts/3" })).error.code, "denied");
  assert.equal((await p.challenge({ tool: "presence.enroll", input: {}, method: "tty", tty: "/dev/pts/3" })).error.code, "denied");
  assert.equal((await p.verify({ ...APPROVE, caller: "cli", proof: { method: "tty", id: "x", code: "y" } })).ok, false);
  p.network = () => ({ owner: "Me@example.com", address: "https://me.vyre.run" });
  const { code } = p.mintCode();
  for (const caller of ["cli", "local", "capsule", "tailnet:other@example.com", "mcp"]) {
    assert.equal((await p.verify({ tool: "presence.enroll", input: {}, caller, proof: { method: "code", code } })).ok, false, caller);
  }
  assert.equal((await p.verify({ tool: "presence.enroll", input: {}, caller: "tailnet:me@example.com", proof: { method: "code", code } })).ok, true, "the owner's device");
  const other = p.mintCode();
  p.network = () => ({});
  assert.equal((await p.verify({ tool: "presence.enroll", input: {}, caller: "tailnet:me@example.com", proof: { method: "code", code: other.code } })).ok, false, "no owner yet, no enrolment");
});

test("presence: a session proves reveal, copy, TOTP and sends for a while, on one device, for items that allow it", async t => {
  const { p, tick } = setup(t);
  const def = { presence: { session: i => !i.reprompt } };
  assert.throws(() => p.openSession({ method: "tty" }), /only after/);
  const s = p.openSession({ method: "passkey", keyId: "cred-1", peer: { stableId: "phone" } });
  const proof = { method: "session", id: s.session, secret: s.secret };
  const reveal = { tool: "vault.reveal", input: { name: "bank" }, caller: "tailnet:me@example.com", def };
  assert.deepEqual(await p.verify({ ...reveal, proof, peer: { stableId: "phone" } }), { ok: true, method: "session", keyId: "cred-1" });
  assert.equal((await p.verify({ ...reveal, proof, peer: { stableId: "laptop" } })).ok, false, "another device");
  assert.equal((await p.verify({ ...reveal, input: { name: "card", reprompt: true }, proof, peer: { stableId: "phone" } })).ok, false, "an item that asks every time");
  assert.equal((await p.verify({ ...reveal, def: { presence: true }, proof, peer: { stableId: "phone" } })).ok, false, "a tool that did not say yes");
  assert.equal((await p.verify({ ...APPROVE, def, proof, peer: { stableId: "phone" } })).ok, true, "a send the Gate says may ride it (the no-nag rule)");
  assert.equal((await p.verify({ ...reveal, tool: "vault.delete", proof, peer: { stableId: "phone" } })).ok, false, "never a tool off the list");
  assert.equal((await p.verify({ ...reveal, proof: { ...proof, secret: "wrong" }, peer: { stableId: "phone" } })).ok, false);
  tick(25 * 60_000);
  assert.equal((await p.verify({ ...reveal, proof, peer: { stableId: "phone" } })).ok, true, "25 minutes unused: still covered, no idle cutoff");
  tick(5 * 60_000);
  assert.equal((await p.verify({ ...reveal, proof, peer: { stableId: "phone" } })).ok, false, "30 minutes from the proof");
  const s2 = p.openSession({ method: "touchid" });
  const proof2 = { method: "session", id: s2.session, secret: s2.secret };
  for (let i = 0; i < 7; i++) { tick(4 * 60_000); assert.ok((await p.verify({ ...reveal, proof: proof2 })).ok, "kept alive " + i); }
  tick(4 * 60_000);
  assert.equal((await p.verify({ ...reveal, proof: proof2 })).ok, false, "30 minutes at most");
  const s3 = p.openSession({ method: "capsule", keyId: "k1" });
  assert.ok(p.closeSession(s3.session));
  assert.equal((await p.verify({ ...reveal, proof: { method: "session", id: s3.session, secret: s3.secret } })).ok, false, "closed");
});

test("presence: a session covers vault reveal, approve and grant for the Deck and the Capsule; the CLI, MCP and agents prove each time", async t => {
  const { p } = setup(t);
  const def = { presence: { session: () => true } };
  const s = p.openSession({ method: "touchid" });
  const proof = { method: "session", id: s.session, secret: s.secret };
  for (const tool of ["vault.reveal", "vault.copy", "vault.totp", "vault.approve", "vault.grant"]) {
    for (const caller of ["deck", "capsule", "tailnet:alex@example.com"]) {
      assert.ok((await p.verify({ tool, input: { name: "mail-token" }, caller, proof, def })).ok, `${tool} from ${caller}`);
    }
    for (const caller of ["cli", "local", "mcp", "mcp:agent:kit", "deck agent:kit", "tailnet:agent:kit", "harness"]) {
      assert.equal((await p.verify({ tool, input: { name: "mail-token" }, caller, proof, def })).ok, false, `${tool} from ${caller}`);
    }
  }
});

test("presence: one Touch ID covers the same login terminal's reveals and grants for 30 minutes; nothing else rides it", async t => {
  const touchid = { available: async () => true, authenticate: async () => ({ ok: true }) };
  const { p, tick, written } = setup(t, { platform: "darwin", touchid });
  const def = { presence: { session: i => !i.reprompt } };
  const at = { tool: "vault.reveal", input: { name: "bank" }, caller: "cli", def, terminal: "ttys003" };
  assert.equal((await p.verify({ ...at, proof: null })).ok, false, "nothing proved yet");
  // A terminal code proves its one call and opens no window.
  const c = await p.challenge({ tool: "vault.reveal", input: { name: "bank" }, method: "tty", tty: "/dev/ttys003" });
  assert.ok((await p.verify({ ...at, proof: { method: "tty", id: c.challenge, code: codeFrom(written.at(-1).text) } })).ok);
  assert.equal((await p.verify({ ...at, proof: null })).ok, false);
  assert.equal((await p.verify({ ...at, proof: { method: "touchid" } })).method, "touchid");
  for (const tool of ["vault.reveal", "vault.copy", "vault.totp", "vault.approve", "vault.grant"]) {
    assert.deepEqual(await p.verify({ ...at, tool, input: { name: "mail-token" }, proof: null }), { ok: true, method: "session", keyId: null }, tool);
  }
  // Another terminal, no terminal, a model or agent label, an item that asks every time, a tool
  // off the list, or a tool that did not say yes: each still asks.
  assert.equal((await p.verify({ ...at, terminal: "ttys004", proof: null })).ok, false, "another terminal");
  assert.equal((await p.verify({ ...at, terminal: null, proof: null })).ok, false, "no terminal");
  for (const caller of ["mcp", "cli agent:kit", "harness", "deck"]) assert.equal((await p.verify({ ...at, caller, proof: null })).ok, false, caller);
  assert.equal((await p.verify({ ...at, input: { name: "card", reprompt: true }, proof: null })).ok, false, "reprompt");
  assert.equal((await p.verify({ ...at, tool: "vault.delete", proof: null })).ok, false, "vault.delete");
  assert.equal((await p.verify({ ...at, def: { presence: true }, proof: null })).ok, false, "a tool that did not say yes");
  tick(29 * 60_000);
  assert.ok((await p.verify({ ...at, proof: null })).ok, "within 30 minutes");
  tick(61_000);
  assert.equal((await p.verify({ ...at, proof: null })).ok, false, "30 minutes from the proof");
});

test("presence: under tests the real Touch ID is never offered or tried; the refusal says no_dialog", async t => {
  // touchid left undefined is the real helper, which shows a system dialog.
  const { p } = setup(t, { platform: "darwin", touchid: undefined });
  assert.ok(!(await p.methods()).includes("touchid"));
  const r = await p.verify({ ...APPROVE, caller: "cli", proof: { method: "touchid" } });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no_dialog");
  assert.equal(p.touchidImpl, undefined, "the helper module was not even loaded");
  // A stand-in shows nothing, so tests that inject one still reach it.
  let asked = 0;
  const { p: faked } = setup(t, { platform: "darwin", touchid: { available: async () => true, authenticate: async () => { asked++; return { ok: true }; } } });
  assert.equal((await faked.verify({ ...APPROVE, caller: "cli", proof: { method: "touchid" } })).ok, true);
  assert.equal(asked, 1);
});

test("presence: every tool on the floor's list is one a shipped module declares", () => {
  // A name no module registers guards nothing: learn.skill_install once sat here while the tool
  // was learn.skill-install. The registry refuses a tool its manifest does not declare, so the
  // manifests are the whole set.
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  const declared = new Set(discover(["core", "local", "modules"].map(d => path.join(repo, d)))
    .flatMap(m => (m.manifest && m.manifest.does && m.manifest.does.tools) || []));
  assert.ok(declared.has("gate.approve") && declared.size > 50, "the manifests were found");
  // Held ahead of the tool on purpose, so it is human-only from its first day (core/vault/prove.js
  // lists it too). Anything else unregistered is a typo.
  const reserved = new Set(["vault.export"]);
  assert.deepEqual([...HUMAN_ONLY].filter(t => !declared.has(t) && !reserved.has(t)), []);
  for (const t of reserved) assert.ok(!declared.has(t), `${t} exists now: drop it from reserved`);
});

test("presence: under tests the real terminal code is never written; tty is not offered", async t => {
  // writeTty left undefined is the real one, which writes into a login terminal the user holds.
  const { p } = setup(t, { writeTty: undefined });
  assert.ok(!(await p.methods()).includes("tty"));
  const c = await p.challenge({ ...APPROVE, method: "tty", tty: "/dev/ttys003" });
  assert.equal(c.error.code, "no_dialog");
});

test("presence: a tool can ask only for some inputs, and counts as asking when listed", () => {
  const p = { required: Presence.prototype.required };
  const def = { presence: { when: i => Boolean(i.auth) } };
  assert.equal(p.required("agents.update", def, { instructions: "x" }), false);
  assert.equal(p.required("agents.update", def, { auth: { budget_usd: 1 } }), true);
  assert.equal(p.required("agents.update", def), true, "no input: listing tools");
  assert.equal(p.required("vault.reveal", {}, { name: "northwind-mail" }), true, "on the floor's list whatever the input");
  assert.equal(p.required("agents.create", {}, { name: "kit" }), false, "making an agent is a person's, with no passkey");
});
