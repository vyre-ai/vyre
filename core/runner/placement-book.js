// @ts-check
// The placement book (R031-95 2.4, 2.5): the home's one record of where each lent session runs. The home owns this fact (FOUNDATION A5): the chat chip, Lumen's list, the mover on the lender's
// computer and the resume on the server all read it here and nowhere else. A record is private operational state of the runner, not business data.
//
// A session is on the lender's computer (`mac`) or on the space's server (`server`). Every change of place bumps its epoch: a lender's call that names an older epoch is fenced, so a computer that was
// paused, not dead, can never write a turn the server already ran again. Nothing here moves a session: it records the move, says who may do the next one, and tells the caller what changed.
import fs from "node:fs";
import path from "node:path";

/** Why a session is where it is, as the chat says it (design's words). `you` is the person's own move. */
export const REASONS = Object.freeze(["lid-closed", "asleep", "unplugged", "cpu-cap", "mem-cap", "switched-off", "offline", "lease-expired", "crash", "version-skew", "you"]);
/** The reasons of a move the computer chose by its own condition: at most one per cooldown for a session. A crash, a lapse, the person's move and a version skew are never held back. */
export const AUTO = Object.freeze(["lid-closed", "asleep", "unplugged", "cpu-cap", "mem-cap", "switched-off"]);
/** The reasons that clear by themselves: when the computer is well again the session is offered back (never moved back). */
export const CLEARS = Object.freeze(["lid-closed", "asleep", "unplugged", "cpu-cap", "mem-cap", "offline", "lease-expired"]);
export const STATES = Object.freeze(["here", "moving", "server", "locked", "updating"]);
/** A lent session whose computer has not been heard from for this long is taken back by the server. The computer beats every HEARTBEAT_MS. */
export const HEARTBEAT_MS = 5_000;
export const LAPSE_MS = 20_000;
/** After an automatic move (a condition, not the person) the same session is not moved automatically again for this long: one move per state change. */
export const COOLDOWN_MS = 120_000;
/** A computer that was asked to hand a session over and has not within this long is overruled: the server takes it. */
export const ASK_MS = 60_000;

const bad = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const SESSION = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * @typedef {{ session: string, chat: string | null, person: string, device: string, key?: string | null, where: "mac" | "server", state: "here" | "moving" | "server" | "locked" | "updating",
 *   reason: string | null, since: number, epoch: number, offer: "mac" | null, pin: "server" | "mac" | null, beat: number, movedAt: number | null, allowMac: boolean, ask?: { do: "release" | "start", reason: string | null, at: number } | null,
 *   facts?: { cpuPercent?: number, memoryMb?: number, turn?: number } }} Row
 * @typedef {{ load(): Row[], save(rows: Row[]): void }} Store
 */

