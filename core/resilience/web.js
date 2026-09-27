// @ts-check
// web: the transports and stores that stream.js and outbox.js take in a browser (the Deck, the
// PWA and the phone app's web target; docs/adr/0029-resilience.md, R1, R2, R3, R5). No Node imports
// and no dependencies; Safari 16 and React Native Web are enough.
//
//   open          one GET for follow(), over fetch and a ReadableStream
//   caller        one tool call for outbox(), over fetch, never thrown
//   idbStore      the outbox, kept in IndexedDB
//   cursorStore   the stream cursor, so a cold start resumes where the last one stopped
//   cacheStore    the last Now, Needs, threads and planner, so the app opens offline
//   lifecycle     hidden tab, network change and back/forward cache, wired to both
//
// A base is an http(s) URL, and may carry a path (a relay route): paths are appended to it.
// Storage never throws. IndexedDB comes first ("vyre-resilience", one object store per box);
// where it is missing or refused (a private window, blocked site data) localStorage takes over,
// and where that fails too, memory, which lasts as long as the page.

/** @param {string} base @param {string} path */
const join = (base, path) => {
  if (!/^https?:/i.test(base)) throw new Error(`a browser reaches the box over http(s), not ${base.split(":")[0]}:`);
  return base.replace(/\/+$/, "") + path;
};

/** @type {import("./stream.js").Open} */
export async function open({ base, path, headers, signal }) {
  const r = await fetch(join(base, path), { method: "GET", headers, signal, cache: "no-store" });
  if (!r.ok) { r.body?.cancel().catch(() => {}); return { status: r.status, chunks: text(null) }; }
  return { status: r.status, chunks: text(r) };
}

/**
 * The body as text chunks. Read through getReader, because Safari cannot iterate a
 * ReadableStream; a body without a stream (an old React Native fetch) arrives whole.
 * @param {Response|null} res
 */
async function* text(res) {
  if (!res) return;
  if (!res.body) { const all = await res.text(); if (all) yield all; return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const s = dec.decode(value, { stream: true });
      if (s) yield s;
    }
    const tail = dec.decode();
    if (tail) yield tail;
  } finally { reader.cancel().catch(() => {}); }
}

/**
 * One tool call with its Idempotency-Key, the same shape as node.js's caller: { data } or
 * { error }, never thrown. No answer is `unreachable`, a 503 is `restarting`, and no answer
 * within `timeoutMs` is `timeout`; the outbox retries all three.
 * @param {string} base
 * @param {{ headers?: Record<string, string>, timeoutMs?: number }} [o]
 * @returns {import("./outbox.js").Call}
 */
export function caller(base, { headers = {}, timeoutMs = 15_000 } = {}) {
  return async (tool, input, key) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(join(base, "/v1/tools/" + encodeURIComponent(tool)), {
        method: "POST", signal: ac.signal, cache: "no-store", body: JSON.stringify(input ?? {}),
        headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}), ...headers } });
      if (r.status === 503) { r.body?.cancel().catch(() => {}); return { error: { code: "restarting", message: "the box is restarting; trying again in a moment" } }; }
      const raw = await r.text();
      try { return JSON.parse(raw); }
      catch { return { error: { code: "unreachable", message: `vyred answered ${r.status} with no JSON` } }; }
    } catch (e) {
      return ac.signal.aborted
        ? { error: { code: "timeout", message: `no answer in ${timeoutMs} ms` } }
        : { error: { code: "unreachable", message: /** @type {Error} */ (e)?.message || "the box is out of reach" } };
    } finally { clearTimeout(t); }
  };
}

// ---- storage -------------------------------------------------------------------------------

const DB = "vyre-resilience";

/**
 * @typedef {{ indexedDB?: IDBFactory | null, localStorage?: Storage | null }} Env
 *   Where to keep things; the page's own by default. Tests pass fakes.
 */

/** @param {() => any} f */
const safely = f => { try { return f(); } catch { return undefined; } };

/** @type {WeakMap<object, Map<string, Promise<IDBDatabase|null>>>} one connection per box */
const conns = new WeakMap();

/**
 * Open the database with an object store for `box`, adding the store (a version bump) when it is
 * new. Resolves null when IndexedDB is missing, refused or stuck, and never rejects.
 * @param {IDBFactory} idb @param {string} box @returns {Promise<IDBDatabase|null>}
 */
