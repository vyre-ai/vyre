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

/**
 * Called when a session's process ends. A resume of a session that never began (its first start failed, say at the sandbox self-test, so the provider has no transcript): any provider's process that ends before
 * it speaks, with no finished turn behind it or saying the session is missing. The thread starts that session now under the same id, and the message that was waiting goes in again.
 * Returns true when it took over (the caller stops handling the exit).
 * @param {any} sb the Switchboard @param {string} id @param {any} st @param {number | null} code @param {any} stderr @param {(sb: any, id: string, rec: any) => Promise<any>} lentOf
 */
export function startFreshOnExit(sb, id, st, code, stderr, lentOf) {
  if (!(st.launch && st.launch.resume && sb.live.get(id) === st && shouldStartFresh({ resume: true, heard: Boolean(st.heard), stopping: Boolean(st.stopping), fresh: Boolean(st.fresh1), closing: Boolean(sb.closing), code, stderr: String(stderr || ""), turns: Number((sb.record(id) || {}).turns) || 0 }))) return false;
  void startFresh(sb, id, st, lentOf);
  return true;
}

/** Start the session over as a new one under the same id (no transcript to resume), once, and send again the words the failed start was carrying.
 * @param {any} sb @param {string} id @param {any} st @param {(sb: any, id: string, rec: any) => Promise<any>} lentOf
 */
async function startFresh(sb, id, st, lentOf) {
  st.switching = true;
  try {
    const rec = sb.must(id);
    const words = st.lastPrompt || null;
    sb.deps.log(`threads: ${String(id).slice(0, 8)} had nothing to resume (its earlier run is gone); starting it again`);
    sb.spawn(id, { ...st.launch, libraryPlugin: await sb.libraryPlugin(rec, st.launch || {}, id), sandboxSpawn: await sb.sandboxFor(id, rec, st.launch || {}), lentSpawn: await lentOf(sb, id, rec), gitEnv: await sb.gitEnv(rec && rec.project, id), resume: false, lastPrompt: words });
    const now = sb.live.get(id); if (now) now.fresh1 = true;
    if (words) sb.write(id, words, { askedBy: sb.turnAsker.get(id) || null });
  } catch (e) { sb.deps.log(`threads: ${String(id).slice(0, 8)} could not start again: ${/** @type {Error} */ (e).message}`); st.switching = false; sb.onExit(id, st, 1, null, "", null); }
}
