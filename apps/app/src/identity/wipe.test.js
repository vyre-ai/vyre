// @ts-check
// A removed device forgets everything it held. The browser steps run against a fake page (IndexedDB, local and session storage, Cache Storage, service workers): after the wipe the fake holds nothing, every
// step the coverage list names is there, a step that fails does not stop the rest, and only the relay's "removed" answer counts (a locked device is not wiped).
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { REMOVED_NOTICE, WIPE_COVERS, isRemovedCode, wipeAll } from "./wipe.js";
import { webSteps } from "./wipe-web.js";

function fakePage(/** @type {{ dbs?: boolean, failDb?: string }} */ o = {}) {
  /** @type {Set<string>} */ const dbs = new Set(["vyre-identity", "vyre-agree", "vyre-person", "vyre-resilience", "something-else"]);
  const store = () => { /** @type {Map<string, string>} */ const m = new Map(); return { m, clear: () => m.clear(), getItem: (/** @type {string} */ k) => m.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => m.set(k, v), get length() { return m.size; } }; };
  const localStorage = store(), sessionStorage = store();
  for (const k of ["vyre.relay.pairing", "vyre.peer", "vyre.appearance", "vyre.push"]) localStorage.setItem(k, "x");
  sessionStorage.setItem("vyre.unlock", "x");
  /** @type {Set<string>} */ const cacheNames = new Set(["app-shell-v1", "precache-v3"]);
  let registrations = 1;
  const indexedDB = {
    ...(o.dbs === false ? {} : { databases: async () => [...dbs].map((name) => ({ name })) }),
    deleteDatabase: (/** @type {string} */ name) => {
      /** @type {any} */ const req = { error: null };
      setTimeout(() => { if (o.failDb === name) { req.error = new Error(`could not delete ${name}`); req.onerror?.(); } else { dbs.delete(name); req.onsuccess?.(); } }, 0);
      return req;
    },
  };
  const caches = { keys: async () => [...cacheNames], delete: async (/** @type {string} */ k) => cacheNames.delete(k) };
  const navigator = { serviceWorker: { getRegistrations: async () => [...Array(registrations)].map(() => ({ unregister: async () => { registrations--; return true; } })) } };
  return { env: { indexedDB, localStorage, sessionStorage, caches, navigator }, dbs, localStorage, sessionStorage, cacheNames, regs: () => registrations };
}

test("wipe: the browser forgets its keys, pairing, settings, pins, cache, outbox, unlock session and app files", async () => {
  const p = fakePage();
  const r = await wipeAll(webSteps(p.env));
  assert.deepEqual(r.failed, []);
  assert.equal(p.dbs.size, 0, "no IndexedDB database is left: the device key, the agreement key, the person key, the cache, the pins and the outbox");
  assert.equal(p.localStorage.m.size, 0, "the pairing and the settings are gone");
  assert.equal(p.sessionStorage.m.size, 0, "the unlock session is gone");
  assert.equal(p.cacheNames.size, 0, "the cached app files are gone");
  assert.equal(p.regs(), 0, "the service worker is unregistered");
  for (const name of WIPE_COVERS) assert.ok(r.done.includes(name), `a step for ${name}`);
});

test("wipe: a browser with no database list still deletes the databases this app keeps", async () => {
  const p = fakePage({ dbs: false });
  const r = await wipeAll(webSteps(p.env));
  assert.deepEqual(r.failed, [], "no list: the names this app keeps are tried, and that is not a failure");
  for (const n of ["vyre-identity", "vyre-agree", "vyre-person", "vyre-resilience"]) assert.equal(p.dbs.has(n), false, n);
});

test("wipe: one step failing does not stop the rest, and the report names it", async () => {
  const p = fakePage({ failDb: "vyre-identity" });
  const r = await wipeAll(webSteps(p.env));
  assert.ok(r.failed.some((f) => f.name === "device keys" && /vyre-identity/.test(f.why)), JSON.stringify(r.failed));
  assert.equal(p.localStorage.m.size, 0);
  assert.equal(p.cacheNames.size, 0);
  assert.equal(p.dbs.has("vyre-resilience"), false, "the cache and the outbox went even though the key database would not");
});

test("wipe: only the relay's removed answer counts; a refused sign-in, a locked device and an unreachable server do not", () => {
  assert.equal(isRemovedCode("relay_removed"), true);
  for (const c of ["denied", "unreachable", "offline", "person_session_required", "timeout", undefined, ""]) assert.equal(isRemovedCode(c), false, String(c));
  assert.match(REMOVED_NOTICE, /Pair it again/);
});

test("wipe: the steps run in order and a throwing step is reported with its own words", async () => {
  /** @type {string[]} */ const ran = [];
  const r = await wipeAll([{ name: "a", run: async () => { ran.push("a"); } }, { name: "b", run: async () => { ran.push("b"); throw new Error("nope"); } }, { name: "c", run: async () => { ran.push("c"); } }]);
  assert.deepEqual(ran, ["a", "b", "c"]);
  assert.deepEqual(r, { done: ["a", "c"], failed: [{ name: "b", why: "nope" }] });
});

test("wipe: the phone's secure-store keys named in wipe.native.ts are the ones the app writes, and nothing else is written by name", async () => {
  const { readFileSync } = await import("node:fs");
  const here = new URL(".", import.meta.url);
  const read = (/** @type {string} */ f) => readFileSync(new URL(f, here), "utf8");
  const wipe = read("./wipe.native.ts");
  for (const [file, lit] of [["../state/appearance-keep.js", "vyre.appearance"], ["../state/setup-progress.ts", "vyre.setup.progress"], ["../state/setup-progress.ts", "vyre.setup.skipped"], ["../state/space-roots.ts", "vyre.space-roots"]]) {
    assert.ok(read(file).includes(`"${lit}"`), `${file} writes ${lit}`);
    assert.ok(wipe.includes(`"${lit}"`), `wipe.native.ts names ${lit}`);
  }
});
