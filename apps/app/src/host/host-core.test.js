import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHost, seedIsDeviceOnChain } from "./host-core.js";
import { fromSeed } from "../identity/keys.js";
import { actMessage } from "../../../../names/worker/id-messages.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createLoginService } from "../../../../kernel/identity/space-login.js";
import { world, BASE } from "../../../../names/worker/testing.js";
import worker from "../../../../names/worker/index.js";
import { who } from "../../../../names/worker/testing.js";
import { claimServerSpace } from "../identity/claim-space.js";

const FAST = { memoryKiB: 64, passes: 2 };
const PASSWORD = "correct horse battery staple";

/** A fetch that is the names Worker itself (the same code the directory runs), so a claim here is checked by the real server side. */
function directory(t) {
  const w = world(t);
  const fetchIn = async (url, init = {}) => {
    const u = new URL(url);
    const headers = new Headers(init.headers || {});
    headers.set("cf-connecting-ip", "203.0.113.9");
    return worker.fetch(new Request(`${BASE}${u.pathname}${u.search}`, { method: init.method || "GET", headers, body: init.body }), w.env);
  };
  return { fetch: fetchIn, base: BASE, now: () => w.clock.t, w };
}

const memoryStore = () => { let kept = null; return { load: async () => (kept ? structuredClone(kept) : null), save: async (k) => { kept = structuredClone(k); }, peek: () => kept }; };

test("first run on a page with no daemon: create an identity, lock, and open it again, against the real names Worker", async (t) => {
  const d = directory(t);
  const store = memoryStore();
  const host = createHost({ store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST });
  assert.deepEqual(await host.call("identity.status"), { exists: false, unlocked: false, username: null, id: null, url: null, private: true, github: null, needsMigration: false });
  assert.deepEqual(await host.call("onboard.status"), { firstRun: "open", person: null });

  const made = await host.call("onboard.person.create", { username: "alex", password: PASSWORD, confirm: PASSWORD });
  assert.equal(made.username, "alex");
  assert.match(made.id, /^per_[a-z2-7]{26}$/);
  assert.match(made.recoveryKey, /^([a-z2-7]{4}-){6}[a-z2-7]{2}$/);
  assert.equal(made.once, true);
  assert.equal(made.route, "https://vyre.run/u/alex");
  assert.equal((await host.call("identity.status")).unlocked, true);

  // What was kept is wrapped bytes and public records, never a key and never the password or the recovery key.
  const kept = JSON.stringify(store.peek());
  assert.ok(!kept.includes(PASSWORD) && !kept.includes(made.recoveryKey));
  assert.equal(typeof store.peek().master.passwordWrap.ct, "string");
  assert.match(store.peek().device.pub, /^[A-Za-z0-9_-]{43}$/, "a device key was made, and kept only wrapped");
  assert.deepEqual(Object.keys(store.peek().device.wrapped).sort(), ["ct", "iv"]);

  const again = await host.call("onboard.person.create", { username: "alex", password: PASSWORD, confirm: PASSWORD });
  assert.deepEqual([again.already, again.recoveryKey], [true, null]);

  await host.call("identity.lock");
  assert.equal((await host.call("identity.status")).unlocked, false);
  assert.equal(host.signer(), null);
  await assert.rejects(() => host.call("identity.unlock", { password: "zebra quartz mango pillow" }), (e) => e.code === "bad_password");
  assert.equal((await host.call("identity.status")).unlocked, false);
  await host.call("identity.unlock", { password: PASSWORD });
  assert.equal((await host.call("identity.status")).unlocked, true);
  assert.ok(host.signer());
  // the unlock screen asks the vault to take the key right after a good password: a page answers that there is none, instead of failing the unlock
  assert.equal(host.has("identity.vault.install"), true);
  assert.deepEqual(await host.call("identity.vault.install", {}), { installed: false, reason: "no_vault" });
  await host.call("identity.lock");
  await host.call("identity.unlock", { recovery: made.recoveryKey.toUpperCase() });
  assert.equal((await host.call("identity.status")).unlocked, true);
});

test("the checks the daemon makes: a bad username, a weak or mismatched password, a taken name, and a secret never needed by a stranger", async (t) => {
  const d = directory(t);
  const host = createHost({ store: memoryStore(), directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST });
  await assert.rejects(() => host.call("onboard.person.create", { username: "ab", password: PASSWORD }), /lowercase letters/);
  await assert.rejects(() => host.call("onboard.person.create", { username: "alex", password: "short" }), /at least 12/);
  await assert.rejects(() => host.call("onboard.person.create", { username: "alex", password: PASSWORD, confirm: "other" }), /same way twice/);
  await host.call("onboard.person.create", { username: "alex", password: PASSWORD, confirm: PASSWORD });
  const second = createHost({ store: memoryStore(), directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST });
  await assert.rejects(() => second.call("onboard.person.create", { username: "alex", password: PASSWORD, confirm: PASSWORD }), (e) => /taken/.test(e.message) || e.code === "name_taken");
  await assert.rejects(() => second.call("identity.unlock", {}), (e) => e.code === "person_enters");
  await assert.rejects(() => second.call("identity.unlock", { password: PASSWORD }), (e) => e.code === "no_identity");
});

test("first-run progress and done are kept with the identity, and a step this stage does not have says so", async (t) => {
  const d = directory(t);
  const host = createHost({ store: memoryStore(), directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST });
  await host.call("onboard.person.create", { username: "blair", password: PASSWORD, confirm: PASSWORD });
  await host.call("onboard.first.progress.save", { screen: "space.choice", stack: ["id.create", "space.choice"] });
  assert.deepEqual(await host.call("onboard.first.progress"), { ok: true, screen: "space.choice", stack: ["id.create", "space.choice"] });
  assert.equal((await host.call("onboard.status")).firstRun, "open");
  await host.call("onboard.first.done");
  assert.equal((await host.call("onboard.status")).firstRun, "done");
  assert.equal(host.has("onboard.space.open"), false);
  await assert.rejects(() => host.call("onboard.space.open", { kind: "linux" }), (e) => e.code === "host_unsupported");
});

/** A space's sign-in door over the names Worker: POST /login is the server module itself (createLoginService), everything else is the directory. */
function spaceWorld(t) {
  const d = directory(t);
  const rec = new Map();
  const SPACE_ROW = (role) => [{ id: "spc_juniperaaaaaaaa", name: "juniper", role, server: "https://juniper.vyre.run" }];
  const svc = createLoginService({ space: "juniper", store: { get: (k) => rec.get(k), set: (k, v) => rec.set(k, v) }, now: d.now, verifyIdentity: async () => true, isMember: async () => true, describe: async () => ({ role: "member", spaces: SPACE_ROW("member") }) });
  const posts = [];
  const fetchAll = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === "juniper.vyre.run" && u.pathname === "/login") {
      assert.equal(init.headers["content-type"], "text/plain", "text/plain keeps the browser from sending a preflight");
      const body = JSON.parse(init.body);
      posts.push(body);
      const out = body.op === "begin" ? svc.begin(body, "203.0.113.5") : body.op === "finish" ? await svc.finish(body, "203.0.113.5")
        // GitHub (the relay's assertion for this space, stood in by a fixed string here): the record comes back with its salt and cost, to be opened with the password on the device.
        : body.op === "github" ? (body.assertion === "assert:juniper" ? { ok: true, session: "s", salt: rec.get("login:alex").salt, kdf: rec.get("login:alex").kdf, bundle: rec.get("login:alex").bundle, role: "admin", spaces: SPACE_ROW("admin") } : { error: { code: "bad_login", message: "That username and password do not match." } })
        : await svc.register(body).catch((e) => ({ error: { code: e.code, message: e.message } }));
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }
    // The names directory's list of a GitHub-linked username's spaces, given only to a valid assertion for "names".
    if (u.pathname === "/v1/ids/spaces") return new Response(JSON.stringify(JSON.parse(init.body).assertion === "assert:names" ? { data: { username: "alex", spaces: [{ name: "juniper", address: "juniper.vyre.run" }] } } : { error: { code: "bad_login" } }), { status: JSON.parse(init.body).assertion === "assert:names" ? 200 : 403 });
    return d.fetch(url, init);
  };
  return { ...d, fetch: fetchAll, svc, posts, rec };
}

