// @ts-check
// kernel/store/sealed.js: the encrypted personal records store (team/0.3/DESIGN-personal-records.md). A Personal person in a team (Cloud) Space keeps their Planner, reminders, notes and personal
// to-dos here: the whole Store interface (kernel/store/memory.js, the reference store, so every rule and every query is the one the conformance suite already holds) with its state held in process
// memory only while the person's yes stands, and written to the server's storage only as ciphertext.
//
// Key: one random records key (PK), sealed under the person's identity memory key (the IMK of core/memory/identity), so the person's one yes that unlocks the identity home unlocks this too; nothing
// else holds it. A server stores, under `personal/<identity>/`: key.json (PK sealed under the IMK), types.json (sealed), rec/<id> (one sealed blob per record, named by an HMAC so a type and an
// id do not show) and chg/<n> (the change log in sealed segments). The "due between" kind of question is the store's own query over a decrypted-in-process table: no index is written in the clear.
// The fixed types a Personal person keeps here (`allow: PERSONAL_TYPES`) are the only ones defined when asked; with no `allow` it holds any type the kernel defines. A per-member cap (set by the space owner) refuses writes once the stored bytes reach it.
import { createMemoryStore, CONFORMANCE_REVISION } from "./memory.js";
import { newKey, seal, open, derive, hmacHex, sha256Hex, utf8, text } from "../../lib/databox.js";

const SEG = 200;
/** The types a Personal person keeps sealed on a server: Planner items, notes, to-dos, and the Planner's own bookkeeping (alarms, repeats, snoozes). */
export const PERSONAL_TYPES = Object.freeze(["reminder", "note", "task", "planner_alarm", "planner_repeat", "planner_state"]);

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const dir = (/** @type {string} */ id) => `personal/${id}`;
const aad = (/** @type {string} */ id, /** @type {string} */ what) => `vyre-personal-records/${id}/${what}`;
const enc = (/** @type {any} */ v) => utf8(JSON.stringify(v));
const size = (/** @type {any} */ b) => (b ? (typeof b === "string" ? utf8(b).length : b.length) : 0);
const dec = (/** @type {any} */ b) => (b ? JSON.parse(text(typeof b === "string" ? utf8(b) : b)) : null);

/**
 * @param {{ backend: { put(n: string, b: Uint8Array|string): any, get(n: string): any, list(p: string): any, delete(n: string): any }, identity: string, imk: Uint8Array, allow?: readonly string[], device?: string,
 *   cap?: () => number, clock?: () => number, create?: boolean }} cfg `cap()` is the owner's per-member limit in bytes (0 or absent: none); `create` makes the store the first time
 */
