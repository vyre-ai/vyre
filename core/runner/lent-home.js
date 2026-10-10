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
import { createPipes } from "./pipe-home.js";
import { within, withinOrThrow } from "../../lib/within.js";
import { newPrefixedId } from "../../lib/id.js";
import { RUNNER_PROTOCOL_MIN } from "./protocol.js";
const err = (code, message) => new KernelError(code, message);
export const CHUNK_BYTES = 96 * 1024;
/** How long the server's continuation of a session may take to answer before the sweep goes on without it. */
const RESUME_MS = 30_000;
/** The most sessions one heartbeat names; a lender with more sends them in several, so none is ever missed (a missed one looks dead). */
export const BEAT_MAX = 100;
/** A file is at most 100 MB (the checkpoint's own cap) in chunks of CHUNK_BYTES: an upload that says it has more chunks than that is refused before anything is written. */
const MAX_CHUNKS = Math.ceil(100 * 1024 * 1024 / CHUNK_BYTES) + 2;
const SESSION = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_UPLOADS = 8;
/** A computer that beat this lately, and said it was well, is one a chat may be started on (three heartbeats). */
const LENDER_FRESH_MS = 15_000;
/** A place kept for a chat moved from the server waits for its next turn this long. */
const ADOPT_MS = 6 * 3600_000;
/** A place written for a new chat is taken back when no spawn follows this soon. */
const RESERVE_MS = 30_000;
/** The tighter of two lender limits: `provider` beats `internet` beats none. */
export const tighterCap = (a, b) => (a === "provider" || b === "provider" ? "provider" : a === "internet" || b === "internet" ? "internet" : undefined);

/**
 * @param {{ space: string, root: string, offers: { active(q: { member: string, device: string }): { spaceAllows: boolean, memberAccepts: boolean }, capOf?(q: { member: string, device: string }): "provider" | "internet" | undefined },
 *   specFor: (i: { space: string, session: string, person: string, device: string }) => Promise<any> | any,
 *   lenderCap?: (i: { person: string, device: string }) => "provider" | "internet" | undefined,
 *   leases?: { renew(chain: any, i: { id: string }): Promise<any>, bind(session: string, id: string, def: any): void, unbind(session: string): void, borrowed?(i: { thread: string, session: string, member: string, device: string, limit: string | null, epoch: number | null }): void, helloOf?(id: string): { cap?: "provider" | "internet" | null } | null },
 *   caps?: any, fs?: any, key?: Buffer, book?: ReturnType<typeof createPlacementBook>, now?: () => number, emit?: (type: string, payload: any) => void,
 *   titleOf?: (chat: string) => Promise<string | null> | string | null,
 *   lapseMs?: number,
 *   canResume?: () => boolean, http?: (thread: string, method: string, path: string, headers: Record<string, string>, body: string) => Promise<{ status: number, body: string }> | null,
 *   resume?: (i: { space: string, session: string, thread?: string, chat: string | null, person: string, device: string, epoch: number, reason: string | null, view: { checkpoint(): Promise<any>, transcript(from: number, limit?: number): Promise<any>, file(rel: string, version: number): Promise<any> } }) => Promise<any> | any }} o
 *   canResume: can the server carry a session on right now (the loader that turns a lent transcript into a chat exists)? When it cannot, the server takes no session from a lender: a move answers `unavailable` and the lender keeps
 *   running it, because a session taken with nothing to continue it is a session lost. Unset: yes.
 *   resume: the home's own continuation of a session the lender gave up (or lost): it runs on the server from the last acknowledged checkpoint. Told again at every sweep until it answers.
 */
