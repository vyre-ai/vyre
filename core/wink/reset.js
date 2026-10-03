// @ts-check
// Reset a server from its own console (reviewer-3 D-3). Resetting a server frees it from an owner that cannot let go (the app was lost, or the server was
// off when the app removed it), so it must need a person at the box. The old way, the server's short fingerprint, was readable by every local caller, 32 bits
// with no attempt limit: it was no more than "any local call resets it". This replaces it.
//
//   vyre wink reset --begin           the CLI makes a one-time code HERE, shows it on the person's own terminal only, and sends the daemon a salted scrypt hash of it
//   vyre wink reset --confirm <code>  the CLI sends the code the person typed; the daemon hashes it with the stored salt and compares in constant time
//
// Why the CLI makes the code and sends only a hash (rather than the daemon making it and the CLI printing it): then no tool result, socket reply, event or log
// line is ever in a position to carry the code. The daemon cannot leak what it never held, and begin's answer has nothing in it that an assistant or a remote
// caller could read. The one place the code crosses is the confirm call, in its input, from the CLI to the daemon over the local socket; it is never answered,
// emitted or logged. A code lasts five minutes and is used once. Five wrong codes lock reset for an hour; the lock is kept in the store, so a restart does not clear it.
//
// Only the local `cli` caller may call either tool: not a deck, hook, mcp, harness, agent, module, device, tailnet or relay caller, even with the right data. The
// daemon cannot see a terminal on that socket; the CLI refuses without one (core/cli/commands/wink.js). A local process that speaks the socket itself as `cli`, as the
// box's own unix user, can still begin and confirm: that is the limit of any local trust, and it is why the code is single-use and the attempts are capped.

import crypto from "node:crypto";
import { normalise, newCode, codeHash, beginInput } from "../../lib/wink-reset.js";

export { normalise, newCode, codeHash, beginInput };

export const CODE_LIFE_MS = 5 * 60_000;
export const MAX_WRONG = 5;
export const LOCK_MS = 60 * 60_000;

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };

/** The code as typed, without dashes, spaces or case {number} at */
export const resetCard = at => ({ title: "This server was reset", text: `This server was reset from its console at ${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC.` });

/**
 * Registers wink.server.reset.begin and wink.server.reset.confirm.
 * `dataStores` is the kernel's list of every store that holds the box's data (vault, sealing folder, records, the Drive pool, workspaces, sessions, memory), each `{ name, holds(), wipe() }`.
 * The default is "holds data": no list, a store that throws or does not answer exactly false, all count as holding data, so a store nobody listed blocks a reset instead of being skipped.
 * A reset of a box that holds data refuses unless it is a wipe (`vyre wink reset --begin --wipe`); a wipe needs the one-time code AND the typed word `wipe`, tells the previous owner first,
 * waits a short time, wipes every store, checks they are empty, and makes a NEW Space identity (`newSpace()`, never the old keys) before the box reports itself unowned. No list or no
 * `newSpace` means a wipe is refused, with the reason.
 * @param {{ ctx: any, pairing: any, now?: () => number, identity?: () => Promise<string>, dropMs?: number, dataStores?: () => Promise<{ name: string, holds: () => Promise<boolean | undefined>, wipe: () => Promise<void> }[]>, newSpace?: () => Promise<void>, wipeDelayMs?: number }} o
 */