export function createSealedStore(cfg) {
  const { backend, identity } = cfg;
  // `allow` limits which types may be defined (a personal Space passes PERSONAL_TYPES); left out, the store keeps whatever the kernel defines in it, as any store does (the suite holds it to that).
  const allow = cfg.allow ? new Set(cfg.allow) : null;
  const keyFile = `${dir(identity)}/key.json`;
  /** @type {Uint8Array | null} */ let pk = null;
  const raw = backend.get(keyFile);
  if (raw) {
    try { pk = open(dec(raw).box, cfg.imk, aad(identity, "key")); } catch { throw fail("denied", "the identity memory key does not open this store"); }
  } else if (cfg.create) {
    pk = newKey();
    backend.put(keyFile, enc({ v: 1, box: seal(pk, cfg.imk, aad(identity, "key")) }));
  } else throw fail("not_found", "no personal records store here");
  const key = /** @type {Uint8Array} */ (pk);
  const idKey = derive(key, "vyre-personal-record-name");
  const nameOf = (/** @type {string} */ type, /** @type {string} */ id) => hmacHex(idKey, `${type}\u0000${id}`);
  const sealed = (/** @type {any} */ v, /** @type {string} */ what) => enc(seal(JSON.stringify(v), key, aad(identity, what)));
  const opened = (/** @type {any} */ b, /** @type {string} */ what) => JSON.parse(text(open(dec(b), key, aad(identity, what))));

  // What is on the server now, with each object's sha256 (what this device last saw, for the compare-and-set) and size (the cap and the status are exact).
  /** @type {Map<string, { sha: string, size: number }>} */ let known = new Map();
  const sha = (/** @type {Uint8Array} */ b) => sha256Hex(b);
  const noteKnown = (/** @type {string} */ name, /** @type {Uint8Array|null} */ b) => { if (b) known.set(name, { sha: sha(b), size: b.length }); else known.delete(name); };
  const device = String(cfg.device || "d").replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "d";
  const typesName = `${dir(identity)}/types.json`;
  /** @type {Record<string, any>} */ let typeMap = {};
  /** How many entries of the change log THIS device has written (it appends only to its own segments, so two devices never write the same object). */
  let ownChanges = 0;

  /** Everything on the server, opened into process memory: types, records, and the change log (every device's segments merged by time). */
  const load = () => {
    known = new Map();
    /** @type {any[]} */ const types = [], records = [], changes = [];
    const kf = backend.get(keyFile); noteKnown(keyFile, kf);
    const typesRaw = backend.get(typesName); noteKnown(typesName, typesRaw);
    typeMap = typesRaw ? opened(typesRaw, "types") : {};
    for (const t of Object.values(typeMap)) types.push(t);
    for (const n of backend.list(`${dir(identity)}/rec`)) { const b = backend.get(n); if (!b) continue; noteKnown(n, b); records.push(opened(b, "rec")); }
    ownChanges = 0;
    for (const n of backend.list(`${dir(identity)}/chg`)) {
      const b = backend.get(n); if (!b) continue; noteKnown(n, b);
      const seg = opened(b, "chg");
      if (n.split("/").pop()?.startsWith(`${device}-`)) ownChanges += seg.length;
      changes.push(...seg);
    }
    changes.sort((x, y) => (x.at || 0) - (y.at || 0));
    changes.forEach((e, i) => { e.cursor = `c${i + 1}`; });
    return { types, records, changes };
  };
  /** A fingerprint of what the server holds, to see whether another device wrote. */
  const serverState = () => {
    const out = [];
    for (const n of [typesName, ...backend.list(`${dir(identity)}/rec`), ...backend.list(`${dir(identity)}/chg`)]) { const b = backend.get(n); if (b) out.push(`${n}:${sha(b)}`); }
    return out.sort().join("|");
  };
  /** The same fingerprint from what this device has read and written itself: equal to the server's when no other device has written. */
  const mine = () => [...known.entries()].filter(([n]) => n !== keyFile).map(([n, v]) => `${n}:${v.sha}`).sort().join("|");

  const usedBytes = () => { let n = 0; for (const v of known.values()) n += v.size; return n; };
  const capNow = () => (cfg.cap ? Number(cfg.cap()) || 0 : 0);
  const WRITES = new Set(["create", "update", "remove", "restore", "define"]);
  const conflict = () => { stale = true; return fail("version_conflict", "another of the person's devices changed this: it was reloaded, try again"); };
  /** One write: only if the object is what this device last saw; a second device's write is never overwritten. */
  const put = (/** @type {string} */ name, /** @type {Uint8Array} */ b) => {
    const was = known.get(name);
    if (typeof backend.putIf === "function") { if (!backend.putIf(name, b, was ? was.sha : null)) throw conflict(); } else backend.put(name, b);
    noteKnown(name, b);
  };
  const del = (/** @type {string} */ name) => { backend.delete(name); known.delete(name); };

  let stale = false;
  const build = () => {
    const loaded = load();
    return createMemoryStore({
      ...(cfg.clock ? { clock: cfg.clock } : {}),
      initial: loaded,
      hook: (op, args) => {
        if (!WRITES.has(op)) return;
        if (op === "define" && allow) for (const t of (args[0].add_types || [])) if (!allow.has(t.name)) throw fail("unsupported", `a personal store keeps only ${[...allow].join(", ")}`);
        const cap = capNow();
        if (cap > 0 && usedBytes() >= cap) throw fail("unavailable", "this person's storage on the server is full: the space owner sets the limit");
      },
      persist: {
        type: (name, def) => { if (def) typeMap[name] = def; else delete typeMap[name]; put(typesName, sealed(typeMap, "types")); },
        record: r => { put(`${dir(identity)}/rec/${nameOf(r.type, r.id)}`, sealed(r, "rec")); },
        change: e => {
          const n = Math.floor(ownChanges / SEG), name = `${dir(identity)}/chg/${device}-${n}`;
          const have = backend.get(name);
          const cur = have ? opened(have, "chg") : [];
          cur.push(e); ownChanges++;
          put(name, sealed(cur, "chg"));
        },
        destroy: (type, id) => del(`${dir(identity)}/rec/${nameOf(type, id)}`),
        scrub: (type, fields) => {
          for (const name of backend.list(`${dir(identity)}/chg`)) {
            const seg = opened(backend.get(name), "chg");
            for (const e of seg) if (e.type === type) for (const f of fields) { if (e.before) delete e.before[f]; if (e.after) delete e.after[f]; }
            put(name, sealed(seg, "chg"));
          }
        },
      },
    });
  };
  /** @type {any} */ let inner = build();
  /** Another device (or a failed write) changed what the server holds: read it again before answering, so the phone sees what the laptop wrote and the other way round. */
  const refresh = () => {
    if (!inner) return;
    if (!stale && serverState() === mine()) return;
    inner = build(); stale = false;
  };

  const locked = () => fail("unavailable", "the personal records are locked: they open for the person's own assistant after their yes");
  // The store a caller sees: every call goes to the live store, and none after `lock()`.
  // A backend with a remote behind it (core/memory/identity/remote-backend.js) is read before each call and flushed after each write, both asynchronous; a local folder needs neither.
  const remote = typeof backend.pull === "function" && typeof backend.flush === "function";
  const store = new Proxy({}, { get: (_t, prop) => { if (prop === "then") return undefined; if (prop === "version") return async () => ({ store: "sealed-personal", version: "1", conformance: CONFORMANCE_REVISION });
    return (/** @type {any[]} */ ...a) => {
      if (!inner) return Promise.reject(locked());
      if (!remote) {
        try { refresh(); } catch (e) { return Promise.reject(e); }
        const f = inner[prop];
        return typeof f === "function" ? f.apply(inner, a) : f;
      }
      return (async () => {
        await backend.pull();
        refresh();
        const f = inner[prop];
        if (typeof f !== "function") return f;
        const r = await f.apply(inner, a);
        if (WRITES.has(String(prop))) { try { await backend.flush(); } catch (e) { stale = true; throw conflict(); } }
        return r;
      })();
    }; } });
  return Object.freeze({
    store: /** @type {any} */ (store),
    /** The bytes on the server, the owner's limit, and what is left. */
    status: () => ({ used_bytes: usedBytes(), cap_bytes: capNow() }),
    /** Wipe the key and drop the in-memory rows: nothing is readable until it is opened again from the IMK. */
    lock() { key.fill(0); inner = null; known = new Map(); },
    get unlocked() { return inner !== null; },
  });
}

