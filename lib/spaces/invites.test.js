// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, createHash } from "node:crypto";
import { SpacesError, memoryStore, createMembers } from "./members.js";
import { createInvites, memoryInviteStore, previewInvite, parseJoinLink, acceptMessage, INVITE_TAG, INVITE_DEFAULTS } from "./invites.js";

const NAME = "harlow.vyre.run";
const SID = "spc_harlow00001";
const DAY = 86400000;
const T0 = 1_800_000_000_000;
const P1 = `vyre://${SID}/project/intake`;
const P2 = `vyre://${SID}/project/probate`;

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return { privateKey, publicKey: der, raw: der.subarray(der.length - 32), sign: (/** @type {Buffer} */ b) => edSign(null, b, privateKey) };
}
const rootKp = keypair();
const signer = { keyId: "root1", publicKey: rootKp.publicKey, sign: rootKp.sign };
const identity = (extra = {}) => ({ id: SID, name: NAME, aliases: [], root_key: Buffer.from(rootKp.raw).toString("base64url"), label: "Harlow Legal", ...extra });
const resolveSpace = async (/** @type {string} */ n) => (n === NAME ? identity() : null);

function person(id) {
  const kp = keypair();
  const accept = (/** @type {string} */ inviteId, name = NAME) => Buffer.from(kp.sign(acceptMessage(inviteId, name, id))).toString("base64url");
  return { id, publicKey: kp.publicKey, accept, kp };
}
const seedRandom = () => { let n = 0; return (/** @type {number} */ len) => Buffer.alloc(len, ++n); };
const code = async (/** @type {Promise<any>} */ p) => { try { await p; } catch (e) { assert.ok(e instanceof SpacesError, String(e)); return e.code; } return null; };

async function world(opts = {}) {
  let t = T0;
  const events = /** @type {any[]} */ ([]);
  const mstore = memoryStore();
  const members = createMembers({ space: SID, store: mstore, now: () => t, emit: () => {}, verifyPresence: () => true, policy: opts.policy });
  await members.bootstrapOwner("alex");
  await members.addMember({ actor: "alex", person: "juno", role: "admin" });
  await members.addMember({ actor: "alex", person: "kit", role: "manager" });
  await members.addMember({ actor: "alex", person: "mo", role: "member" });
  await members.addMember({ actor: "alex", person: "tee", role: "temp", scope: [P1], expires: T0 + 30 * DAY });
  const store = memoryInviteStore();
  const inv = createInvites({
    space: { id: SID, name: NAME, aliases: ["app.harlow-legal.example"] }, signer, members, store, now: () => t, random: seedRandom(),
    emit: (type, payload) => { events.push({ type, ...payload }); }, policy: opts.policy,
    projectsOf: (p) => (p === "kit" ? [P1] : []), ...(opts.deps || {}),
  });
  events.length = 0;
  return { inv, members, store, events, mstore, clock: { get: () => t, set: (/** @type {number} */ v) => { t = v; }, tick: (/** @type {number} */ d) => { t += d; } } };
}
const tokenOf = (/** @type {string} */ link) => link.split("/join/")[1];
const decode = (/** @type {string} */ token) => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
/** Build a validly signed token with a custom payload (what a key holder could do). */
const forge = (/** @type {any} */ payload, kp = rootKp) => {
  const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${b}.${Buffer.from(kp.sign(Buffer.from(`${INVITE_TAG}\n${b}`))).toString("base64url")}`;
};

test("createInvite: token layout, link host and signed payload", async () => {
  const w = await world();
  const r = await w.inv.createInvite({ creator: "alex", role: "member" });
  assert.equal(r.link, `https://${NAME}/join/${r.token}`);
  assert.match(r.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const p = decode(r.token);
  assert.deepEqual(Object.keys(p), ["v", "id", "space", "sid", "role", "uses", "iat", "ttl"]);
  assert.deepEqual({ v: p.v, space: p.space, sid: p.sid, role: p.role, uses: p.uses, iat: p.iat, ttl: p.ttl }, { v: 1, space: NAME, sid: SID, role: "member", uses: 1, iat: T0, ttl: INVITE_DEFAULTS.ttl });
  assert.equal(r.id, p.id);
  assert.equal(w.events[0].type, "invite.created");
  assert.equal(JSON.stringify(w.events).includes(r.token), false, "no token in events");
  assert.equal(JSON.stringify(w.events).includes("sig"), false);
  // signature really covers the domain tag
  const [b, s] = r.token.split(".");
  const { verify, createPublicKey } = await import("node:crypto");
  const pk = createPublicKey({ key: rootKp.publicKey, format: "der", type: "spki" });
  assert.equal(verify(null, Buffer.from(`${INVITE_TAG}\n${b}`), pk, Buffer.from(s, "base64url")), true);
  assert.equal(verify(null, Buffer.from(b), pk, Buffer.from(s, "base64url")), false, "not valid without the tag");
});