export function registerReset(o) {
  const { ctx, pairing } = o;
  const now = o.now || Date.now;
  const meta = pairing.meta;
  const GUARD = "reset_guard", BEGUN = "reset_begin";

  /** Local `cli` only: never an agent, a module, a device, the tailnet, the relay or a hook. @param {any} m */
  const cliOnly = m => {
    const c = String((m && m.caller) || "");
    if (c !== "cli" || (m && m.agent)) throw fail("denied", "A server is reset from its own console: run vyre wink reset in a terminal on the server.");
  };
  /** What this box holds, by the kernel's list; fail closed. @returns {Promise<{ holds: boolean, names: string[], stores: any[] | null }>} */
  const holdsData = async () => {
    /** @type {any[] | null} */ let stores = null;
    try { const l = o.dataStores ? await o.dataStores() : null; stores = Array.isArray(l) ? l : null; } catch { stores = null; }
    if (!stores) return { holds: true, names: ["the list of this box's data stores"], stores: null };
    /** @type {string[]} */ const names = [];
    for (const st of stores) { let h; try { h = await st.holds(); } catch { h = undefined; } if (h !== false) names.push(String(st.name)); }
    return { holds: names.length > 0, names, stores };
  };
  const owned = () => Boolean(meta.get("owner") || meta.get("adopter"));
  const lockedUntil = () => { const g = meta.get(GUARD); return g && g.until > now() ? g.until : 0; };
  const notLocked = () => {
    const u = lockedUntil();
    if (u) throw fail("reset_locked", `Resetting this server is locked until ${new Date(u).toISOString().slice(0, 16).replace("T", " ")} UTC, after too many wrong codes.`);
  };
  /** Takes the relay device of an app off the box after the answer has travelled. @param {string} id */
  const dropDevice = id => {
    if (typeof ctx.call !== "function") return;
    const go = () => { Promise.resolve(ctx.call("relay.devices.drop", { id })).catch(() => null); };
    const wait = o.dropMs ?? 750;
    if (!wait) { go(); return; }
    const t = setTimeout(go, wait);
    if (t.unref) t.unref();
  };

  ctx.tool("wink.server.reset.begin", {
    callers: ["cli"],
    description: "On the server's own console only: start a reset. The command line (vyre wink reset --begin) makes a one-time code, shows it on the person's terminal, and sends this only its salted hash { salt, hash }. The code is valid 5 minutes and once. The local command line only: never a deck, hook, agent, module, device, tailnet or relay caller. Answers { begun, until }.",
    input: obj({ salt: str, hash: str, wipe: { type: "boolean" } }, ["salt", "hash"]),
    run: async (/** @type {any} */ input, /** @type {any} */ m = {}) => {
      cliOnly(m);
      notLocked();
      if (!input || !/^[0-9a-f]{32}$/.test(String(input.salt)) || !/^[0-9a-f]{64}$/.test(String(input.hash))) throw fail("bad_input", "begin takes the salt and hash the command line made");
      const wipe = input.wipe === true;
      if (owned()) {
        const h = await holdsData();
        if (h.holds && !wipe) throw fail("holds_data", `This server holds data (${h.names.join(", ")}), and a reset would leave it for the next owner. Nothing was reset. If you only lost a device, recover your identity from another device instead. To erase everything on this server and start it as a new Space, run vyre wink reset --begin --wipe.`);
        if (h.holds && wipe && (!h.stores || typeof o.newSpace !== "function")) throw fail("wipe_unavailable", `This server cannot be wiped yet: ${!h.stores ? "it has no list of its data stores" : "it cannot make a new Space identity"}. Nothing was reset.`);
      }
      const until = now() + CODE_LIFE_MS;
      meta.set(BEGUN, { salt: String(input.salt), hash: String(input.hash), until, ...(wipe ? { wipe: true } : {}) });
      return { begun: true, until, ...(wipe ? { wipe: true } : {}) };
    },
  });

  ctx.tool("wink.server.reset.confirm", {
    callers: ["cli"],
    description: "On the server's own console only: finish a reset with the code that vyre wink reset --begin showed. The server forgets its owner (owner, adopter, hand-over, peer secret, the app's devices) and keeps its own keys; the previous owner's devices get a card. Five wrong codes lock this for an hour. The local command line only. Answers { reset, had }.",
    input: obj({ code: str, typed: str }, ["code"]),
    run: async (/** @type {any} */ input, /** @type {any} */ m = {}) => {
      cliOnly(m);
      notLocked();
      const b = meta.get(BEGUN);
      if (!b) throw fail("no_code", "There is no reset in progress. Run vyre wink reset --begin first.");
      if (b.until <= now()) { meta.del(BEGUN); throw fail("expired", "That reset code has expired. Run vyre wink reset --begin again."); }
      const got = Buffer.from(codeHash(String((input && input.code) || ""), b.salt), "hex"), want = Buffer.from(b.hash, "hex");
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
        const g = meta.get(GUARD) || { wrong: 0, until: 0 };
        const wrong = (g.until && g.until <= now() ? 0 : g.wrong) + 1;
        if (wrong >= MAX_WRONG) {
          meta.set(GUARD, { wrong: 0, until: now() + LOCK_MS });
          meta.del(BEGUN);
          ctx.log(`wink: ${MAX_WRONG} wrong reset codes; resetting this server is locked for an hour`);
          throw fail("reset_locked", "Too many wrong codes. Resetting this server is locked for an hour.");
        }
        meta.set(GUARD, { wrong, until: 0 });
        throw fail("wrong_code", `That is not the code. ${MAX_WRONG - wrong} ${MAX_WRONG - wrong === 1 ? "try" : "tries"} left.`);
      }
      // a wipe also needs the typed word, checked before the code is spent so a slip does not cost the code
      if (b.wipe && String((input && input.typed) || "").trim().toLowerCase() !== "wipe") throw fail("wipe_needs_typed", "This erases everything stored on this server. Type the word wipe to go on.");
      // the box may have changed since begin: a reset that is not a wipe still refuses on data
      if (owned() && !b.wipe) { const h = await holdsData(); if (h.holds) { meta.del(BEGUN); throw fail("holds_data", `This server holds data (${h.names.join(", ")}). Nothing was reset. Begin again with --wipe to erase it.`); } }
      meta.del(BEGUN); meta.del(GUARD);
      const at = now();
      const om = meta.get("owner");
      const had = Boolean(om);
      const identity = om && om.identity ? String(om.identity) : o.identity ? await o.identity() : "";
      const devs = identity ? pairing.devices.list(identity).filter((/** @type {any} */ d) => d.id !== "self") : [];
      // The card goes first, while the previous owner's devices are still reachable; then the owner goes and so do their devices here.
      if (had) ctx.events.emit("wink.server-reset", { at, devices: devs.map((/** @type {any} */ d) => d.id), card: resetCard(at) });
      ctx.log(`wink: this server was reset from its console at ${new Date(at).toISOString()}`);
      if (b.wipe) {
        // the previous owner has the card; a short wait, then every store is wiped, checked empty, and a NEW Space identity is made. Any failure leaves the owner in place and says why.
        const wait = o.wipeDelayMs ?? 10_000;
        if (wait) await new Promise(r => { const t = setTimeout(r, wait); if (t.unref) t.unref(); });
        try {
          const h = await holdsData();
          if (!h.stores || typeof o.newSpace !== "function") throw fail("wipe_unavailable", "This server cannot be wiped: no list of its data stores, or no way to make a new Space identity.");
          for (const st of h.stores) await st.wipe();
          const after = await holdsData();
          if (after.holds) throw fail("wipe_failed", `The wipe did not empty this server (${after.names.join(", ")}). It still belongs to its owner and nothing was reset.`);
          await o.newSpace();
        } catch (e) {
          ctx.events.emit("wink.server-reset-failed", { at, reason: String(/** @type {any} */ (e).message || e) });
          ctx.log(`wink: the wipe failed: ${String(/** @type {any} */ (e).message || e)}`);
          throw e;
        }
      }
      const adopter = String(meta.get("adopter") || "");
      pairing.clearOwner(); // drops the adopter's relay device
      for (const d of devs) { pairing.devices.remove(d.id); if (`device:${d.id}` !== adopter) dropDevice(d.id); }
      // every paired person session and grant ends with the owner (ADR 0032 2d): a reset is a recovery reset
      if (typeof ctx.call === "function") Promise.resolve(ctx.call("presence.person.end-paired", {})).catch(() => null);
      return { reset: true, had, ...(b.wipe ? { wiped: true } : {}) };
    },
  });
}
