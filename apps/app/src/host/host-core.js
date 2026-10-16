// @ts-check
// The in-page tool host, stage 1: the identity half of first run, for a page with no daemon (web.vyre.run, the Windows window, a Mac window with no vyred). It answers the SAME tool names and shapes as
// core/onboard (onboard.person.*, onboard.first.*) and core/identity (identity.status, unlock, lock), so the screens call one door whether a daemon or this answers. Nothing here is a second design: the
// identity chain and the directory claim are apps/app/src/identity/claim.js (kernel/identity/chain.js itself), the master record is master-web.js (byte-identical to kernel/identity/master.js), and the
// shapes come from lib/first-run-shape.js. What is kept at rest is JSON bytes only: the chain (public) and the master record (every key wrapped by the master password or the recovery key). The unlocked
// key lives in this object's memory until lock. Stage 2 (create a space) answers onboard.space.*: the install line is made here with the identity key (relay/client/pair-install.js, the one mint the
// app already uses, whose bytes lib/pair-code.js verifies), the server is found and paired through src/real/add-server.js over the relay, and what is kept is the space row and the paired server's
// name, never a key. Steps not in a stage answer `host_unsupported`.
import { claimIdentity } from "../identity/claim.js";
import { fromSeed } from "../identity/keys.js";
import { commandOk, inviteChainId, parseInvite, passwordOk, personRoutes, placeKind, spaceAddressOf, spaceKey, usernameOf } from "../../../../lib/first-run-shape.js";
import { mintPairCode } from "../../../../relay/client/pair-install.js";
import { createSetupKey, setupFingerprint } from "../../../../relay/client/setup.js";
import { createAddServer } from "../real/add-server.js";
import { createMasterRecord, openMasterRecord } from "./master-web.js";
import { makeDeviceKey } from "./device-key.js";
import * as C from "../../../../kernel/identity/chain.js";
import { githubSay } from "../identity/github-core.js";
import { actMessage } from "../../../../names/worker/id-messages.js";
import { acceptKdf, bundleHash, deriveLogin, loginMessage, registerMessage } from "./login-web.js";

/**
 * Is this key a DEVICE key on the person's checked chain? A sign-in that opens a record whose identity key the chain does not list as a device is refused: the server (or a swapped record) cannot hand a device
 * a key the person never published. @param {Uint8Array} seed @param {{ eid: string, kind: string }[]} entries
 */
export async function seedIsDeviceOnChain(seed, entries) {
  const key = await fromSeed(seed);
  return Array.isArray(entries) && entries.some((e) => e && e.eid === key.eid && e.kind === "device");
}

const bad = (/** @type {string} */ message, code = "bad_input") => Object.assign(new Error(message), { code });
const b64u = (/** @type {Uint8Array} */ b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (/** @type {string} */ s) => { const t = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0)); };

/**
 * @typedef {{ id: string, name: string, role: string, server: string | null, paired?: { box: string, route: string, relay: string, name: string } | null }} KeptSpace
 * @typedef {{ master: any, username: string, id: string, ops: unknown[], pin: unknown, device?: { pub: string, wrapped: { iv: string, ct: string } }, signin?: { space: string }, spaces?: KeptSpace[], current?: string | null, progress?: { screen: string, stack: string[] } | null, done?: boolean }} Kept
 * @typedef {{ load(): Promise<Kept | null>, save(k: Kept): Promise<void> }} KeptStore
 * The GitHub leg of sign-in, bound in the app (host/index.ts): `start` runs the GitHub sign-in (src/real/github.ts signInWithGithub: who GitHub says this is, and the session the relay holds), `assert` asks the relay for a short assertion
 * for one audience (a space's name, or "names" for the directory). @typedef {{ start(): Promise<{ ok: boolean, code?: string, session?: any, user?: { id: number, login: string } }>, assert(session: any, audience: string): Promise<string> }} GithubPorts
 * The outside things the space steps need (host/space-ports.ts binds them in the app; a test binds fakes or a real server over a real relay): the relay client's setup module, the relay's url, the setup channel,
 * the pairing the app already does with a server's ticket (it returns the pairing it made), the claim of the space's name (the paired server names its own space and the directory gets the record, signed by this identity), a call to the paired server, reading and accepting a join link through the team's own server, and forgetting a pairing.
 * @typedef {{ client: any, relay: string, connect: (o: any) => Promise<any>, pair: (qr: string, ctx: { pageKey?: unknown }, who: { id: string, name: string, pin: any, key: any }) => Promise<{ box: string, route: string, relay: string, name: string } | null>, claim: (who: { id: string, name: string, eid: string, ops: unknown[], key: any }, o: { name: string, route: { relay: string, route: string, box: string } }) => Promise<string>, call: (name: string, input: any, box: string) => Promise<any>, join?: (link: string, who: { id: string, name: string, pin: any, key: any }) => Promise<{ card: any, accept: () => Promise<any>, close: () => void }>, forget: (box: string) => Promise<void> }} SpacePorts
 */