test("link host can be a verified alias only", async () => {
  const w = await world();
  const r = await w.inv.createInvite({ creator: "alex", role: "member", alias: "App.Harlow-Legal.example" });
  assert.equal(r.link.startsWith("https://app.harlow-legal.example/join/"), true);
  assert.equal(await code(w.inv.createInvite({ creator: "alex", role: "member", alias: "evil.example" })), "bad_input");
});

test("who may invite whom, creator by creator", async () => {
  const w = await world({ policy: { managersInvite: true } });
  const ok = (/** @type {any} */ a) => w.inv.createInvite(a);
  const tempArgs = { scope: [P1], expires: T0 + 5 * DAY };
  // owner: admin, manager, member, temp; never owner
  for (const role of /** @type {const} */ (["admin", "manager", "member"])) assert.ok((await ok({ creator: "alex", role })).token);
  assert.ok((await ok({ creator: "alex", role: "temp", ...tempArgs })).token);
  assert.equal(await code(ok({ creator: "alex", role: "owner" })), "forbidden");
  // admin: manager, member, temp; never admin or owner
  for (const role of /** @type {const} */ (["manager", "member"])) assert.ok((await ok({ creator: "juno", role })).token);
  assert.ok((await ok({ creator: "juno", role: "temp", ...tempArgs })).token);
  assert.equal(await code(ok({ creator: "juno", role: "admin" })), "forbidden");
  assert.equal(await code(ok({ creator: "juno", role: "owner" })), "forbidden");
  // member and temp: nothing
  for (const c of ["mo", "tee"]) for (const role of /** @type {const} */ (["member", "manager", "admin"])) assert.equal(await code(ok({ creator: c, role })), "forbidden");
  assert.equal(await code(ok({ creator: "tee", role: "temp", ...tempArgs })), "forbidden");
  // outsiders
  assert.equal(await code(ok({ creator: "ghost", role: "member" })), "not_a_member");
});

test("manager may invite only if the policy allows, only member or temp, only inside their projects", async () => {
  const off = await world();
  assert.equal(await code(off.inv.createInvite({ creator: "kit", role: "member", scope: [P1] })), "forbidden");
  const w = await world({ policy: { managersInvite: true } });
  assert.ok((await w.inv.createInvite({ creator: "kit", role: "member", scope: [P1] })).token);
  assert.ok((await w.inv.createInvite({ creator: "kit", role: "member", scope: [`${P1}/task/t1`] })).token);
  assert.ok((await w.inv.createInvite({ creator: "kit", role: "temp", scope: [P1], expires: T0 + DAY })).token);
  assert.equal(await code(w.inv.createInvite({ creator: "kit", role: "member", scope: [P2] })), "forbidden", "not their project");
  assert.equal(await code(w.inv.createInvite({ creator: "kit", role: "member", scope: [P1, P2] })), "forbidden");
  assert.equal(await code(w.inv.createInvite({ creator: "kit", role: "member" })), "forbidden", "must name projects");
  assert.equal(await code(w.inv.createInvite({ creator: "kit", role: "temp", scope: [P2], expires: T0 + DAY })), "forbidden");
  assert.equal(await code(w.inv.createInvite({ creator: "kit", role: "manager", scope: [P1] })), "forbidden");
  assert.equal(await code(w.inv.createInvite({ creator: "kit", role: "admin" })), "forbidden");
  assert.equal(await code(w.inv.createInvite({ creator: "kit", role: "temp", scope: [`vyre://${SID}/project/intake-two`], expires: T0 + DAY })), "forbidden", "segment boundary");
});