test("sign in from another device: register the record at a space, then a new page with nothing on it signs in with the address, the username and the password", { timeout: 240000 }, async (t) => {
  const w = spaceWorld(t);
  // Device one makes the identity at the production cost (the record's password key and the login key are one Argon2id of the password).
  const one = createHost({ store: memoryStore(), directory: w.base, fetch: w.fetch, now: w.now });
  const made = await one.call("onboard.person.create", { username: "alex", password: PASSWORD, confirm: PASSWORD });
  const body = await one.registerLogin("juniper", PASSWORD);
  assert.equal(JSON.stringify(body).includes(PASSWORD), false, "the password is not in the registration");
  assert.deepEqual((await w.svc.register(body)), { ok: true, username: "alex" });

  // Device two: nothing on it.
  const store2 = memoryStore();
  const two = createHost({ store: store2, directory: w.base, fetch: w.fetch, now: w.now });
  await assert.rejects(() => two.call("onboard.signin", { space: "juniper.vyre.run", username: "alex", password: "zebra quartz mango pillow staple" }), (e) => e.code === "bad_login" && e.message === "That username and password do not match.");
  await assert.rejects(() => two.call("onboard.signin", { space: "juniper.vyre.run", username: "nobody", password: PASSWORD }), (e) => e.code === "bad_login" && e.message === "That username and password do not match.", "an unknown name gets the same answer");
  assert.equal(await store2.load(), null, "a refused sign-in leaves nothing on the device");
  const signed = await two.call("onboard.signin", { space: "juniper.vyre.run", username: "alex", password: PASSWORD });
  assert.deepEqual([signed.username, signed.id], ["alex", made.id]);
  assert.equal(signed.spaces[0].name, "juniper");
  assert.deepEqual(Object.keys(signed.spaces[0]).sort(), ["id", "name", "role", "server"], "a signed-in space is the same row as a created one: id, name, role, server");
  assert.equal(signed.spaces[0].id, "spc_juniperaaaaaaaa", "the id is the space's own (spc_), not its name");
  assert.equal(signed.spaces[0].server, "https://juniper.vyre.run");
  assert.equal((await two.call("identity.status")).unlocked, true);
  const kept = await store2.load();
  assert.equal(kept.id, made.id);
  assert.ok(kept.device && kept.ops.length >= 1 && kept.pin, "a device key, and the identity's checked chain");
  assert.ok(!JSON.stringify(kept).includes(PASSWORD));
  // The same identity key opens: the identity seeds of both devices sign the same public key.
  await two.call("identity.lock");
  await two.call("identity.unlock", { password: PASSWORD });
  assert.ok(two.signer());
  assert.equal(w.posts.filter((p) => p.op === "finish").every((p) => !JSON.stringify(p).includes(PASSWORD)), true, "the password never went to the space");
  // A device that already has an identity does not take a second one.
  await assert.rejects(() => two.call("onboard.signin", { space: "juniper.vyre.run", username: "alex", password: PASSWORD }), (e) => e.code === "exists");
});

test("a hostile space that asks for cheap password settings is refused before any password work", async (t) => {
  const d = directory(t);
  const fetchCheap = async (url, init = {}) => {
    if (new URL(url).host === "juniper.vyre.run") return new Response(JSON.stringify({ salt: "AAAAAAAAAAAAAAAAAAAAAA", kdf: { memoryKiB: 8, passes: 1, lanes: 1, tagLength: 32 }, challenge: "c", expires: 1 }), { status: 200 });
    return d.fetch(url, init);
  };
  const host = createHost({ store: memoryStore(), directory: d.base, fetch: fetchCheap, now: d.now });
  await assert.rejects(() => host.call("onboard.signin", { space: "juniper.vyre.run", username: "alex", password: PASSWORD }), (e) => e.code === "bad_kdf");
});

test("sign in with GitHub: the directory lists the spaces for a valid assertion, the password is asked once, and the bundle opens on the device", { timeout: 240000 }, async (t) => {
  const w = spaceWorld(t);
  const one = createHost({ store: memoryStore(), directory: w.base, fetch: w.fetch, now: w.now });
  const made = await one.call("onboard.person.create", { username: "alex", password: PASSWORD, confirm: PASSWORD });
  await w.svc.register(await one.registerLogin("juniper", PASSWORD));
  const asked = [];
  const github = { start: async () => ({ ok: true, session: { ticket: "t", cv: "c" }, user: { id: 7, login: "alexg" } }), assert: async (_s, audience) => { asked.push(audience); return `assert:${audience}`; } };
  const store = memoryStore();
  const two = createHost({ store, directory: w.base, fetch: w.fetch, now: w.now, github });
  const found = await two.call("onboard.signin.github");
  assert.equal(found.login, "alex");
  assert.deepEqual(found.spaces.map((x) => x.name), ["juniper"]);
  assert.equal(await store.load(), null, "nothing is kept until the password opens the bundle");
  await assert.rejects(() => two.call("onboard.signin.unlock", { password: "zebra quartz mango pillow staple" }), (e) => e.code === "bad_password");
  assert.equal(await store.load(), null);
  const opened = await two.call("onboard.signin.unlock", { password: PASSWORD });
  assert.deepEqual([opened.username, opened.id], ["alex", made.id]);
  assert.equal(opened.spaces[0].role, "admin");
  assert.deepEqual(asked, ["names", "juniper", "juniper"], "an assertion for the directory, then one per space and per try");
  assert.equal((await two.call("identity.status")).unlocked, true);
  assert.ok(!JSON.stringify(await store.load()).includes(PASSWORD));
  assert.equal(w.posts.some((p) => JSON.stringify(p).includes(PASSWORD)), false);
});

test("GitHub sign-in with no directory list asks for a space address, and a cancelled GitHub window says so in the words and keeps nothing", async (t) => {
  const w = spaceWorld(t);
  const bad = createHost({ store: memoryStore(), directory: w.base, fetch: w.fetch, now: w.now, github: { start: async () => ({ ok: true, session: {}, user: { id: 1, login: "x" } }), assert: async () => "wrong" } });
  // The directory refuses the assertion (not linked) and no space address was typed: there is nothing to log in to, and the words ask for the address.
  await assert.rejects(() => bad.call("onboard.signin.github"), (e) => e.code === "needs_space" && /address of a space/.test(e.message));
  const cancelled = createHost({ store: memoryStore(), directory: w.base, fetch: w.fetch, now: w.now, github: { start: async () => ({ ok: false, code: "denied" }), assert: async () => "x" } });
  await assert.rejects(() => cancelled.call("onboard.signin.github"), (e) => e.code === "denied" && /cancelled/.test(e.message));
  await assert.rejects(() => cancelled.call("onboard.signin.unlock", { password: PASSWORD }), (e) => e.code === "expired");
});

