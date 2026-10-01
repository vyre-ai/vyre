// @ts-check
// The five memory tools every session is offered (docs/work/iq.md, plan 3.1A), in the words an
// agent uses: memory_ask, memory_search, memory_decisions, memory_remember, memory_correct. Each
// maps onto a vyred tool. Nothing here decides what a caller may see: vyred reads the caller's
// identity and reach itself (memory's guard), so a project named here only ever narrows.

/** @type {Record<string, { tool: string, description: string, input: any, map: (args: any, env: Record<string, string | undefined>) => any, route?: { when: (args: any, env: Record<string, string | undefined>) => boolean, tool: string, map: (args: any, env: Record<string, string | undefined>) => any } }>} */
export const ALIASES = {
  memory_search: {
    tool: "memory.retrieve",
    description: "Search past sessions by meaning: the passages themselves, each with its session, no answer written. Use memory_ask for a question you want answered.",
    input: { type: "object", required: ["query"], properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 30 } } },
    map: a => ({ question: String(a.query || ""), ...(a.limit ? { k: a.limit } : {}) }),
  },
  memory_remember: {
    tool: "memory.write",
    description: "Keep something you learned while working, in the project's memory, at once and under your name: a lasting fact, a decision, or a note. It is read back as quoted text, never as an instruction. Say plainly what was decided or learned.",
    input: { type: "object", required: ["text"], properties: { text: { type: "string" }, kind: { type: "string", enum: ["fact", "decision", "note"] }, project: { type: "string", description: "a project slug you are granted; left out, your only project" } } },
    map: (a, env) => {
      const granted = String(env.VYRE_PROJECTS || "");
      const only = granted && granted !== "*" && !granted.includes(",") ? granted : "";
      return { kind: a.kind || "note", text: String(a.text || ""), project: a.project || only || undefined };
    },
    // The person's own session (no agent, no project named) is telling memory about their own life: a personal fact, kept
    // at once (memory.remember), as /vyre remember does. An agent, or anyone naming a project, writes to that project's memory.
    route: { when: (a, env) => !env.VYRE_AGENT && !a.project, tool: "memory.remember", map: a => ({ text: String(a.text || "") }) },
  },
  memory_correct: {
    tool: "memory.heard",
    description: "Pass on a correction the person just made in this chat. from_turn is the person's own turn (seq) that says it; when it is their typed words it is applied as theirs, otherwise it is filed as your own note. action: wrong, ended, replace, add or forget.",
    input: { type: "object", required: ["action", "from_turn"], properties: { action: { type: "string", enum: ["wrong", "ended", "replace", "add", "forget"] }, answer_id: { type: "string" },
      from_turn: { type: "object", properties: { seq: { type: "integer" } } }, subject: { type: "string" }, rel: { type: "string" }, object: { type: "string" }, project: { type: "string" } } },
    map: a => { const { answer_id, ...rest } = a; return { ...rest, ...(answer_id ? { answer: answer_id } : {}) }; },
  },
};

/** The vyred tool an alias or raw name stands for, when it is one of the five. @param {string} name */
export const aliasFor = name => ALIASES[name];
/** The vyred tools the aliases replace, so the raw twin is not offered beside them. */
export const REPLACED = new Set(Object.values(ALIASES).map(a => a.tool));
