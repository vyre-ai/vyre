// @ts-check
// core/switchboard/recall-sessions.js: the session ids Recall may attribute to one person. Split out of index.js (its line budget); registered by the Switchboard's module start.

/**
 * @param {any} ctx the module context @param {any} sb the Switchboard @param {any} str the string schema @param {(row: any) => any} optsOf a run row's options
 */
export function registerRecallSessions(ctx, sb, str, optsOf) {
  ctx.tool("threads.recall-sessions", {
    description: "Session ids Recall may attribute to one person: their threads, each thread's rollover windows, and nothing else. For recall.search member scoping only.", internal: true, callers: ["module"],
    input: { type: "object", required: ["person"], properties: { person: str } },
    run: async i => {
      const want = sb.canon(String(i.person));
      /** @type {string[]} */
      const threads = [];
      for (const row of /** @type {any[]} */ (sb.db.prepare("SELECT id, opts FROM threads_runs").all())) {
        const o = optsOf(row);
        if (o.person && sb.canon(String(o.person)) === want) threads.push(String(row.id));
      }
      const sessions = new Set(threads);
      for (const tid of threads) {
        sessions.add(tid);
        sessions.add(sb.mirrorId(tid));
        for (const r of /** @type {any[]} */ (sb.db.prepare("SELECT native_to, native_from FROM threads_rolls WHERE thread = ?").all(tid))) {
          if (r.native_to) sessions.add(String(r.native_to));
          if (r.native_from) sessions.add(String(r.native_from));
        }
      }
      return { sessions: [...sessions] };
    },
  });
}
