// @ts-check
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
//   const ks = createKernelSessions({ kernel });
//   const s = await ks.open({ chain: personChain, chat, agent, thread });    // { id, expires }: no token
//   openThreadSocket({ ..., kernelToken: ks.tokenFor(s.id) });               // vyred's side only
//   await ks.end(s.id);                                                      // revoked; the socket's function now answers nothing
//   await ks.turn({ chain, chat }, async s => { ... });                      // one kernel session per turn: nothing survives the turn

/**
 * @param {{ kernel: { surfaces: { open(chain: any, o?: any): Promise<{ token: string, session: string, expires: number }>, revoke(session: string): void } }, ttlMs?: number,
 *   defaultAgent?: string, renewBeforeMs?: number, clock?: () => number }} cfg
 *   kernel: the daemon's kernel (its Surfaces door). defaultAgent: the assistant identity a thread with no named assistant runs as.
 */
export function createKernelSessions(cfg) {
  const clock = cfg.clock || Date.now;
  const renewBefore = cfg.renewBeforeMs ?? 5 * 60_000;
  /** @type {Map<string, { token: string, session: string, expires: number, q: any }>} handle -> the live token. Never leaves this closure except through `tokenFor`, which only vyred's own socket handler is given. */
  const tokens = new Map();
  /** Every session socket is a model's, so every session token carries a model-originated hop: a thread with no named assistant runs as the default one, never as the person alone. */
  const agentOf = (/** @type {any} */ q) => q.agent || cfg.defaultAgent || "assistant";
  const mint = (/** @type {any} */ q) => cfg.kernel.surfaces.open(q.chain, { ...(q.chat ? { chat: q.chat } : {}), agent: agentOf(q), ...(q.thread ? { thread: q.thread } : {}), ttl_ms: q.ttlMs ?? cfg.ttlMs ?? 3600_000 });

  const api = {
    /**
     * Open a kernel session for one session or one turn. The chain must be exactly one person (the kernel checks); `chat` is written into the token by the kernel after it
     * checks that person is in that chat. Returns the session id, never the token.
     * @param {{ chain: any, chat?: string, agent?: string, thread?: string, ttlMs?: number }} q @returns {Promise<{ id: string, expires: number }>}
     */
    async open(q) {
      const k = await mint(q);
      tokens.set(k.session, { token: k.token, session: k.session, expires: k.expires, q });
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
      return tokens.get(id)?.token;
    },
    /** End the session now: the kernel stops honouring its token and the function above answers nothing. Safe to call twice. */
    async end(/** @type {string} */ id) {
      if (!tokens.has(id)) return false;
      const e = tokens.get(id);
      tokens.delete(id);
      if (e) cfg.kernel.surfaces.revoke(e.session);
      return true;
    },
    /** One kernel session for the length of one turn: the token dies when `fn` returns or throws, so nothing a turn learned can be replayed after it. */
    async turn(/** @type {{ chain: any, chat?: string, agent?: string, thread?: string }} */ q, /** @type {(s: { id: string, token: () => string | undefined }) => Promise<any>} */ fn) {
      const s = await api.open(q);
      try { return await fn({ id: s.id, token: api.tokenFor(s.id) }); } finally { await api.end(s.id); }
    },
    list: () => [...tokens.keys()],
    async closeAll() { for (const id of [...tokens.keys()]) await api.end(id); },
  };
  return Object.freeze(api);
}