test("a record whose identity key is not a device key on the person's chain is refused", async () => {
  const seed = new Uint8Array(32).fill(7);
  const key = await fromSeed(seed);
  assert.equal(await seedIsDeviceOnChain(seed, [{ eid: key.eid, kind: "device" }, { eid: "other", kind: "code" }]), true);
  assert.equal(await seedIsDeviceOnChain(seed, [{ eid: key.eid, kind: "code" }]), false, "a recovery entry is not a device");
  assert.equal(await seedIsDeviceOnChain(seed, [{ eid: "someone-else", kind: "device" }]), false);
  assert.equal(await seedIsDeviceOnChain(seed, []), false);
  assert.equal(await seedIsDeviceOnChain(seed, /** @type {any} */ (null)), false);
});

test("GitHub sign-in with no directory list uses the one space address the person typed", { timeout: 240000 }, async (t) => {
  const w = spaceWorld(t);
  const one = createHost({ store: memoryStore(), directory: w.base, fetch: w.fetch, now: w.now });
  await one.call("onboard.person.create", { username: "alex", password: PASSWORD, confirm: PASSWORD });
  await w.svc.register(await one.registerLogin("juniper", PASSWORD));
  const noList = async (url, init) => (new URL(url).pathname === "/v1/ids/spaces" ? new Response("{}", { status: 404 }) : w.fetch(url, init));
  const github = { start: async () => ({ ok: true, session: { ticket: "t", cv: "c" }, user: { id: 7, login: "alexg" } }), assert: async (_s, audience) => `assert:${audience}` };
  const two = createHost({ store: memoryStore(), directory: w.base, fetch: noList, now: w.now, github });
  await assert.rejects(() => two.call("onboard.signin.github", {}), (e) => e.code === "needs_space" && /address of a space/.test(e.message));
  const found = await two.call("onboard.signin.github", { space: "juniper.vyre.run" });
  assert.deepEqual(found.spaces.map((x) => x.name), ["juniper"]);
  const opened = await two.call("onboard.signin.unlock", { password: PASSWORD });
  assert.equal(opened.username, "alex");
});

test("publishing a space to the directory is an act the identity key signs, and sign-in sends one stable device id", { timeout: 240000 }, async (t) => {
  const w = spaceWorld(t);
  const posted = [];
  const fetchSeen = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.startsWith("/v1/ids/spaces/")) { posted.push({ path: u.pathname, body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); }
    return w.fetch(url, init);
  };
  const store = memoryStore();
  const host = createHost({ store, directory: w.base, fetch: fetchSeen, now: w.now, kdf: FAST });
  await assert.rejects(() => host.publishSpace("juniper"), (e) => e.code === "no_identity");
  await host.call("onboard.person.create", { username: "alex", password: PASSWORD, confirm: PASSWORD });
  const r = await host.publishSpace("juniper");
  assert.equal(r.address, "juniper.vyre.run");
  await host.publishSpace("juniper.vyre.run", "remove");
  assert.deepEqual(posted.map((p) => p.path), ["/v1/ids/spaces/add", "/v1/ids/spaces/remove"]);
  const add = posted[0].body;
  assert.deepEqual([add.name, add.address], ["alex", "juniper.vyre.run"]);
  const kept = await store.load();
  const entry = (await (async () => { const C = await import("../../../../kernel/identity/chain.js"); return (await C.verifyChain(kept.ops, { now: w.now() })).entries.find((e) => e.eid === add.act.by); })());
  assert.ok(entry && entry.kind === "device", "signed by a device key on the person's chain");
  const msg = actMessage({ action: "space-add", name: "alex", domain: "juniper.vyre.run", ts: add.act.ts });
  assert.equal(ed25519.verify(Buffer.from(add.act.sig, "base64url"), msg, Buffer.from(entry.pub, "base64url")), true);
  await assert.rejects(() => host.publishSpace("not an address"), /not a space address/);
  await host.call("identity.lock");
  await assert.rejects(() => host.publishSpace("juniper"), (e) => e.code === "locked");

  // sign-in carries a stable device id, and only a well-formed one.
  const seen = [];
  const peek = async (url, init = {}) => { if (new URL(url).pathname === "/login") { const b = JSON.parse(init.body); if (b.op === "finish") seen.push(b.device); } return w.fetch(url, init); };
  const one = createHost({ store: memoryStore(), directory: w.base, fetch: w.fetch, now: w.now });
  await one.call("onboard.person.create", { username: "blair", password: PASSWORD, confirm: PASSWORD });
  await w.svc.register(await one.registerLogin("juniper", PASSWORD));
  const two = createHost({ store: memoryStore(), directory: w.base, fetch: peek, now: w.now, signin: { deviceId: () => "abcdef0123456789" } });
  await two.call("onboard.signin", { space: "juniper.vyre.run", username: "blair", password: PASSWORD });
  assert.deepEqual(seen, [{ id: "abcdef0123456789", label: "This browser" }]);
});

test("a space that does not say which space it is gets no row, and nothing is kept", { timeout: 240000 }, async (t) => {
  const w = spaceWorld(t);
  const one = createHost({ store: memoryStore(), directory: w.base, fetch: w.fetch, now: w.now });
  await one.call("onboard.person.create", { username: "alex", password: PASSWORD, confirm: PASSWORD });
  await w.svc.register(await one.registerLogin("juniper", PASSWORD));
  const noSpace = async (url, init = {}) => (new URL(url).pathname === "/login" ? new Response(JSON.stringify(w.svc.finish ? await (async () => { const b = JSON.parse(init.body); if (b.op === "begin") return w.svc.begin(b, "203.0.113.5"); const r = await w.svc.finish(b, "203.0.113.5"); const { spaces: _s, ...bare } = r; return bare; })() : {}), { status: 200 }) : w.fetch(url, init));
  const store = memoryStore();
  const two = createHost({ store, directory: w.base, fetch: noSpace, now: w.now });
  await assert.rejects(() => two.call("onboard.signin", { space: "juniper.vyre.run", username: "alex", password: PASSWORD }), (e) => e.code === "bad_space");
  assert.equal(await store.load(), null);
});

test("a browser with no Ed25519 and no fallback is told in plain words, not given the chain's sentence", async (t) => {
  const d = directory(t);
  const real = (await import("node:crypto")).webcrypto;
  const refuse = () => Object.assign(new Error("Algorithm: Unrecognized name"), { name: "NotSupportedError" });
  const before = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const subtle = { digest: (...a) => real.subtle.digest(...a), importKey: async (f, data, algo, ...r) => { if (String(algo.name || algo).toUpperCase() === "ED25519") throw refuse(); return real.subtle.importKey(f, data, algo, ...r); }, verify: async () => { throw refuse(); } };
  Object.defineProperty(globalThis, "crypto", { value: { subtle, getRandomValues: (a) => real.getRandomValues(a) }, configurable: true });
  try {
    const host = createHost({ store: memoryStore(), directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST });
    await assert.rejects(() => host.call("onboard.person.create", { username: "alex", password: PASSWORD, confirm: PASSWORD }), (e) => e.code === "browser_too_old" && e.message === "This browser is too old for Vyre. Update it, or use the Vyre app.");
    await assert.rejects(() => host.call("onboard.signin", { space: "juniper.vyre.run", username: "alex", password: PASSWORD }), (e) => e.code === "browser_too_old");
  } finally { if (before) Object.defineProperty(globalThis, "crypto", before); }
});

