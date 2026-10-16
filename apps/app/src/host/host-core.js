// @ts-check
// The in-page tool host, stage 1: the identity half of first run, for a page with no daemon (web.vyre.run, the Windows window, a Mac window with no vyred). It answers the SAME tool names and shapes as
// core/onboard (onboard.person.*, onboard.first.*) and core/identity (identity.status, unlock, lock), so the screens call one door whether a daemon or this answers. Nothing here is a second design: the
// identity chain and the directory claim are apps/app/src/identity/claim.js (kernel/identity/chain.js itself), the master record is master-web.js (byte-identical to kernel/identity/master.js), and the
// shapes come from lib/first-run-shape.js. What is kept at rest is JSON bytes only: the chain (public) and the master record (every key wrapped by the master password or the recovery key). The unlocked
// key lives in this object's memory until lock. Space steps are the next stage and answer `host_unsupported` until then.
import { claimIdentity } from "../identity/claim.js";
import { fromSeed } from "../identity/keys.js";
import { passwordOk, personRoutes, spaceAddressOf, usernameOf } from "../../../../lib/first-run-shape.js";
import { createMasterRecord, openMasterRecord } from "./master-web.js";
import { makeDeviceKey } from "./device-key.js";
import * as C from "../../../../kernel/identity/chain.js";
import { acceptKdf, bundleHash, deriveLogin, loginMessage, registerMessage } from "./login-web.js";

const bad = (/** @type {string} */ message, code = "bad_input") => Object.assign(new Error(message), { code });
const b64u = (/** @type {Uint8Array} */ b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (/** @type {string} */ s) => { const t = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0)); };

/**
 * @typedef {{ master: any, username: string, id: string, ops: unknown[], pin: unknown, device?: { pub: string, wrapped: { iv: string, ct: string } }, signin?: { space: string }, spaces?: { id: string, name: string, role: string, server: string | null }[], current?: string | null, progress?: { screen: string, stack: string[] } | null, done?: boolean }} Kept
 * @typedef {{ load(): Promise<Kept | null>, save(k: Kept): Promise<void> }} KeptStore
 */

