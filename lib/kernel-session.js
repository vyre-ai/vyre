// @ts-check
import { withinOrThrow } from "./within.js";
// kernel-session: the kernel credential of a session Vyre starts, and how it reaches the daemon without the session ever holding it.
//
// The daemon sets a call's kernel token only from the header `x-vyre-kernel-session` (core/daemon/index.js, verified by the kernel's Surfaces door). So every call a
// session makes must arrive with its own token. The token is the session's, issued by the kernel when the session (or its turn) opens, with its chat written in by the
// kernel. It must never be chosen or read by the model, so it is NOT handed to the harness: not in an environment variable (Claude Code passes its environment to every
// tool, so a Bash call could print it), not in a file in the workspace, not in a tool argument.
//
// The one shape (this and the session-bound socket): vyred holds the token. The session's own socket (core/daemon/threadsock.js, the one VYRE_SOCKET names) takes a
// `kernelToken` function and sets the header on every request itself, after dropping any `x-vyre-kernel-session` the client sent. The harness gets a socket path, which is
// not a credential: the token cannot be read from it, and it stops verifying the moment the session or its turn ends.
//
// This is half of the boundary: it keeps the credential out of the session's reach. It is not a boundary until the sandbox rules (D-1 to D-3) keep the session off vyred's main
// socket, which carries no stamping. Every token has a model hop (an unnamed thread runs as the default assistant), and a long thread's token is renewed before it runs out.
//
// Setup: the default assistant ("assistant", or cfg.defaultAgent) must be an actor of the Space, added once at setup (grants.addActor). Without it every kernel call from an
// unnamed thread is not_a_member: it fails closed, it never runs as the person.
//
//   const ks = createKernelSessions({ kernel });
//   const s = await ks.open({ chain: personChain, chat, agent, thread });    // { id, expires }: no token
//   openThreadSocket({ ..., kernelToken: ks.tokenFor(s.id) });               // vyred's side only
//   await ks.end(s.id);                                                      // revoked; the socket's function now answers nothing
//   await ks.turn({ chain, chat }, async s => { ... });                      // one kernel session per turn: nothing survives the turn

/**
 * @param {{ kernel: { surfaces: { open(chain: any, o?: any): Promise<{ token: string, session: string, expires: number }>, revoke(session: string): void } }, ttlMs?: number,
 *   defaultAgent?: string, retireCapMs?: number, renewBeforeMs?: number, clock?: () => number,
 *   chats?: { appendOpen(token: string, m?: any): Promise<any>, append(token: string, m: any): Promise<any>, roomFor?(token: string): Promise<any> },
 *   turns?: { get(thread: string): any, set(thread: string, rec: any): void, delete(thread: string): void, all(): [string, any][] } }} cfg
 *   chats: the kernel's chat calls (ctx.kernel.chats). turns: where the open turns are kept so a restart can reopen them (the person, the chat and the assistant, never a token).
 *   kernel: the daemon's kernel (its Surfaces door). defaultAgent: the assistant identity a thread with no named assistant runs as.
 */