/** A real P-256 point, as an agree key makes one: 0x04 || x || y, base64url. */
async function agreePointOf() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))).toString("base64url");
}
const chainEntry = async (d, name) => {
  const r = await (await d.fetch(`${d.base}/v1/ids/resolve?name=${name}`)).json();
  const C = await import("../../../../kernel/identity/chain.js");
  const state = await C.verifyChain(r.data.ops, { now: d.now() });
  return { ops: r.data.ops, entry: state.entries.find((e) => e.kind === "device") };
};

test("a fresh identity's genesis device entry carries the device's key-agreement point, so chats can be wrapped to it", async (t) => {
  const d = directory(t);
  const point = await agreePointOf();
  const host = createHost({ store: memoryStore(), directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST, agreePoint: async () => point });
  await host.call("onboard.person.create", { username: "agnes", password: PASSWORD, confirm: PASSWORD });
  const { entry } = await chainEntry(d, "agnes");
  assert.equal(entry.agree, point);
});

test("an identity made without a key-agreement point (v0.6.1) is repaired when it is unlocked: the device signs the chain's own agree op for itself, once", async (t) => {
  const d = directory(t);
  const store = memoryStore();
  const old = createHost({ store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST });
  await old.call("onboard.person.create", { username: "olga", password: PASSWORD, confirm: PASSWORD });
  assert.equal((await chainEntry(d, "olga")).entry.agree, undefined, "made the old way: no agree");

  const point = await agreePointOf();
  const fresh = createHost({ store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST, agreePoint: async () => point });
  await fresh.call("identity.unlock", { password: PASSWORD });
  for (let i = 0; i < 100 && (await chainEntry(d, "olga")).entry.agree === undefined; i++) await new Promise((r) => setTimeout(r, 20));
  const after = await chainEntry(d, "olga");
  assert.equal(after.entry.agree, point, "the entry now has the point");
  assert.equal(after.ops.length, 2, "one agree op was appended");
  assert.equal(after.ops[1].type, "agree");
  assert.equal(store.peek().ops.length, 2, "the kept copy of the chain follows");

  // unlocking again changes nothing: the point is set once
  await fresh.call("identity.lock");
  await fresh.call("identity.unlock", { password: PASSWORD });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await chainEntry(d, "olga")).ops.length, 2);

  // a page with no agree key leaves the old identity as it was
  const none = createHost({ store: memoryStore(), directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST });
  await none.call("onboard.person.create", { username: "nina", password: PASSWORD, confirm: PASSWORD });
  await none.call("identity.lock"); await none.call("identity.unlock", { password: PASSWORD });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await chainEntry(d, "nina")).ops.length, 1);
});

test("a Space named before its server was listed (v0.6.1) is listed when its owner unlocks: the server's route may then ask for the name, and it is done once", async (t) => {
  const d = directory(t);
  const store = memoryStore();
  const host = createHost({ store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST });
  const made = await host.call("onboard.person.create", { username: "tessa", password: PASSWORD, confirm: PASSWORD });
  const box = who(d.w);
  // the name is claimed the old way: the record carries no listing (no route given to the claim), and the app kept the paired server's route beside the Space row
  const dev = await fromSeed(host.signer().seed);
  const me = { id: made.id, name: "tessa", eid: dev.eid, ops: store.peek().ops, key: dev };
  await claimServerSpace({ identity: me, name: "tess", base: d.base, fetch: d.fetch, now: d.now, host: async () => ({ space: "spc_" + "abcdefghijkl", rootPublic: Buffer.alloc(32, 7).toString("base64url") }) });
  assert.equal((await box.get("/v1/names/mine")).json.data.name, null, "listed with nothing: the box's route serves nothing");
  const kept = store.peek();
  await store.save({ ...kept, spaces: [{ id: "spc_abcdefghijkl", name: "tess", role: "owner", server: "https://tess.vyre.run", paired: { box: "bx", route: box.route, relay: "https://relay.example", name: "the test box" } }] });
  await host.call("identity.lock");
  await host.call("identity.unlock", { password: PASSWORD });
  for (let i = 0; i < 100 && (await box.get("/v1/names/mine")).json.data.name === null; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await box.get("/v1/names/mine")).json.data.name, "tess", "the server is listed: its route serves tess");
  assert.equal(store.peek().listed.tess, box.route, "kept, so it is done once");
  await host.call("identity.lock");
  await host.call("identity.unlock", { password: PASSWORD });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(store.peek().listed.tess, box.route);
  assert.ok(made.id);
});

test("a Space whose paired route was never kept is listed with the route the paired server itself reports, and only a well-formed one is taken", async (t) => {
  const d = directory(t);
  const store = memoryStore();
  const asked = [];
  let answer = { route: "not a route" };
  const space = { load: async () => ({ call: async (tool, input, box) => { asked.push([tool, box]); return answer; } }) };
  const host = createHost({ store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST, space });
  const made = await host.call("onboard.person.create", { username: "tessb", password: PASSWORD, confirm: PASSWORD });
  const box = who(d.w);
  const dev = await fromSeed(host.signer().seed);
  await claimServerSpace({ identity: { id: made.id, name: "tessb", eid: dev.eid, ops: store.peek().ops, key: dev }, name: "teamb", base: d.base, fetch: d.fetch, now: d.now, host: async () => ({ space: "spc_" + "abcdefghijkl", rootPublic: Buffer.alloc(32, 7).toString("base64url") }) });
  await store.save({ ...store.peek(), spaces: [{ id: "spc_abcdefghijkl", name: "teamb", role: "owner", server: "https://teamb.vyre.run", paired: { box: "bx-1", route: "", relay: "https://relay.example", name: "the test box" } }] });
  await host.call("identity.lock");
  await host.call("identity.unlock", { password: PASSWORD });
  for (let i = 0; i < 100 && asked.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(asked, [["relay.status", "bx-1"]], "the paired server was asked, by its own box id");
  assert.equal((await box.get("/v1/names/mine")).json.data.name, null, "a malformed answer lists nothing");
  assert.equal(store.peek().listed, undefined);
  answer = { route: box.route };
  await host.call("identity.lock");
  await host.call("identity.unlock", { password: PASSWORD });
  for (let i = 0; i < 100 && (await box.get("/v1/names/mine")).json.data.name === null; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await box.get("/v1/names/mine")).json.data.name, "teamb", "the route the server reported is listed");
  assert.equal(store.peek().listed.teamb, box.route);
});

/** An owner whose Space "tess" was claimed the old way (the directory lists no server for it), with the Space row kept on this page as paired with the test box. */
async function oldSpace(t, username, o = {}) {
  const d = directory(t);
  const store = memoryStore();
  const host = createHost({ store, directory: d.base, fetch: o.fetch ? o.fetch(d.fetch) : d.fetch, now: d.now, kdf: FAST, ...(o.space ? { space: o.space } : {}) });
  const made = await host.call("onboard.person.create", { username, password: PASSWORD, confirm: PASSWORD });
  const box = who(d.w);
  const dev = await fromSeed(host.signer().seed);
  await claimServerSpace({ identity: { id: made.id, name: username, eid: dev.eid, ops: store.peek().ops, key: dev }, name: "tess", base: d.base, fetch: d.fetch, now: d.now, host: async () => ({ space: "spc_" + "abcdefghijkl", rootPublic: Buffer.alloc(32, 7).toString("base64url") }) });
  await new Promise((r) => setTimeout(r, 50));
  await store.save({ ...store.peek(), spaces: [{ id: "spc_abcdefghijkl", name: "tess", role: "owner", server: "https://tess.vyre.run", paired: { box: "bx", route: box.route, relay: "https://relay.example", name: "the test box" } }], ...(o.listed ? { listed: { tess: box.route } } : {}) });
  const servedName = async () => (await box.get("/v1/names/mine")).json.data.name;
  return { d, store, host, box, servedName };
}

