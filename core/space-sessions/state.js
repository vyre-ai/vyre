// core/space-sessions/state.js: what a checkpoint carries so a session can move between machines without gaining anything on the way.
// The runner (core/runner) writes the checkpoint and moves the files; the transcript, the working copy and the key lease are its. This is
// the `state` it stores with every turn: the Space and session it belongs to, the taint the session has picked up, the permissions it
// held, its tasks and its meta. Resume reads it back with two rules: taint is carried and never improved, and a permission is carried
// only if the resuming chain still holds it now (a resume never widens anything).
import { sha256, canonical } from "../../kernel/core/canonical.js";
import { TRUST_ORDER } from "../../kernel/contracts/index.js";

const weakest = (/** @type {string} */ a, /** @type {string} */ b) => (TRUST_ORDER.indexOf(/** @type {any} */ (a)) <= TRUST_ORDER.indexOf(/** @type {any} */ (b)) ? a : b);
const MAX_TASKS = 200, MAX_PERMS = 500;

/**
 * The state to store with a checkpoint.
 * @param {{ space: string, session: string, labels: { trust: string, red: string, source_spaces: readonly string[] }, permissions: { action: string, resource: string }[],
 *   tasks?: string[], meta?: Record<string, any> }} s
 */
export function snapshot(s) {
  const body = {
    v: 1, space: s.space, session: s.session,
    taint: { trust: s.labels.trust, red: s.labels.red, source_spaces: [...s.labels.source_spaces] },
    permissions: s.permissions.slice(0, MAX_PERMS).map(p => ({ action: String(p.action), resource: String(p.resource) })),
    tasks: (s.tasks || []).slice(0, MAX_TASKS), meta: s.meta || {},
  };
  return { ...body, hash: sha256(canonical(body)) };
}

/**
 * Read a stored state back for a resume under `chain`. Refuses a state that is another Space's, another session's or altered.
 * @param {{ chain: any, space: string, session: string, state: any, authorize(i: { chain: any, action: string, resource: string }): Promise<{ effect: string }> }} q
 * @returns {Promise<{ labels: { trust: string, red: string, source_spaces: string[] }, permissions: { action: string, resource: string }[], dropped: { action: string, resource: string }[], tasks: string[], meta: any }>}
 */
export async function restore(q) {
  const st = q.state;
  const bad = (/** @type {string} */ m, code = "integrity") => Object.assign(new Error(m), { code });
  if (!st || st.v !== 1) throw bad("this checkpoint carries no session state");
  const { hash, ...body } = st;
  if (hash !== sha256(canonical(body))) throw bad("the session state does not match its hash");
  if (st.space !== q.space || st.session !== q.session || q.chain.space !== q.space) throw bad("this checkpoint belongs to another session or space", "not_found");
  // Taint is carried: the resumed session is at best as trusted as it was, and at best as trusted as the chain resuming it.
  const trust = weakest(st.taint.trust, q.chain.labels.trust);
  const source_spaces = [...new Set([...st.taint.source_spaces, ...q.chain.labels.source_spaces])];
  const permissions = [], dropped = [];
  for (const p of st.permissions) ((await q.authorize({ chain: q.chain, action: p.action, resource: p.resource })).effect === "allow" ? permissions : dropped).push(p);
  return { labels: { trust, red: st.taint.red, source_spaces }, permissions, dropped, tasks: st.tasks, meta: st.meta };
}