/**
 * @param {{ store: KeptStore, directory: string, fetch?: typeof fetch, kdf?: { memoryKiB: number, passes: number }, random?: (n: number) => Uint8Array, now?: () => number, signin?: { base?: (space: string) => string, label?: string } }} o
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


  /** POST one step of the space's sign-in door: https://<space>.vyre.run/login, text/plain so the browser sends no preflight. The answer is the door's own JSON (kernel/identity/space-login.js shapes). */
  async function door(/** @type {string} */ space, /** @type {any} */ body) {
    const base = (o.signin && o.signin.base ? o.signin.base(space) : `https://${space}.vyre.run`).replace(/\/+$/, "");
    let res;
    try { res = await f(`${base}/login`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) }); }
    catch { throw bad("Cannot reach that space right now. Check the address and try again.", "unreachable"); }
    /** @type {any} */ let out = null;
    try { out = await res.json(); } catch { /* not JSON */ }
    if (!out || typeof out !== "object") throw bad("That address did not answer like a Vyre space. Check it and try again.", "unreachable");
    if (out.error) throw Object.assign(new Error(String(out.error.message || "That did not work.")), { code: String(out.error.code || "failed"), ...(out.error.retry ? { retry: out.error.retry } : {}) });
    return out;
  }

  /** The whole chain of a person from the names directory, checked, and the pin a later claim carries. @param {string} id */
  async function chainOf(id) {
    let res;
    try { res = await f(`${base}/v1/ids/resolve?id=${encodeURIComponent(id)}`); } catch { throw bad("Cannot reach the names directory right now.", "unreachable"); }
    /** @type {any} */ let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    const d = body && body.data;
    if (!res.ok || !d || !Array.isArray(d.ops)) throw bad("That identity is not in the directory.", "bad_login");
    const state = await C.verifyChain(d.ops, { now: o.now ? o.now() : Date.now() });
    if (state.id !== id) throw bad("That identity's chain does not match.", "bad_login");
    return { ops: d.ops, pin: C.pinOf(state) };
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
      await o.store.save({ master, username: name, id: made.id, ops: made.ops, pin: made.pin, device: makeDeviceKey(seed, o.random) });
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
      // A record made before the device key existed gets one now, wrapped under the identity just opened.
      if (!k.device) await o.store.save({ ...k, device: makeDeviceKey(held, o.random) });
      return { unlocked: true, username: k.username, id: k.id };
    },

    "identity.lock": async () => { if (held) held.fill(0); held = null; return { locked: true }; },

    // Sign in from any device: the space's address, the username, the master password. The space gives the username's salt, the device stretches the password itself, signs a single-use challenge, and
    // opens the returned record with the same key. Every refusal for a wrong name or password is the door's one bad_login answer.
    "onboard.signin": async ({ space, username, password }) => {
      const addr = spaceAddressOf(String(space || "").includes(".") ? space : `${String(space || "").trim()}.vyre.run`);
      const name = usernameOf(username);
      const BAD = "That username and password do not match.";
      if (!addr) throw bad("Use the address of a space, like juniper.vyre.run.");
      if (!name || !password) throw Object.assign(new Error(BAD), { code: "bad_login" });
      if (await o.store.load()) throw bad("This device already has an identity. Lock it and use its master password, or forget it first.", "exists");
      const begun = await door(addr.space, { op: "begin", username: name });
      const kdf = acceptKdf(begun.kdf);
      const d = await deriveLogin(String(password).normalize("NFKC"), String(begun.salt), kdf);
      /** @type {any} */ let done, keys;
      try {
        const sig = d.sign(loginMessage(addr.space, name, String(begun.challenge)));
        done = await door(addr.space, { op: "finish", username: name, challenge: begun.challenge, sig, device: { label: (o.signin && o.signin.label) || "This browser" } });
        if (!done.bundle || done.bundle.username !== name) throw Object.assign(new Error(BAD), { code: "bad_login" });
        keys = await openMasterRecord(done.bundle, { kek: d.K }).catch(() => { throw Object.assign(new Error(BAD), { code: "bad_login" }); });
      } finally { d.close(); }
      const chain = await chainOf(String(done.bundle.id));
      const seed = unb64(keys.privateKey);
      const row = { id: addr.space, name: addr.space, role: String(done.role || "member"), server: addr.address };
      await o.store.save({ master: done.bundle, username: name, id: String(done.bundle.id), ops: chain.ops, pin: chain.pin, device: makeDeviceKey(seed, o.random), signin: { space: addr.space }, spaces: [row], current: row.id });
      held = seed;
      return { username: name, id: String(done.bundle.id), spaces: [row] };
    },

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
    /**
     * The body that registers this identity's sign-in record at a space (op "register"), signed by the identity key: K is the password key of the stored master record (its own salt and cost), so the
     * login key and the record's wrap come from one stretch. The password is the person's, held in memory by the caller only until this is made. @param {string} space @param {string} password
     */
    async registerLogin(space, password) {
      const k = await o.store.load();
      if (!k) throw bad("Make your username first.", "no_identity");
      if (!held) throw bad("Unlock with your master password first.", "locked");
      const kdf = acceptKdf(k.master.kdf);
      const d = await deriveLogin(String(password).normalize("NFKC"), String(k.master.kdf.salt), kdf);
      try {
        const ts = o.now ? o.now() : Date.now();
        const pub = (await fromSeed(held)).publicKey;
        const sig = b64u(await (await fromSeed(held)).sign(registerMessage(space, k.username, d.loginPub, bundleHash(k.master), ts)));
        return { op: "register", username: k.username, person: k.id, pub, ts, sig, salt: String(k.master.kdf.salt), loginPub: d.loginPub, bundle: k.master };
      } finally { d.close(); }
    },
    /** The unlocked key for the identity's own signing (the next stage's pair code), or null while locked. */
    signer: () => (held ? { seed: held } : null),
  };
}