test("invite shape rules: temp needs scope and expiry, others carry no end date", async () => {
  const w = await world();
  const c = "alex";
  assert.equal(await code(w.inv.createInvite({ creator: c, role: "temp" })), "bad_scope");
  assert.equal(await code(w.inv.createInvite({ creator: c, role: "temp", scope: [P1] })), "bad_scope");
  assert.equal(await code(w.inv.createInvite({ creator: c, role: "temp", expires: T0 + DAY })), "bad_scope");
  assert.equal(await code(w.inv.createInvite({ creator: c, role: "temp", scope: [P1], expires: T0 })), "expired");
  assert.equal(await code(w.inv.createInvite({ creator: c, role: "temp", scope: [P1], expires: T0 + 400 * DAY })), "bad_scope");
  assert.equal(await code(w.inv.createInvite({ creator: c, role: "member", expires: T0 + DAY })), "bad_scope");
  assert.equal(await code(w.inv.createInvite({ creator: c, role: "admin", scope: [P1] })), "bad_scope");
  assert.equal(await code(w.inv.createInvite({ creator: c, role: "manager", scope: [P1] })), "bad_scope");
  assert.equal(await code(w.inv.createInvite({ creator: c, role: "member", scope: ["nope"] })), "bad_scope");
  assert.equal(await code(w.inv.createInvite({ creator: c, role: "member", scope: /** @type {any} */ ("x") })), "bad_scope");
  assert.equal(await code(w.inv.createInvite({ creator: c, role: /** @type {any} */ ("boss") })), "bad_input");
  assert.equal(await code(w.inv.createInvite({ creator: c, role: "member", uses: 0 })), "bad_input");
  assert.equal(await code(w.inv.createInvite({ creator: c, role: "member", uses: 1.5 })), "bad_input");
  assert.equal(await code(w.inv.createInvite({ creator: c, role: "member", uses: 101 })), "bad_input");
  assert.equal(await code(w.inv.createInvite({ creator: c, role: "member", ttl: 0 })), "bad_input");
  assert.equal(await code(w.inv.createInvite({ creator: c, role: "member", ttl: 31 * DAY })), "bad_input");
  const t = decode((await w.inv.createInvite({ creator: c, role: "temp", scope: [P1], expires: T0 + DAY, uses: 3, ttl: DAY })).token);
  assert.deepEqual([t.scope, t.expires, t.uses, t.ttl], [[P1], T0 + DAY, 3, DAY]);
});

test("previewInvite returns only the card, verified against the pinned key", async () => {
  const w = await world();
  const r = await w.inv.createInvite({ creator: "juno", role: "temp", scope: [P1], expires: T0 + 5 * DAY });
  const pv = await previewInvite(r.token, { resolveSpace, now: T0 });
  assert.equal(pv.ok, true);
  const card = /** @type {any} */ (pv).card;
  assert.deepEqual(Object.keys(card).sort(), ["button", "label", "role", "role_label", "sees", "space", "valid_until"]);
  assert.equal(card.button, "Join Harlow Legal");
  assert.equal(card.role_label, "Temp");
  assert.deepEqual(card.sees, { scope: [P1], expires: T0 + 5 * DAY });
  const txt = JSON.stringify(card);
  for (const leak of [r.id, "juno", "uses", "inv_", "created"]) assert.equal(txt.includes(leak), false, leak);
  // renamed role labels and a label fallback
  const pv2 = await previewInvite(r.token, { resolveSpace: async () => identity({ label: undefined, displayNames: { temp: "Guest" } }), now: T0 });
  assert.equal(/** @type {any} */ (pv2).card.role_label, "Guest");
  assert.equal(/** @type {any} */ (pv2).card.button, "Join harlow");
  // the service wrapper also checks the store
  assert.equal((await w.inv.previewInvite(r.token, { resolveSpace })).ok, true);
});

