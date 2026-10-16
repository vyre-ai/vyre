// @ts-check
// The in-page tool host, stage 1: the identity half of first run, for a page with no daemon (web.vyre.run, the Windows window, a Mac window with no vyred). It answers the SAME tool names and shapes as
// core/onboard (onboard.person.*, onboard.first.*) and core/identity (identity.status, unlock, lock), so the screens call one door whether a daemon or this answers. Nothing here is a second design: the
// identity chain and the directory claim are apps/app/src/identity/claim.js (kernel/identity/chain.js itself), the master record is master-web.js (byte-identical to kernel/identity/master.js), and the
// shapes come from lib/first-run-shape.js. What is kept at rest is JSON bytes only: the chain (public) and the master record (every key wrapped by the master password or the recovery key). The unlocked
// key lives in this object's memory until lock. Space steps are the next stage and answer `host_unsupported` until then.
import { claimIdentity } from "../identity/claim.js";
import { fromSeed } from "../identity/keys.js";
import { passwordOk, personRoutes, usernameOf } from "../../../../lib/first-run-shape.js";
import { createMasterRecord, openMasterRecord } from "./master-web.js";

const bad = (/** @type {string} */ message, code = "bad_input") => Object.assign(new Error(message), { code });
const b64u = (/** @type {Uint8Array} */ b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (/** @type {string} */ s) => { const t = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0)); };

/**
 * @typedef {{ master: any, username: string, id: string, ops: unknown[], pin: unknown, progress?: { screen: string, stack: string[] } | null, done?: boolean }} Kept
 * @typedef {{ load(): Promise<Kept | null>, save(k: Kept): Promise<void> }} KeptStore
 */

/**
 * @param {{ store: KeptStore, directory: string, fetch?: typeof fetch, kdf?: { memoryKiB: number, passes: number }, random?: (n: number) => Uint8Array, now?: () => number }} o
 */
export function createHost(o) {
  const f = o.fetch || globalThis.fetch.bind(globalThis);
  const base = o.directory.replace(/\/+$/, "");
  /** The unlocked identity key, in memory only. @type {Uint8Array | null} */
  let held = null;

  async function reserve(/** @type {string} */ name) {
    let res;
    try { res = await f(`${base}/v1/ids/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); }
    catch { throw bad("Cannot reach the names directory right now.", "unreachable"); }
    /** @type {any} */ let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (res.status === 200 && body && body.data && typeof body.data.code === "string") return String(body.data.code);
    const code = body && body.error && body.error.code;
    throw bad(code === "name_taken" || code === "taken" ? "That name is taken." : code === "rate_limited" ? "Too many names were claimed from here today. Try again tomorrow." : "That name cannot be claimed right now. Try another.", code || "reserve");
  }

  /** @type {Record<string, (input: any) => Promise<any>>} */
  const tools = {
    "onboard.person.lookup": async ({ username }) => {
      const name = usernameOf(username);
      if (!name) return { ok: false, reason: "invalid" };
      return { ok: true, username: name, ...personRoutes(name) };
    },

    "onboard.person.status": async () => {
      const k = await o.store.load();
      return { exists: Boolean(k), username: k ? k.username : null, id: k ? k.id : null, current: null, spaces: [], ...(k ? personRoutes(k.username) : {}) };
    },

    "onboard.person.create": async ({ username, password, confirm }) => {
      const name = usernameOf(username);
      if (!name) throw bad("A username is lowercase letters, digits and hyphens, 3 to 20 characters, starting with a letter.");
      if (!passwordOk(password)) throw bad("Use a master password of at least 12 characters, and not a common one.");
      if (confirm !== undefined && confirm !== password) throw bad("Type the master password the same way twice.");
      const existing = await o.store.load();
      if (existing) return { username: existing.username, id: existing.id, ...personRoutes(existing.username), recoveryKey: null, once: false, already: true };
      const seed = (o.random || ((n) => crypto.getRandomValues(new Uint8Array(n))))(32);
      const key = await fromSeed(seed);
      const code = await reserve(name);
      const made = await claimIdentity({ name, code, base, key, fetch: f, ...(o.random ? { random: o.random } : {}), ...(o.now ? { now: o.now } : {}) });
      const master = await createMasterRecord({ username: name, id: made.id, password, recoveryCode: made.recoveryCode, privateKey: b64u(seed), agreePrivate: null, ...(o.kdf ? { kdf: o.kdf } : {}) });
      await o.store.save({ master, username: name, id: made.id, ops: made.ops, pin: made.pin });
      held = seed;
      return { username: name, id: made.id, ...personRoutes(name), recoveryKey: made.recoveryCode, once: true, already: false };
    },

    "identity.status": async () => {
      const k = await o.store.load();
      if (!k) return { exists: false, unlocked: false, username: null, id: null, url: null, private: true, github: null, needsMigration: false };
      return { exists: true, unlocked: held !== null, username: k.username, id: k.id, url: personRoutes(k.username).route, private: true, github: null, needsMigration: false };
    },

    "identity.unlock": async ({ password, recovery }) => {
      if ((password == null || password === "") && (recovery == null || recovery === "")) throw bad("Enter your master password on this device.", "person_enters");
      const k = await o.store.load();
      if (!k) throw bad("There is no master password on this device yet. Create your username first.", "no_identity");
      const keys = await openMasterRecord(k.master, recovery ? { recovery } : { password });
      held = unb64(keys.privateKey);
      return { unlocked: true, username: k.username, id: k.id };
    },

    "identity.lock": async () => { if (held) held.fill(0); held = null; return { locked: true }; },

    "onboard.first.progress": async () => {
      const k = await o.store.load();
      return k && k.progress ? { ok: true, ...k.progress } : { ok: true, screen: null, stack: [] };
    },
    "onboard.first.progress.save": async ({ screen, stack }) => {
      const k = await o.store.load();
      if (!k) return { saved: false };
      await o.store.save({ ...k, progress: { screen: String(screen || ""), stack: Array.isArray(stack) ? stack.map(String) : [] } });
      return { saved: true };
    },
    "onboard.first.done": async () => {
      const k = await o.store.load();
      if (k) await o.store.save({ ...k, done: true, progress: null });
      return { done: true };
    },
    "onboard.status": async () => {
      const k = await o.store.load();
      return { firstRun: k && k.done ? "done" : "open", person: k ? k.username : null };
    },
  };

  return {
    /** Does this host answer that tool name? */
    has: (/** @type {string} */ name) => name in tools,
    /** Answer a tool, or throw what the daemon would throw. Names this stage does not have say so plainly. @param {string} name @param {any} [input] */
    async call(name, input = {}) {
      const fn = tools[name];
      if (!fn) throw Object.assign(new Error("This step is not ready in the app yet."), { code: "host_unsupported" });
      return fn(input || {});
    },
    /** The unlocked key for the identity's own signing (the next stage's pair code), or null while locked. */
    signer: () => (held ? { seed: held } : null),
  };
}
