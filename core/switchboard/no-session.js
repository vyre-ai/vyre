// @ts-check
// A resume of a session that never began: the provider's process ended before it said anything, and the thread has no finished turn to lose. Whatever the provider calls that
// ("No conversation found with session ID" from Claude, "no rollout found" from Codex, "session not found" from an ACP agent), the thread starts the session fresh under the same id, once.

/** What a provider says when the session it was asked to resume does not exist. */
const NO_SESSION = /no (?:conversation|session|thread|rollout|transcript)s?\b[^\n]{0,40}(?:found|exists?)|(?:conversation|session|thread|rollout|transcript)\b[^\n]{0,60}(?:not found|does not exist|doesn't exist|unknown|no such)|unknown session|no such session|could not (?:find|load|resume) (?:the )?(?:conversation|session|thread)/i;

/**
 * @param {{ resume: boolean, heard: boolean, stopping: boolean, fresh: boolean, closing: boolean, code: number | null, stderr: string, turns: number }} o
 * `heard` is true once the process wrote any message (the session began); `turns` is the thread's finished turns.
 */
export function shouldStartFresh(o) {
  if (!o.resume || o.stopping || o.fresh || o.closing || o.code === 0) return false;
  if (NO_SESSION.test(String(o.stderr || ""))) return true;       // the provider says the session is missing, whatever it said before that
  return !o.heard && !(o.turns > 0);                              // it never spoke and there is no finished turn to lose
}
