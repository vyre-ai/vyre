// @ts-check
// The home's end of a lent computer (team/archive/work-journals/runner.md "The lent-computer wire"): what the Space's home does when a member's computer runs one of its sessions.
// It is a SERVICE of the kernel's remote server (kernel/remote/server.js `services.lent`): every method is `(chain, ...args)` with the chain the home's own Surfaces door minted from
// what the transport proved (the lender's device key and person), never from the request. It holds the lent-session table, decides what a session may reach, and fronts the
// checkpoint store (core/runner/checkpoint-store.js) with a per-call authorization that comes from the Offers and the table, not from a role.
//
//   start({ session, lease })   the home writes the session's definition (its command, routes, read-only folders, labels and NETWORK limited by the lender's cap), binds the lease to the
//                               session's routes, and records the session as lent to THIS person and device. Both Offers must stand.
//   stop({ session })           the session leaves the table; its calls answer not_found from then on.
//   beat({ sessions })          the lender is alive (every HEARTBEAT_MS): its sessions' epochs are checked, a session that moved is told so (`fenced`), and a computer that has been well again is offered its sessions back.
//   release({ session, epoch, reason })  the lender hands a session to the server after its final checkpoint (lid, sleep, battery, caps, the person's move): the home takes it, resumes it, and fences the lender.
// A lent session has an EPOCH, raised at every change of place. The lender names it on every write; a write at an older epoch is refused (`conflict`), so a computer that was paused, not dead, can never
// write a turn the server already ran again. A lender that stops beating for LAPSE_MS is taken the same way (reason `offline`). The place of every session is the placement book (placement-book.js).
//   appendTranscript, getTranscript, putFile, getFile, putCheckpoint, getCheckpoint, usage    the store's own, authorized per call; files cross in chunks.
//
// A call is allowed only when the session is in the table for this person AND device, both Offers still stand at this very call, and then the store's own checks pass.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createCheckpointStore } from "./checkpoint-store.js";
import { effectiveNetwork } from "./runner.js";
import { deviceIdOf } from "../../lib/caller.js";
import { KernelError } from "../../kernel/core/errors.js";
import { createPlacementBook, fileStore, placementOf, REASONS, AUTO, HEARTBEAT_MS } from "./placement-book.js";
const err = (code, message) => new KernelError(code, message);
export const CHUNK_BYTES = 96 * 1024;
const SESSION = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_UPLOADS = 8;
/** The tighter of two lender limits: `provider` beats `internet` beats none. */
export const tighterCap = (a, b) => (a === "provider" || b === "provider" ? "provider" : a === "internet" || b === "internet" ? "internet" : undefined);

/**
 * @param {{ space: string, root: string, offers: { active(q: { member: string, device: string }): { spaceAllows: boolean, memberAccepts: boolean }, capOf?(q: { member: string, device: string }): "provider" | "internet" | undefined },
 *   specFor: (i: { space: string, session: string, person: string, device: string }) => Promise<any> | any,
 *   lenderCap?: (i: { person: string, device: string }) => "provider" | "internet" | undefined,
 *   leases?: { renew(chain: any, i: { id: string }): Promise<any>, bind(session: string, id: string, def: any): void, unbind(session: string): void },
 *   caps?: any, fs?: any, key?: Buffer, book?: ReturnType<typeof createPlacementBook>, now?: () => number, emit?: (type: string, payload: any) => void,
 *   titleOf?: (chat: string) => Promise<string | null> | string | null,
 *   resume?: (i: { space: string, session: string, chat: string | null, person: string, device: string, epoch: number, reason: string | null, view: { checkpoint(): Promise<any>, transcript(from: number, limit?: number): Promise<any>, file(rel: string, version: number): Promise<any> } }) => Promise<any> | any }} o
 *   resume: the home's own continuation of a session the lender gave up (or lost): it runs on the server from the last acknowledged checkpoint. Told again at every sweep until it answers.
 */