test("previewInvite refusals: forged, wrong space, expired, revoked, used, junk", async () => {
  const w = await world();
  const r = await w.inv.createInvite({ creator: "alex", role: "member", ttl: DAY });
  const bad = async (/** @type {string} */ tok, /** @type {any} */ o = {}) => /** @type {any} */ (await previewInvite(tok, { resolveSpace, now: T0, ...o }));
  // signed by a different key: forged
  const other = keypair();
  const p = decode(r.token);
  const e1 = await bad(forge(p, other));
  assert.deepEqual([e1.ok, e1.code], [false, "forged"]);
  assert.match(e1.message, /could not be verified/);
  // payload edited, signature kept
  const [, s] = r.token.split(".");
  const e2 = await bad(`${Buffer.from(JSON.stringify({ ...p, role: "admin" })).toString("base64url")}.${s}`);
  assert.equal(e2.code, "forged");
  // role escalated to owner is malformed even if signed
  assert.equal((await bad(forge({ ...p, role: "owner" }))).code, "bad_input");
  // truncated / swapped signature
  assert.equal((await bad(r.token.slice(0, -4))).code, "forged");
  assert.equal((await bad(`${r.token.split(".")[0]}.${Buffer.alloc(64).toString("base64url")}`)).code, "forged");
  // unknown space, mismatched id, expected-name mismatch
  assert.equal((await bad(forge({ ...p, space: "nobody.vyre.run" }))).code, "wrong_space");
  assert.equal((await bad(forge({ ...p, sid: "spc_other" }))).code, "wrong_space");
  assert.equal((await bad(r.token, { expectName: "northwind.vyre.run" })).code, "wrong_space");
  assert.equal((await bad(r.token, { resolveSpace: async () => { throw new Error("net"); } })).code, "wrong_space");
  // root key pinned for another key: the real token no longer verifies
  assert.equal((await bad(r.token, { resolveSpace: async () => identity({ root_key: other.raw.toString("base64url") }) })).code, "forged");
  // clock edges: valid at iat+ttl-1, expired at iat+ttl
  assert.equal((await bad(r.token, { now: T0 + DAY - 1 })).ok, true);
  assert.equal((await bad(r.token, { now: T0 + DAY })).code, "expired");
  assert.equal((await bad(r.token, { now: T0 - 10 * 60 * 1000 })).code, "forged", "issued in the future");
  assert.equal((await bad(r.token, { now: T0 - 1000 })).ok, true, "small clock skew tolerated");
  // junk
  for (const junk of ["", "a.b", "x".repeat(10), "a.b.c", "!!.!!", `${"a".repeat(5000)}.sig`, /** @type {any} */ (null), /** @type {any} */ (42)]) assert.equal((await bad(junk)).code, "bad_input", String(junk).slice(0, 12));
  // revoked and used need the store
  await w.inv.revokeInvite({ actor: "alex", id: r.id });
  assert.equal((await bad(r.token, { store: w.store })).code, "revoked");
  assert.equal((await bad(r.token)).ok, true, "without a store, revocation is unknown");
  const r2 = await w.inv.createInvite({ creator: "alex", role: "member" });
  await w.inv.acceptInvite({ token: r2.token, person: person("p1"), proof: "" }).catch(() => {});
  const pe = person("p2");
  await w.inv.acceptInvite({ token: r2.token, person: pe, proof: pe.accept(r2.id) });
  assert.equal((await bad(r2.token, { store: w.store })).code, "used_up");
  // temp end passed
  const r3 = await w.inv.createInvite({ creator: "alex", role: "temp", scope: [P1], expires: T0 + 2000, ttl: DAY });
  assert.equal((await bad(r3.token, { now: T0 + 2000 })).code, "expired");
});

test("acceptInvite creates the membership and consumes a single-use invite atomically", async () => {
  const w = await world();
  const r = await w.inv.createInvite({ creator: "juno", role: "member" });
  const n = person("nina");
  const res = await w.inv.acceptInvite({ token: r.token, person: n, proof: n.accept(r.id) });
  assert.equal(res.membership.role, "member");
  assert.equal(res.membership.added_by, "juno");
  assert.equal((await w.members.get("nina"))?.role, "member");
  assert.deepEqual(w.events.map(e => e.type), ["invite.created", "invite.accepted"]);
  assert.equal(JSON.stringify(w.events).includes("publicKey"), false);
  // replay: same joiner, same proof
  assert.equal(await code(w.inv.acceptInvite({ token: r.token, person: n, proof: n.accept(r.id) })), "used_up");
  // another person with a valid proof of their own
  const m = person("max");
  assert.equal(await code(w.inv.acceptInvite({ token: r.token, person: m, proof: m.accept(r.id) })), "used_up");
  assert.equal(await w.members.get("max"), undefined);
});

