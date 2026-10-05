// @ts-check
// kernel/store/sealed.js: the encrypted personal records store (team/0.3/DESIGN-personal-records.md). A Personal person in a team (Cloud) Space keeps their Planner, reminders, notes and personal
// to-dos here: the whole Store interface (kernel/store/memory.js, the reference store, so every rule and every query is the one the conformance suite already holds) with its state held in process
// memory only while the person's yes stands, and written to the server's storage only as ciphertext.
//
// Key: one random records key (PK), sealed under the person's identity memory key (the IMK of core/memory/identity), so the person's one yes that unlocks the identity home unlocks this too; nothing
// else holds it. A server stores, under `personal/<identity>/`: key.json (PK sealed under the IMK), types.json (sealed), rec/<id> (one sealed blob per record, named by an HMAC so a type and an
// id do not show) and chg/<n> (the change log in sealed segments). The "due between" kind of question is the store's own query over a decrypted-in-process table: no index is written in the clear.
// Only the fixed types a Personal person keeps here may be defined; anything else is refused. A per-member cap (set by the space owner) refuses writes once the stored bytes reach it.
import crypto from "node:crypto";
import { createMemoryStore } from "./memory.js";
import { newKey, seal, open } from "../../lib/keywrap.js";

const SEG = 200;
/** The types a Personal person keeps sealed on a server: Planner items, notes, to-dos, and the Planner's own bookkeeping (alarms, repeats, snoozes). */
export const PERSONAL_TYPES = Object.freeze(["reminder", "note", "task", "planner_alarm", "planner_repeat", "planner_state"]);

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const dir = (/** @type {string} */ id) => `personal/${id}`;
const aad = (/** @type {string} */ id, /** @type {string} */ what) => `vyre-personal-records/${id}/${what}`;
const enc = (/** @type {any} */ v) => Buffer.from(JSON.stringify(v), "utf8");
const dec = (/** @type {any} */ b) => (b ? JSON.parse(Buffer.from(b).toString("utf8")) : null);
const bytes = (/** @type {any} */ b) => (b ? Buffer.byteLength(b) : 0);

/**
 * @param {{ backend: { put(n: string, b: Buffer|string): any, get(n: string): any, list(p: string): any, delete(n: string): any }, identity: string, imk: Buffer, allow?: readonly string[],
 *   cap?: () => number, clock?: () => number, create?: boolean }} cfg `cap()` is the owner's per-member limit in bytes (0 or absent: none); `create` makes the store the first time
 */
