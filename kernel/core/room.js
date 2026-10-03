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

const MAX_BODY = 64 * 1024;
const RATE = Object.freeze({ max: 120, window_ms: 60_000, sessions: 5000 });

/**
 * The room as the gateway sees it, for a chain made from a session token that names a chat (kernel/core/chain.js `room`): the chat's LIVE participants at every call (never a
 * list taken earlier). A READ always sees the room as it is now; a REPLY belongs to the version it was opened under (see `appendOpen`).
 * @param {{ grantsStore: any }} cfg
 */
export function createRoomPort(cfg) {
  const gs = cfg.grantsStore;
  return Object.freeze({
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

  /** @type {Map<string, { chat: string, ver: number }> | null} message id -> the chat and membership version it was written under, read back from the log on first use */ let seen = null;
  const messages = () => {
    if (!seen) {
      seen = new Map();
      for (const e of cfg.log.read({})) if ((e.type === "message.opened" || e.type === "message.added") && e.data && typeof e.data.id === "string" && typeof e.data.chat === "string" && Number.isInteger(e.data.ver)) seen.set(e.data.id, { chat: e.data.chat, ver: e.data.ver });
    }
    return seen;
  };
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
    const everyone = async (/** @type {any[]} */ vs, /** @type {(v: any) => Promise<boolean>} */ f) => { let all = true; for (const v of vs) if (!(await f(v))) all = false; return all; }; // asks every viewer: its time does not say who failed
    return Object.freeze({
      group: true,
      /** True only when every person in the room may read it: a record, a task, a team member or a playbook, by its urn. Row predicates apply (no type-level probe). */
      canRead: async (/** @type {string} */ resource) => {
        limited(t.session);
        if (typeof resource !== "string" || !segments(resource)) return false;
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
        const vs = viewers();
        let rows;
        try { rows = await Promise.all(vs.map(v => cfg.gateway.records.get(v, s[1], s[2]))); } catch { return null; }
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

  /** @type {any} */ const api = Object.freeze({
    bindCalls(/** @type {() => any} */ fn) { currentCall = fn; },
    /** The room the running turn answers in: `{ group: false }`, or the handle. Never from an argument; throws `no_audience` when it cannot be built. */
    async audienceFor() {
      const t = await turn("no_audience");
      const people = gs.chatPeople(t.chat);
      if (!people || !people.includes(t.person)) throw new KernelError("no_audience", "the chat is not known");
      if (people.length < 2) return Object.freeze({ group: false });
      return handle({ chat: t.chat, session: t.session, person: t.person });
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
      if (t.agent) { const a = gs.chatAssistants(t.chat); if (!a || !a.includes(t.agent)) throw new KernelError("not_found", "no such chat"); }
      const v = gs.chatVersion(t.chat);
      if (!v) throw new KernelError("not_found", "no such chat");
      const id = mintId("msg", clock());
      const kind = String(message.kind || "text").slice(0, 32);
      const by = { person: t.person, ...(t.agent ? { agent: t.agent } : {}) };
      const subject = `vyre://${cfg.space}/chat/${t.chat}`;
      const chain = await cfg.surfaces.chainFor(token);
      cfg.log.append(chain, { type: "message.opened", sv: 1, subject, data: { id, chat: t.chat, ver: v.ver, session: t.session, by, kind }, vis: "owner", red: "internal" });
      messages().set(id, { chat: t.chat, ver: v.ver });
      let open = true, bytes = 0;
      const hash = crypto.createHash("sha256");
      /** The token must still be good and the person still in the chat at every write. */
      const live = async () => { if (!open) throw new KernelError("closed", "this reply is closed"); await ofToken(token, "not_found"); };
      return Object.freeze({
        id, chat: t.chat, ver: v.ver,
        /** @param {any} delta text (or a JSON value) of the reply so far, in order */
        async write(delta) {
          await live();
          const text = typeof delta === "string" ? delta : canonical(delta ?? null);
          bytes += Buffer.byteLength(text);
          if (bytes > MAX_BODY) { open = false; throw new KernelError("bad_input", "a message is at most 64 KB"); }
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
      if (agent && !(gs.chatAssistants(m.chat) || []).includes(agent.id)) return false;
      const then = gs.chatPeopleAt(m.chat, m.ver), now = gs.chatPeople(m.chat);
      return Boolean(then && now && then.includes(who.id) && now.includes(who.id));
    },
  });
  return api;
}