test("a server that says its Space has not listed it is listed again when the app heals, even when this page thinks it listed it already", async (t) => {
  const asked = [];
  let phase = "not-listed";
  const space = { load: async () => ({ call: async (tool, _input, box) => { asked.push([tool, box]); return tool === "names.status" ? { name: "tess", phase } : {}; } }) };
  const w = await oldSpace(t, "tesso", { space, listed: true });
  assert.equal(await w.servedName(), null, "the directory has no listing, though this page kept one");
  for (let i = 0; i < 50 && (await w.servedName()) === null; i++) { await w.host.call("identity.heal"); await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(await w.servedName(), "tess", "the server's word made the app list it again");
  assert.ok(asked.some(([tool, box]) => tool === "names.status" && box === "bx"), "the paired server was asked how its name stands, by its own box id");
  assert.equal((await w.host.call("identity.servers.status")).failed, "");

  // a server that is serving is not listed again: the directory is not asked
  phase = "serving";
  let posts = 0;
  const counting = createHost({ store: w.store, directory: w.d.base, fetch: async (url, init) => { if (String(url).includes("/v1/ids/server")) posts++; return w.d.fetch(url, init); }, now: w.d.now, kdf: FAST, space });
  await counting.call("identity.unlock", { password: PASSWORD });
  await counting.call("identity.heal");
  assert.equal(posts, 0);

  // a locked page heals nothing and says so
  await counting.call("identity.lock");
  assert.deepEqual(await counting.call("identity.heal"), { healed: false });
});

test("the owner's state on 20 Oct: a Space row kept with no pairing and the server's own Space id, one paired server that says the directory refuses its name; unlocking finds that server and lists it", async (t) => {
  const asked = [];
  let pairs = [];
  const space = { load: async () => ({
    pairings: async () => pairs,
    call: async (tool, _input, box) => { asked.push([tool, box]); return tool === "names.status" ? { name: "tess", via: "vyre.run", phase: "failed", why: "that name is not served by this server" } : {}; },
  }) };
  const w = await oldSpace(t, "tessz", { space });
  // as a sign-in keeps it: the id the server itself uses (not the directory's), the role, no pairing
  await w.store.save({ ...w.store.peek(), spaces: [{ id: "spc_vvquqb6nm5q5", name: "tess", role: "owner", server: "https://tess.vyre.run" }] });

  // no pairing on this app yet: nothing is listed, and Account says why instead of staying quiet
  await w.host.call("identity.lock");
  await w.host.call("identity.unlock", { password: PASSWORD });
  for (let i = 0; i < 100 && !(await w.host.call("identity.servers.status")).failed; i++) await new Promise((r) => setTimeout(r, 20));
  assert.match((await w.host.call("identity.servers.status")).failed, /^tess\.vyre\.run: this app is not paired with the server of this Space/);
  assert.equal(await w.servedName(), null);

  // the app is paired with the owner's server (another pairing beside it names another Space): the next heal finds it by the name it holds and lists it
  pairs = [{ box: "bx-other", route: "a".repeat(26), relay: "https://relay.example", name: "other" }, { box: "bx", route: w.box.route, relay: "https://relay.example", name: "the owner's server" }];
  const other = space.load;
  space.load = async () => { const p = await other(); return { ...p, call: async (tool, input, box) => (box === "bx-other" && tool === "names.status" ? { name: "elsewhere", phase: "serving" } : p.call(tool, input, box)) }; };
  for (let i = 0; i < 50 && (await w.servedName()) === null; i++) { await w.host.call("identity.heal"); await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(await w.servedName(), "tess", "the server that holds tess is listed");
  assert.equal((await w.host.call("identity.servers.status")).failed, "");
  const row = w.store.peek().spaces[0];
  assert.deepEqual([row.id, row.paired.box, row.paired.route], ["spc_vvquqb6nm5q5", "bx", w.box.route], "the server found is kept beside the row");
  assert.equal(w.store.peek().listed.tess, w.box.route);
});

test("when the Space's server listing cannot finish, Account is told why in words and Retry lists it again", async (t) => {
  let down = true;
  const w = await oldSpace(t, "tessr", { fetch: (inner) => async (url, init) => { if (down && String(url).includes("/v1/ids/server")) throw new Error("offline"); return inner(url, init); } });
  await w.host.call("identity.lock");
  await w.host.call("identity.unlock", { password: PASSWORD });
  for (let i = 0; i < 100 && !(await w.host.call("identity.servers.status")).failed; i++) await new Promise((r) => setTimeout(r, 20));
  const st = await w.host.call("identity.servers.status");
  assert.match(st.failed, /^tess\.vyre\.run: the names directory could not be reached$/, "a plain reason, per Space, not silence");
  assert.equal(st.unlocked, true);
  assert.equal(await w.servedName(), null);
  down = false;
  assert.deepEqual(await w.host.call("identity.servers.retry"), { failed: "" });
  assert.equal(await w.servedName(), "tess", "the retry listed the server");
  assert.equal(w.store.peek().listed.tess, w.box.route);
  await w.host.call("identity.lock");
  await assert.rejects(() => w.host.call("identity.servers.retry"), (e) => e.code === "locked");
});

test("signing in on the web to a Space whose address is not live yet says so and what to do, not 'cannot reach'; once it is live, a door that does not answer is 'cannot reach' again", async (t) => {
  const w = await oldSpace(t, "tessw");
  const noDoor = async (url, init) => { if (String(url).endsWith("/login")) throw new TypeError("Load failed"); return w.d.fetch(url, init); };
  const page = createHost({ store: memoryStore(), directory: w.d.base, fetch: noDoor, now: w.d.now, kdf: FAST });
  const LIVE_NOT = "The address tess.vyre.run isn't live yet. Open the Vyre app as the owner to finish setting it up.";
  await assert.rejects(() => page.call("onboard.signin", { space: "tess", username: "tessw", password: PASSWORD }), (e) => { assert.equal(e.message, LIVE_NOT); assert.equal(e.code, "unreachable"); return true; });
  assert.equal((await w.d.fetch(`${w.d.base}/v1/names/check?name=tess`).then((r) => r.json())).data.live, false, "the directory says the Space is not live: no server is listed");

  // the owner's app lists the server, and the server publishes its address: the Space is live, and a door that does not answer is the plain "cannot reach"
  await w.host.call("identity.servers.retry");
  assert.equal((await w.box.post("/v1/names/publish", { name: "tess" }, { ip: "93.184.216.34" })).status, 200);
  assert.equal((await w.d.fetch(`${w.d.base}/v1/names/check?name=tess`).then((r) => r.json())).data.live, true);
  await assert.rejects(() => page.call("onboard.signin", { space: "tess", username: "tessw", password: PASSWORD }), /Cannot reach that space right now/);

  // a directory that does not say (an older one) keeps the plain words too
  const unsure = createHost({ store: memoryStore(), directory: w.d.base, fetch: noDoor, now: w.d.now, kdf: FAST, signin: { resolves: async () => null } });
  await assert.rejects(() => unsure.call("onboard.signin", { space: "tess", username: "tessw", password: PASSWORD }), /Cannot reach that space right now/);
});

test("Settings, Account on a page with no daemon reads the person's list from the host and the directory: the device, the recovery code, and which entry is this one", async (t) => {
  const d = directory(t);
  const point = await agreePointOf();
  const host = createHost({ store: memoryStore(), directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST, agreePoint: async () => point });
  assert.deepEqual(await host.call("identity.entries"), { entries: [] }, "no identity yet");
  const made = await host.call("onboard.person.create", { username: "ida", password: PASSWORD, confirm: PASSWORD });
  const { entries } = await host.call("identity.entries");
  assert.deepEqual(entries.map((e) => e.kind).sort(), ["code", "device"]);
  const dev = entries.find((e) => e.kind === "device");
  assert.deepEqual([dev.self, dev.agree], [true, true]);
  assert.equal(entries.find((e) => e.kind === "code").self, false);
  assert.equal((await host.call("identity.status")).id, made.id);
  await host.call("identity.lock");
  assert.equal((await host.call("identity.entries")).entries.find((e) => e.kind === "device").self, false, "locked: this device's entry is not known");
});

test("a new recovery code on a page with no daemon: the password is asked, the device signs the chain's replace-code op, the old code stops, and the new one opens this device later", async (t) => {
  const d = directory(t);
  const store = memoryStore();
  const host = createHost({ store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST, agreePoint: async () => agreePointOf() });
  const made = await host.call("onboard.person.create", { username: "rhea", password: PASSWORD, confirm: PASSWORD });
  const before = await chainEntry(d, "rhea");
  await assert.rejects(() => host.call("identity.code.replace", { password: "" }), (e) => e.code === "person_enters");
  await assert.rejects(() => host.call("identity.code.replace", { password: "zebra quartz mango pillow" }), (e) => e.code === "bad_password" || /password|recovery|open/i.test(e.message));
  assert.equal((await chainEntry(d, "rhea")).ops.length, before.ops.length, "a wrong password changed nothing");
  const r = await host.call("identity.code.replace", { password: PASSWORD });
  assert.match(r.recoveryCode, /^([a-z2-7]{4}-){6}[a-z2-7]{2}$/);
  assert.notEqual(r.recoveryCode, made.recoveryKey);
  const { ops } = await chainEntry(d, "rhea");
  assert.equal(ops[ops.length - 1].type, "replace-code");
  const { codeKey } = await import("../identity/recovery.js");
  const ck = await codeKey(r.recoveryCode, "");
  const C = await import("../../../../kernel/identity/chain.js");
  const state = await C.verifyChain(ops, { now: d.now() });
  assert.deepEqual(state.entries.filter((e) => e.kind === "code").map((e) => e.eid), [ck.eid], "the list holds only the new code");
  // the kept record opens with the new code, not the old
  await host.call("identity.lock");
  await assert.rejects(() => host.call("identity.unlock", { recovery: made.recoveryKey }));
  await host.call("identity.unlock", { recovery: r.recoveryCode });
  assert.equal((await host.call("identity.status")).unlocked, true);
});

test("taking a device off the list: this device cannot take itself off, a stranger is not on the list, and a locked page asks for the password", async (t) => {
  const d = directory(t);
  const host = createHost({ store: memoryStore(), directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST });
  await host.call("onboard.person.create", { username: "remo", password: PASSWORD, confirm: PASSWORD });
  const { entries } = await host.call("identity.entries");
  const me = entries.find((e) => e.self);
  await assert.rejects(() => host.call("identity.entry.remove", { eid: me.eid }), (e) => e.code === "bad_input");
  await assert.rejects(() => host.call("identity.entry.remove", { eid: "5wmpjevadlr3ouy5wjob4cy2pw" }), (e) => e.code === "not_found");
  await host.call("identity.lock");
  await assert.rejects(() => host.call("identity.entry.remove", { eid: me.eid }), (e) => e.code === "locked");
});

test("when the repair of private chats cannot finish, the host says why and a retry runs it again", async (t) => {
  const d = directory(t);
  const store = memoryStore();
  const old = createHost({ store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST });
  await old.call("onboard.person.create", { username: "vera", password: PASSWORD, confirm: PASSWORD });
  const point = await agreePointOf();
  let down = true;
  const flaky = async (url, init) => { if (down && String(url).includes("/v1/ids/append")) throw new Error("offline"); return d.fetch(url, init); };
  const host = createHost({ store, directory: d.base, fetch: flaky, now: d.now, kdf: FAST, agreePoint: async () => point });
  await host.call("identity.unlock", { password: PASSWORD });
  for (let i = 0; i < 100 && !(await host.call("identity.agree.status")).failed; i++) await new Promise((r) => setTimeout(r, 20));
  const st = await host.call("identity.agree.status");
  assert.match(st.failed, /could not be reached|did not go through/, "a plain reason, not silence");
  assert.equal((await chainEntry(d, "vera")).entry.agree, undefined);
  down = false;
  assert.deepEqual(await host.call("identity.agree.retry"), { failed: "" });
  assert.equal((await chainEntry(d, "vera")).entry.agree, point);
  // a page with no key says so
  const none = createHost({ store: memoryStore(), directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST, agreePoint: async () => null });
  await none.call("onboard.person.create", { username: "wren", password: PASSWORD, confirm: PASSWORD });
  await none.call("identity.lock"); await none.call("identity.unlock", { password: PASSWORD });
  for (let i = 0; i < 100 && !(await none.call("identity.agree.status")).failed; i++) await new Promise((r) => setTimeout(r, 20));
  assert.match((await none.call("identity.agree.status")).failed, /no key for private chats/);
});

test("the unlock repair never drops the chat key quietly: a store that refused says why in its own words, and a list holding a point this device no longer has is named", async (t) => {
  const d = directory(t);
  // every store refused (the ad-hoc Mac app with a Keychain and a page storage that both say no): the page's reason is what Account shows
  const said = "Vyre couldn't save this device's chat key: the Mac's Keychain said \"OSStatus -34018\", and this page's storage did not give the key back.";
  const refused = createHost({ store: memoryStore(), directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST, agreePoint: async () => { throw Object.assign(new Error(said), { code: "no_agree_key" }); } });
  await refused.call("onboard.person.create", { username: "ruth", password: PASSWORD, confirm: PASSWORD });
  assert.equal((await chainEntry(d, "ruth")).entry.agree, undefined, "no point in the genesis entry, and first run went on");
  await refused.call("identity.lock"); await refused.call("identity.unlock", { password: PASSWORD });
  for (let i = 0; i < 100 && !(await refused.call("identity.agree.status")).failed; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await refused.call("identity.agree.status")).failed, said);

  // an older build put a point on the list that this device lost (a key made new on every launch): the repair cannot set a second one, and says so instead of returning quietly
  const store = memoryStore();
  const first = await agreePointOf();
  const old = createHost({ store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST, agreePoint: async () => first });
  await old.call("onboard.person.create", { username: "lena", password: PASSWORD, confirm: PASSWORD });
  const now = await agreePointOf();
  const later = createHost({ store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST, agreePoint: async () => now });
  await later.call("identity.unlock", { password: PASSWORD });
  for (let i = 0; i < 100 && !(await later.call("identity.agree.status")).failed; i++) await new Promise((r) => setTimeout(r, 20));
  assert.match((await later.call("identity.agree.status")).failed, /older chat key for this device/);
  assert.equal((await chainEntry(d, "lena")).entry.agree, first, "the list is unchanged");
  // Try again replaces it: this device signs a replacing agree op for its own entry with the key it holds, no second device
  assert.deepEqual(await later.call("identity.agree.retry"), { failed: "" });
  assert.equal((await chainEntry(d, "lena")).entry.agree, now, "the list now holds the point this device keeps");
  // locked: no replacing, no change
  await later.call("identity.lock");
  await assert.rejects(() => later.call("identity.agree.retry"), (e) => e.code === "locked");
  // the same point: nothing to say
  const same = createHost({ store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST, agreePoint: async () => now });
  await same.call("identity.unlock", { password: PASSWORD });
  assert.deepEqual(await same.call("identity.agree.retry"), { failed: "" });
});

test("a page with no key of its own reads a person's list from the directory, checked, and cannot change it", async (t) => {
  const { publicEntries } = await import("../identity/public-list.js");
  const d = directory(t);
  const host = createHost({ store: memoryStore(), directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST });
  const made = await host.call("onboard.person.create", { username: "sol", password: PASSWORD, confirm: PASSWORD });
  const list = await publicEntries({ directory: d.base, id: made.id, fetch: d.fetch, now: d.now() });
  assert.equal(list.filter((e) => e.kind === "device").length, 1, "the one device");
  assert.equal(list.filter((e) => e.kind === "code").length, 1, "the recovery code");
  assert.ok(list.every((e) => e.self === false), "no entry is this page's own");
  await assert.rejects(() => publicEntries({ directory: d.base, id: "per_zzzzzzzzzzzzzzzzzzzzzzzzzz", fetch: d.fetch, now: d.now() }), (e) => e.code === "not_found");
});

test("the name typed in first run is kept beside the username, and identity.status gives it to Account; a missing one, one with no letter and a long one leave the username alone (the directory allows a few claims a day from one address, so only three here)", async (t) => {
  const d = directory(t);
  const store = memoryStore();
  const host = createHost({ store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST });
  await host.call("onboard.person.create", { username: "pia", password: PASSWORD, confirm: PASSWORD, display: "  Pia Walker " });
  const st = await host.call("identity.status");
  assert.deepEqual([st.username, st.display], ["pia", "Pia Walker"]);
  assert.equal(store.peek().display, "Pia Walker");
  await host.call("identity.lock");
  assert.equal((await host.call("identity.status")).display, "Pia Walker", "kept across a lock");

  for (const [i, bad] of [undefined, "12345", "x".repeat(61)].entries()) {
    const h = createHost({ store: memoryStore(), directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST });
    await h.call("onboard.person.create", { username: `quin${i}`, password: PASSWORD, confirm: PASSWORD, display: bad });
    assert.equal((await h.call("identity.status")).display, undefined, JSON.stringify(bad));
  }
});

test("the name can be set in Account (one line, a letter, up to 60), and an older identity takes the name its server already holds", async (t) => {
  const d = directory(t);
  const store = memoryStore();
  // made the old way: no name kept; the server was told the name at the Assistant step and says it in onboard.status
  const asked = [];
  const ports = { call: async (name, input, box) => { asked.push([name, box]); return name === "onboard.status" ? { person: "Ola Walker" } : {}; } };
  const host = createHost({ store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST, space: { load: async () => ports } });
  await host.call("onboard.person.create", { username: "ola", password: PASSWORD, confirm: PASSWORD });
  assert.deepEqual(await host.call("identity.display.sync"), { display: null }, "no server paired yet: nothing to read");
  store.peek().spaces = [{ id: "spc_aaaaaaaaaaaa", name: "ola-space", role: "owner", server: null, paired: { box: "box1", route: "r", relay: "ws://x", name: "ola" } }];
  assert.deepEqual(await host.call("identity.display.sync"), { display: "Ola Walker" });
  assert.deepEqual(asked.at(-1), ["onboard.status", "box1"]);
  assert.equal((await host.call("identity.status")).display, "Ola Walker");
  // a kept name is never replaced by the server's
  ports.call = async () => ({ person: "Someone Else" });
  assert.deepEqual(await host.call("identity.display.sync"), { display: "Ola Walker" });
  // set it by hand
  assert.deepEqual(await host.call("identity.display.set", { display: " Ola W. " }), { display: "Ola W." });
  assert.equal((await host.call("identity.status")).display, "Ola W.");
  for (const bad of ["", "   ", "1234", "a\nb", "x".repeat(61), 5]) await assert.rejects(() => host.call("identity.display.set", { display: bad }), (e) => e.code === "bad_name", JSON.stringify(bad));
  // a server that answers with the username, or nothing sensible, gives no name
  const store2 = memoryStore();
  const h2 = createHost({ store: store2, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST, space: { load: async () => ({ call: async () => ({ person: "olb" }) }) } });
  await h2.call("onboard.person.create", { username: "olb", password: PASSWORD, confirm: PASSWORD });
  store2.peek().spaces = [{ id: "spc_bbbbbbbbbbbb", name: "olb-space", role: "owner", server: null, paired: { box: "box2", route: "r", relay: "ws://x", name: "olb" } }];
  assert.deepEqual(await h2.call("identity.display.sync"), { display: null });
});

/** The owner's state on 20 Oct: the Space is the owner's in the directory, the server is paired, and this app's list has no row for it. */
async function lostRow(t, username, label) {
  const calls = [];
  const pairs = [{ box: "bx", route: "", relay: "https://relay.example", name: "the owner's server" }];
  const space = { load: async () => ({
    pairings: async () => pairs,
    join: async () => { throw new Error("not a team"); },
    call: async (tool, _input, box) => { calls.push([tool, box]); return tool === "names.status" ? { name: label, phase: "not-listed" } : tool === "spaces.list" ? [{ id: "spc_vy7xabcdefgh", name: label }] : {}; },
  }) };
  const w = await oldSpace(t, username, { space });
  pairs[0].route = w.box.route;
  // oldSpace claimed "tess"; the name this test wants is claimed the same way, and the app's list is emptied
  const dev = await fromSeed(w.host.signer().seed);
  await claimServerSpace({ identity: { id: w.store.peek().id, name: username, eid: dev.eid, ops: w.store.peek().ops, key: dev }, name: label, base: w.d.base, fetch: w.d.fetch, now: w.d.now, host: async () => ({ space: "spc_vy7xabcdefgh", rootPublic: Buffer.alloc(32, 9).toString("base64url") }) });
  await new Promise((r) => setTimeout(r, 50));
  await w.store.save({ ...w.store.peek(), spaces: [], current: null, listed: {} });
  return { ...w, calls, label };
}

test("unlocking adds back a Space the identity owns in the directory that the app's list lacks, when a paired server says it is that Space's name, and lists the server (not selected)", async (t) => {
  const w = await lostRow(t, "harbo", "harbor");
  await w.host.call("identity.lock");
  await w.host.call("identity.unlock", { password: PASSWORD });
  for (let i = 0; i < 100 && !(w.store.peek().spaces || []).length; i++) await new Promise((r) => setTimeout(r, 20));
  const row = w.store.peek().spaces[0];
  assert.deepEqual([row.id, row.name, row.role, row.server, row.paired.box], ["spc_vy7xabcdefgh", "harbor", "owner", "https://harbor.vyre.run", "bx"]);
  assert.equal(w.store.peek().current, null, "a repair does not change the Space showing");
  for (let i = 0; i < 100 && (await w.servedName()) === null; i++) { await w.host.call("identity.heal"); await new Promise((r) => setTimeout(r, 20)); }
  assert.equal((await w.host.call("identity.servers.status")).failed, "");
  assert.ok(w.store.peek().listed.harbor, "the server was listed on the directory, signed by the unlocked identity");
});

test("a Space owned in the directory is not added for someone else's identity, or when no paired server says its name", async (t) => {
  const w = await lostRow(t, "harbn", "harbor");
  const other = createHost({ store: memoryStore(), directory: w.d.base, fetch: w.d.fetch, now: w.d.now, kdf: FAST, space: { load: async () => ({ pairings: async () => [{ box: "bx", route: w.box.route, relay: "r", name: "x" }], call: async (tool) => (tool === "names.status" ? { name: "harbor" } : {}) }) } });
  await other.call("onboard.person.create", { username: "stranger", password: PASSWORD, confirm: PASSWORD });
  await other.call("identity.heal");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual((await other.call("onboard.space.list")).spaces, []);
  await assert.rejects(() => other.call("onboard.join.read", { link: "harbor" }), (e) => e.code !== "no_pairing", "someone else's Space is not treated as theirs");
});

test("joining by name a Space the person owns is the owner's own Space: the row is added with its pairing, selected, and the server is listed", async (t) => {
  const w = await lostRow(t, "harbj", "harbor");
  await w.host.call("identity.lock");
  await w.host.call("identity.unlock", { password: PASSWORD });
  for (let i = 0; i < 100 && !(w.store.peek().spaces || []).length; i++) await new Promise((r) => setTimeout(r, 20));
  await w.store.save({ ...w.store.peek(), spaces: [], current: null, listed: {} });
  const read = await w.host.call("onboard.join.read", { link: "harbor.vyre.run" });
  assert.deepEqual([read.role, read.space], ["owner", "harbor"]);
  const joined = await w.host.call("onboard.space.join", { link: "harbor" });
  assert.deepEqual([joined.joined, joined.role, joined.space, joined.id], [true, "owner", "harbor", "spc_vy7xabcdefgh"]);
  const kept = w.store.peek();
  assert.equal(kept.current, "spc_vy7xabcdefgh");
  assert.equal(kept.spaces[0].paired.box, "bx");
  assert.ok(kept.listed.harbor);
});

test("the chat key lives in the master record: an account with none gets one made into its record on the next password unlock, the list's agree point is replaced once, and the next unlock reads the same key", async (t) => {
  const A = await import("../crypto/agree-key.ts");
  const d = directory(t);
  const store = memoryStore();
  const old = createHost({ store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST });
  await old.call("onboard.person.create", { username: "ruth", password: PASSWORD, confirm: PASSWORD });
  const before = store.peek().master;
  const port = { make: A.makeRecordAgreeKey, use: A.useRecordAgreeKey };
  const agreePoint = async () => { const r = await A.agreeKeyResult(); if (!r.key) throw Object.assign(new Error(r.reason), { code: "no_agree_key" }); return r.key.point; };
  const fresh = createHost({ store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST, agreePoint, agreeKey: port });
  assert.equal((await A.agreeKeyResult()).key, null, "locked: no chat key, and no device makes one");
  await fresh.call("identity.unlock", { password: PASSWORD });
  const point = (await A.agreeKeyResult()).key.point;
  const after = store.peek().master;
  assert.deepEqual([after.kdf, after.passwordWrap, after.recoveryWrap], [before.kdf, before.passwordWrap, before.recoveryWrap], "the salt, the password wrap and the recovery wrap are as they were, so the space's login key still fits");
  assert.notDeepEqual(after.identityWrap, before.identityWrap, "the identity wrap now carries the chat key");
  assert.ok(!JSON.stringify(store.peek()).includes('"d":'), "the private half is kept only inside the wrap");
  for (let i = 0; i < 100 && (await chainEntry(d, "ruth")).entry.agree !== point; i++) await new Promise((r) => setTimeout(r, 20));
  const entry = await chainEntry(d, "ruth");
  assert.equal(entry.entry.agree, point, "the list's agree point is the record's key");
  // lock drops the key from memory; the next unlock reads the SAME key out of the record and changes nothing on the list
  await fresh.call("identity.lock");
  assert.equal((await A.agreeKeyResult()).key, null);
  await fresh.call("identity.unlock", { password: PASSWORD });
  assert.equal((await A.agreeKeyResult()).key.point, point);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await chainEntry(d, "ruth")).ops.length, entry.ops.length, "no second op");
  // a recovery-key unlock has no password to re-wrap with: it makes nothing and says why
  await fresh.call("identity.lock");
  const recDev = createHost({ store: memoryStore(), directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST, agreeKey: port });
  const made = await recDev.call("onboard.person.create", { username: "ira", password: PASSWORD, confirm: PASSWORD });
  const iraEntry = await chainEntry(d, "ira");
  assert.ok(iraEntry.entry.agree, "a new account's genesis entry already carries the record's key");
  assert.ok(made.recoveryKey);
});