export function createLentHome(o) {
  const now = o.now || Date.now;
  const book = o.book || createPlacementBook({ now, ...(o.lapseMs ? { lapseMs: o.lapseMs } : {}), ...(o.emit ? { emit: o.emit } : {}), ...(o.root ? { store: fileStore(path.join(o.root, "placements.json")) } : {}) });
  const lent = new Map();
  // A restart of the home keeps the sessions that were on lenders' computers: they are lent again as they were, and each lender gets a whole lapse to show itself.
  for (const r of book.all()) if (r.where === "mac" && r.key !== undefined) lent.set(r.session, { person: r.person, device: r.device, key: r.key || undefined, ...(r.chat ? { chat: r.chat } : {}) });
  book.grace();
  /** Sessions the server took and has not yet carried on, including those a restart of this home found still owed. @type {Set<string>} */ const owed = new Set(book.pendingResume().map(r => r.session));
  /** Continuations running now, one per session: a slow one is not started a second time. @type {Map<string, Promise<void>>} */ const resuming = new Map();
  // partial uploads of a lender that vanished are not kept across a restart
  try { if (o.root) fs.rmSync(path.join(o.root, ".uploads"), { recursive: true, force: true }); } catch { /* nothing there */ }
  const uploads = new Map();
  const downloads = new Map();
  /** The pipes of lent spawns (contracts/lent-spawn.md): a chat's agent process on a lender, as the SDK on this home sees it. */
  const pipes = o.pipes || createPipes({ now });
  /** The key each computer lent under, as it last said it (in `status`): the Offers are made for the computer and its key. @type {Map<string, string>} */ const keys = new Map();
  /** The thread each spawned session was opened under (`spawn({ thread })`): the key of the tool socket the daemon holds for it. A row older than the rule has a session id that is not its thread id, so Vyre's tools are routed by this, never by the session. @type {Map<string, string>} */ const threads = new Map();
  /** Tool calls that outlast one wire call (lent.http answers `{ pending }` after HTTP_FIRST_MS and the lender asks again with the ticket): ticket -> { session, p, at }. A call is kept at most CALL_MAX_MS. @type {Map<string, { session: string, p: Promise<any>, result: any, at: number }>} */ const calls = new Map();
  const HTTP_FIRST_MS = o.httpFirstMs ?? 20_000, CALL_MAX_MS = o.callMaxMs ?? 30 * 60_000, MAX_PENDING = 8;
  const dropCalls = (/** @type {string} */ session) => { for (const [k, c] of calls) if (c.session === session) calls.delete(k); };
  /** Waits up to HTTP_FIRST_MS for a kept tool call: its answer (and the call is done), or `{ pending: ticket }` to ask again. */
  const settle = async (/** @type {string} */ session, /** @type {string} */ ticket, /** @type {{ p: Promise<any> }} */ c) => {
    const got = await within(c.p, HTTP_FIRST_MS, null);
    if (got === null) return { pending: ticket };
    calls.delete(ticket);
    if (got.e) throw got.e;
    if (!got.r) throw err("unavailable", "this session has no socket open on this home");
    return { status: got.r.status, body: got.r.body };
  };
  /** A chat that began on the server and is moving to a computer: its transcript is already in the store; the lender writes it into its own agent home before the program starts (spec.seed). session -> { native, count }. @type {Map<string, { native: string, count: number }>} */ const seeds = new Map();
  /** Sessions placed for a new chat that no lender has started yet. @type {Set<string>} */ const reserved = new Set();
  /** The ready computers waiting on the home for something to do (`wait`), one each. @type {Map<string, { t: any, res: (a: any) => void }>} */ const waiters = new Map();
  const directivesFor = (/** @type {string} */ device) => [...book.directives(device), ...pipes.wants(device)];
  const nudge = (/** @type {string} */ device) => { const x = waiters.get(device); if (!x) return; clearTimeout(x.t); waiters.delete(device); x.res({ directives: directivesFor(device) }); };
  /** The ready computer of this person's to start a session on, or null: it beat lately and said nothing holds it back, both Offers stand, and the server could take the session back if the lid closed. The computer already running the session wins. */
  const pickLender = (/** @type {string} */ person, /** @type {string} */ session) => {
    const row = SESSION.test(session) ? book.get(session) : null;
    const fresh = [...lenders].filter(([device, l]) => l.person === person && l.well && now() - l.at <= LENDER_FRESH_MS && stands({ person, device }, keys.get(device)));
    // A chat is not started on a computer while the server could not carry it on if the lid closed: it would sit frozen on a sleeping Mac. It fails as a spawn that never started and runs on the box.
    if (!canResume() || !SESSION.test(session) || (row && row.person !== person) || (row && row.where === "server" && !row.allowMac)) return null;
    if (row && row.where === "mac") return (fresh.find(([d]) => d === row.device) || [null])[0];
    return fresh.sort((a, b) => b[1].at - a[1].at).map(x => x[0])[0] || null;
  };
  /** Computers that beat lately and said nothing holds them back: a chat may be started on one. @type {Map<string, { person: string, at: number, well: boolean }>} */ const lenders = new Map();
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
  const canResume = () => (typeof o.canResume === "function" ? o.canResume() === true : true);
  const takeOver = async (session, reason, opt = {}) => {
    if (!canResume()) return { changed: false, why: "unavailable" };
    const r = book.toServer(session, reason, opt);
    if (!r.changed) return r;
    lent.delete(String(session)); dropCalls(String(session)); owed.add(String(session));   // the thread stays until the server has carried the chat on (resumeOwed): the loader needs it
    pipes.end(String(session), { moved: { to: "server", reason: r.row ? r.row.reason : reason, epoch: r.row ? r.row.epoch : null } });
    if (o.leases) { try { o.leases.unbind(String(session)); } catch { /* already gone */ } }
    kickResume(String(session));
    return r;
  };
  /** Start the server's continuation of a session, once at a time; the caller does not wait for it (a slow continuation must not hold a lender's release or the sweep of the others). */
  const kickResume = (/** @type {string} */ session) => {
    if (resuming.has(session)) return;
    const p = resumeOwed(session).finally(() => { resuming.delete(session); });
    resuming.set(session, p);
  };
  const resumeOwed = async (/** @type {string} */ session) => {
    const row = book.get(session);
    if (!row || row.where !== "server") { owed.delete(session); return; }
    if (!canResume()) return;   // still owed: told again when the loader exists
    if (!o.resume) { owed.delete(session); book.resumed(session); return; }
    // writes that passed their checks before the take-over finish first, so the server carries on from what the store really holds
    try { await store.drain(session); } catch { /* the store answers for itself */ }
    // a continuation that hangs is given half a minute and told again at the next sweep
    try {
      await withinOrThrow(Promise.resolve(o.resume({ space: o.space, session, thread: threads.get(session) || row.chat || session, chat: row.chat, person: row.person, device: row.device, epoch: row.epoch, reason: row.reason, view: viewOf(session) })), RESUME_MS, () => new Error("the continuation did not answer"));
      // only what was owed at THIS take-over: a later one of the same session is owed its own
      if (book.get(session)?.epoch === row.epoch) { owed.delete(session); book.resumed(session); threads.delete(session); }
    } catch { /* told again at the next sweep */ }
  };
  // The lender that stops beating is taken; what the server owes is tried again. One timer for the Space, never faster than the heartbeat.
  let timer = null;
  const watch = (everyMs = HEARTBEAT_MS) => {
    if (timer) return () => {};
    timer = setInterval(() => { sweepOnce().catch(() => {}); }, everyMs);
    timer.unref?.();
    return () => { if (timer) clearInterval(timer); timer = null; };
  };
  let sweeping = false;
  const sweepOnce = async () => {
    if (sweeping) return;
    sweeping = true;
    try { await sweepAll(); } finally { sweeping = false; }
  };
  const sweepAll = async () => {
    for (const r of book.lapsed()) await takeOver(r.session, "offline");
    for (const r of book.overdue()) await takeOver(r.session, r.ask && r.ask.reason ? r.ask.reason : "you");
    for (const s of [...owed]) kickResume(s);
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
    book, watch, sweep: sweepOnce, takeOver, canResume, view: viewOf, pipes,
    /** Every session the book knows, as `runner.placement` answers it. */
    placements() { return book.all().map(r => ({ session: r.session, chat: r.chat, device: r.device, epoch: r.epoch, ...placementOf(r) })); },
    /** The home's own view of what is lent (never on the wire: wire.js lists the calls): the session, the device it runs on and its chat if the lender named one. */
    rows() { return [...lent].map(([session, v]) => ({ session, device: v.device, ...(v.chat ? { chat: v.chat } : {}) })); },
    /** The id this home gives the computer that is calling, and the person: read from what the transport proved, never from the request. A lender lends under this id (the Offers are made for it) and presents it when it runs a session. @param {any} chain */
    async whoami(chain) { const w = who(chain); return { device: w.device, person: w.person }; },
    /** Whether this person's computer may run the Space's work now (both Offers), and the lender's own cap: the lender's runner polls it (never faster than once a minute). @param {any} chain @param {{ device_key?: string }} [i] */
    async status(chain, i = {}) {
      const w = who(chain); const a = o.offers.active({ member: w.person, device: w.device, ...(i && i.device_key ? { device_key: String(i.device_key) } : {}) });
      if (i && typeof i.device_key === "string" && i.device_key.length <= 200 && a && a.memberAccepts) keys.set(w.device, i.device_key);
      return { spaceAllows: Boolean(a && a.spaceAllows), memberAccepts: Boolean(a && a.memberAccepts), lenderCap: tighterCap((o.lenderCap && o.lenderCap(w)) || undefined, o.offers.capOf ? o.offers.capOf({ member: w.person, device: w.device }) : undefined) || null };
    },
    /** @param {any} chain @param {{ session: string, lease?: string, device_key?: string, cap?: "provider" | "internet" | null, chat?: string }} i */
    async start(chain, i) {
      const w = who(chain);
      if (!i || !SESSION.test(String(i.session))) throw err("bad_input", "name the session");
      if (!stands(w, i.device_key)) throw err("not_allowed", "this computer is not allowed to run this Space's work");
      // a session id belongs to the first person who used it, for good: nobody else reads what it left in the store
      { const owner = book.ownerOf(String(i.session)); if (owner !== null && owner !== w.person) throw err("not_found", "not found"); }
      { const had0 = lent.get(String(i.session)); if (had0 && had0.person !== w.person) throw err("not_found", "not found"); }
      let spec = await o.specFor({ space: o.space, session: i.session, person: w.person, device: w.device });
      if (!spec || typeof spec.command !== "string" || !Array.isArray(spec.routes)) throw err("not_found", "the Space has no definition for that session");
      // A chat spawned on this computer (lent spawn): the SDK's flags replace the Space's bare program, and the runner pumps the process's bytes through `lent.pipe`.
      const asked = pipes.pending(String(i.session), w.device);
      if (asked) spec = { ...spec, command: asked.command, args: asked.args, env: {}, pipe: true, vyre: typeof o.http === "function" };
      if (i.cap !== undefined && i.cap !== null && i.cap !== "provider" && i.cap !== "internet") throw err("bad_input", "the lender's network limit is provider or internet");
      // The tightest of what the home knows (the lender's acceptance and the floor of every limit this computer was ever lent with) and what the lender's runner signed in its hello: a runner can only ask for less.
      // The limit the lender's key signed with the lease request counts too, whatever a later, unsigned start says.
      const signedCap = i.lease && o.leases && typeof o.leases.helloOf === "function" ? ((o.leases.helloOf(String(i.lease)) || {}).cap || undefined) : undefined;
      const cap = tighterCap(tighterCap(tighterCap((o.lenderCap && o.lenderCap(w)) || undefined, o.offers.capOf ? o.offers.capOf({ member: w.person, device: w.device }) : undefined), i.cap || undefined), signedCap);
      // The Space's choice, limited by what this lender accepted: the Space can never hand a session more than the lender allowed (the runner applies the same rule again on the lender).
      const network = effectiveNetwork(spec.network, cap);
      // A session lent to someone else's computer is never taken: only the same person may continue it from another of their computers (the resume path).
      const had = lent.get(String(i.session));
      if (had && had.person !== w.person) throw err("not_found", "not found");
      if (i.chat !== undefined && !(typeof i.chat === "string" && /^chat_[0-9a-f-]{36}$/.test(i.chat))) throw err("bad_input", "a chat is named by its id");
      // The lender names the chat, so the home believes it only when that person is in that chat (the kernel's own read decision): otherwise the session runs and the chat is dropped, never shown as running here.
      const chat = i.chat && o.chatHas && (await Promise.resolve(o.chatHas(chain, i.chat)).catch(() => false)) === true ? i.chat : null;
      // A runner older than this server needs (the protocol it signed in its hello) never half-runs a session: the session is the server's, the chat says this computer is updating, and the lender is told what
      // protocol is needed. Where no hello was signed (a test, a home that does not require it) there is nothing to compare.
      const hello = o.leases && i.lease && typeof o.leases.helloOf === "function" ? o.leases.helloOf(String(i.lease)) : null;
      if (hello && Number.isInteger(hello.protocol) && hello.protocol < RUNNER_PROTOCOL_MIN) {
        const live = book.get(String(i.session));
        book.skew({ session: String(i.session), chat, person: w.person, device: w.device, key: i.device_key || null });
        // an old runner on a second computer must not take the credentials of a session that is running well on the first
        if (o.leases && !(live && live.where === "mac")) { try { o.leases.unbind(String(i.session)); } catch { /* not bound */ } }
        return { skew: { need: RUNNER_PROTOCOL_MIN, have: hello.protocol } };
      }
      // The book decides whether this computer may run it (a session the server took comes back only when the person asked) and gives the epoch every later write names.
      // Nothing of a session that is running well elsewhere is touched until the book has said this computer may have it: the refusals above and the book's own (a second computer, a session on the server) leave its
      // credentials and its row as they were.
      const before = book.get(String(i.session));
      const row = book.lend({ session: String(i.session), chat: chat || (asked && asked.chat) || null, person: w.person, device: w.device, key: i.device_key || null });
      if (asked) pipes.claimed(String(i.session), w.device);
      if (o.leases && i.lease) {
        try { await o.leases.renew(chain, { id: String(i.lease) }); o.leases.bind(String(i.session), String(i.lease), { routes: spec.credentialRoutes || [] }); }
        catch (e) {
          // the lease did not hold: the lend is undone, and the epoch it used stays used (a row that existed goes back to the server; one that did not is forgotten, its id still the person's)
          if (before) book.toServer(String(i.session), "crash"); else book.forget(String(i.session));
          throw e;
        }
      }
      owed.delete(String(i.session));
      lent.set(String(i.session), { person: w.person, device: w.device, key: i.device_key, ...(chat ? { chat } : {}) });
      reserved.delete(String(i.session));
      // one line on the Space's timeline for each chat that borrows a computer: who, which computer, what limit holds
      if (o.emit) { try { o.emit("lease.borrowed", { thread: chat || (asked && asked.chat) || String(i.session), session: String(i.session), person: w.person, device: w.device, limit: cap || null, epoch: row.epoch, at: now() }); } catch { /* a notice, never a stop */ } }
      if (o.leases && typeof o.leases.borrowed === "function") { try { o.leases.borrowed({ thread: chat || (asked && asked.chat) || String(i.session), session: String(i.session), member: w.person, device: w.device, limit: cap || null, epoch: row.epoch }); } catch { /* a record, never a gate */ } }
      const title = (asked && asked.title) || (chat && o.titleOf ? await Promise.resolve(o.titleOf(chat)).catch(() => null) : null);
      const { credentialRoutes, ...visible } = spec;
      const seed = seeds.get(String(i.session)); if (seed) seeds.delete(String(i.session));
      return { ...visible, ...(seed ? { seed } : {}), network, lenderCap: cap || null, epoch: row.epoch, ...(typeof title === "string" && title ? { title: title.slice(0, 120) } : {}) };
    },
    /**
     * The lender is alive. Each session it still runs is checked against the book: one whose epoch is not current (it moved, or the home restarted without it) is listed in `fenced`, and the lender stops it
     * at once. `well` is the lender saying nothing holds its sessions back now (lid open, plugged in, online): sessions it gave up for a condition that clears are then offered back. The answer also carries
     * what the home wants done: hand a session over (the person's move), or start one the person brought back.
     * @param {any} chain @param {{ sessions?: { session: string, epoch: number, cpuPercent?: number, memoryMb?: number, turn?: number, paused?: boolean }[], well?: boolean }} [i]
     */
    async beat(chain, i = {}) {
      const w = who(chain);
      const list = i && Array.isArray(i.sessions) ? i.sessions.slice(0, BEAT_MAX) : [];
      /** @type {string[]} */ const fencedList = [];
      for (const x of list) {
        const sid = String(x && x.session), l = lent.get(sid);
        // an Offer that no longer stands ends the lending: the server takes the session instead of counting a healthy beat
        if (l && l.person === w.person && l.device === w.device) {
          if (stands(w, l.key)) l.unstood = 0;
          else if ((l.unstood = (l.unstood || 0) + 1) >= 2 && (await takeOver(sid, "switched-off")).changed) { fencedList.push(sid); continue; }   // twice running: a home that has only just started and not yet read its Offers must not take a healthy session
        }
        if (!SESSION.test(sid) || !l || l.person !== w.person || l.device !== w.device || !Number.isInteger(x.epoch) || !book.beat({ session: sid, epoch: x.epoch, device: w.device, cpuPercent: x.cpuPercent, memoryMb: x.memoryMb, turn: x.turn, paused: x.paused === true }).ok) fencedList.push(sid);
      }
      if (i && i.well === true) book.clear(w.device);
      lenders.set(w.device, { person: w.person, at: now(), well: i && i.well === true });
      return { ok: true, fenced: fencedList, offers: book.offered(w.device), directives: directivesFor(w.device) };
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
    /**
     * The lender's side of a lent spawn: bytes of the process it runs for a chat, up; bytes for its stdin, down. A long poll (contracts/lent-spawn.md). Fenced like every write: an old epoch is `conflict`.
     * @param {any} chain @param {{ session: string, epoch: number, up?: any[], exit?: any, ack?: number, wait_ms?: number }} i
     */
    async pipe(chain, i) {
      const w = writer(chain, i && i.session, i && i.epoch);
      return pipes.poll(String(i.session), i.epoch, w.device, i);
    },
    /**
     * A chat's agent process on this person's computer, for the Agent SDK on this home (`sandboxSpawn`): a ChildProcess whose bytes ride `lent.pipe`. The computer is the person's own that beat lately with nothing holding
     * it back, or the one already running the session. With none ready it fails as a spawn that never started.
     * `thread` is the id the daemon opened the chat's tool socket under; Vyre's tools are routed by it, while `session` stays the key of the book, the checkpoints and the transcript.
     * @param {{ session: string, thread?: string | null, chat?: string | null, person: string, command?: string, args?: string[], signal?: AbortSignal }} i
     */
    spawn(i) {
      const session = String(i && i.session), person = String(i && i.person);
      if (i && i.thread) threads.set(session, String(i.thread));
      const device = pickLender(person, session);
      const proc = pipes.spawn({ session, chat: i.chat || null, title: i.title || null, computer: i.computer || null, person, device, command: "claude", args: i.args, ...(i.signal ? { signal: i.signal } : {}) });
      // a spawn that never started leaves no row saying the chat is on a computer it never reached
      proc.on("error", (/** @type {any} */ e) => { if (e && e.code === "lent_unavailable" && reserved.delete(session) && !lent.has(session)) book.forget(session); });
      if (device) nudge(device);
      return proc;
    },
    /**
     * A new chat's place (contracts/lent-spawn.md): a ready computer of the person's, with the row written, or the box with nothing written. The row is the chat's until a spawn follows (30 seconds), then the lender's own start makes it real.
     * @param {{ session: string, chat?: string | null, person: string }} i
     * @returns {{ where: "mac", device: string, epoch: number } | { where: "box" }}
     */
    placeNew(i) {
      const session = String(i && i.session), person = String(i && i.person);
      const had = SESSION.test(session) ? book.get(session) : null;
      if (had) return had.where === "mac" && had.person === person ? { where: "mac", device: had.device, epoch: had.epoch } : { where: "box" };
      const device = pickLender(person, session);
      if (!device) return { where: "box" };
      const row = book.lend({ session, chat: (i && i.chat) || null, person, device, key: keys.get(device) || null });
      reserved.add(session);
      const t = setTimeout(() => { if (reserved.delete(session) && !lent.has(session)) book.forget(session); }, RESERVE_MS); t.unref?.();
      return { where: "mac", device, epoch: row.epoch };
    },
    /**
     * A chat that began on the server moves to one of the person's computers (runner.move to a computer): its whole turns so far are put in the store as the session's transcript, the book lends the session
     * to a ready computer, and the computer writes that transcript into its own Claude home before it starts the program (the spec's `seed`). Nothing is moved from the server's own disk: the server's copy stays.
     * @param {{ session: string, thread: string, chat?: string | null, person: string, native: string, lines: string[] }} i
     * @returns {{ where: "mac", device: string, epoch: number }}
     */
    async adopt(i) {
      const session = String(i && i.session), person = String(i && i.person);
      if (!SESSION.test(session)) throw err("bad_input", "a session is named by its id");
      if (book.get(session)) throw err("conflict", "that chat already has a place");
      const device = pickLender(person, session);
      if (!device) throw err("unavailable", "none of your computers is ready to take this chat now");
      const lines = Array.isArray(i.lines) ? i.lines : [];
      if (!lines.length) throw err("unavailable", "this chat has no whole turn to move yet");
      return Promise.resolve(store.appendTranscript(HOME, session, lines.map((line, k) => ({ seq: k + 1, line: String(line) })))).then(() => {
        const row = book.lend({ session, chat: i.chat || null, person, device, key: keys.get(device) || null });
        seeds.set(session, { native: String(i.native), count: lines.length });
        threads.set(session, String(i.thread));
        reserved.add(session);
        // the chat's next turn starts the program there (the Switchboard finds this row); until then the place is kept for hours, not seconds
        const t = setTimeout(() => { if (reserved.delete(session) && !lent.has(session)) { book.forget(session); seeds.delete(session); } }, ADOPT_MS); t.unref?.();
        nudge(device);
        return { where: "mac", device, epoch: row.epoch };
      });
    },
    /**
     * The nudge: held up to `wait_ms` until the home has something for this computer to do (a chat to start), so a ready computer is told at once and not at its next heartbeat. The same directives the heartbeat carries.
     * @param {any} chain @param {{ wait_ms?: number }} [i]
     */
    async wait(chain, i = {}) {
      const w = who(chain);
      const ms = Math.max(0, Math.min(25_000, Number.isInteger(i && i.wait_ms) ? /** @type {number} */ (i.wait_ms) : 20_000));
      const now0 = directivesFor(w.device);
      if (now0.length || ms === 0) return { directives: now0 };
      return new Promise(res => {
        const old = waiters.get(w.device); if (old) { clearTimeout(old.t); old.res({ directives: [] }); }
        const t = setTimeout(() => { if (waiters.get(w.device)?.t === t) waiters.delete(w.device); res({ directives: directivesFor(w.device) }); }, ms); t.unref?.();
        waiters.set(w.device, { t, res });
      });
    },
    /**
     * A tool call of the chat's session on a lender, brought to this home: the lent computer's Vyre MCP server asks here, and it is the session's own call, with the session socket's caller binding and kernel credential, so it
     * has the same answers and the same grants as on this box. Fenced like every write. POST /v1/tools/<tool> only. (contracts/lent-spawn.md)
     * @param {any} chain @param {{ session: string, epoch: number, method?: "GET" | "POST", path: string, body?: string, caller?: string }} i
     */
    async http(chain, i) {
      writer(chain, i && i.session, i && i.epoch);
      if (typeof o.http !== "function") throw err("unavailable", "this home cannot bring Vyre's tools to a lent computer");
      const session = String(i.session), now0 = now();
      for (const [k, c] of calls) if (now0 - c.at > CALL_MAX_MS) calls.delete(k);
      // A call that outlasted one wire call: the lender asks again with its ticket and waits for the same answer.
      if (i.ticket !== undefined) {
        const c = typeof i.ticket === "string" ? calls.get(i.ticket) : undefined;
        if (!c || c.session !== session) throw err("not_found", "that tool call is not running any more");
        return await settle(session, String(i.ticket), c);
      }
      const p = String(i.path || ""), method = i.method === "GET" ? "GET" : "POST";
      // a tool call (POST /v1/tools/<name>) or the list of tools the session may use (GET /v1/tools): nothing else of vyred is reachable from a lent computer
      if (method === "GET" ? p !== "/v1/tools" : !/^\/v1\/tools\/[A-Za-z0-9._%-]{1,140}$/.test(p)) throw err("bad_input", "a lent computer asks for a tool: POST /v1/tools/<name>, or GET /v1/tools");
      const body = method === "GET" ? "" : typeof i.body === "string" ? i.body : "{}";
      if (body.length > 128 * 1024) throw err("bad_input", "that request is too large");
      if ([...calls.values()].filter(c => c.session === session).length >= MAX_PENDING) throw err("unavailable", "this chat already has several tool calls running; wait for one to finish");
      const run = Promise.resolve(o.http(threads.get(session) || lent.get(session)?.chat || session, method, p, { "x-vyre-caller": i.caller === "harness" ? "harness" : "mcp" }, body)).then(r => ({ r }), e => ({ e }));
      const ticket = newPrefixedId("call"), c = { session, p: run, at: now0 };
      calls.set(ticket, c);
      return await settle(session, ticket, c);
    },
    async stop(chain, i) { mine(chain, i && i.session); pipes.end(String(i.session), { signal: "SIGTERM" }); lent.delete(String(i.session)); threads.delete(String(i.session)); dropCalls(String(i.session)); book.forget(String(i.session)); if (o.leases) { try { o.leases.unbind(String(i.session)); } catch {} } return { stopped: true }; },
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
      if (!Number.isInteger(c.index) || !Number.isInteger(c.total) || c.total < 1 || c.total > MAX_CHUNKS || c.index < 0 || c.index >= c.total || typeof c.b64 !== "string" || typeof c.upload !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(c.upload)) throw err("bad_input", "a file chunk is numbered and carries its bytes");
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
