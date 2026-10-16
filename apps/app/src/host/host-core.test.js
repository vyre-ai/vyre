import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHost } from "./host-core.js";
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
