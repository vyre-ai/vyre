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
import { commandOk, passwordOk, personRoutes, placeKind, spaceKey, usernameOf } from "../../../../lib/first-run-shape.js";
import { mintPairCode } from "../../../../relay/client/pair-install.js";
import { createSetupKey, setupFingerprint } from "../../../../relay/client/setup.js";
import { createAddServer } from "../real/add-server.js";
import { createMasterRecord, openMasterRecord } from "./master-web.js";

const bad = (/** @type {string} */ message, code = "bad_input") => Object.assign(new Error(message), { code });
const b64u = (/** @type {Uint8Array} */ b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (/** @type {string} */ s) => { const t = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0)); };

/**
 * @typedef {{ id: string, name: string, role: string, server: string | null, paired?: { box: string, route: string, relay: string, name: string } | null }} KeptSpace
 * @typedef {{ master: any, username: string, id: string, ops: unknown[], pin: unknown, progress?: { screen: string, stack: string[] } | null, done?: boolean, spaces?: KeptSpace[], current?: string | null }} Kept
 * @typedef {{ load(): Promise<Kept | null>, save(k: Kept): Promise<void> }} KeptStore
 * The outside things stage 2 needs (host/space-ports.ts binds them in the app; a test binds fakes or a real server over a real relay): the relay client's setup module, the relay's url, the setup channel,
 * the pairing the app already does with a server's ticket (it returns the pairing it made), the claim of the space's name (the paired server names its own space and the directory gets the record, signed by this identity), a call to the paired server, and forgetting a pairing.
 * @typedef {{ client: any, relay: string, connect: (o: any) => Promise<any>, pair: (qr: string, ctx: { pageKey?: unknown }, who: { id: string, name: string, pin: any, key: any }) => Promise<{ box: string, route: string, relay: string, name: string } | null>, claim: (who: { id: string, name: string, eid: string, ops: unknown[], key: any }, o: { name: string, route: { relay: string, route: string, box: string } }) => Promise<string>, call: (name: string, input: any, box: string) => Promise<any>, forget: (box: string) => Promise<void> }} SpacePorts
 */

/**
 * @param {{ store: KeptStore, directory: string, fetch?: typeof fetch, kdf?: { memoryKiB: number, passes: number }, random?: (n: number) => Uint8Array, now?: () => number,
 *   space?: { load: () => Promise<SpacePorts> }, sleep?: (ms: number) => Promise<void>, pollMs?: number, version?: string | null }} o
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

  /** One run per install line this page made: the add-server run, what the person called the space, the pairing it made and whether it is kept. @type {Map<string, { run: ReturnType<typeof createAddServer>, name: string, kind: string, paired: any, saved: boolean, failed: any }>} */
  const waits = new Map();
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

    "identity.lock": async () => { stopRuns(); if (held) held.fill(0); held = null; return { locked: true }; },

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
      waits.set(id, { run, name: label, kind: place, paired: null, saved: false, failed: null });
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
          // The server is paired. Now the space is usable: the paired server names its own space and the directory gets the record signed by this identity (so <space>.vyre.run signs in), then the space vault is made on that server.
          if (!p || !p.box) { w.failed = { code: "pair", message: "Your server did not finish connecting. Start again." }; return { ...base, online: false, expired: false, failed: true, ...w.failed, canRemove: false }; }
          let space = "";
          try {
            space = await ports.claim({ id: k.id, name: k.username, eid: key.eid, ops: k.ops, key }, { name: w.name, route: { relay: p.relay, route: p.route, box: p.box } });
            try { await ports.call("vault.space.create", { space }, p.box); } catch (e) { if (!e || /** @type {any} */ (e).code !== "exists") throw e; }
          } catch (e) {
            const x = /** @type {any} */ (e);
            w.failed = { code: String((x && x.code) || "claim"), message: String((x && x.message) || "The space could not be made.").slice(0, 300) };
            return { ...base, online: false, expired: false, failed: true, ...w.failed, canRemove: true, canRename: w.failed.code === "taken" || w.failed.code === "name_taken" };
          }
          await keepSpace(k, { id: space || spaceKey("", w.name), name: w.name, role: "owner", server: `https://${w.name}.vyre.run`, paired: p });
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
      return { removed: true, id: hit.id };
    },
  };

  return {
    /** Does this host answer that tool name? */
    has: (/** @type {string} */ name) => name in tools && (Boolean(o.space) || !name.startsWith("onboard.space.")),
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