test("two simultaneous accepts of a single-use invite: exactly one wins", async () => {
  const w = await world();
  const r = await w.inv.createInvite({ creator: "alex", role: "member" });
  const a = person("a1"); const b = person("b1");
  const out = await Promise.allSettled([
    w.inv.acceptInvite({ token: r.token, person: a, proof: a.accept(r.id) }),
    w.inv.acceptInvite({ token: r.token, person: b, proof: b.accept(r.id) }),
  ]);
  assert.equal(out.filter(o => o.status === "fulfilled").length, 1);
  assert.equal((await w.members.list()).filter(m => ["a1", "b1"].includes(m.person)).length, 1);
});

test("multi-use invites count uses and stop at the limit", async () => {
  const w = await world();
  const r = await w.inv.createInvite({ creator: "alex", role: "member", uses: 2 });
  for (const id of ["u1", "u2"]) { const p = person(id); await w.inv.acceptInvite({ token: r.token, person: p, proof: p.accept(r.id) }); }
  const p3 = person("u3");
  assert.equal(await code(w.inv.acceptInvite({ token: r.token, person: p3, proof: p3.accept(r.id) })), "used_up");
  const [rec] = await w.inv.listInvites({ actor: "alex" });
  assert.deepEqual([rec.used, rec.status], [2, "used"]);
});

test("a person already in the space gets a clear error and the use is not spent", async () => {
  const w = await world();
  const r = await w.inv.createInvite({ creator: "alex", role: "member", uses: 1 });
  const kitKey = person("kit");
  assert.equal(await code(w.inv.acceptInvite({ token: r.token, person: kitKey, proof: kitKey.accept(r.id) })), "duplicate");
  assert.equal((await w.members.get("kit"))?.role, "manager", "unchanged");
  const n = person("nina");
  assert.ok(await w.inv.acceptInvite({ token: r.token, person: n, proof: n.accept(r.id) }), "use still available");
});

test("a failed membership add gives the use back", async () => {
  const w = await world();
  const r = await w.inv.createInvite({ creator: "alex", role: "member" });
  const n = person("nina");
  const real = w.members.addMember;
  w.members.addMember = async () => { throw new SpacesError("bad_input", "boom"); };
  assert.equal(await code(w.inv.acceptInvite({ token: r.token, person: n, proof: n.accept(r.id) })), "bad_input");
  w.members.addMember = real;
  assert.ok(await w.inv.acceptInvite({ token: r.token, person: n, proof: n.accept(r.id) }));
});

test("accept proof: must be the joiner's signature over the exact message", async () => {
  const w = await world();
  const r = await w.inv.createInvite({ creator: "alex", role: "member", uses: 5 });
  const n = person("nina");
  const imposter = person("nina");
  const acc = (/** @type {any} */ a) => code(w.inv.acceptInvite({ token: r.token, ...a }));
  assert.equal(await acc({ person: n, proof: "" }), "bad_proof");
  assert.equal(await acc({ person: n, proof: imposter.accept(r.id) }), "bad_proof", "signed by a different key");
  assert.equal(await acc({ person: n, proof: n.accept(r.id, "northwind.vyre.run") }), "bad_proof", "bound to another space name");
  assert.equal(await acc({ person: n, proof: n.accept("inv_other0000000") }), "bad_proof", "bound to another invite");
  assert.equal(await acc({ person: person("nora"), proof: n.accept(r.id) }), "bad_proof", "bound to another person id");
  assert.equal(await acc({ person: { id: "nina", publicKey: Buffer.alloc(5) }, proof: n.accept(r.id) }), "bad_proof");
  assert.equal(await acc({ person: { id: "", publicKey: n.publicKey }, proof: n.accept(r.id) }), "bad_input");
  assert.equal(await acc({ person: null, proof: "x" }), "bad_input");
  assert.equal((await w.members.list()).some(m => m.person === "nina"), false);
  assert.ok(await w.inv.acceptInvite({ token: r.token, person: n, proof: n.accept(r.id) }));
});

test("the proof signature is raw Ed25519 and a 32-byte raw key is accepted", async () => {
  const w = await world();
  const r = await w.inv.createInvite({ creator: "alex", role: "member" });
  const n = person("nina");
  const res = await w.inv.acceptInvite({ token: r.token, person: { id: "nina", publicKey: n.kp.raw }, proof: n.accept(r.id) });
  assert.equal(res.membership.person, "nina");
});