/**
 * The bytes a person's sealed records take on a server, counted from the storage alone (no key: the names and sizes of the objects are all that is read), so the app can show it while the store is
 * locked. @param {{ list(p: string): any, get(n: string): any }} backend @param {string} identity
 */
export function usageOf(backend, identity) {
  let n = 0;
  const walk = (/** @type {string} */ p, /** @type {number} */ depth) => {
    for (const name of backend.list(p)) {
      const b = backend.get(name);
      if (b) n += size(b); else if (depth < 3) walk(name, depth + 1);
    }
  };
  const base = dir(identity);
  const k = backend.get(`${base}/key.json`); if (k) n += size(k);
  const t = backend.get(`${base}/types.json`); if (t) n += size(t);
  walk(`${base}/rec`, 1); walk(`${base}/chg`, 1);
  return n;
}

/**
 * Open a sealed store over a remote backend: read the server's objects into the cache first (the store's core is synchronous). Same options as createSealedStore.
 * @param {Parameters<typeof createSealedStore>[0]} cfg
 */
export async function openSealedStore(cfg) {
  const b = /** @type {any} */ (cfg.backend);
  if (typeof b.pull === "function") await b.pull();
  const s = createSealedStore(cfg);
  if (typeof b.flush === "function") await b.flush();   // a store made here (the key file, first types) goes up now
  return s;
}

/** The folders of a person's sealed store on a server whose listing is one level deep (`spaces.storage.list`): the store's own folder and its two children, for RemoteBackend's `prefixes`. @param {string} identity */
export const sealedPrefixes = identity => [`${dir(identity)}`, `${dir(identity)}/rec`, `${dir(identity)}/chg`];