export function createSealedStore(cfg) {
  const { backend, identity } = cfg;
  const allow = new Set(cfg.allow || PERSONAL_TYPES);
  const keyFile = `${dir(identity)}/key.json`;
  /** @type {Buffer | null} */ let pk = null;
  const raw = backend.get(keyFile);
  if (raw) {
    try { pk = open(dec(raw).box, cfg.imk, aad(identity, "key")); } catch { throw fail("denied", "the identity memory key does not open this store"); }
  } else if (cfg.create) {
    pk = newKey();
    backend.put(keyFile, enc({ v: 1, box: seal(pk, cfg.imk, aad(identity, "key")) }));
  } else throw fail("not_found", "no personal records store here");
  const key = /** @type {Buffer} */ (pk);
  const idKey = Buffer.from(crypto.hkdfSync("sha256", key, Buffer.alloc(0), Buffer.from("vyre-personal-record-name"), 32));
  const nameOf = (/** @type {string} */ type, /** @type {string} */ id) => crypto.createHmac("sha256", idKey).update(`${type}\u0000${id}`).digest("hex");
  const sealed = (/** @type {any} */ v, /** @type {string} */ what) => enc(seal(JSON.stringify(v), key, aad(identity, what)));
  const opened = (/** @type {any} */ b, /** @type {string} */ what) => JSON.parse(open(dec(b), key, aad(identity, what)).toString("utf8"));

  // what is on the server now, and its size, so the cap and the status are exact
  /** @type {Map<string, number>} */ const sizes = new Map();
  const put = (/** @type {string} */ name, /** @type {Buffer} */ b) => { backend.put(name, b); sizes.set(name, b.length); };
  const del = (/** @type {string} */ name) => { backend.delete(name); sizes.delete(name); };
  for (const n of [keyFile]) sizes.set(n, bytes(backend.get(n)));

  // load: types, records and the change log, opened into process memory
  /** @type {any[]} */ const types = [], records = [], changes = [];
  const typesRaw = backend.get(`${dir(identity)}/types.json`);
  if (typesRaw) { sizes.set(`${dir(identity)}/types.json`, bytes(typesRaw)); for (const t of Object.values(opened(typesRaw, "types"))) types.push(t); }
  for (const n of backend.list(`${dir(identity)}/rec`)) { const b = backend.get(n); sizes.set(n, bytes(b)); records.push(opened(b, "rec")); }
  const segs = backend.list(`${dir(identity)}/chg`).sort((/** @type {string} */ a, /** @type {string} */ b) => Number(a.split("/").pop()) - Number(b.split("/").pop()));
  for (const n of segs) { const b = backend.get(n); sizes.set(n, bytes(b)); changes.push(...opened(b, "chg")); }
  let nChanges = changes.length;
  const typeMap = Object.fromEntries(types.map(t => [t.name, t]));

  const usedBytes = () => { let n = 0; for (const v of sizes.values()) n += v; return n; };
  const capNow = () => (cfg.cap ? Number(cfg.cap()) || 0 : 0);
  const WRITES = new Set(["create", "update", "remove", "restore", "define"]);

  /** @type {any} */ let inner = createMemoryStore({
    ...(cfg.clock ? { clock: cfg.clock } : {}),
    initial: { types, records, changes },
    hook: (op, args) => {
      if (!WRITES.has(op)) return;
      if (op === "define") { for (const t of (args[0].add_types || [])) if (!allow.has(t.name)) throw fail("unsupported", `a personal store keeps only ${[...allow].join(", ")}`); for (const t of (args[0].change_types || [])) if (!allow.has(t.name)) throw fail("unsupported", "not a personal type"); }
      const cap = capNow();
      if (cap > 0 && usedBytes() >= cap) throw fail("unavailable", "this person's storage on the server is full: the space owner sets the limit");
    },
    persist: {
      type: (name, def) => { if (def) typeMap[name] = def; else delete typeMap[name]; put(`${dir(identity)}/types.json`, sealed(typeMap, "types")); },
      record: r => { if (!allow.has(r.type)) return; put(`${dir(identity)}/rec/${nameOf(r.type, r.id)}`, sealed(r, "rec")); },
      change: e => {
        const n = Math.floor(nChanges / SEG), name = `${dir(identity)}/chg/${n}`;
        const cur = n * SEG < nChanges && backend.get(name) ? opened(backend.get(name), "chg") : [];
        cur.push(e); nChanges++;
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

  const locked = () => fail("unavailable", "the personal records are locked: they open for the person's own assistant after their yes");
  // The store a caller sees: every call goes to the live store, and none after `lock()`.
  const store = new Proxy({}, { get: (_t, prop) => { if (prop === "then") return undefined; return (/** @type {any[]} */ ...a) => { if (!inner) return Promise.reject(locked()); const f = inner[prop]; return typeof f === "function" ? f.apply(inner, a) : f; }; } });
  return Object.freeze({
    store: /** @type {any} */ (store),
    /** The bytes on the server, the owner's limit, and what is left. */
    status: () => ({ used_bytes: usedBytes(), cap_bytes: capNow() }),
    /** Wipe the key and drop the in-memory rows: nothing is readable until it is opened again from the IMK. */
    lock() { key.fill(0); inner = null; },
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
      if (b) n += Buffer.byteLength(b); else if (depth < 3) walk(name, depth + 1);
    }
  };
  const base = dir(identity);
  const k = backend.get(`${base}/key.json`); if (k) n += Buffer.byteLength(k);
  const t = backend.get(`${base}/types.json`); if (t) n += Buffer.byteLength(t);
  walk(`${base}/rec`, 1); walk(`${base}/chg`, 1);
  return n;
}