test("person id binding is enforced when a derivation is supplied", async () => {
  const idOf = (/** @type {any} */ pk) => `per_${createHash("sha256").update(Buffer.from(pk)).digest("hex").slice(0, 26)}`;
  const w = await world({ deps: { personIdFromKey: idOf } });
  const r = await w.inv.createInvite({ creator: "alex", role: "member", uses: 3 });
  const kp = person("whatever");
  const good = person(idOf(kp.publicKey));
  const g2 = { id: idOf(kp.publicKey), publicKey: kp.publicKey, proof: Buffer.from(kp.kp.sign(acceptMessage(r.id, NAME, idOf(kp.publicKey)))).toString("base64url") };
  assert.equal(await code(w.inv.acceptInvite({ token: r.token, person: { id: "per_claimedsomeoneelse", publicKey: kp.publicKey }, proof: g2.proof })), "bad_proof");
  assert.ok(await w.inv.acceptInvite({ token: r.token, person: { id: g2.id, publicKey: g2.publicKey }, proof: g2.proof }));
  void good;
});

test("accept refusals: forged, wrong space, expired, temp end, future-dated, unknown", async () => {
  const w = await world();
  const r = await w.inv.createInvite({ creator: "alex", role: "member", ttl: DAY });
  const n = person("nina");
  const go = (/** @type {string} */ token, /** @type {any} */ extra = {}) => code(w.inv.acceptInvite({ token, person: n, proof: n.accept((() => { try { return decode(token).id; } catch { return r.id; } })()), ...extra }));
  const p = decode(r.token);
  assert.equal(await go(forge(p, keypair())), "forged");
  assert.equal(await go(forge({ ...p, space: "other.vyre.run" })), "wrong_space");
  assert.equal(await go(forge({ ...p, sid: "spc_other" })), "wrong_space");
  assert.equal(await go(forge({ ...p, role: "owner" })), "bad_input");
  assert.equal(await go(forge({ ...p, iat: T0 + DAY })), "forged");
  assert.equal(await go(r.token, { now: T0 + DAY }), "expired");
  assert.equal(await go("garbage"), "bad_input");
  // signed by the real key but never issued by this store
  assert.equal(await go(forge({ ...p, id: "inv_neverissued1" })), "revoked");
  // temp end passes before accept
  const t = await w.inv.createInvite({ creator: "alex", role: "temp", scope: [P1], expires: T0 + 1000, ttl: DAY });
  assert.equal(await code(w.inv.acceptInvite({ token: t.token, person: n, proof: n.accept(t.id), now: T0 + 1000 })), "expired");
  assert.equal(await code(w.inv.acceptInvite({ token: t.token, person: n, proof: n.accept(t.id), now: T0 + 999 })), null);
  // the clock is injected: accept at the exact end of ttl fails, one earlier works
  w.clock.set(T0 + DAY - 1);
  const r2 = await w.inv.createInvite({ creator: "alex", role: "member", ttl: 1000 });
  const m = person("mia");
  assert.equal(await code(w.inv.acceptInvite({ token: r2.token, person: m, proof: m.accept(r2.id), now: T0 + DAY + 998 })), null);
  assert.equal(await code(w.inv.acceptInvite({ token: r2.token, person: m, proof: m.accept(r2.id), now: T0 + DAY + 999 })), "expired");
});

test("temp invite becomes a temp membership with the invite's scope and end", async () => {
  const w = await world();
  const r = await w.inv.createInvite({ creator: "juno", role: "temp", scope: [P1], expires: T0 + 5 * DAY });
  const n = person("nina");
  const { membership } = await w.inv.acceptInvite({ token: r.token, person: n, proof: n.accept(r.id) });
  assert.deepEqual([membership.role, membership.scope, membership.expires], ["temp", [P1], T0 + 5 * DAY]);
});

test("a manager's member invite reports the projects to add, and a removed manager's invites stop working", async () => {
  const w = await world({ policy: { managersInvite: true } });
  const r = await w.inv.createInvite({ creator: "kit", role: "member", scope: [P1] });
  const r2 = await w.inv.createInvite({ creator: "kit", role: "member", scope: [P1] });
  const n = person("nina");
  const res = await w.inv.acceptInvite({ token: r.token, person: n, proof: n.accept(r.id) });
  assert.deepEqual(res.projects, [P1]);
  assert.equal(res.membership.scope, undefined);
  await w.members.removeMember({ actor: "alex", person: "kit" });
  const m = person("mia");
  assert.equal(await code(w.inv.acceptInvite({ token: r2.token, person: m, proof: m.accept(r2.id) })), "revoked");
});