/** A store in one JSON file beside the home's lent folder; the file is rewritten whole and renamed in, so a crash leaves the old or the new one. @param {string} file @returns {Store} */
export function fileStore(file) {
  return {
    load() { try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(j) ? j : []; } catch { return []; } },
    save(rows) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

/**
 * @param {{ now?: () => number, store?: Store, emit?: (type: string, payload: any) => void, cooldownMs?: number, lapseMs?: number }} [o]
 */
export function createPlacementBook(o = {}) {
  const now = o.now || Date.now;
  const cooldown = o.cooldownMs ?? COOLDOWN_MS, lapse = o.lapseMs ?? LAPSE_MS;
  /** @type {Map<string, Row>} */ const rows = new Map();
  for (const r of o.store ? o.store.load() : []) if (r && SESSION.test(String(r.session))) rows.set(r.session, r);
  const save = () => { try { o.store?.save([...rows.values()]); } catch { /* a book that cannot be written still answers; the next change tries again */ } };
  const copy = (/** @type {Row} */ r) => ({ ...r, ...(r.facts ? { facts: { ...r.facts } } : {}) });
  /** What a move says to the world: the chat (or the session when no chat is named), from, to, why. */
  const moved = (/** @type {Row} */ r, /** @type {string} */ from, /** @type {string} */ to, /** @type {string | null} */ reason) => {
    try { o.emit?.("thread.moved", { thread: r.chat || r.session, session: r.session, from, to, reason, epoch: r.epoch, device: r.device, at: now() }); } catch { /* a notice, never a stop */ }
  };

  return {
    /** The row for a session, or null. @param {string} session */
    get(session) { const r = rows.get(String(session)); return r ? copy(r) : null; },
    /** The row for a chat or a session id. @param {string} id */
    find(id) { const r = rows.get(String(id)) || [...rows.values()].find(x => x.chat === id); return r ? copy(r) : null; },
    all() { return [...rows.values()].map(copy); },

    /**
     * The lender starts (or resumes) a session on its computer. A session now on the server comes back only when the person asked for it (`bringBack`), and never while pinned to the server.
     * Answers the row, with a new epoch: everything the lender writes from now on names it.
     * @param {{ session: string, chat?: string | null, person: string, device: string, key?: string | null }} i
     */
    lend(i) {
      const session = String(i.session);
      if (!SESSION.test(session)) throw bad("name the session", "bad_input");
      const had = rows.get(session);
      if (had && had.person !== i.person) throw bad("not found", "not_found");
      if (had && had.pin === "server") throw bad("this session is pinned to the server: unpin it before it runs on a computer", "conflict");
      if (had && had.where === "server" && !had.allowMac) throw bad("this session runs on the server now: bring it back to the computer from its chat first", "conflict");
      const t = now();
      /** @type {Row} */ const r = { session, chat: i.chat || (had && had.chat) || null, person: i.person, device: i.device, key: i.key || null, where: "mac", state: "here", reason: null, since: t, epoch: (had ? had.epoch : 0) + 1,
        offer: null, pin: had ? had.pin : null, beat: t, movedAt: had ? had.movedAt : null, allowMac: false, ask: null };
      rows.set(session, r); save();
      if (had && had.where === "server") moved(r, "server", "mac", "you");
      return copy(r);
    },

    /** The person asks for a session on the server to run on its computer again (the offer, or a tap): the next lend of it is allowed. @param {string} id @param {string} person */
    bringBack(id, person) {
      const r = this.find(id); if (!r || r.person !== person) throw bad("no such session", "not_found");
      const live = /** @type {Row} */ (rows.get(r.session));
      if (live.pin === "server") throw bad("this session is pinned to the server: unpin it first", "conflict");
      if (live.where === "mac") return copy(live);
      live.allowMac = true; live.offer = "mac"; live.ask = { do: "start", reason: null, at: now() }; save();
      return copy(live);
    },

    /**
     * The lender is alive and says how its sessions are. Answers `{ ok, epoch }`, or `{ ok: false, fenced: true }` when the session is no longer this epoch's (it moved, or it was never this lender's):
     * the lender stops it at once.
     * @param {{ session: string, epoch: number, device: string, cpuPercent?: number, memoryMb?: number, turn?: number }} i
     */
    beat(i) {
      const r = rows.get(String(i.session));
      if (!r || r.where !== "mac" || r.epoch !== i.epoch || r.device !== i.device) return { ok: false, fenced: true };
      r.beat = now();
      const f = {}; for (const k of /** @type {const} */ (["cpuPercent", "memoryMb", "turn"])) if (Number.isFinite(i[k])) /** @type {any} */ (f)[k] = Number(i[k]);
      r.facts = f;
      return { ok: true, epoch: r.epoch };
    },

    /** Is a lender's call at this epoch still the session's current one? @param {string} session @param {number} epoch @param {string} device */
    current(session, epoch, device) { const r = rows.get(String(session)); return Boolean(r && r.where === "mac" && r.epoch === epoch && r.device === device); },

    /** A restarted home gives every lender a whole lapse to show itself before it takes a session. */
    grace() { const t = now(); let n = 0; for (const r of rows.values()) if (r.where === "mac") { r.beat = t; n++; } return n; },

    /** The sessions on a computer that has not been heard from for the lapse: they are the server's to take. @returns {Row[]} */
    lapsed() { const t = now(); return [...rows.values()].filter(r => r.where === "mac" && t - r.beat > lapse).map(copy); },

    /**
     * Record a move to the server. `auto` is a move the computer's own condition asked for (not the person, not a vanished computer): at most one per cooldown for a session. The epoch rises, so the old
     * lender is fenced. Answers `{ changed, row }`, or `{ changed: false, why }` when it is already there or the cooldown holds.
     * @param {string} session @param {string} reason one of REASONS @param {{ auto?: boolean }} [opt]
     */
    toServer(session, reason, opt = {}) {
      if (!REASONS.includes(reason)) throw bad("that reason is not one the chat knows", "bad_input");
      const r = rows.get(String(session));
      if (!r) return { changed: false, why: "unknown" };
      if (r.where === "server") return { changed: false, why: "there", row: copy(r) };
      const t = now();
      if (opt.auto && r.movedAt !== null && t - r.movedAt < cooldown) return { changed: false, why: "cooldown", row: copy(r) };
      r.where = "server"; r.state = "server"; r.reason = reason; r.since = t; r.epoch += 1; r.movedAt = t; r.allowMac = false; r.offer = null; r.ask = null; r.facts = undefined;
      save(); moved(r, "mac", "server", reason);
      return { changed: true, row: copy(r) };
    },

    /** The person (or the server) asks the lender to hand a session over: it finishes its turn, checkpoints and releases it. Until it does the session reads as moving. @param {string} id @param {string} reason */
    askRelease(id, reason) {
      const r = this.find(id); if (!r) throw bad("no such session", "not_found");
      if (!REASONS.includes(reason)) throw bad("that reason is not one the chat knows", "bad_input");
      const live = /** @type {Row} */ (rows.get(r.session));
      if (live.where !== "mac") return copy(live);
      live.state = "moving"; live.ask = { do: "release", reason, at: now() }; save();
      return copy(live);
    },
    /** What the home wants this computer to do, told in the answer to its heartbeat: hand a session over, or start one the person brought back. @param {string} device @returns {{ do: "release" | "start", session: string, chat: string | null, reason: string | null }[]} */
    directives(device) {
      return [...rows.values()].filter(r => r.device === device && r.ask && (r.ask.do === "release" ? r.where === "mac" : r.where === "server" && r.allowMac)).map(r => ({ do: /** @type {"release" | "start"} */ (/** @type {any} */ (r.ask).do), session: r.session, chat: r.chat, reason: /** @type {any} */ (r.ask).reason }));
    },
    /** Sessions of this computer the server has and the person may bring back. @param {string} device */
    offered(device) { return [...rows.values()].filter(r => r.device === device && r.where === "server" && r.offer === "mac" && r.pin !== "server").map(r => r.session); },
    /** Sessions the lender was asked to hand over and has not, for longer than ASK_MS: overruled. */
    overdue() { const t = now(); return [...rows.values()].filter(r => r.where === "mac" && r.ask && r.ask.do === "release" && t - r.ask.at > ASK_MS).map(copy); },

    /** The computer's condition cleared (lid open, plugged in, back online): every session of it that moved for a reason that clears is offered back. Nothing moves. Answers the sessions offered. @param {string} device */
    clear(device) {
      const out = [];
      for (const r of rows.values()) if (r.device === device && r.where === "server" && r.pin !== "server" && r.reason && CLEARS.includes(r.reason) && r.offer !== "mac") { r.offer = "mac"; out.push(copy(r)); }
      if (out.length) save();
      return out;
    },

    /** The person pins a session ("keep running when I close my laptop") or lets it go. @param {string} id @param {"server" | "mac" | null} pin */
    pin(id, pin) {
      const r = this.find(id); if (!r) throw bad("no such session", "not_found");
      if (pin !== null && pin !== "server" && pin !== "mac") throw bad("a pin is server, mac or none", "bad_input");
      const live = /** @type {Row} */ (rows.get(r.session)); live.pin = pin; if (pin === "server") live.offer = null; save();
      return copy(live);
    },

    /** The state the lender's own state machine reports for a session that is moving or locked. @param {string} session @param {Row["state"]} state */
    mark(session, state) { const r = rows.get(String(session)); if (r && STATES.includes(state)) { r.state = state; save(); } },

    /** The session is over for good (stopped by the person, deleted). @param {string} session */
    forget(session) { if (rows.delete(String(session))) save(); },
  };
}

/** The place a row stands for, in the shape `runner.placement` answers (the contract: team/contracts/runner.md). @param {Row | null} r @param {{ computer?: string | null }} [x] */
export function placementOf(r, x = {}) {
  if (!r) return { where: "server", computer: null, state: "server", reason: null, since: null, offer: null, pinned: false, pin: null };
  return { where: r.where, computer: r.where === "mac" ? x.computer ?? null : null, state: r.state, reason: r.reason, since: r.since, offer: r.offer, pinned: r.pin !== null, pin: r.pin, epoch: r.epoch };
}