export function createKernelSessions(cfg) {
  const clock = cfg.clock || Date.now;
  const renewBefore = cfg.renewBeforeMs ?? 5 * 60_000;
  /** @type {Map<string, { token: string, session: string, expires: number, q: any }>} handle -> the live token. Never leaves this closure except through `tokenFor`, which only vyred's own socket handler is given. */
  const tokens = new Map();
  /** @type {Map<string, string>} thread id -> the handle of its current kernel session */
  const byThread = new Map();
  /** @type {Set<string>} replaced chat-turn sessions waiting out their grace */
  const retiring = new Set();
  /** @type {Map<string, number>} handle -> replies opened through forThread and not closed yet */
  const openReplies = new Map();
  /** @type {Map<string, any>} handle -> the safety timer of a session waiting for its replies to close */
  const capTimers = new Map();
  const capMs = cfg.retireCapMs ?? 15 * 60_000;
  const revokeNow = (/** @type {string} */ id) => { everOpened.delete(id); retiring.delete(id); const t = capTimers.get(id); if (t) clearTimeout(t); capTimers.delete(id); openReplies.delete(id); const e = tokens.get(id); tokens.delete(id); if (e) cfg.kernel.surfaces.revoke(e.session); };
  /** @type {Set<string>} sessions a reply was ever asked for under */
  const everOpened = new Set();
  const idleMs = cfg.retireIdleMs ?? 2 * 60_000;
  /**
   * A session that is ended is revoked when the replies streaming under it have closed (never cut mid-stream). One REPLACED by the next asker's turn before the stream has asked for its reply is
   * kept for that reply (the stream binds a reply to the asker's own session, never to the thread's newest), for `retireIdleMs` at most; a cap is only a safety net for a reply that never closes.
   */
  const release = (/** @type {string} */ id, replaced = false) => {
    const e = tokens.get(id);
    if (!e) return;
    const waiting = openReplies.get(id) > 0 || (replaced && Boolean(e.q && e.q.chat) && !everOpened.has(id));
    if (!waiting) return revokeNow(id);
    retiring.add(id);
    if (!capTimers.has(id)) { const tm = setTimeout(() => revokeNow(id), everOpened.has(id) ? capMs : idleMs); tm.unref?.(); capTimers.set(id, tm); }
  };
  /** Open turns, for a restart: a Map when the caller gives none (lost on restart), or the caller's durable store. */
  const turns = cfg.turns || (() => { const m = new Map(); return { get: (/** @type {string} */ t) => m.get(t), set: (/** @type {string} */ t, /** @type {any} */ r) => m.set(t, r), delete: (/** @type {string} */ t) => m.delete(t), all: () => [...m] }; })();
  /** Every session socket is a model's, so every session token carries a model-originated hop: a thread with no named assistant runs as the default one, never as the person alone. */
  // A session acts as the agent it was STARTED as and only that (the lead's ruling, MH-1/MS-1 for sessions): a named agent as itself, the assistant-kind agent as the Space's assistant actor (the daemon
  // names it so), a chat turn as the chat's assistant (the default). A plain session, started for no agent and no chat, is nobody's assistant: its token carries an agent hop that is no actor of the
  // Space, so every kernel call it makes fails closed instead of borrowing the assistant's authority.
  const agentOf = (/** @type {any} */ q) => q.agent || (q.chat ? (cfg.defaultAgent || "assistant") : "session");
  const mint = (/** @type {any} */ q) => cfg.kernel.surfaces.open(q.chain, { ...(q.chat ? { chat: q.chat } : {}), agent: agentOf(q), ...(q.thread ? { thread: q.thread } : {}), ...(q.project ? { project: q.project } : {}), ...(typeof q.agent === "string" && q.agent.startsWith("model:") && q.slotOpen === true ? { slot_open: true } : {}), ttl_ms: q.ttlMs ?? cfg.ttlMs ?? 3600_000 });

  const api = {
    /**
     * Open a kernel session for one session or one turn. The chain must be exactly one person (the kernel checks); `chat` is written into the token by the kernel after it
     * checks that person is in that chat. Returns the session id, never the token.
     * @param {{ chain: any, chat?: string, agent?: string, thread?: string, ttlMs?: number }} q @returns {Promise<{ id: string, expires: number }>}
     */
    async open(q) {
      const k = await mint(q);
      tokens.set(k.session, { token: k.token, session: k.session, expires: k.expires, q });
      // A chat turn begins at the kernel the moment its session opens, before the assistant is asked anything, so the version it will answer for is fixed before its first read (CH-10).
      if (q.chat && cfg.chats && typeof cfg.chats.beginTurn === "function") { try { await cfg.chats.beginTurn(k.token); } catch (e) { cfg.kernel.surfaces.revoke(k.session); tokens.delete(k.session); throw e; } }
      if (q.thread) {
        // One kernel session per thread: opening another (a send after a restart reopened this thread's turn, say) replaces the earlier one, which is revoked, never left open beside it.
        const prev = byThread.get(q.thread);
        // A replaced session is released, not cut: a reply of the turn before may still be streaming under it (a reply handle is bound to its own token). See release().
        if (prev && prev !== k.session) release(prev, true);
        byThread.set(q.thread, k.session);
        // What a restart needs to reopen this turn: who asked, in which chat, for which assistant. Never the token.
        const person = q.chain && q.chain.hops && q.chain.hops[0] && q.chain.hops[0].actor && q.chain.hops[0].actor.id;
        if (person) turns.set(q.thread, { person, chat: q.chat || null, agent: q.agent || null, ...(q.project ? { project: q.project } : {}), at: clock() });
      }
      return { id: k.session, expires: k.expires };
    },
    /** For vyred's own socket handler only: a function that answers this session's token while it is open, and nothing after. */
    tokenFor: (/** @type {string} */ id) => async () => {
      const e = tokens.get(id);
      if (!e) return undefined;
      // A thread that outlives its token gets a fresh one (same person, chat and assistant) before a call goes out, so its calls are never unstamped. One renewal at a time;
      // the old token is revoked once the new one is in place. A failed renewal leaves the old token, which the kernel then refuses: the call is simply not in any chat.
      if (e.expires - clock() < renewBefore) {
        const cur = /** @type {any} */ (e);
        cur.renewing = cur.renewing || mint(e.q).then(k => { const live = tokens.get(id); if (live) { cfg.kernel.surfaces.revoke(live.session); tokens.set(id, { token: k.token, session: k.session, expires: k.expires, q: live.q }); } else cfg.kernel.surfaces.revoke(k.session); }).catch(() => {}).finally(() => { cur.renewing = null; });
        await cur.renewing;
      }
      // Past its life (a failed renewal left the old token and it has expired): answer nothing, so the socket refuses the call rather than send it unstamped.
      const cur = tokens.get(id);
      return cur && cur.expires > clock() ? cur.token : undefined;
    },
    /** End the session now: the kernel stops honouring its token and the function above answers nothing. Safe to call twice. */
    async end(/** @type {string} */ id) {
      if (!tokens.has(id)) return false;
      const e0 = tokens.get(id);
      for (const [t, h] of [...byThread]) if (h === id) { byThread.delete(t); turns.delete(t); }
      release(id, Boolean(e0 && e0.q && e0.q.thread && byThread.has(e0.q.thread) && byThread.get(e0.q.thread) !== id));
      return true;
    },
    /** One kernel session for the length of one turn: the token dies when `fn` returns or throws, so nothing a turn learned can be replayed after it. */
    async turn(/** @type {{ chain: any, chat?: string, agent?: string, thread?: string }} */ q, /** @type {(s: { id: string, token: () => string | undefined }) => Promise<any>} */ fn) {
      const s = await api.open(q);
      try { return await fn({ id: s.id, token: api.tokenFor(s.id) }); } finally { await api.end(s.id); }
    },
    /**
     * The kernel session of one thread's current turn, as calls and not as a token: the stream (or anything a model can influence) asks for `appendOpen`, `append` or `roomFor` and the
     * token is looked up here and used here. It is never returned. No open session for the thread is `no_session`.
     * @param {string} thread
     */
    forThread(thread) {
      const personOf = (/** @type {any} */ q) => q && q.chain && q.chain.hops && q.chain.hops[0] && q.chain.hops[0].actor && q.chain.hops[0].actor.id;
      /** The session a call runs under: the thread's current one, or (with `asker`) that person's own newest session on this thread, current or still held for its reply, and none if they have none: a reply is never written under another person's session. */
      const idFor = (/** @type {string | undefined} */ asker) => {
        if (!asker) return byThread.get(thread);
        let found;
        for (const [id, e] of tokens) if (e.q && e.q.thread === thread && personOf(e.q) === asker) found = id;
        return found;
      };
      const live = async (/** @type {string | undefined} */ asker, /** @type {string | undefined} */ pick) => {
        const id = pick || idFor(asker);
        const tok = id ? await api.tokenFor(id)() : undefined;
        if (!tok || !cfg.chats) throw Object.assign(new Error("this thread has no open kernel session"), { code: "no_session" });
        return tok;
      };
      return Object.freeze({
        appendOpen: async (/** @type {any} */ m0) => {
          // `asker` (the person the reply acts for, per_...) is the stream's word for whose turn this reply is; it is not the kernel's message
          const { asker: want, ...m } = m0 && typeof m0 === "object" ? m0 : /** @type {any} */ ({});
          const asker = typeof want === "string" && want ? want.replace(/^person:/, "") : undefined;
          const id = idFor(asker);
          // counted from the moment it is asked for: the next asker's session may open while this reply is still being opened
          if (id) { openReplies.set(id, (openReplies.get(id) || 0) + 1); everOpened.add(id); }
          let done = false;
          const finish = () => { if (done || !id) return; done = true; const n = (openReplies.get(id) || 1) - 1; if (n > 0) { openReplies.set(id, n); return; } openReplies.delete(id); if (retiring.has(id)) revokeNow(id); };
          let h;
          try { h = await /** @type {any} */ (cfg.chats).appendOpen(await live(asker, id), m); } catch (e) { finish(); throw e; }
          if (!id || !h || typeof h.close !== "function") { finish(); return h; }
          // the reply is counted open until it closes: the session it is bound to is not revoked under it
          return { ...h, close: async (/** @type {any[]} */ ...a) => { try { return await h.close(...a); } finally { finish(); } } };
        },
        append: async (/** @type {any} */ m) => /** @type {any} */ (cfg.chats).append(await live(), m),
        beginTurn: async () => { const c = /** @type {any} */ (cfg.chats); if (!c.beginTurn) throw Object.assign(new Error("the kernel has no turn-begin yet"), { code: "unsupported" }); return c.beginTurn(await live()); },
        roomFor: async () => { const c = /** @type {any} */ (cfg.chats); if (!c.roomFor) throw Object.assign(new Error("the kernel has no room view for a turn yet"), { code: "unsupported" }); return c.roomFor(await live()); },
      });
    },
    /**
     * After a restart: reopen the kernel session of every turn that was still open, from the stored turn (the person who asked, the chat, the assistant), without waiting for the
     * asker's next call. `personChainFor(personId)` is the daemon's: a chain of exactly that one person, made by the kernel from what it stored. A turn that cannot be reopened in
     * time is given up with `onGiveUp(thread, why)` (the chat then says "couldn't resume, ask again") and forgotten.
     * @param {{ personChainFor(person: string): Promise<any>, timeoutMs?: number, onGiveUp?: (thread: string, why: string) => any }} o
     * @returns {Promise<{ resumed: string[], gaveUp: string[] }>}
     */
    async reopenPending(o) {
      const resumed = [], gaveUp = [];
      const limit = o.timeoutMs ?? 10_000;
      for (const [thread, rec] of turns.all()) {
        if (byThread.has(thread)) continue;
        try {
          const chain = await withinOrThrow(o.personChainFor(rec.person), limit, () => Object.assign(new Error("timed out"), { code: "timeout" }));
          await api.open({ chain, ...(rec.chat ? { chat: rec.chat } : {}), ...(rec.agent ? { agent: rec.agent } : {}), ...(rec.project ? { project: rec.project } : {}), ...(typeof rec.agent === "string" && rec.agent.startsWith("model:") ? { slotOpen: true } : {}), thread });
          resumed.push(thread);
        } catch (e) {
          turns.delete(thread); gaveUp.push(thread);
          try { await o.onGiveUp?.(thread, String(/** @type {any} */ (e).code || "failed")); } catch { /* the giving up stands */ }
        }
      }
      return { resumed, gaveUp };
    },
    list: () => [...tokens.keys()].filter(id => !retiring.has(id)), // the open ones: a replaced turn's session waiting out its grace is not counted
    /**
     * The daemon stops (gracefully or not): every session's token is revoked, but the open turns stay in the durable store, so the next start reopens them for their people, or says it could
     * not and gives them up (`reopenPending`). Only `end` (a turn that is over) forgets a turn.
     */
    async closeAll() { for (const t of capTimers.values()) clearTimeout(t); capTimers.clear(); retiring.clear(); openReplies.clear(); for (const [id, e] of [...tokens]) { tokens.delete(id); for (const [t, h] of [...byThread]) if (h === id) byThread.delete(t); cfg.kernel.surfaces.revoke(e.session); } },
  };
  return Object.freeze(api);
}
