// @ts-check
// heal: repair an operation after a site changed under it, and only keep the repair if it is proven.
//
// Ported in method from api-anything heal.ts (github.com/goodnight000/api-anything, MIT; see NOTICE): reactive only (the stored template is always tried first), the stable identity
// (host, path, GraphQL operation name) finds the request again, never a queryId or hash, the request is relearned from what the page just sent, and the new version is kept ONLY after a
// replay of it answers ok. Otherwise the old operation stays as it was and the failure is reported honestly ("could not repair").
//
// The shell supplies `runTrigger` (run the operation's trigger in the browser that signs for it and hand back what the page sent) and the same deps as run.js for the replay.

import { learnOperation, matches, rankCandidates } from "./learn.js";
import { runOperation } from "./run.js";

/**
 * @typedef {import("./run.js").RunDeps & { runTrigger: (op: any, inputs: Record<string, any>) => Promise<{ exchanges: any[], cookies?: { name: string, value: string }[], storage?: Record<string, string>, loginWall?: string }>, now?: string }} HealDeps
 */

/**
 * @param {any} op the stored operation @param {Record<string, any>} inputs the failing call's own inputs (a heal needs one real example) @param {HealDeps} deps
 * @param {{ verifyInputs?: Record<string, any> }} [o] a different input to prove the repair on, when there is one
 * @returns {Promise<{ outcome: "healed"|"unchanged"|"failed", class?: string, reason: string, operation?: any, warnings?: string[] }>}
 */
export async function healOperation(op, inputs, deps, o = {}) {
  /** @type {Awaited<ReturnType<HealDeps["runTrigger"]>>} */ let run;
  try { run = await deps.runTrigger(op, inputs); }
  catch (e) { return { outcome: "failed", class: "error", reason: `the trigger could not run: ${String(/** @type {any} */ (e)?.message || e).split("\n")[0]}` }; }
  if (run.loginWall) return { outcome: "failed", class: "auth", reason: `the trigger landed on a sign-in page (${run.loginWall})` };
  const pool = run.exchanges.filter(e => matches(op.match, e.request));
  if (!pool.length) return { outcome: "failed", class: "drift", reason: `the trigger fired no request matching ${JSON.stringify(op.match)}` };
  const top = rankCandidates(pool, inputs, { all: true })[0];
  /** @type {any} */ let learned;
  try {
    learned = learnOperation({ name: op.name, kind: op.kind, exchanges: run.exchanges, examples: [inputs], id: top.id, cookies: run.cookies ?? [], storage: run.storage, trigger: op.trigger, match: op.match,
      public: op.public, rungs: op.rungs, now: deps.now });
  } catch (e) { return { outcome: "failed", class: "input", reason: String(/** @type {any} */ (e)?.message || e) }; }
  const fresh = learned.operation;
  // The repair replaces what the page sends and where the answer sits; what the person or agent named and tuned stays.
  const next = { ...op, request: fresh.request, slots: fresh.slots, volatile: fresh.volatile, login: fresh.login, minTier: Math.max(op.minTier || 1, fresh.minTier), learnedAt: fresh.learnedAt ?? op.learnedAt,
    response: { ...op.response, ...(fresh.response.xssiPrefix ? { xssiPrefix: fresh.response.xssiPrefix } : {}), shape: fresh.response.shape ?? op.response.shape, contentType: fresh.response.contentType ?? op.response.contentType } };
  /** @param {any} candidate */
  const prove = async candidate => runOperation(candidate, o.verifyInputs ?? inputs, deps);
  let proof = await prove(next);
  // The answer may have moved (a renamed list key): try the extract the page's own answer suggests, once.
  if (!proof.ok && proof.class === "drift" && fresh.response.extract !== undefined && fresh.response.extract !== op.response.extract) {
    const moved = { ...next, response: { ...next.response, extract: fresh.response.extract } };
    const again = await prove(moved);
    if (again.ok) { proof = again; next.response = moved.response; }
  }
  if (!proof.ok) return { outcome: "failed", class: proof.class, reason: `a relearned version did not answer: ${proof.reason ?? proof.class}`, warnings: learned.warnings };
  const same = JSON.stringify({ r: op.request, s: op.slots, v: op.volatile, e: op.response.extract, x: op.response.shape }) === JSON.stringify({ r: next.request, s: next.slots, v: next.volatile, e: next.response.extract, x: next.response.shape });
  return { outcome: same ? "unchanged" : "healed", reason: same ? "the stored operation already matches what the page sends" : "relearned from the page and proven by a replay", operation: next, warnings: learned.warnings };
}
