// @ts-check
// personal/trust: whose words may teach memory about the user's life (ADR 0034, source trust).
//
// A personal fact comes only from the user's own words about their life. Never from Claude's
// turns, tool output, code, test fixtures, sample worlds, docs or pasted text, and never from a
// session that builds or tests memory itself. The Capsule once answered "what is my wife's name"
// with a name from a Vyre dev session's test example: that is the failure this file exists for.
//
// Pure: a session row or a turn's text in, a verdict out. The store keeps the verdicts
// (memory_me_trust), and derive() leaves out every claim from a session that is not trusted.

/** Bumped when the rules change: the store reads every session again. */
export const TRUST_VERSION = 1;

/** Blocks a harness puts into a user turn: not the person's words. */
const INJECTED = /<(system-reminder|teammate-message|task-notification|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|user-prompt-submit-hook|pasted_content|bash-input|bash-stdout|bash-stderr|tool_use_error|cross-session-message|function_results|antml:[\w-]+)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/g;

/** The person's own words in a user turn: injected blocks gone. */
export const userWords = (/** @type {string} */ text) => {
  const t = String(text || "");
  return t.includes("<") ? t.replace(INJECTED, "\n").trim() : t;
};

/**
 * Words of building or testing memory itself: a turn with one is someone writing examples, not
 * someone talking about their life. Specific on purpose: "test" alone is an ordinary word, and so
 * are a dev job's own words ("seed data", "assert"): a work session is not about memory.
 */
const DEV = /\b(?:fixtures?|test (?:worlds?|cases?|sentences?|examples?|inputs?)|(?:sample|sealed|gold|held-?out|synthetic|fake|made-up|invented) (?:worlds?|persons?|people|users?|sessions?)|evals?|eval harness|evaluation (?:worlds?|cases?|sets?)|memory\.(?:answer|remember|profile|context|retrieve)|iq\.ask|personal facts?|extract(?:ion|or|s)? (?:rules?|pass)|checkread|confident[- ]wrong|recall@\d|expected (?:answer|output)s?|seed(?:ed)? worlds?|should (?:answer|return|extract))\b/i;

/** A user turn that is about building or testing memory. */
export const devTalk = (/** @type {string} */ text) => DEV.test(userWords(text));

/** A session with this many dev turns is about memory: none of its turns teach personal facts. */
export const DEV_TURNS = 2;

/** A folder of Vyre itself: the repo or one of its worktrees. */
const VYRE_DIR = /(?:^|\/)vyre(?:[-_.][\w.-]*)?(?:\/|$)/i;

/**
 * Whether a session may teach personal facts, from what Recall knows of it.
 * @param {{ cwd?: string|null, human?: number|boolean|null, parent?: string|null, name?: string|null, title?: string|null }} s
 * @param {{ scratch?: string|null, quick?: string|null, skip?: string[] }} [o]  scratch: the Capsule's ask folder; quick: the
 *   warm sessions' folder (threads.quick, <home>/quick); skip: folders the user excluded
 * @returns {{ ok: boolean, why: "program"|"ask"|"dev"|"skipped"|null }}
 */
export function sessionTrust(s, o = {}) {
  // A subagent's "user" turn is the brief another agent wrote; an SDK run's is a program's.
  if (s.parent || s.human === 0 || s.human === false) return { ok: false, why: "program" };
  const label = String(s.name || s.title || "");
  const cwd = String(s.cwd || "");
  if (/^Capsule: /.test(label) || (o.scratch && cwd.startsWith(o.scratch)) || (o.quick && cwd.startsWith(o.quick))) return { ok: false, why: "ask" };
  if (VYRE_DIR.test(cwd)) return { ok: false, why: "dev" };
  if (o.skip?.some(p => p && (cwd === p || cwd.startsWith(p.endsWith("/") ? p : p + "/")))) return { ok: false, why: "skipped" };
  return { ok: true, why: null };
}
