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
//   const ks = createKernelSessions({ kernel });
//   const s = await ks.open({ chain: personChain, chat, agent, thread });    // { id, expires }: no token
//   openThreadSocket({ ..., kernelToken: ks.tokenFor(s.id) });               // vyred's side only
//   await ks.end(s.id);                                                      // revoked; the socket's function now answers nothing
//   await ks.turn({ chain, chat }, async s => { ... });                      // one kernel session per turn: nothing survives the turn

/**
 * @param {{ kernel: { surfaces: { open(chain: any, o?: any): Promise<{ token: string, session: string, expires: number }>, revoke(session: string): void } }, ttlMs?: number }} cfg
 *   kernel: the daemon's kernel (its Surfaces door).
 */
export function createKernelSessions(cfg) {
  /** @type {Map<string, string>} session id -> token. Never leaves this closure except through `tokenFor`, which only vyred's own socket handler is given. */
  const tokens = new Map();

  const api = {
    /**
     * Open a kernel session for one session or one turn. The chain must be exactly one person (the kernel checks); `chat` is written into the token by the kernel after it
     * checks that person is in that chat. Returns the session id, never the token.
     * @param {{ chain: any, chat?: string, agent?: string, thread?: string, ttlMs?: number }} q @returns {Promise<{ id: string, expires: number }>}
     */
    async open(q) {
      const k = await cfg.kernel.surfaces.open(q.chain, { ...(q.chat ? { chat: q.chat } : {}), ...(q.agent ? { agent: q.agent } : {}), ...(q.thread ? { thread: q.thread } : {}), ttl_ms: q.ttlMs ?? cfg.ttlMs ?? 3600_000 });
      tokens.set(k.session, k.token);
      return { id: k.session, expires: k.expires };
    },
    /** For vyred's own socket handler only: a function that answers this session's token while it is open, and nothing after. */
    tokenFor: (/** @type {string} */ id) => () => tokens.get(id),
    /** End the session now: the kernel stops honouring its token and the function above answers nothing. Safe to call twice. */
    async end(/** @type {string} */ id) {
      if (!tokens.has(id)) return false;
      tokens.delete(id);
      cfg.kernel.surfaces.revoke(id);
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