test("an admin demoted after creating an invite cannot get people in as an admin-level invite", async () => {
  const w = await world();
  const r = await w.inv.createInvite({ creator: "alex", role: "admin" });
  await w.members.setRole({ actor: "alex", person: "alex", role: "owner" }).catch(() => {});
  // alex is the only owner: make a second owner so alex can step down
  await w.members.addMember({ actor: "alex", person: "o2", role: "owner", presence: {} });
  await w.members.setRole({ actor: "alex", person: "alex", role: "member" });
  const n = person("nina");
  assert.equal(await code(w.inv.acceptInvite({ token: r.token, person: n, proof: n.accept(r.id) })), "revoked");
});

test("revokeInvite: creator, owner, admin rules; idempotent; the invite then fails", async () => {
  const w = await world({ policy: { managersInvite: true } });
  const a = await w.inv.createInvite({ creator: "juno", role: "member" });
  const adminInv = await w.inv.createInvite({ creator: "alex", role: "admin" });
  assert.equal(await code(w.inv.revokeInvite({ actor: "mo", id: a.id })), "forbidden");
  assert.equal(await code(w.inv.revokeInvite({ actor: "juno", id: adminInv.id })), "forbidden", "admin cannot cancel an admin invite");
  assert.equal(await code(w.inv.revokeInvite({ actor: "ghost", id: a.id })), "not_a_member");
  assert.equal(await code(w.inv.revokeInvite({ actor: "juno", id: "inv_nope00000000" })), "unknown_invite");
  w.events.length = 0;
  assert.equal((await w.inv.revokeInvite({ actor: "juno", id: a.id })).status, "revoked");
  assert.equal((await w.inv.revokeInvite({ actor: "alex", id: a.id })).status, "revoked");
  assert.equal(w.events.filter(e => e.type === "invite.revoked").length, 1, "one event only");
  const n = person("nina");
  assert.equal(await code(w.inv.acceptInvite({ token: a.token, person: n, proof: n.accept(a.id) })), "revoked");
  await w.inv.revokeInvite({ actor: "alex", id: adminInv.id });
  const own = await w.inv.createInvite({ creator: "kit", role: "member", scope: [P1] });
  assert.equal((await w.inv.revokeInvite({ actor: "kit", id: own.id })).status, "revoked", "creator can cancel their own");
});

test("listInvites shows what the actor may manage and never a token", async () => {
  const w = await world({ policy: { managersInvite: true } });
  await w.inv.createInvite({ creator: "alex", role: "admin" });
  await w.inv.createInvite({ creator: "juno", role: "member" });
  await w.inv.createInvite({ creator: "kit", role: "member", scope: [P1] });
  assert.equal((await w.inv.listInvites({ actor: "alex" })).length, 3);
  assert.deepEqual((await w.inv.listInvites({ actor: "juno" })).map(r => r.role).sort(), ["member", "member"], "admin sees no admin invite");
  assert.deepEqual((await w.inv.listInvites({ actor: "kit" })).map(r => r.created_by), ["kit"]);
  assert.deepEqual(await w.inv.listInvites({ actor: "mo" }), []);
  assert.equal(await code(w.inv.listInvites({ actor: "ghost" })), "not_a_member");
  assert.equal(JSON.stringify(await w.inv.listInvites({ actor: "alex" })).includes("token"), false);
});

test("sweepInvites marks and reports expired invites once", async () => {
  const w = await world();
  const a = await w.inv.createInvite({ creator: "alex", role: "member", ttl: DAY });
  const b = await w.inv.createInvite({ creator: "alex", role: "member", ttl: 3 * DAY });
  const c = await w.inv.createInvite({ creator: "alex", role: "temp", scope: [P1], expires: T0 + 2 * DAY, ttl: 5 * DAY });
  w.events.length = 0;
  assert.deepEqual(await w.inv.sweepInvites(T0 + DAY - 1), []);
  const out = await w.inv.sweepInvites(T0 + DAY);
  assert.deepEqual(out.map(r => r.id), [a.id]);
  assert.deepEqual((await w.inv.sweepInvites(T0 + 2 * DAY)).map(r => r.id), [c.id], "temp end counts");
  assert.deepEqual(await w.inv.sweepInvites(T0 + 2 * DAY), []);
  assert.deepEqual(w.events.map(e => e.type), ["invite.expired", "invite.expired"]);
  const n = person("nina");
  assert.equal(await code(w.inv.acceptInvite({ token: a.token, person: n, proof: n.accept(a.id), now: T0 + DAY - 1 })), "expired", "marked expired stays expired");
  assert.ok(b.id);
  // listing reflects expiry without a sweep too
  w.clock.set(T0 + 4 * DAY);
  assert.equal((await w.inv.listInvites({ actor: "alex" })).find(r => r.id === b.id)?.status, "expired");
});