export function createLentHome(o) {
  const now = o.now || Date.now;
  const book = o.book || createPlacementBook({ now, ...(o.emit ? { emit: o.emit } : {}), ...(o.root ? { store: fileStore(path.join(o.root, "placements.json")) } : {}) });
  const lent = new Map();
  // A restart of the home keeps the sessions that were on lenders' computers: they are lent again as they were, and each lender gets a whole lapse to show itself.
  for (const r of book.all()) if (r.where === "mac" && r.key !== undefined) lent.set(r.session, { person: r.person, device: r.device, key: r.key || undefined, ...(r.chat ? { chat: r.chat } : {}) });
  book.grace();
  /** Sessions the server took and has not yet resumed. @type {Set<string>} */ const owed = new Set();
  const uploads = new Map();
  const downloads = new Map();
  const who = chain => {
    const h = chain && Array.isArray(chain.hops) ? chain.hops : [];
    if (chain?.space !== o.space || h.length !== 1 || !h[0].actor || h[0].actor.kind !== "person") throw err("not_found", "not found");
    const via = String(h[0].via?.device || "");
    const device = deviceIdOf(via) ?? via; // the kernel says which device (bookkeeping); the person is the chain's one person hop above
    if (!device) throw err("not_found", "not found");
    return { person: String(h[0].actor.id), device };
  };
  const stands = ({ person, device }, device_key) => { const a = o.offers.active({ member: person, device, ...(device_key ? { device_key } : {}) }); return Boolean(a && a.spaceAllows && a.memberAccepts); };
  const mine = (chain, session) => {
    const w = who(chain);
    const l = lent.get(String(session));
    if (!SESSION.test(String(session)) || !l || l.person !== w.person || l.device !== w.device || !stands(w, l.key)) throw err("not_found", "not found");
    return w;
  };
  // A write names the epoch the session was lent under. An older one is the computer that was paused, not dead: the server has the session now, so what it says counts for nothing.
  const fenced = () => err("conflict", "this session moved to the server: stop it on this computer");
  const writer = (chain, session, epoch) => {
    const w = mine(chain, session);
    if (!Number.isInteger(epoch)) throw err("bad_input", "a write names the epoch the session was lent under");
    if (!book.current(String(session), epoch, w.device)) throw fenced();
    return w;
  };
  // The server takes a session: the book moves it (the lender is fenced from this moment), the lender's table entry and credential binding go, and the resume is owed until it answers.
  const takeOver = async (session, reason, opt = {}) => {
    const r = book.toServer(session, reason, opt);
    if (!r.changed) return r;
    lent.delete(String(session)); owed.add(String(session));
    if (o.leases) { try { o.leases.unbind(String(session)); } catch { /* already gone */ } }
    await resumeOwed(String(session));
    return r;
  };
  const resumeOwed = async (session) => {
    const row = book.get(session);
    if (!row || row.where !== "server") { owed.delete(session); return; }
    if (!o.resume) { owed.delete(session); return; }
    try { await o.resume({ space: o.space, session, chat: row.chat, person: row.person, device: row.device, epoch: row.epoch, reason: row.reason, view: viewOf(session) }); owed.delete(session); }
    catch { /* told again at the next sweep */ }
  };
  // The lender that stops beating is taken; what the server owes is tried again. One timer for the Space, never faster than the heartbeat.
  let timer = null;
  const watch = (everyMs = HEARTBEAT_MS) => {
    if (timer) return () => {};
    timer = setInterval(() => { sweepOnce().catch(() => {}); }, everyMs);
    timer.unref?.();
    return () => { if (timer) clearInterval(timer); timer = null; };
  };
  const sweepOnce = async () => {
    for (const r of book.lapsed()) await takeOver(r.session, "offline");
    for (const r of book.overdue()) await takeOver(r.session, r.ask && r.ask.reason ? r.ask.reason : "you");
    for (const s of [...owed]) await resumeOwed(s);
  };
  // The store is asked per call; its authorizer is the lent table and the Offers, so no role and no grant is needed and a withdrawn Offer ends the next call.
  // The home's own chain: it reads a session the lender gave up from the same store, to resume it on the server. A private object, never on the wire, so nothing a peer sends can be it.
  const HOME = Object.freeze({ space: o.space, hops: [] });
  const store = createCheckpointStore({ space: o.space, root: o.root, caps: o.caps, fs: o.fs, ...(o.key ? { key: o.key } : {}), authorize: async ({ chain, resource }) => {
    if (chain === HOME) return { effect: "allow" };
    const session = String(resource).split("/checkpoint/")[1] || "";
    try { mine(chain, session); return { effect: "allow" }; } catch { return { effect: "deny" }; }
  } });
  /** What the server reads to carry a session on: the last acknowledged checkpoint, the transcript up to it, and its files. */
  const viewOf = (/** @type {string} */ session) => Object.freeze({
    checkpoint: () => store.getCheckpoint(HOME, session),
    transcript: (/** @type {number} */ from, /** @type {number} */ limit) => store.getTranscript(HOME, session, from, limit),
    file: (/** @type {string} */ rel, /** @type {number} */ version) => store.getFile(HOME, session, rel, version),
  });
  const sweep = () => { while (uploads.size > MAX_UPLOADS) { const k = uploads.keys().next().value; const u = uploads.get(k); uploads.delete(k); try { fs.rmSync(u.dir, { recursive: true, force: true }); } catch {} } };

  return {
    store,
    /** The book of where every lent session runs, and the timer that takes a lender that went quiet. */
    book, watch, sweep: sweepOnce, takeOver,
    /** Every session the book knows, as `runner.placement` answers it. */
    placements() { return book.all().map(r => ({ session: r.session, chat: r.chat, device: r.device, epoch: r.epoch, ...placementOf(r) })); },
    /** The home's own view of what is lent (never on the wire: wire.js lists the calls): the session, the device it runs on and its chat if the lender named one. */
    rows() { return [...lent].map(([session, v]) => ({ session, device: v.device, ...(v.chat ? { chat: v.chat } : {}) })); },
    /** The id this home gives the computer that is calling, and the person: read from what the transport proved, never from the request. A lender lends under this id (the Offers are made for it) and presents it when it runs a session. @param {any} chain */
    async whoami(chain) { const w = who(chain); return { device: w.device, person: w.person }; },
    /** Whether this person's computer may run the Space's work now (both Offers), and the lender's own cap: the lender's runner polls it (never faster than once a minute). @param {any} chain @param {{ device_key?: string }} [i] */
    async status(chain, i = {}) {
      const w = who(chain); const a = o.offers.active({ member: w.person, device: w.device, ...(i && i.device_key ? { device_key: String(i.device_key) } : {}) });
      return { spaceAllows: Boolean(a && a.spaceAllows), memberAccepts: Boolean(a && a.memberAccepts), lenderCap: tighterCap((o.lenderCap && o.lenderCap(w)) || undefined, o.offers.capOf ? o.offers.capOf({ member: w.person, device: w.device }) : undefined) || null };
    },
    /** @param {any} chain @param {{ session: string, lease?: string, device_key?: string, cap?: "provider" | "internet" | null, chat?: string }} i */
    async start(chain, i) {
      const w = who(chain);
      if (!i || !SESSION.test(String(i.session))) throw err("bad_input", "name the session");
      if (!stands(w, i.device_key)) throw err("not_allowed", "this computer is not allowed to run this Space's work");
      { const had0 = lent.get(String(i.session)); if (had0 && had0.person !== w.person) throw err("not_found", "not found"); }
      const spec = await o.specFor({ space: o.space, session: i.session, person: w.person, device: w.device });
      if (!spec || typeof spec.command !== "string" || !Array.isArray(spec.routes)) throw err("not_found", "the Space has no definition for that session");
      if (i.cap !== undefined && i.cap !== null && i.cap !== "provider" && i.cap !== "internet") throw err("bad_input", "the lender's network limit is provider or internet");
      // The tightest of what the home knows (the lender's acceptance and the floor of every limit this computer was ever lent with) and what the lender's runner signed in its hello: a runner can only ask for less.
      const cap = tighterCap(tighterCap((o.lenderCap && o.lenderCap(w)) || undefined, o.offers.capOf ? o.offers.capOf({ member: w.person, device: w.device }) : undefined), i.cap || undefined);
      // The Space's choice, limited by what this lender accepted: the Space can never hand a session more than the lender allowed (the runner applies the same rule again on the lender).
      const network = effectiveNetwork(spec.network, cap);
      if (o.leases && i.lease) { await o.leases.renew(chain, { id: String(i.lease) }); o.leases.bind(String(i.session), String(i.lease), { routes: spec.credentialRoutes || [] }); }
      // A session lent to someone else's computer is never taken: only the same person may continue it from another of their computers (the resume path).
      const had = lent.get(String(i.session));
      if (had && had.person !== w.person) throw err("not_found", "not found");
      if (i.chat !== undefined && !(typeof i.chat === "string" && /^chat_[0-9a-f-]{36}$/.test(i.chat))) throw err("bad_input", "a chat is named by its id");
      // The lender names the chat, so the home believes it only when that person is in that chat (the kernel's own read decision): otherwise the session runs and the chat is dropped, never shown as running here.
      const chat = i.chat && o.chatHas && (await Promise.resolve(o.chatHas(chain, i.chat)).catch(() => false)) === true ? i.chat : null;
      // The book decides whether this computer may run it (a session the server took comes back only when the person asked) and gives the epoch every later write names.
      let row;
      try { row = book.lend({ session: String(i.session), chat, person: w.person, device: w.device, key: i.device_key || null }); }
      catch (e) { if (o.leases) { try { o.leases.unbind(String(i.session)); } catch { /* not bound */ } } throw e; }
      owed.delete(String(i.session));
      lent.set(String(i.session), { person: w.person, device: w.device, key: i.device_key, ...(chat ? { chat } : {}) });
      const title = chat && o.titleOf ? await Promise.resolve(o.titleOf(chat)).catch(() => null) : null;
      const { credentialRoutes, ...visible } = spec;
      return { ...visible, network, lenderCap: cap || null, epoch: row.epoch, ...(typeof title === "string" && title ? { title: title.slice(0, 120) } : {}) };
    },
    /**
     * The lender is alive. Each session it still runs is checked against the book: one whose epoch is not current (it moved, or the home restarted without it) is listed in `fenced`, and the lender stops it
     * at once. `well` is the lender saying nothing holds its sessions back now (lid open, plugged in, online): sessions it gave up for a condition that clears are then offered back. The answer also carries
     * what the home wants done: hand a session over (the person's move), or start one the person brought back.
     * @param {any} chain @param {{ sessions?: { session: string, epoch: number, cpuPercent?: number, memoryMb?: number, turn?: number, paused?: boolean }[], well?: boolean }} [i]
     */
    async beat(chain, i = {}) {
      const w = who(chain);
      const list = i && Array.isArray(i.sessions) ? i.sessions.slice(0, 50) : [];
      /** @type {string[]} */ const fencedList = [];
      for (const x of list) {
        const sid = String(x && x.session), l = lent.get(sid);
        if (!SESSION.test(sid) || !l || l.person !== w.person || l.device !== w.device || !Number.isInteger(x.epoch) || !book.beat({ session: sid, epoch: x.epoch, device: w.device, cpuPercent: x.cpuPercent, memoryMb: x.memoryMb, turn: x.turn, paused: x.paused === true }).ok) fencedList.push(sid);
      }
      if (i && i.well === true) book.clear(w.device);
      return { ok: true, fenced: fencedList, offers: book.offered(w.device), directives: book.directives(w.device) };
    },
    /**
     * The lender hands a session to the server, after its final checkpoint. Only at the epoch it holds. A move its own condition asked for (lid, battery, a cap) is held back inside the cooldown and the lender
     * keeps running it; every other reason moves at once. The server resumes the session from the last acknowledged checkpoint and the lender is fenced.
     * @param {any} chain @param {{ session: string, epoch: number, reason: string }} i
     */
    async release(chain, i) {
      writer(chain, i && i.session, i && i.epoch);
      const reason = String(i.reason);
      if (!REASONS.includes(reason)) throw err("bad_input", "say why: " + REASONS.join(", "));
      const r = await takeOver(String(i.session), reason, { auto: AUTO.includes(reason) });
      return r.changed ? { moved: true, epoch: r.row ? r.row.epoch : undefined } : { moved: false, why: r.why };
    },
    async stop(chain, i) { mine(chain, i && i.session); lent.delete(String(i.session)); book.forget(String(i.session)); if (o.leases) { try { o.leases.unbind(String(i.session)); } catch {} } return { stopped: true }; },
    appendTranscript: (chain, s, e, epoch) => { writer(chain, s, epoch); return store.appendTranscript(chain, String(s), e); },
    getTranscript: (chain, s, from, limit) => store.getTranscript(chain, String(s), from, limit),
    putCheckpoint: (chain, s, cp, epoch) => { writer(chain, s, epoch); return store.putCheckpoint(chain, String(s), cp); },
    getCheckpoint: (chain, s) => store.getCheckpoint(chain, String(s)),
    usage: (chain, s) => store.usage(chain, String(s)),
    /**
     * A file in chunks of at most CHUNK_BYTES raw, numbered from 0, with the total count; the last one commits it whole to the store. `deleted: true` is a removal in one call.
     * @param {any} chain @param {string} s @param {string} rel @param {{ upload?: string, index?: number, total?: number, b64?: string, deleted?: boolean, epoch?: number }} c
     */
    async putFile(chain, s, rel, c = {}) {
      writer(chain, s, c && c.epoch);
      if (c.deleted) return store.putFile(chain, String(s), String(rel), null);
      if (!Number.isInteger(c.index) || !Number.isInteger(c.total) || c.total < 1 || c.index < 0 || c.index >= c.total || typeof c.b64 !== "string" || typeof c.upload !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(c.upload)) throw err("bad_input", "a file chunk is numbered and carries its bytes");
      const bytes = Buffer.from(c.b64, "base64");
      if (bytes.length > CHUNK_BYTES) throw err("too_large", "that chunk is too large");
      const key = `${w2(chain)}|${s}|${c.upload}`;
      let u = uploads.get(key);
      if (!u) { const dir = path.join(o.root, ".uploads", crypto.randomBytes(8).toString("hex")); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); u = { dir, total: c.total, next: 0 }; uploads.set(key, u); sweep(); }
      if (c.index !== u.next || c.total !== u.total) throw err("gap", "a chunk is missing or repeated");
      fs.appendFileSync(path.join(u.dir, "data"), bytes, { mode: 0o600 }); u.next++;
      if (u.next < u.total) return { pending: true, next: u.next };
      uploads.delete(key);
      try { return await store.putFile(chain, String(s), String(rel), new Uint8Array(fs.readFileSync(path.join(u.dir, "data")))); }
      finally { fs.rmSync(u.dir, { recursive: true, force: true }); }
    },
    /** A file in ranges: `{ offset, len }` up to CHUNK_BYTES; the answer says the file's size so the reader knows when it has all of it. */
    async getFile(chain, s, rel, version, r = {}) {
      mine(chain, s);
      const key = `${s}|${rel}|${version}`;
      let b = downloads.get(key);
      if (!b) { b = Buffer.from(await store.getFile(chain, String(s), String(rel), version)); downloads.set(key, b); if (downloads.size > 4) downloads.delete(downloads.keys().next().value); }
      const offset = Number.isInteger(r.offset) && r.offset >= 0 ? r.offset : 0, len = Math.min(CHUNK_BYTES, Number.isInteger(r.len) && r.len > 0 ? r.len : CHUNK_BYTES);
      return { size: b.length, offset, b64: b.subarray(offset, offset + len).toString("base64") };
    },
  };
  function w2(chain) { const w = who(chain); return w.person + "/" + w.device; }
}
