// kernel/core/room.js: the kernel's side of a chat. A session's chat is in its signed token from birth (kernel/core/surfaces.js `open`), so the kernel never asks a module
// which chat a turn is in. This file answers three things from that token alone:
//   audienceFor(): the room the RUNNING turn answers in, as an opaque handle `{ group: false }` or `{ group: true, size, read(resource, fields?), canRead(resource) }`. It
//     is asked with the turn's own token (the one the dispatcher holds for the call now running, never one a module passes), the kernel computes what EVERYONE in the room
//     may read, and no chain for any other person leaves the kernel, nor any answer that says which person lacks access.
//   append(token, message): the only way a reply lands in a chat: the destination is the chat in the token, so a session opened one-to-one cannot write into a group and
//     a write to any other chat is refused. The kernel records who wrote what where (an owner-visible event with a hash, never the text); the stream keeps the text.
//   An opener who has left the chat (or the Space) has no room and cannot append.
import crypto from "node:crypto";
import { KernelError } from "./errors.js";
import { isChain } from "./chain.js";
import { mintId } from "./ids.js";
import { canonical, sha256 } from "./canonical.js";
import { segments } from "./urn.js";
import { isSealedShape } from "../store/values.js";

/** The person's own assistant is identity-level: never listed in a chat, acting as the person (via: "assistant"), so a chat checks its person, as authorize.js already treats it as a pass-through hop. */
const DEFAULT_ASSISTANT = "assistant";

const MAX_BODY = 64 * 1024;
const RATE = Object.freeze({ max: 120, window_ms: 60_000, sessions: 5000 });

/**
 * The room as the gateway sees it, for a chain made from a session token that names a chat (kernel/core/chain.js `room`): the chat's LIVE participants at every call (never a
 * list taken earlier). A READ always sees the room as it is now; a REPLY belongs to the version it was opened under (see `appendOpen`).
 * @param {{ grantsStore: any }} cfg
 */
export function createRoomPort(cfg) {
  const gs = cfg.grantsStore;
  /** @type {Map<string, number>} session -> the lowest room version any read since its last reply was made under */ const reads = new Map();
  return Object.freeze({
    /** A read under a group session happened now: remember the room's version it was made under (a reply built from it belongs to that version, or an older one). @param {any} chain */
    noteRead(chain) {
      const v = gs.chatVersion(chain.room.chat);
      if (!v) return;
      const sid = chain.room.session, was = reads.get(sid);
      reads.set(sid, was === undefined ? v.ver : Math.min(was, v.ver));
      if (reads.size > RATE.sessions) reads.delete(reads.keys().next().value);
    },
    /** The session's turn begins now: the room's version is fixed here, before the turn's first read. A reply for this turn belongs to this version or an older one. @param {string} session @param {string} chat */
    begin(session, chat) {
      const v = gs.chatVersion(chat);
      if (!v) return null;
      reads.set(session, v.ver);
      if (reads.size > RATE.sessions) reads.delete(reads.keys().next().value);
      return v.ver;
    },
    /** The version a reply opened now belongs to: the oldest version any read since the last reply was made under, else the current one; the notes start again. @param {string} session @param {number} current */
    takeVersion(session, current) { const was = reads.get(session); reads.delete(session); return was === undefined ? current : Math.min(current, was); },
    /** The people of the chain's room when it is a group (more than one), null when it is not; `not_found` when the person the session is for is no longer in the chat. @param {any} chain @returns {string[] | null} */
    peopleOf(chain) {
      const r = chain && chain.room;
      if (!r) return null;
      const people = gs.chatPeople(r.chat);
      const asker = chain.hops[0].actor.id;
      if (!people || !people.includes(asker)) throw new KernelError("not_found", "no such chat");
      return people.length > 1 ? people : null;
    },
  });
}

/**
 * @param {{ space: string, grantsStore: any, port: any, surfaces: any, chains: any, gateway: any, log: any, clock?: () => number, currentCall?: () => any }} cfg
 */