/**
 * @param {{ store: KeptStore, directory: string, fetch?: typeof fetch, kdf?: { memoryKiB: number, passes: number }, random?: (n: number) => Uint8Array, now?: () => number, signin?: { base?: (space: string) => string, label?: string, deviceId?: () => Promise<string> | string }, github?: GithubPorts,
 *   space?: { load: () => Promise<SpacePorts> }, done?: () => Promise<void>, sleep?: (ms: number) => Promise<void>, pollMs?: number, version?: string | null }} o
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

  /** One run per install line this page made: the add-server run, what the person called the space, the pairing it made and whether it is kept. @type {Map<string, { run: ReturnType<typeof createAddServer>, name: string, kind: string, paired: any, saved: boolean, failed: any, space: string, vault: boolean }>} */
  const waits = new Map();
  /**
   * The link the join reads. An invite link is either `https://<space>.vyre.run/join/<token>` (names its space) or the one the owner shares, `https://vyre.run/i/<token>`, which names no server: the token carries the
   * space's chain id, and the names directory says which space has it. A directory that names the wrong space cannot send the person anywhere else, because the join checks the space's chain against the pin the
   * token carries (join-team.js openInvite) and a record that does not match is refused.
   * @param {string} text
   */
  async function joinLinkOf(text) {
    const p = parseInvite(text);
    if (!p) throw bad("That link does not open a space. Ask for a new invite.");
    if (p.legacy) return p.link;
    const chain = inviteChainId(p.token);
    if (!chain) throw bad("This invite does not say which space it is for. Ask for a new one.");
    let res;
    try { res = await f(`${base}/v1/ids/resolve?id=${encodeURIComponent(chain)}`, { headers: { accept: "application/json" } }); } catch { throw bad("Cannot reach the names directory right now.", "unreachable"); }
    /** @type {any} */ let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    const d = body && body.data;
    const name = d && d.kind === "space" && d.id === chain && typeof d.name === "string" ? d.name.replace(/\.vyre\.run$/, "") : "";
    if (!name || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw bad("That invite could not be matched to a space. Ask for a new one.", "not_found");
    return `https://${name}.vyre.run/join/${p.token}`;
  }

  /** The join cards read and not yet accepted, by link: the open stream is kept for the accept that follows. @type {Map<string, { card: any, accept: () => Promise<any>, close: () => void }>} */
  const invites = new Map();
  const stopRuns = () => { for (const w of waits.values()) w.run.stop(); };

  const unsupported = () => Object.assign(new Error("This step is not ready in the app yet."), { code: "host_unsupported" });
  /** Stage 2 needs the ports, and the unlocked identity: the line is signed by the identity key and the person's own yes is pressing Create. */
  async function spaceCtx() {
    if (!o.space) throw unsupported();
    const k = await o.store.load();
    if (!k) throw bad("Make your username first.", "no_identity");
    if (!held) throw bad("Unlock with your master password first.", "locked");
    return { k, ports: await o.space.load(), key: await fromSeed(held) };
  }
  /** @param {KeptSpace[]} rows */
  const outRows = (rows) => rows.map((s) => ({ id: s.id, name: s.name, role: s.role, server: s.server }));
  /** Keep the new space and the server it paired with, and make it the current one. */
  async function keepSpace(/** @type {Kept} */ k, /** @type {KeptSpace} */ row) {
    const rows = (k.spaces || []).filter((s) => s.id !== row.id && s.name !== row.name);
    await o.store.save({ ...k, spaces: [...rows, row], current: row.id });
  }


  /** This browser's stable device id (so a known browser does not ring the person's other devices on every sign-in) and its label. */
  async function deviceInfo() {
    const id = o.signin && o.signin.deviceId ? await o.signin.deviceId() : "";
    return { ...(/^[A-Za-z0-9_-]{8,64}$/.test(String(id)) ? { id: String(id) } : {}), label: (o.signin && o.signin.label) || "This browser" };
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
    return { ops: d.ops, pin: C.pinOf(state), entries: /** @type {any[]} */ (state.entries || []) };
  }

  /** The GitHub sign-in in progress: the relay session, the username the directory found, and the spaces it listed. Memory only, ten minutes. @type {{ session: any, username: string, spaces: { space: string, address: string }[], at: number } | null} */
  let pendingGithub = null;

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

    "identity.lock": async () => { stopRuns(); for (const i of invites.values()) { try { i.close(); } catch { /* gone */ } } invites.clear(); if (held) held.fill(0); held = null; pendingGithub = null; return { locked: true }; },

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
        done = await door(addr.space, { op: "finish", username: name, challenge: begun.challenge, sig, device: await deviceInfo() });
        if (!done.bundle || done.bundle.username !== name) throw Object.assign(new Error(BAD), { code: "bad_login" });
        keys = await openMasterRecord(done.bundle, { kek: d.K }).catch(() => { throw Object.assign(new Error(BAD), { code: "bad_login" }); });
      } finally { d.close(); }
      const chain = await chainOf(String(done.bundle.id));
      const seed = unb64(keys.privateKey);
      if (!(await seedIsDeviceOnChain(seed, chain.entries))) throw Object.assign(new Error(BAD), { code: "bad_login" });
      const row = { id: addr.space, name: addr.space, role: String(done.role || "member"), server: addr.address };
      await o.store.save({ master: done.bundle, username: name, id: String(done.bundle.id), ops: chain.ops, pin: chain.pin, device: makeDeviceKey(seed, o.random), signin: { space: addr.space }, spaces: [row], current: row.id });
      held = seed;
      return { username: name, id: String(done.bundle.id), spaces: [row] };
    },

    // Sign in with GitHub: the relay vouches for the GitHub account with a short assertion; the names directory answers with the spaces that account's linked username belongs to (only to a valid assertion);
    // the master password is asked ONCE, next, and opens the bundle each space returns. Nothing about the password reaches any server.
    "onboard.signin.github": async ({ space } = {}) => {
      if (!o.github) throw Object.assign(new Error("This step is not ready in the app yet."), { code: "host_unsupported" });
      if (await o.store.load()) throw bad("This device already has an identity. Lock it and use its master password, or forget it first.", "exists");
      const started = await o.github.start();
      if (!started.ok || !started.session) throw Object.assign(new Error(githubSay(started.code)), { code: started.code || "denied" });
      /** @type {{ space: string, address: string }[]} */ let spaces = [];
      let username = "";
      // The directory's list of this GitHub account's spaces, when it has one (only a valid assertion gets it). Without one (the list is not there yet, or the account is not linked), the person's own space
      // address, typed on the sign-in screen, is the one space to log in to; the space's reply names the rest.
      try {
        const assertion = await o.github.assert(started.session, "names");
        const res = await f(`${base}/v1/ids/spaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assertion }) });
        /** @type {any} */ const body = await res.json().catch(() => null);
        const d = body && body.data;
        if (res.ok && d && Array.isArray(d.spaces)) {
          username = String(d.username || "");
          spaces = /** @type {any} */ (d.spaces.map((/** @type {any} */ x) => spaceAddressOf(String(x.address || `${x.name}.vyre.run`))).filter(Boolean));
        }
      } catch { /* no list: the typed address below */ }
      if (!spaces.length) {
        const typed = space ? spaceAddressOf(String(space).includes(".") ? space : `${String(space).trim()}.vyre.run`) : null;
        if (!typed) throw Object.assign(new Error("Type the address of a space you belong to, then continue with GitHub again."), { code: "needs_space" });
        spaces = [typed];
      }
      pendingGithub = { session: started.session, username, spaces, at: Date.now() };
      return { login: pendingGithub.username, spaces: spaces.map((x) => ({ id: x.space, name: x.space, role: "member", server: x.address })) };
    },

    // The master password, once, after GitHub: log in to each space the directory listed (each asks for its own assertion), stretch the password with the first space's salt, and open its bundle.
    "onboard.signin.unlock": async ({ password }) => {
      const BAD = "That password does not unlock this identity. Try again.";
      const pend = pendingGithub;
      if (!pend || Date.now() - pend.at > 10 * 60_000 || !o.github) throw bad("Start with GitHub again.", "expired");
      if (!password) throw bad("Enter your master password on this device.", "person_enters");
      /** @type {{ space: string, address: string, role: string }[]} */ const opened = [];
      /** @type {any} */ let first = null, keys = null;
      for (const sp of pend.spaces) {
        let done;
        try {
          const assertion = await o.github.assert(pend.session, sp.space);
          done = await door(sp.space, { op: "github", assertion, device: await deviceInfo() });
        } catch (e) { if (!first) throw e; continue; }
        if (!done.bundle) continue;
        if (!first) {
          const d = await deriveLogin(String(password).normalize("NFKC"), String(done.salt), acceptKdf(done.kdf));
          try { keys = await openMasterRecord(done.bundle, { kek: d.K }).catch(() => { throw Object.assign(new Error(BAD), { code: "bad_password" }); }); }
          finally { d.close(); }
          first = done;
        }
        opened.push({ space: sp.space, address: sp.address, role: String(done.role || "member") });
      }
      if (!first || !keys) throw bad("None of your spaces answered. Try again.", "unreachable");
      const chain = await chainOf(String(first.bundle.id));
      const seed = unb64(keys.privateKey);
      if (!(await seedIsDeviceOnChain(seed, chain.entries))) throw Object.assign(new Error(BAD), { code: "bad_password" });
      const rows = opened.map((x) => ({ id: x.space, name: x.space, role: x.role, server: x.address }));
      await o.store.save({ master: first.bundle, username: String(first.bundle.username), id: String(first.bundle.id), ops: chain.ops, pin: chain.pin, device: makeDeviceKey(seed, o.random), signin: { space: opened[0].space }, spaces: rows, current: rows[0].id });
      held = seed;
      pendingGithub = null;
      return { username: String(first.bundle.username), id: String(first.bundle.id), spaces: rows };
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
      // The Windows app starts hidden in the tray from now on (shell.ts shellSetupDone); a page with no such shell has nothing to tell.
      if (o.done) { try { await o.done(); } catch { /* the shell opens its window until this lands */ } }
      return { done: true };
    },
    "onboard.status": async () => {
      const k = await o.store.load();
      return { firstRun: k && k.done ? "done" : "open", person: k ? k.username : null };
    },

    "onboard.space.open": async ({ kind, name }) => {
      const { k, ports, key } = await spaceCtx();
      const place = placeKind(kind);
      if (!place) throw bad("Pick a Linux server or an always-on Mac.");
      const label = usernameOf(name) || "space";
      stopRuns();
      const random = o.random || ((n) => crypto.getRandomValues(new Uint8Array(n)));
      const run = createAddServer({
        client: ports.client, relay: ports.relay, autoPair: true,
        issue: async () => {
          const setupKey = await createSetupKey();
          const secret = random(16);
          const minted = await mintPairCode({ person: k.id, publicKey: key.publicKey, secret, fingerprint: await setupFingerprint(setupKey.spki), sign: (m) => key.sign(m), ...(o.now ? { now: o.now } : {}), random });
          return { code: minted.code, secret, key: setupKey, expiresAt: minted.exp * 1000 };
        },
        identity: async () => ({ id: k.id }),
        connect: ports.connect,
        pair: async (qr, ctx) => {
          const made = await ports.pair(qr, ctx || {}, { id: k.id, name: k.username, pin: k.pin, key });
          const w = waits.get(id);
          if (w) w.paired = made;
        },
        ...(o.random ? { random } : {}), ...(o.now ? { now: o.now } : {}), ...(o.sleep ? { sleep: o.sleep } : {}), ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}), version: o.version ?? null,
      });
      const id = `fr_${Array.from(random(8), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      waits.set(id, { run, name: label, kind: place, paired: null, saved: false, failed: null, space: "", vault: false });
      await run.begin("records", place);
      const st = run.state;
      if (st.stage === "stopped" || !commandOk(st.installLine)) { waits.delete(id); throw bad(st.error ? st.error.message : "The install command is not one this app can show.", st.error ? st.error.code : "bad_input"); }
      return { id, command: st.installLine, expiresAt: new Date(st.expiresAt).toISOString(), kind: place, name: label, spaceId: spaceKey("", label) || null, role: "owner" };
    },

    "onboard.space.poll": async ({ id }) => {
      const w = waits.get(String(id || ""));
      if (!w) throw bad("That install is not one this device started.");
      const st = w.run.state;
      const base = { id: String(id), kind: w.kind, expiresAt: new Date(st.expiresAt || 0).toISOString() };
      if (st.stage === "done") {
        const { k, ports, key } = await spaceCtx();
        const p = w.paired;
        const hostname = (p && p.name) || (st.box && st.box.name) || "";
        if (w.failed) return { ...base, online: false, expired: false, failed: true, ...w.failed, canRemove: Boolean(p && p.box), canRename: w.failed.code === "taken" || w.failed.code === "name_taken" };
        if (!w.saved) {
          // The server is paired. Now the space is usable: the paired server names its own space and the directory gets the record signed by this identity (so <space>.vyre.run signs in), the space vault is made on
          // that server, and the space is added to the person's list in the directory so GitHub sign-in finds it. Each step is done once; only the last (the directory being unreachable) is tried again on the next poll.
          if (!p || !p.box) { w.failed = { code: "pair", message: "Your server did not finish connecting. Start again." }; return { ...base, online: false, expired: false, failed: true, ...w.failed, canRemove: false }; }
          if (!w.space) {
            try { w.space = await ports.claim({ id: k.id, name: k.username, eid: key.eid, ops: k.ops, key }, { name: w.name, route: { relay: p.relay, route: p.route, box: p.box } }); }
            catch (e) {
              const x = /** @type {any} */ (e);
              w.failed = { code: String((x && x.code) || "claim"), message: String((x && x.message) || "The space could not be made.").slice(0, 300) };
              return { ...base, online: false, expired: false, failed: true, ...w.failed, canRemove: true, canRename: w.failed.code === "taken" || w.failed.code === "name_taken" };
            }
          }
          if (!w.vault) {
            try { await ports.call("vault.space.create", { space: w.space }, p.box); }
            catch (e) {
              const x = /** @type {any} */ (e);
              if (!x || x.code !== "exists") {
                w.failed = { code: String((x && x.code) || "vault"), message: String((x && x.message) || "The space vault could not be made.").slice(0, 300) };
                return { ...base, online: false, expired: false, failed: true, ...w.failed, canRemove: true };
              }
            }
            w.vault = true;
          }
          try { await api.publishSpace(w.name, "add"); }
          catch (e) {
            const x = /** @type {any} */ (e);
            return { ...base, online: false, expired: false, failed: true, code: String((x && x.code) || "directory"), message: String((x && x.message) || "The names directory did not take the space. Trying again.").slice(0, 300), canRemove: true, retrying: true };
          }
          await keepSpace(k, { id: w.space || spaceKey("", w.name), name: w.name, role: "owner", server: `https://${w.name}.vyre.run`, paired: p });
          w.saved = true;
        }
        const row = ((await o.store.load())?.spaces || []).find((s) => s.name === w.name);
        return { ...base, online: true, expired: false, space: row ? row.id : spaceKey("", w.name), server: { hostname, address: `https://${w.name}.vyre.run`, space: w.name, name: hostname, route: (p && p.route) || "", box: (p && p.box) || "" }, canRemove: true };
      }
      if (st.stage === "stopped") {
        const code = st.error ? st.error.code : "stopped";
        const message = st.error ? st.error.message : "The install stopped. Show a new command.";
        // Two servers answered one line: nothing was paired and nothing will be. The only way on is a new line.
        if (code === "contested") return { ...base, online: false, expired: false, contested: true, message };
        if (code === "expired") return { ...base, online: false, expired: true, message: "The install window ended. Go back and show a new command." };
        return { ...base, online: false, expired: false, failed: true, code, message };
      }
      if (st.stage === "found" || st.stage === "pairing") return { ...base, online: false, expired: false, connecting: true, ...(st.box ? { found: { name: st.box.name } } : {}) };
      return { ...base, online: false, expired: false };
    },

    // The directory said the name is taken: pick another and the claim is tried again on the same paired server.
    "onboard.space.name": async ({ id, name }) => {
      const w = waits.get(String(id || ""));
      if (!w) throw bad("That install is not one this device started.");
      const label = usernameOf(name);
      if (!label) throw bad("A space name is lowercase letters, digits and hyphens, 3 to 20 characters, starting with a letter.");
      w.name = label; w.failed = null;
      return { id: String(id), name: label };
    },

    "onboard.join.read": async ({ link }) => {
      const { k, ports, key } = await spaceCtx();
      if (!ports.join) throw unsupported();
      const text = String(link || "").trim();
      if (!text) throw bad("That link does not open a space. Ask for a new invite.");
      const inv = await ports.join(await joinLinkOf(text), { id: k.id, name: k.username, pin: k.pin, key });
      const was = invites.get(text);
      if (was) was.close();
      invites.set(text, inv);
      const c = inv.card || {};
      return { link: text, role: String(c.role || "member"), space: String(c.space || "").replace(/\.vyre\.run$/, "") || null, ttlDays: null, ...(c.fingerprint_words ? { fingerprint_words: String(c.fingerprint_words) } : {}) };
    },

    // Join a space with the role on the link; the space is then added to this username's list in the directory (so GitHub sign-in finds it), as on create. The list line is best effort once the person is a member.
    "onboard.space.join": async ({ link }) => {
      const { k, ports, key } = await spaceCtx();
      if (!ports.join) throw unsupported();
      const text = String(link || "").trim();
      if (!text) throw bad("That link does not open a space. Ask for a new invite.");
      const inv = invites.get(text) || await ports.join(await joinLinkOf(text), { id: k.id, name: k.username, pin: k.pin, key });
      invites.delete(text);
      /** @type {any} */ let r;
      try { r = await inv.accept(); } finally { inv.close(); }
      const c = inv.card || {};
      const name = String(c.space || "").replace(/\.vyre\.run$/, "");
      const role = String((r && r.membership && r.membership.role) || c.role || "member");
      const id = String((r && r.space) || "") || spaceKey("", name);
      const fresh = (await o.store.load()) || k;
      await keepSpace(fresh, { id, name: name || id, role, server: name ? `https://${name}.vyre.run` : null, paired: null });
      let listed = false;
      if (name) { try { await api.publishSpace(name, "add"); listed = true; } catch { /* a member already; the line is added the next time this space is published */ } }
      return { joined: true, space: name || null, id, role, server: name ? `https://${name}.vyre.run` : null, listed };
    },

    "onboard.space.list": async () => {
      const k = await o.store.load();
      if (!k) throw bad("Make your username first.", "no_identity");
      return { person: k.username, id: k.id, current: k.current || null, spaces: outRows(k.spaces || []) };
    },

    "onboard.space.current": async ({ space }) => {
      const k = await o.store.load();
      if (!k) throw bad("Make your username first.", "no_identity");
      const want = String(space || "");
      const hit = (k.spaces || []).find((s) => s.id === want || s.name === want);
      if (!hit) throw bad("That space is not one this identity belongs to.");
      await o.store.save({ ...k, current: hit.id });
      return { current: hit.id, name: hit.name, role: hit.role, server: hit.server };
    },

    // "Not your server? Remove it": forget the pairing this page made and the space row that came with it. The person's own yes was pressing Create; this is the way back from a stand-in.
    "onboard.space.remove": async ({ space }) => {
      if (!o.space) throw unsupported();
      const k = await o.store.load();
      if (!k) throw bad("Make your username first.", "no_identity");
      const want = String(space || "");
      const hit = (k.spaces || []).find((s) => s.id === want || s.name === want);
      if (!hit) throw bad("That space is not one this identity belongs to.");
      const ports = await o.space.load();
      if (hit.paired && hit.paired.box) await ports.forget(hit.paired.box);
      stopRuns();
      for (const [wid, w] of waits) if (w.name === hit.name) waits.delete(wid);
      const rest = (k.spaces || []).filter((s) => s.id !== hit.id);
      await o.store.save({ ...k, spaces: rest, current: k.current === hit.id ? (rest[0] ? rest[0].id : null) : k.current || null });
      // The directory's list for this username drops the space too, so GitHub sign-in stops offering it. Best effort: the space is already gone here, and a locked page or an unreachable directory leaves a stale line the directory ignores when the space does not answer.
      let unpublished = false;
      try { await api.publishSpace(hit.name, "remove"); unpublished = true; } catch { /* stale line at most */ }
      return { removed: true, id: hit.id, unpublished };
    },
  };

  /** The host's own methods; the space steps call publishSpace through it. */
  const api = {
    /** Does this host answer that tool name? */
    has: (/** @type {string} */ name) => name in tools && (Boolean(o.space) || !/^onboard\.(space|join)\./.test(name)),
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
    /**
     * Add (or remove) a space address in the names directory's list for this username, signed by the identity as an act (`space-add` / `space-remove`), so GitHub sign-in can find the person's spaces. Called when a space
     * is created or joined. @param {string} space the space's name (juniper) @param {"add" | "remove"} [what]
     */
    async publishSpace(space, what = "add") {
      const k = await o.store.load();
      if (!k) throw bad("Make your username first.", "no_identity");
      if (!held) throw bad("Unlock with your master password first.", "locked");
      const addr = spaceAddressOf(`${String(space).replace(/\.vyre\.run$/, "")}.vyre.run`);
      if (!addr) throw bad("That is not a space address.");
      const key = await fromSeed(held);
      const ts = o.now ? o.now() : Date.now();
      const domain = `${addr.space}.vyre.run`;
      const sig = b64u(await key.sign(actMessage({ action: `space-${what}`, name: k.username, domain, ts })));
      let res;
      try { res = await f(`${base}/v1/ids/spaces/${what}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: k.username, address: domain, act: { by: key.eid, ts, sig } }) }); } catch { throw bad("Cannot reach the names directory right now.", "unreachable"); }
      if (!res.ok) throw bad("The names directory did not take the space.", "directory");
      return { ok: true, address: domain };
    },
    /** The unlocked key for the identity's own signing (the next stage's pair code), or null while locked. */
    signer: () => (held ? { seed: held } : null),
  };
  return api;
}