test("link GitHub from Settings: each of the person's spaces gets a signed link-github request (the relay's assertion for that space, the identity key's signature over space, username, GitHub id and time), and the status names the login", { timeout: 240000 }, async (t) => {
  const { githubLinkMessage } = await import("./login-web.js");
  const w = spaceWorld(t);
  const one = createHost({ store: memoryStore(), directory: w.base, fetch: w.fetch, now: w.now });
  await one.call("onboard.person.create", { username: "alex", password: PASSWORD, confirm: PASSWORD });
  await w.svc.register(await one.registerLogin("juniper", PASSWORD));
  const linkPosts = [];
  const fetchLink = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === "juniper.vyre.run" && u.pathname === "/login" && JSON.parse(init.body).op === "link-github") { linkPosts.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, username: "alex", login: "alexg" }), { status: 200 }); }
    if (u.pathname.startsWith("/v1/ids/spaces/")) return new Response(JSON.stringify({ data: {} }), { status: 200 });
    return w.fetch(url, init);
  };
  const github = { start: async () => ({ ok: true, session: { ticket: "t", cv: "c" }, user: { id: 7, login: "alexg" } }), assert: async (_s, audience) => `assert:${audience}` };
  const two = createHost({ store: memoryStore(), directory: w.base, fetch: fetchLink, now: w.now, github });
  await two.call("onboard.signin", { space: "juniper.vyre.run", username: "alex", password: PASSWORD });
  const r = await two.call("identity.github.link", {});
  assert.deepEqual([r.linked, r.login, r.spaces], [true, "alexg", 1]);
  assert.equal(linkPosts.length, 1);
  const p = linkPosts[0];
  assert.equal(p.assertion, "assert:juniper");
  assert.equal(p.username, "alex");
  assert.ok(ed25519.verify(Buffer.from(p.sig, "base64url"), githubLinkMessage("juniper", "alex", "7", p.ts), Buffer.from(p.pub, "base64url")), "signed by the identity key over the space, the name, the GitHub id and the time");
  assert.equal((await two.call("identity.status")).github, "alexg");
  await two.call("identity.lock");
  await assert.rejects(() => two.call("identity.github.link", {}), (e) => e.code === "locked");
});