function openDb(idb, box) {
  return new Promise(resolve => {
    let settled = false;
    const done = (/** @type {IDBDatabase|null} */ db) => {
      if (settled) return void db?.close();
      settled = true; clearTimeout(stuck); resolve(db);
    };
    const stuck = setTimeout(() => done(null), 3_000);   // another tab blocking the upgrade: use the fallback
    const attempt = (/** @type {number|undefined} */ version, /** @type {number} */ left) => {
      /** @type {IDBOpenDBRequest} */ let req;
      try { req = version ? idb.open(DB, version) : idb.open(DB); } catch { return done(null); }
      req.onupgradeneeded = () => safely(() => { if (!req.result.objectStoreNames.contains(box)) req.result.createObjectStore(box); });
      req.onerror = e => {
        // Two stores added at once race for the same version: look again and bump past it.
        safely(() => e.preventDefault());
        if (left > 0 && safely(() => req.error?.name) === "VersionError") attempt(undefined, left - 1); else done(null);
      };
      req.onsuccess = () => {
        const db = req.result;
        if (!safely(() => db.objectStoreNames.contains(box))) { const v = db.version + 1; db.close(); return left > 0 ? attempt(v, left - 1) : done(null); }
        // Let another tab add its box: close, and open again on the next use.
        db.onversionchange = () => { db.close(); conns.get(idb)?.delete(box); };
        done(db);
      };
    };
    attempt(undefined, 5);
  });
}

/** @param {IDBRequest|IDBTransaction} r @param {"onsuccess"|"oncomplete"} ok */
const settle = (r, ok) => new Promise((resolve, reject) => {
  /** @type {any} */ (r)[ok] = () => resolve(/** @type {any} */ (r).result);
  /** @type {any} */ (r).onerror = () => reject(/** @type {any} */ (r).error);
  if (ok === "oncomplete") /** @type {any} */ (r).onabort = () => reject(/** @type {any} */ (r).error);
});

/**
 * A small key-value store for one box: IndexedDB, else localStorage, else memory. Reads after a
 * write in this page come from memory; get, set and del never throw.
 * @param {string} box @param {Env} [env]
 */
function kv(box, env = {}) {
  const idb = env.indexedDB !== undefined ? env.indexedDB : safely(() => globalThis.indexedDB) ?? null;
  const ls = env.localStorage !== undefined ? env.localStorage : safely(() => globalThis.localStorage) ?? null;
  /** @type {Map<string, any>} */ const mem = new Map();
  const lsKey = (/** @type {string} */ k) => `${DB}:${box}:${k}`;

  function db() {
    if (!idb) return Promise.resolve(null);
    let per = conns.get(idb);
    if (!per) conns.set(idb, per = new Map());
    let p = per.get(box);
    if (!p) per.set(box, p = openDb(idb, box));
    return p;
  }
  /** @param {IDBTransactionMode} mode @param {(s: IDBObjectStore) => any} f */
  async function idbDo(mode, f) {
    const d = await db();
    if (!d) throw new Error("no IndexedDB");
    try {
      const tx = d.transaction(box, mode);
      const r = f(tx.objectStore(box));
      return mode === "readonly" ? await settle(r, "onsuccess") : await settle(tx, "oncomplete");
    } catch (e) { conns.get(/** @type {object} */ (idb))?.delete(box); throw e; }   // a closed connection: reopen next time
  }

  return {
    /** @param {string} k @returns {Promise<any>} the value, or undefined */
    async get(k) {
      if (mem.has(k)) return mem.get(k);
      let v;
      try { v = await idbDo("readonly", s => s.get(k)); }
      catch { v = safely(() => { const raw = ls?.getItem(lsKey(k)); return raw == null ? undefined : JSON.parse(raw); }); }
      if (v !== undefined) mem.set(k, v);
      return v;
    },
    /** @param {string} k @param {any} v */
    async set(k, v) {
      mem.set(k, v);
      try { await idbDo("readwrite", s => s.put(v, k)); }
      catch { safely(() => ls?.setItem(lsKey(k), JSON.stringify(v))); }
    },
    /** @param {string} k */
    async del(k) {
      mem.delete(k);
      try { await idbDo("readwrite", s => s.delete(k)); } catch {}
      safely(() => ls?.removeItem(lsKey(k)));
    },
  };
}

