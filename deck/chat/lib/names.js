// @ts-check
// Who a row is from, in the words every Chat view shows. One rule, here, so the session view, the
// cards and the list agree (and the Capsule and the phone mirror it):
//
//   a reply        the agent's own name when the thread is an agent's, else the assistant's name
//                  from onboarding (system.info's assistant.name), else "Vyre"
//   the person     "you" when it came from this person's own surfaces (or says nothing)
//   another surface  its own name
//
// Never "claude": a name that says Claude falls back to the assistant's name (a reply) or
// "terminal" (a surface).

/** The Deck's own surface names: a lease or a message from these is this screen's, so it reads "you". */
export const OURS = new Set(["deck", "chat"]);

const clean = v => (v == null ? "" : String(v).trim());

/**
 * @param {{ role?: "assistant"|"user", agent?: string|null, surface?: string|null }} row
 * @param {{ assistant?: string|null, owner?: string|null }} [names] system.info's assistant.name and owner.name
 * @returns {string}
 */
export function labelFor(row, names = {}) {
  const assistant = clean(names.assistant);
  const fallback = assistant && !/claude/i.test(assistant) ? assistant : "Vyre";
  if ((row.role || "assistant") === "assistant") {
    const a = clean(row.agent);
    return a && !/claude/i.test(a) ? a : fallback;
  }
  const s = clean(row.surface);
  if (!s || OURS.has(s)) return "you";
  if (/claude/i.test(s)) return "terminal";
  return s;
}

/** Whether a reply's label is the assistant itself (it wears the Vyre mark) rather than an agent. */
export const isAssistant = (row, names = {}) => {
  const a = clean(row.agent);
  return !a || /claude/i.test(a) || a === clean(names.assistant);
};

/**
 * The names from system.info, read once per page load and shared by every view that asks.
 * @param {(tool: string, input?: any) => Promise<{ data?: any, error?: any }>} attempt js/api.js's attempt
 * @returns {Promise<{ assistant: string|null, owner: string|null }>}
 */
let reading = null;
export function readNames(attempt) {
  if (!reading) {
    reading = attempt("system.info").then(r => {
      if (r.error) reading = null; // ask again next time rather than keep a failure
      return { assistant: r.data?.assistant?.name || null, owner: r.data?.owner?.name || null };
    });
  }
  return reading;
}
