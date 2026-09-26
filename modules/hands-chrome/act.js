// @ts-check
// act: perceive, decide, re-bind, act, verify. The same shape as hands-desktop/act.js (both
// modules read this project's write-up of the same measured lesson), adapted to this module's
// own selector.js (resolve/score against a DOM snapshot instead of an accessibility bind) and to
// a page having no notion of "app": there is one target, the tab.
//
// FRESH BINDING. A control chosen from one snapshot belongs to that snapshot. Between deciding
// and clicking, the DOM can repaint, a banner can appear, an id can get reused by a different
// element. So the chosen control is described as a Selector, and re-resolved against a FRESH
// snapshot immediately before the click, by identity rather than by an index into a stale array.
//
// HALT, DO NOT GUESS. When a target will not re-bind uniquely, the recovery is to look again or
// to stop with a reason, never to click the nearest thing.

import * as selector from "./selector.js";
import * as verify from "./verify.js";
import * as consequence from "./consequence.js";

/** @typedef {import("./snapshot.js").Snapshot} Snapshot */
/** @typedef {import("./snapshot.js").Control} Control */

export const LIMITS = { decisions: 30, mutations: 20, ms: 90_000, repeats: 2 };
export const TAKE_OVER = "take over in Glass to do this yourself";

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** @param {Control} c */
const label = c => JSON.stringify(c.name || c.role);

/**
 * One turn: look, choose, look again, act, look again.
 *
 * `perceive`, `decide` and `click` are injected so this can be tested without a browser and so
 * a caller can swap the decider. `decide` gets the first look's candidates and a request (the
 * caller's own selector-shaped hint, e.g. `{role: "button", name: "Submit"}`); it returns
 * `{control}` or `{why}`. `click` may return `{ok: false, why}` to stop at the last moment (the
 * keyboard was taken over mid-turn), in which case nothing is verified or claimed.
 *
 * @param {{ request?: any,
 *   perceive: () => Promise<Snapshot>,
 *   decide: (candidates: Control[], o: { request: any }) => Promise<{ control?: Control|null, why?: string } | null>,
 *   click: (c: Control, o: { consequential: boolean }) => Promise<void | { ok: false, why: string }>,
 *   settle?: number, consequential?: "refuse"|"allow" }} o
 */
export async function once({ request, perceive, decide, click, settle = 250, consequential = "refuse" }) {
  const before = await perceive();
  const candidates = before.controls || [];
  if (!candidates.length) return { ok: false, why: "nothing actionable on this page" };

  const d = await decide(candidates, { request });
  const chosen = d && d.control;
  if (!chosen) return { ok: false, why: (d && d.why) || "nothing here matches " + JSON.stringify(request) };

  const sel = selector.of(chosen);
  let kind = consequence.of(chosen);
  if (kind.consequential && consequential !== "allow") {
    return { ok: false, consequential: true, retryable: false, selector: sel, why: `${kind.why}; ${TAKE_OVER}` };
  }

  // The fresh frame. Everything above described a page that may no longer exist.
  const fresh = await perceive();
  const r = selector.resolve(sel, fresh.controls || []);
  if (!r.control) {
    return {
      ok: false, needsFreshLook: r.why === "unbound", selector: sel,
      why: r.why === "tied"
        ? `several controls now match ${label(chosen)} equally, so nothing was clicked`
        : "the control moved or changed between looking and reaching, so nothing was clicked",
    };
  }
  const bound = r.control;
  if (bound.enabled === false) return { ok: false, control: bound, selector: sel, why: label(bound) + " is disabled right now" };

  // What actually bound, not only what was chosen: a page can rename a button between the two
  // looks, and "Save" becoming "Send" must not be pressed because it was safe a moment ago.
  kind = consequence.of(bound);
  if (kind.consequential && consequential !== "allow") {
    return { ok: false, consequential: true, retryable: false, control: bound, selector: sel, why: `${kind.why}; ${TAKE_OVER}` };
  }

  const stopped = await click(bound, { consequential: kind.consequential });
  if (stopped && stopped.ok === false) return { ok: false, control: bound, selector: sel, why: stopped.why };

  // A click can trigger a re-render; reading immediately reports the page before it repaints.
  if (settle > 0) await sleep(settle);
  const after = await perceive();
  const moved = verify.changed(fresh, after);

  return {
    ok: moved.ok,
    why: moved.ok ? "clicked " + label(bound) : moved.why,
    control: bound,
    selector: sel,
    consequential: kind.consequential,
    changed: moved.ok ? verify.diff(fresh, after) : null,
    // A consequential action that appears not to have landed is never retried; retrying "send"
    // because the page looked unchanged is exactly how a message gets sent twice.
    retryable: moved.ok ? false : consequence.retryable(bound),
    url: after.url, title: after.title,
  };
}

/**
 * Keep going until `done` says so or a limit says stop. The repeat limit matters most: the
 * common runaway is one action that does nothing, attempted forever, each attempt looking
 * exactly like the last.
 * @param {Parameters<typeof once>[0] & { limits?: Partial<typeof LIMITS>, done?: (r: any) => Promise<boolean>|boolean }} opts
 */
export async function run(opts) {
  const started = Date.now();
  const limits = { ...LIMITS, ...(opts.limits || {}) };
  const seen = new Map();
  /** @type {any[]} */
  const log = [];
  let decisions = 0, mutations = 0;
  while (true) {
    if (decisions >= limits.decisions) return { ok: false, why: `stopped after ${decisions} decisions`, log };
    if (mutations >= limits.mutations) return { ok: false, why: `stopped after ${mutations} changes to the page`, log };
    if (Date.now() - started > limits.ms) return { ok: false, why: `stopped after ${Math.round((Date.now() - started) / 1000)} seconds`, log };
    decisions++;
    const r = await once(opts);
    log.push(r);
    if (r.ok) {
      mutations++;
      if (opts.done && await opts.done(r)) return { ok: true, why: "done", log };
      continue;
    }
    if (r.needsFreshLook) continue;
    if (r.consequential) return { ok: false, why: r.why, log };
    const sig = JSON.stringify(r.selector || r.why);
    const n = (seen.get(sig) || 0) + 1;
    seen.set(sig, n);
    if (n >= limits.repeats) return { ok: false, why: "tried the same thing twice and nothing happened: " + r.why, log };
  }
}

/**
 * The default decider: resolve the caller's request (a Selector-shaped hint) against the first
 * look the same way it will be re-resolved against the fresh one. Kept separate from `once` so a
 * caller with a smarter decision (an LLM reading a screenshot, say) can supply its own.
 * @param {Control[]} candidates @param {{ request: any }} o
 */
export function decideBySelector(candidates, { request }) {
  const r = selector.resolve(request || {}, candidates);
  if (r.control) return { control: r.control };
  return { why: r.why === "tied" ? `more than one control matches ${JSON.stringify(request)}` : `nothing matches ${JSON.stringify(request)}` };
}
