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
  return { fetch: fetchIn, base: BASE, now: () => w.clock.t };
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

test("sign in from another device: register the record at a space, then a new page with nothing on it signs in with the address, the username and the master password", { timeout: 240000 }, async (t) => {
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

test("sign in with GitHub: the directory lists the spaces for a valid assertion, the master password is asked once, and the bundle opens on the device", { timeout: 240000 }, async (t) => {
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
  assert.equal(await store.load(), null, "nothing is kept until the master password opens the bundle");
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

test("GitHub sign-in with no link, or a cancelled GitHub window, says so in the words and keeps nothing", async (t) => {
  const w = spaceWorld(t);
  const bad = createHost({ store: memoryStore(), directory: w.base, fetch: w.fetch, now: w.now, github: { start: async () => ({ ok: true, session: {}, user: { id: 1, login: "x" } }), assert: async () => "wrong" } });
  await assert.rejects(() => bad.call("onboard.signin.github"), (e) => e.code === "not_linked" && /not linked/.test(e.message));
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
