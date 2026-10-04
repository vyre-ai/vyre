// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "../chat/lib/test-dom.js";

installDom();
const { myIds, isMyRemoval, wipeThisPhone, watchRemoval } = await import("./wipe.js");

const store = (/** @type {Record<string, string>} */ o) => { const m = new Map(Object.entries(o)); return Object.assign(Object.create(null), { getItem: (k) => m.get(k) ?? null, removeItem: (k) => m.delete(k), _m: m }); };

test("myIds: the passkey, the push device and the relay device of this phone", () => {
  assert.deepEqual(myIds({ getItem: k => ({ "vyre.passkey": JSON.stringify({ id: "pk1" }), "vyre.push.device": "d9" })[k] ?? null }), ["pk1", "d9"]);
  assert.deepEqual(myIds({ getItem: k => (k === "vyre.passkey" ? "{not json" : null) }), [], "a broken note is ignored");
});

test("isMyRemoval: only presence.removed or device.removed with one of this phone's ids", () => {
  const ids = ["pk1", "d9"];
  assert.equal(isMyRemoval({ type: "presence.removed", payload: { id: "pk1" } }, ids), true);
  assert.equal(isMyRemoval({ type: "device.removed", payload: { id: "d9", why: "removed" } }, ids), true);
  assert.equal(isMyRemoval({ type: "presence.removed", payload: { id: "other" } }, ids), false);
  assert.equal(isMyRemoval({ type: "push.subscribed", payload: { id: "pk1" } }, ids), false);
  assert.equal(isMyRemoval({ type: "device.removed" }, ids), false);
});

/** A phone with everything the box left on it, and a record of what was cleared. */
function phone() {
  const log = /** @type {string[]} */ ([]);
  const ls = { "vyre.passkey": "x", "vyre.push.device": "d", "vyre.theme": "paper", "unrelated": "keep" };
  const localStorage = Object.assign({ ...ls }, { removeItem(k) { delete this[k]; log.push("ls:" + k); } });
  // Object.keys must list only the data keys, so methods are non-enumerable.
  Object.defineProperty(localStorage, "removeItem", { enumerable: false });
  return {
    log, localStorage,
    sessionStorage: { clear: () => log.push("session") },
    caches: { keys: async () => ["a", "b"], delete: async k => { log.push("cache:" + k); return true; } },
    indexedDB: { databases: async () => [{ name: "vyre-resilience" }, { name: "keystore" }], deleteDatabase: n => { log.push("idb:" + n); const r = /** @type {any} */ ({}); queueMicrotask(() => r.onsuccess?.()); return r; } },
    navigator: { clearAppBadge: async () => log.push("badge"),
      serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => ({ unsubscribe: async () => log.push("unsub") }) } }), getRegistrations: async () => [{ unregister: async () => log.push("unreg") }] } },
  };
}

test("wipeThisPhone clears the push subscription, caches, every database, this app's keys, session storage and the workers", async () => {
  const p = phone();
  const done = await wipeThisPhone(p);
  assert.deepEqual(done, ["push", "badge", "caches", "indexedDB", "localStorage", "sessionStorage", "workers"]);
  for (const x of ["unsub", "cache:a", "cache:b", "idb:vyre-resilience", "idb:keystore", "ls:vyre.passkey", "ls:vyre.push.device", "ls:vyre.theme", "session", "unreg"]) assert.ok(p.log.includes(x), x);
  assert.equal(p.log.includes("ls:unrelated"), false, "only this app's keys");
});

test("wipeThisPhone: one failing step does not stop the rest", async () => {
  const p = phone();
  p.caches.keys = async () => { throw new Error("no"); };
  const done = await wipeThisPhone(p);
  assert.ok(!done.includes("caches"));
  assert.ok(done.includes("indexedDB") && done.includes("workers"));
});

test("watchRemoval: its own removal event wipes once; another device's does not", async () => {
  const p = phone();
  const subs = /** @type {Record<string, (e: any) => void>} */ ({});
  let wiped = 0;
  const root = document.createElement("div");
  const st = { getItem: k => ({ "vyre.passkey": JSON.stringify({ id: "pk1" }) })[k] ?? null };
  watchRemoval({ on: (t, fn) => { subs[t] = fn; return () => {}; }, attempt: async () => ({ error: { code: "offline" } }), env: p, store: st, root, onWiped: () => { wiped++; } });
  subs["presence.removed"]({ payload: { id: "someone-else" } });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(wiped, 0);
  subs["presence.removed"]({ payload: { id: "pk1" } }); subs["presence.removed"]({ payload: { id: "pk1" } });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(wiped, 1, "once");
  assert.match(root.textContent || "", /This phone was removed/);
});

test("watchRemoval: removed while away, one miss only marks it and a second look a minute later wipes; a key that is listed clears the mark; a server that cannot be asked wipes nothing", async () => {
  const mem = new Map([["vyre.passkey", JSON.stringify({ id: "pk1" })]]);
  const st = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); }, removeItem: k => { mem.delete(k); } };
  let clock = 1_000_000, w = 0;
  const launch = async (/** @type {any} */ answer) => { w = 0; watchRemoval({ on: () => () => {}, attempt: async () => answer, now: () => clock, env: phone(), store: st, onWiped: () => { w++; } }); await new Promise(r => setTimeout(r, 30)); return w; };
  assert.equal(await launch({ data: [{ id: "other" }] }), 0, "first miss: only marked");
  assert.equal(mem.has("vyre.removed.suspect"), true);
  clock += 5_000;
  assert.equal(await launch({ data: [{ id: "other" }] }), 0, "too soon for a second look");
  assert.equal(await launch({ error: { code: "offline" } }), 0, "cannot ask");
  clock += 120_000;
  assert.equal(await launch({ data: [{ id: "pk1" }] }), 0, "listed again (a restored box): mark cleared");
  assert.equal(mem.has("vyre.removed.suspect"), false);
  assert.equal(await launch({ data: [{ id: "other" }] }), 0);
  clock += 120_000;
  assert.equal(await launch({ data: [{ id: "other" }] }), 1, "still missing a minute or more later: wipe");
});

test("watchRemoval: your server's device_removed answer wipes", async () => {
  const p = phone();
  let fire = () => {};
  let w = 0;
  watchRemoval({ on: () => () => {}, attempt: async () => ({ error: { code: "offline" } }), onDeviceRemoved: fn => { fire = fn; return () => {}; }, env: p, store: { getItem: () => null }, onWiped: () => { w++; } });
  fire(); fire();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(w, 1);
});
