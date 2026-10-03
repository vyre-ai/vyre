// kernel/core/room.js: the kernel's side of a chat. A session's chat is in its signed token from birth (kernel/core/surfaces.js `open`), so the kernel never asks a module
// which chat a turn is in. This file answers three things from that token alone:
//   audienceFor(): the room the RUNNING turn answers in, as an opaque handle `{ group: false }` or `{ group: true, size, read(resource, fields?), canRead(resource) }`. It
//     is asked with the turn's own token (the one the dispatcher holds for the call now running, never one a module passes), the kernel computes what EVERYONE in the room
//     may read, and no chain for any other person leaves the kernel, nor any answer that says which person lacks access.
//   append(token, message): the only way a reply lands in a chat: the destination is the chat in the token, so a session opened one-to-one cannot write into a group and
//     a write to any other chat is refused. The kernel records who wrote what where (an owner-visible event with a hash, never the text); the stream keeps the text.
//   An opener who has left the chat (or the Space) has no room and cannot append.
import { KernelError } from "./errors.js";
import { mintId } from "./ids.js";
import { canonical, sha256 } from "./canonical.js";
import { segments } from "./urn.js";
import { isSealedShape } from "../store/values.js";

const MAX_BODY = 64 * 1024;

/**
 * @param {{ space: string, grantsStore: any, surfaces: any, chains: any, gateway: any, log: any, clock?: () => number, currentCall?: () => any }} cfg
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

  /** @param {string[]} people */
  function handle(people) {
    const viewers = people.map(person => cfg.chains.fromFacts({ kind: "viewer", person, vouched: true }));
    const everyone = async (/** @type {(v: any) => Promise<boolean>} */ f) => { for (const v of viewers) if (!(await f(v))) return false; return true; };
    return Object.freeze({
      group: true,
      size: viewers.length,
      /** True only when every person in the room may read it: a record, a task, a team member or a playbook, by its urn. */
      canRead: async (/** @type {string} */ resource) => {
        if (typeof resource !== "string" || !segments(resource)) return false;
        // A task lives in the kernel's task store or as a record, so a task counts as readable only when BOTH reads allow it (the narrower of the two); team members, playbooks and
        // every other record are `records.read` on their urn.
        const type = segments(resource)[1];
        const actions = type === "task" ? ["records.read", "tasks.read"] : ["records.read"];
        try { return await everyone(async v => { for (const action of actions) if ((await cfg.gateway.authorize({ chain: v, action, resource, probe: true })).effect !== "allow") return false; return true; }); } catch { return false; }
      },
      /**
       * A record as the whole room may see it: `{ values, restricted }`, where a field is a value only when every person may read it and holds the same value. Any other
       * field's name is in `restricted`, and a sealed field is always there, whatever anyone's grants say. Null when any person cannot read the record at all (or it does not
       * exist), so a record someone cannot see is not mentioned to the room.
       */
      read: async (/** @type {string} */ resource, /** @type {string[] | undefined} */ fields) => {
        const s = typeof resource === "string" ? segments(resource) : null;
        if (!s || s.length !== 3 || s[0] !== cfg.space) return null;
        let rows;
        try { rows = await Promise.all(viewers.map(v => cfg.gateway.records.get(v, s[1], s[2]))); } catch { return null; }
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

  return Object.freeze({
    bindCalls(/** @type {() => any} */ fn) { currentCall = fn; },
    /** The room the running turn answers in: `{ group: false }`, or the handle. Never from an argument; throws `no_audience` when it cannot be built. */
    async audienceFor() {
      const t = await turn("no_audience");
      const people = gs.chatPeople(t.chat);
      if (!people || !people.includes(t.person)) throw new KernelError("no_audience", "the chat is not known");
      if (people.length < 2) return Object.freeze({ group: false });
      return handle(people);
    },
    /**
     * Write a message into the chat the session was opened for. `message` is `{ kind?, body, chat? }`; naming a chat other than the token's is refused. Returns the id the
     * stream stores the text under, with its hash.
     * @param {string} token @param {{ kind?: string, body: any, chat?: string }} message
     */
    async append(token, message) {
      const t = await ofToken(token, "not_found");
      if (!message || typeof message !== "object" || (message.chat !== undefined && message.chat !== t.chat)) throw new KernelError("not_found", "no such chat");
      const text = canonical(message.body ?? null);
      if (Buffer.byteLength(text) > MAX_BODY) throw new KernelError("bad_input", "a message is at most 64 KB");
      if (t.agent) { const a = gs.chatAssistants(t.chat); if (!a || !a.includes(t.agent)) throw new KernelError("not_found", "no such chat"); }
      const chain = await cfg.surfaces.chainFor(token);
      const id = mintId("msg", clock());
      const hash = sha256(text);
      cfg.log.append(chain, { type: "message.added", sv: 1, subject: `vyre://${cfg.space}/chat/${t.chat}`, data: { id, chat: t.chat, session: t.session, by: { person: t.person, ...(t.agent ? { agent: t.agent } : {}) }, kind: String(message.kind || "text").slice(0, 32), hash, bytes: Buffer.byteLength(text) }, vis: "owner", red: "internal" });
      return Object.freeze({ id, chat: t.chat, at: clock(), hash });
    },
  });
}