test("parseJoinLink accepts names and aliases and refuses anything risky", () => {
  const tok = "abc_DEF-1.sig_x-9";
  assert.deepEqual(parseJoinLink(`https://harlow.vyre.run/join/${tok}`), { host: NAME, name: NAME, alias: false, token: tok });
  assert.deepEqual(parseJoinLink(`https://HARLOW.vyre.run/join/${tok}`).host, NAME);
  const a = parseJoinLink(`https://app.harlow-legal.example/join/${tok}`, { aliases: { "app.harlow-legal.example": NAME } });
  assert.deepEqual([a.alias, a.name], [true, NAME]);
  assert.equal(parseJoinLink(`https://app.harlow-legal.example/join/${tok}`, { aliases: ["app.harlow-legal.example"] }).alias, true);
  const bad = [
    `http://harlow.vyre.run/join/${tok}`, `ftp://harlow.vyre.run/join/${tok}`, `javascript:alert(1)`,
    `https://alex:pw@harlow.vyre.run/join/${tok}`, `https://alex@harlow.vyre.run/join/${tok}`,
    `https://harlow.vyre.run/join/${tok}?token=abc`, `https://harlow.vyre.run/join/${tok}?x=1`, `https://harlow.vyre.run/join/${tok}#frag`,
    `https://harlow.vyre.run:8443/join/${tok}`, `https://evil.example/join/${tok}`, `https://harlow.vyre.run.evil.example/join/${tok}`,
    `https://a.b.vyre.run/join/${tok}`, `https://vyre.run/join/${tok}`, `https://harlow.vyre.run/join/`, `https://harlow.vyre.run/join/${tok}/extra`,
    `https://harlow.vyre.run/other/${tok}`, `https://harlow.vyre.run/join/${tok}%2f`, `https://harlow.vyre.run/join/notoken`, "not a url", "",
  ];
  for (const u of bad) assert.throws(() => parseJoinLink(u), (/** @type {any} */ e) => e instanceof SpacesError && e.code === "bad_input", u);
  assert.throws(() => parseJoinLink(`https://app.harlow-legal.example/join/${tok}`), SpacesError, "alias not listed");
});

test("a link made by createInvite round-trips through parseJoinLink, preview and accept", async () => {
  const w = await world();
  const r = await w.inv.createInvite({ creator: "alex", role: "member", alias: "app.harlow-legal.example" });
  const parsed = parseJoinLink(r.link, { aliases: { "app.harlow-legal.example": NAME } });
  assert.equal(parsed.token, r.token);
  const pv = await previewInvite(parsed.token, { resolveSpace, expectName: parsed.name, now: T0 });
  assert.equal(pv.ok, true);
  const n = person("nina");
  assert.ok(await w.inv.acceptInvite({ token: parsed.token, person: n, proof: n.accept(r.id) }));
});

test("ids are drawn from the injected randomness", async () => {
  const w = await world();
  const a = await w.inv.createInvite({ creator: "alex", role: "member" });
  const b = await w.inv.createInvite({ creator: "alex", role: "member" });
  assert.notEqual(a.id, b.id);
  assert.equal(a.id, `inv_${Buffer.alloc(12, 1).toString("base64url")}`);
});

test("an alias-bearing identity pinned by hash-free raw key still verifies with root_public_key", async () => {
  const w = await world();
  const r = await w.inv.createInvite({ creator: "alex", role: "member" });
  const pv = await previewInvite(r.token, { resolveSpace: async () => identity({ root_key: "hash-of-key", root_public_key: rootKp.publicKey.toString("base64url") }), now: T0 });
  assert.equal(pv.ok, true);
});