export function createRoom(cfg) {
  const clock = cfg.clock || Date.now;
  /** @type {() => any} */ let currentCall = cfg.currentCall || (() => null);
  const gs = cfg.grantsStore;

  /** The verified facts of the running turn's own token, with the chat and the asker still in it; else the reason it has no room. @param {string} code */
  async function turn(code) {
    const call = currentCall();
    const token = call && typeof call.token === "string" ? call.token : null;
    if (!token) throw new KernelError(code, "this call carries no session of its own, so there is no room");
    return ofToken(token, code);
  }
  /** @param {string} token @param {string} code */
  async function ofToken(token, code) {
    let t;
    try { t = await cfg.surfaces.verify(token); } catch { throw new KernelError(code, "this session is not valid"); }
    if (typeof t.chat !== "string" || !t.chat) throw new KernelError(code, "this session is not in a chat");
    // CH-5: an opener who has left the chat, or the Space, has no room and no write.
    if (!gs.chatHas(t.person, t.chat)) throw new KernelError(code, "the person this turn is for is no longer in the chat");
    return t;
  }

  /** @type {Map<string, { chat: string, ver: number }>} the messages seen lately: id -> the chat and membership version it was written under; the rest are looked up in the log by id, never loaded as a whole */ const seen = new Map();
  const messages = () => ({
    get(/** @type {string} */ id) {
      const hit = seen.get(id);
      if (hit) return hit;
      for (const e of cfg.log.read({ type: "message.*", ref: id, limit: 2 })) if (e.data && e.data.id === id && typeof e.data.chat === "string" && Number.isInteger(e.data.ver)) { const m = { chat: e.data.chat, ver: e.data.ver }; this.set(id, m); return m; }
      return undefined;
    },
    set(/** @type {string} */ id, /** @type {{ chat: string, ver: number }} */ m) { seen.set(id, m); if (seen.size > 2000) seen.delete(seen.keys().next().value); },
  });
  /** @type {Map<string, number[]>} session -> times of its recent room questions */ const asked = new Map();
  /** One session may ask the room only so often: the answers are one bit about everyone else, and a loop of them is a probe. @param {string} session */
  function limited(session) {
    const now = clock();
    let w = asked.get(session);
    if (!w) { if (asked.size >= RATE.sessions) asked.delete(asked.keys().next().value); w = []; asked.set(session, w); }
    while (w.length && now - w[0] > RATE.window_ms) w.shift();
    if (w.length >= RATE.max) throw new KernelError("rate_limited", "too many questions about this room; wait a moment");
    w.push(now);
  }

  /**
   * The handle for one session's turn. It keeps the chat and the session, never a list of people: the room is the chat's LIVE participants at every question, so a person who
   * joined after the handle was made is asked too (R3), and a person who left or the asker leaving ends the answer. It has no head count.
   * @param {{ chat: string, session: string, person: string }} t
   */
  function handle(t) {
    /** Live viewers, or null when the room is no longer a group of the asker's. */
    const viewers = () => {
      const people = gs.chatPeople(t.chat);
      if (!people || !people.includes(t.person)) throw new KernelError("no_audience", "the person this turn is for is no longer in the chat");
      return people.map(person => cfg.chains.fromFacts({ kind: "viewer", person, vouched: true }));
    };
    const note = () => cfg.port.noteRead({ room: { chat: t.chat, session: t.session } });
    const everyone = async (/** @type {any[]} */ vs, /** @type {(v: any) => Promise<boolean>} */ f) => { let all = true; for (const v of vs) if (!(await f(v))) all = false; return all; }; // asks every viewer: its time does not say who failed
    return Object.freeze({
      group: true,
      /** True only when every person in the room may read it: a record, a task, a team member or a playbook, by its urn. Row predicates apply (no type-level probe). */
      canRead: async (/** @type {string} */ resource) => {
        limited(t.session);
        if (typeof resource !== "string" || !segments(resource)) return false;
        note();
        // A task lives in the kernel's task store or as a record, so a task counts as readable only when BOTH reads allow it (the narrower of the two); team members, playbooks and
        // every other record are `records.read` on their urn.
        const type = segments(resource)[1];
        const actions = type === "task" ? ["records.read", "tasks.read"] : ["records.read"];
        try { return await everyone(viewers(), async v => { for (const action of actions) if ((await cfg.gateway.authorize({ chain: v, action, resource })).effect !== "allow") return false; return true; }); } catch (e) { if (e instanceof KernelError && e.code === "no_audience") throw e; return false; }
      },
      /**
       * A record as the whole room may see it: `{ values, restricted }`, where a field is a value only when every person may read it and holds the same value. Any other
       * field's name is in `restricted`, and a sealed field is always there, whatever anyone's grants say. Null when any person cannot read the record at all (or it does not
       * exist), so a record someone cannot see is not mentioned to the room.
       */
      read: async (/** @type {string} */ resource, /** @type {string[] | undefined} */ fields) => {
        limited(t.session);
        const s = typeof resource === "string" ? segments(resource) : null;
        if (!s || s.length !== 3 || s[0] !== cfg.space) return null;
        note();
        const vs = viewers();
        let rows;
        try {
          // A kernel task is held by the task store, read under each person's own `tasks.read`; every other type is a record under `records.read`.
          rows = s[1] === "task" && cfg.gateway.ask && typeof cfg.gateway.ask.get === "function"
            ? (await Promise.all(vs.map(v => cfg.gateway.ask.get(v, s[2])))).map(t => (t && typeof t === "object" ? { data: t } : null))
            : await Promise.all(vs.map(v => cfg.gateway.records.get(v, s[1], s[2])));
        } catch { return null; }
        if (rows.some(r => !r || typeof r.data !== "object")) return null;
        const want = Array.isArray(fields) ? new Set(fields.map(String)) : null;
        const names = [...new Set(rows.flatMap(r => Object.keys(r.data)))].filter(n => !want || want.has(n)).sort();
        /** @type {Record<string, any>} */ const values = {};
        /** @type {string[]} */ const restricted = [];
        for (const n of names) {
          const first = rows[0].data[n];
          const same = rows.every(r => n in r.data && canonical(r.data[n]) === canonical(first));
          if (same && !rows.some(r => isSealedShape(r.data[n]))) values[n] = first; else restricted.push(n);
        }
        if (want) for (const n of want) if (!names.includes(n) && !restricted.includes(n)) restricted.push(n);
        return Object.freeze({ values: Object.freeze(values), restricted: Object.freeze(restricted) });
      },
    });
  }

  /** The handle for a verified turn's facts: `{ group: false }`, or the live room. @param {any} t */
  const roomOf = (t) => {
    const people = gs.chatPeople(t.chat);
    if (!people || !people.includes(t.person)) throw new KernelError("no_audience", "the chat is not known");
    if (people.length < 2) return Object.freeze({ group: false });
    return handle({ chat: t.chat, session: t.session, person: t.person });
  };
  /** @type {any} */ const api = Object.freeze({
    bindCalls(/** @type {() => any} */ fn) { currentCall = fn; },
    /** The room the running turn answers in: `{ group: false }`, or the handle. Never from an argument; throws `no_audience` when it cannot be built. */
    async audienceFor() { return roomOf(await turn("no_audience")); },
    /**
     * The same room, from a context that is not a call (event-driven code holding the session's token): the token must verify, name a chat, and its person be in it; the answer
     * is the live room as `audienceFor` gives it, with the same rules and the same rate limit. Only for a module whose manifest declares it (kernel/index.js).
     * @param {string} token
     */
    async roomFor(token) { return roomOf(await ofToken(token, "no_audience")); },
    /**
     * Begin the session's turn (CH-10): fix the room's membership version NOW, before the turn reads anything. Everything the turn reads and the reply it opens belong to this
     * version or an older one, so the kernel does not depend on the stream calling in a particular order. Returns `{ ver }`.
     * @param {string} token
     */
    async beginTurn(token) {
      const t = await ofToken(token, "not_found");
      const ver = cfg.port.begin(t.session, t.chat);
      if (ver === null) throw new KernelError("not_found", "no such chat");
      return Object.freeze({ chat: t.chat, ver });
    },
    /**
     * Open a reply in the chat the session was opened for. The reply is stamped with the chat's membership VERSION now and belongs to it: it is delivered only to the people who
     * were in the room at that version (`mayReceive`), so someone who joins while it streams, or afterwards, never receives it, and a reply never has to be refused or run again
     * because the room grew. Returns a handle `{ id, chat, ver, write(delta), close(final?) }`. Each write checks the session's token is still good and its person is still in the
     * chat; a handle is dead after `close`. The kernel keeps no text: it counts bytes, hashes what was written and records who wrote what where, in which version.
     * @param {string} token @param {{ kind?: string, chat?: string }} [message]
     */
    async appendOpen(token, message = {}) {
      const t = await ofToken(token, "not_found");
      if (!message || typeof message !== "object" || (message.chat !== undefined && message.chat !== t.chat)) throw new KernelError("not_found", "no such chat");
      if (t.agent && !gs.chatAssistantOk(t.chat, t.agent)) throw new KernelError("not_found", "no such chat");
      const cur = gs.chatVersion(t.chat);
      if (!cur) throw new KernelError("not_found", "no such chat");
      // CH-10: a reply built from reads made when the room was smaller belongs to that smaller room, however late it is opened.
      const v = { ver: cfg.port.takeVersion(t.session, cur.ver) };
      const id = mintId("msg", clock());
      const kind = String(message.kind || "text").slice(0, 32);
      const by = { person: t.person, ...(t.agent ? { agent: t.agent } : {}) };
      const subject = `vyre://${cfg.space}/chat/${t.chat}`;
      const chain = await cfg.surfaces.chainFor(token);
      cfg.log.append(chain, { type: "message.opened", sv: 1, subject, data: { id, chat: t.chat, ver: v.ver, session: t.session, by, kind }, vis: "owner", red: "internal" });
      messages().set(id, { chat: t.chat, ver: v.ver });
      let open = true, bytes = 0;
      const hash = crypto.createHash("sha256");
      /** The reply stops here: what was written stays, and the log says it ended and why. */
      const stop = (/** @type {string} */ reason) => {
        if (!open) return;
        open = false;
        try { cfg.log.append(chain, { type: "message.ended", sv: 1, subject, data: { id, chat: t.chat, ver: v.ver, session: t.session, by, kind, bytes, hash: hash.copy().digest("hex"), reason }, vis: "owner", red: "internal" }); } catch { /* the reply is dead either way */ }
      };
      /** At every write and at the close: the token is still good, the person it acts for is still in the chat, and the assistant (when there is one) is still a participant. */
      const live = async () => {
        if (!open) throw new KernelError("closed", "this reply is closed");
        try {
          const now = await ofToken(token, "not_found");
          if (now.agent && !gs.chatAssistantOk(t.chat, now.agent)) throw new KernelError("not_found", "the assistant is no longer in the chat");
        } catch (e) { stop(e instanceof KernelError ? "no_longer_allowed" : "failed"); throw e; }
      };
      return Object.freeze({
        id, chat: t.chat, ver: v.ver,
        /** @param {any} delta text (or a JSON value) of the reply so far, in order */
        async write(delta) {
          await live();
          const text = typeof delta === "string" ? delta : canonical(delta ?? null);
          bytes += Buffer.byteLength(text);
          if (bytes > MAX_BODY) { stop("too_large"); throw new KernelError("bad_input", "a message is at most 64 KB"); }
          hash.update(text);
          return { bytes };
        },
        /** End the reply; `final` (optional) is the whole text, whose hash is the one recorded, else the hash of the deltas. @param {any} [final] */
        async close(final) {
          await live();
          open = false;
          let h;
          if (final !== undefined) { const text = typeof final === "string" ? final : canonical(final ?? null); if (Buffer.byteLength(text) > MAX_BODY) throw new KernelError("bad_input", "a message is at most 64 KB"); h = sha256(text); bytes = Buffer.byteLength(text); } else h = hash.digest("hex");
          cfg.log.append(chain, { type: "message.added", sv: 1, subject, data: { id, chat: t.chat, ver: v.ver, session: t.session, by, kind, hash: h, bytes }, vis: "owner", red: "internal" });
          return Object.freeze({ id, chat: t.chat, ver: v.ver, at: clock(), hash: h });
        },
      });
    },
    /**
     * Write a whole message (a person's send, or a reply that is already complete): `appendOpen` and `close` in one step, stamped with the version the same way.
     * @param {string} token @param {{ kind?: string, body: any, chat?: string }} message
     */
    async append(token, message) {
      if (!message || typeof message !== "object") throw new KernelError("not_found", "no such chat");
      const text = canonical(message.body ?? null);
      if (Buffer.byteLength(text) > MAX_BODY) throw new KernelError("bad_input", "a message is at most 64 KB");
      const h = await api.appendOpen(token, { kind: message.kind, chat: message.chat });
      return h.close(text);
    },
    /**
     * May this person receive this message? True when they were in the room at the message's version AND are in it now (someone removed stops receiving at once; someone who joined
     * later never receives what was said before). Asked with the viewer's OWN chain (a person, or an assistant acting for one who is listed), so it answers only for the person
     * asking and says nothing about anyone else; unknown messages and anything else are false. The stream's per-viewer filter asks this and does not decide for itself.
     * @param {any} chain @param {string} messageId
     */
    mayReceive(chain, messageId) {
      const m = messages().get(String(messageId));
      if (!m || !isChain(chain) || chain.viewer === true) return false;
      const hops = chain.hops, who = hops[0] && hops[0].actor.kind === "person" ? hops[0].actor : null;
      const agent = hops.length === 2 && hops[1].actor.kind === "agent" ? hops[1].actor : null;
      if (!who || !(hops.length === 1 || agent)) return false;
      if (agent && !gs.chatAssistantOk(m.chat, agent.id)) return false;
      const then = gs.chatPeopleAt(m.chat, m.ver), now = gs.chatPeople(m.chat);
      return Boolean(then && now && then.includes(who.id) && now.includes(who.id));
    },
  });
  return api;
}