/**
 * The outbox's Store (outbox.js) for one box, kept in IndexedDB.
 * @param {string} box @param {Env} [env] @returns {import("./outbox.js").Store}
 */
export function idbStore(box, env) {
  const s = kv(box, env);
  return {
    load: async () => { const v = await s.get("outbox"); return Array.isArray(v) ? v : []; },
    save: entries => s.set("outbox", entries.map(e => ({ ...e }))),
  };
}

/**
 * The stream cursor for one box. Pass `await load()` as follow's `cursor` and `save` as its
 * `save`. A heartbeat moves the cursor often, so writes are coalesced: one in flight, the
 * newest after it.
 * @param {string} box @param {Env} [env]
 */
export function cursorStore(box, env) {
  const s = kv(box, env);
  let want = /** @type {number|null} */ (null), writing = false;
  async function write() {
    writing = true;
    try { while (want !== null) { const n = want; want = null; await s.set("cursor", n); } }
    finally { writing = false; }
  }
  return {
    /** @returns {Promise<number|null>} */
    async load() { const v = await s.get("cursor"); return Number.isFinite(v) ? v : null; },
    /** @param {number} n */
    save(n) { want = n; if (!writing) write(); },
  };
}

/**
 * The last state each view showed, for one box, so the app opens from it offline (R3). Keys are
 * the view's own ("now", "needs", "planner", "thread:<id>"); values must survive JSON. `at` is
 * when it was saved, and `cursor` the event it is current to (a read's `last_event`), so the view
 * can follow from there with no gap.
 * @param {string} box @param {Env} [env]
 */
export function cacheStore(box, env) {
  const s = kv(box, env);
  return {
    /** @param {string} key @returns {Promise<{ value: any, at: number, cursor: number|null } | null>} */
    async get(key) { const v = await s.get("cache:" + key); return v && typeof v === "object" && "value" in v ? v : null; },
    /** @param {string} key @param {any} value @param {{ cursor?: number|null, now?: () => number }} [o] */
    set(key, value, { cursor = null, now = Date.now } = {}) { return s.set("cache:" + key, { value, at: now(), cursor }); },
    /** @param {string} key */
    del(key) { return s.del("cache:" + key); },
  };
}

// ---- lifecycle -----------------------------------------------------------------------------

/**
 * Hidden: close the stream. Visible again, back from the back/forward cache, or a network change:
 * reconnect at once and try the outbox now (R3, R5). Returns a function that unwires it all.
 * @param {ReturnType<typeof import("./stream.js").follow> | null} stream
 * @param {{ win?: EventTarget, doc?: EventTarget & { visibilityState?: string }, outbox?: { kick?: () => any } | null }} [o]
 */
export function lifecycle(stream, { win = globalThis.window, doc = globalThis.document, outbox = null } = {}) {
  let paused = false;   // paused by us, so only we resume it
  const hide = () => { if (!paused) { paused = true; stream?.pause(); } };
  // Back in front. Both visibilitychange and pageshow fire on a return from the cache, so only
  // the first one resumes.
  const front = () => { if (!paused) return; paused = false; stream?.resume(); outbox?.kick?.(); };
  const onVisibility = () => (doc?.visibilityState === "hidden" ? hide() : front());
  const onNet = (/** @type {Event} */ e) => { stream?.kick(); if (e.type === "online") outbox?.kick?.(); };
  const onPageHide = (/** @type {any} */ e) => { if (e.persisted) hide(); };
  const onPageShow = (/** @type {any} */ e) => {
    if (!e.persisted || doc?.visibilityState === "hidden") return;
    if (paused) front(); else { stream?.kick(); outbox?.kick?.(); }
  };

  /** @type {[EventTarget|undefined, string, (e: any) => void][]} */
  const wired = [[doc, "visibilitychange", onVisibility], [win, "online", onNet], [win, "offline", onNet],
    [win, "pagehide", onPageHide], [win, "pageshow", onPageShow]];
  for (const [t, name, f] of wired) safely(() => t?.addEventListener(name, f));
  if (doc?.visibilityState === "hidden") hide();
  return () => { for (const [t, name, f] of wired) safely(() => t?.removeEventListener(name, f)); };
}
