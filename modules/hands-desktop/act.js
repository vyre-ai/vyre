// @ts-check
// act: perceive, decide, re-bind, act, verify.
//
// A single-shot action finds a control and presses it, reporting success if the press was
// accepted. There is no check that the press did anything, and no notion that the screen might
// have moved between choosing a target and reaching for it. Two rules do most of the work here,
// and both are about refusing to guess.
//
// FRESH BINDING. A target identified in one observation belongs to THAT observation. Between
// reading the screen and the click landing, a menu can open, a dialog can appear, focus can move.
// Clicking an index from a stale frame is how an agent confidently clicks the wrong thing while
// every individual component behaved correctly. So the chosen control is re-resolved against a
// fresh snapshot immediately before the click, by identity rather than by position.
//
// HALT, DO NOT GUESS. When a target will not re-bind, the recovery is to observe again or to stop
// with a reason. It is never to lower a threshold or to click something nearby.

import * as selector from "./selector.js";
import * as verify from "./verify.js";
import * as consequence from "./consequence.js";

/** @typedef {import("./snapshot.js").Snapshot} Snapshot */
/** @typedef {import("./snapshot.js").Control} Control */

export const LIMITS = {
  decisions: 30, // total turns round the loop
  mutations: 20, // actions that change something
  ms: 90_000,    // wall clock
  repeats: 2,    // the same failure on an equivalent screen
};

export const TAKE_OVER = "take over in Glass to do this yourself";

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** @param {Control} c */
const label = c => JSON.stringify(c.name || c.role);

/**
 * One turn: look, choose, look again, act, look again.
 *
 * `perceive`, `decide` and `click` are injected rather than imported so this file can be tested
 * without a screen, and so the decider can be swapped without this file knowing which one answered.
 *
 * `decide` returns `{control}` for its choice or `{why}` to refuse (two equal matches, a number
 * past the end of the last look). `click` may return `{ok: false, why}` to stop at the last
 * moment (the keyboard was taken over mid-turn); nothing is then verified or claimed.
 *
 * Consequential controls are refused unless `consequential: "allow"`: nothing exists yet to hold
 * a send or a payment for the user's approval, so the hands do not do them at all.
 *
 * @param {{ app: string, request?: any,
 *   perceive: () => Promise<Snapshot>,
 *   decide: (candidates: Control[], o: { request: any, app: string, window: string }) => Promise<{ control?: Control|null, why?: string } | null>,
 *   click: (c: Control, o: { consequential: boolean }) => Promise<void | { ok: false, why: string }>,
 *   settle?: number, consequential?: "refuse"|"allow" }} o
 */
export async function once({ app, request, perceive, decide, click, settle = 250, consequential = "refuse" }) {
  const before = await perceive();
  const candidates = before.controls || [];
  if (!candidates.length) return { ok: false, why: "nothing actionable on this screen" };

  const d = await decide(candidates, { request, app, window: before.window });
  const chosen = d && d.control;
  if (!chosen) return { ok: false, why: (d && d.why) || "nothing here matches " + JSON.stringify(request) };

  const sel = selector.of(app, chosen);
  let kind = consequence.of(chosen);
  if (kind.consequential && consequential !== "allow") {
    return { ok: false, consequential: true, retryable: false, selector: sel, why: `${kind.why}; ${TAKE_OVER}` };
  }

  // The fresh frame. Everything above described a screen that may no longer exist.
  const fresh = await perceive();
  const b = selector.bind(sel, fresh.controls || []);
  if (!b.control) {
    return {
      ok: false, needsFreshLook: b.why === "missing", selector: sel,
      why: b.why === "tied"
        ? `${b.tied ? b.tied.length : "several"} controls now match ${label(chosen)} equally, so nothing was clicked`
        : "the control moved or changed between looking and reaching, so nothing was clicked",
    };
  }
  const bound = b.control;
  if (bound.enabled === false) return { ok: false, control: bound, selector: sel, why: label(bound) + " is disabled right now" };

  // Classify what actually bound, not only what was chosen: an app can rename a button between
  // the two looks, and "Save" becoming "Send" must not be pressed because it was safe a moment ago.
  kind = consequence.of(bound);
  if (kind.consequential && consequential !== "allow") {
    return { ok: false, consequential: true, retryable: false, control: bound, selector: sel, why: `${kind.why}; ${TAKE_OVER}` };
  }

  const stopped = await click(bound, { consequential: kind.consequential });
  if (stopped && stopped.ok === false) return { ok: false, control: bound, selector: sel, why: stopped.why };

  // Give the app a moment. Reading immediately reports the screen before it has repainted, which
  // makes a click that worked look like one that missed.
  if (settle > 0) await sleep(settle);
  const after = await perceive();
  const moved = verify.changed(fresh, after);

  return {
    ok: moved.ok,
    why: moved.ok ? "pressed " + label(bound) : moved.why,
    control: bound,
    selector: sel,
    consequential: kind.consequential,
    changed: moved.ok ? verify.diff(fresh, after) : null,
    // A consequential action that appears not to have landed is NOT retried, and the caller is
    // told plainly. Pressing send again because the screen looked unchanged is exactly how a
    // message gets sent twice.
    retryable: moved.ok ? false : consequence.retryable(bound),
    window: after.window,
  };
}

/**
 * Keep going until `done` says so or a limit says stop.
 *
 * The repeat limit is the one that matters. The common runaway is not a long task; it is one
 * action that does nothing, attempted forever, each attempt looking exactly like the last.
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
    if (mutations >= limits.mutations) return { ok: false, why: `stopped after ${mutations} changes to the screen`, log };
    if (Date.now() - started > limits.ms) return { ok: false, why: `stopped after ${Math.round((Date.now() - started) / 1000)} seconds`, log };
    decisions++;
    const r = await once(opts);
    log.push(r);
    if (r.ok) {
      mutations++;
      if (opts.done && await opts.done(r)) return { ok: true, why: "done", log };
      continue;
    }
    // A stale binding is the one failure worth simply looking again for: the step is still
    // sensible and only its target moved. Anything else is structural and stops here.
    if (r.needsFreshLook) continue;
    if (r.consequential) return { ok: false, why: r.why, log };
    const sig = JSON.stringify(r.selector || r.why);
    const n = (seen.get(sig) || 0) + 1;
    seen.set(sig, n);
    if (n >= limits.repeats) return { ok: false, why: "tried the same thing twice and nothing happened: " + r.why, log };
  }
}