/**
 * The authorizer every read goes through, made group-aware (CH-8b). For a chain made from a session token that names a chat of more than one person, a READ action is allowed
 * only when every person in the room is also allowed it: so tasks, drive files, events, listings and every other gated read give the room's view, not the asker's, whichever
 * module asks. Writes and every other act still run under the asker's grants. A chain with no room, or a room of one, is untouched.
 * @param {any} base the real authorizer @param {{ peopleOf(chain: any): string[] | null, noteRead(chain: any): void }} port @param {any} chains
 */
export function roomedAuthorizer(base, port, chains) {
  return Object.create(base, {
    authorize: { value: async (/** @type {any} */ input) => {
      const d = await base.authorize(input);
      const chain = input && input.chain;
      if (!chain || !chain.room || d.effect !== "allow") return d;
      const def = base.actions && base.actions.get ? base.actions.get(input.action) : null;
      if (!def || def.risk !== "read") return d;
      let people;
      try { people = port.peopleOf(chain); } catch { return Object.freeze({ ...d, effect: "deny", reason: "not_in_room", obligations: Object.freeze([]) }); }
      if (!people) return d;
      port.noteRead(chain);
      for (const person of people) {
        const v = await chains.fromFacts({ kind: "viewer", person, vouched: true });
        const r = await base.authorize({ chain: v, action: input.action, resource: input.resource, ...(input.probe === true ? { probe: true } : {}) });
        if (r.effect !== "allow") return Object.freeze({ ...d, effect: "deny", reason: "not_in_room", obligations: Object.freeze([]) });
      }
      return d;
    } },
  });
}
