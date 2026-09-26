// @ts-check
// claim: is this conversation already being written by a headless thread here?
//
// The two-writer case the lease cannot see (floor rule 4, SPEC 11): a person runs
// `claude --resume <id>` in a terminal while vyred's child for that same id is alive. Claude
// Code does not know Vyre exists, so the terminal session takes no lease; both processes append
// to one transcript and it diverges. The Harness SessionStart hook runs on every session however
// it was started, so it asks here and warns in the first thing the session reads.
//
// Ported from the prototype's claim.cjs, with its lesson: the hook never refuses to let a
// session begin. A hook that stops people working is a hook they turn off. So these tools only
// say what is true; they never stop, lease or refuse anything.

/**
 * The live headless thread for a session id, if this vyred has one.
 * holder is the surface with its keyboard, else the agent it runs for, else null.
 * @param {import("./index.js").Switchboard} sb @param {string} session
 */
export function claimed(sb, session) {
  const id = String(session || "").trim();
  const rec = id ? sb.record(id) : null;
  if (!rec || !sb.live.has(id)) return { headless: false, holder: null, status: rec ? rec.status : null };
  return { headless: true, holder: rec.holder || (rec.agent ? `agent:${rec.agent}` : null), status: rec.status };
}

/** @param {any} ctx @param {import("./index.js").Switchboard} sb */
export function register(ctx, sb) {
  const input = { type: "object", required: ["session"], properties: { session: { type: "string" } } };

  ctx.tool("threads.claimed", {
    description: "Whether a Claude Code session id is a live headless thread in this vyred, and who holds it.", internal: true,
    input, run: async ({ session }) => claimed(sb, session),
  });

  // A second tool rather than a flag on threads.claimed, so asking stays a pure read that any
  // module can make without leaving a trace. Saying "a second writer is here" is an act, and the
  // switchboard checks it again rather than trusting the caller: a thread that stopped in
  // between is not contended, and no event is emitted for it.
  ctx.tool("threads.contend", {
    description: "Say a second writer opened a live headless thread's session (a terminal resume); emits thread.contended.", internal: true,
    input, run: async ({ session }) => {
      const c = claimed(sb, session);
      if (!c.headless) return { emitted: false, ...c };
      const rec = sb.record(session);
      sb.emit("thread.contended", { session, holder: c.holder }, session, rec ? rec.project : null);
      return { emitted: true, ...c };
    },
  });
}
