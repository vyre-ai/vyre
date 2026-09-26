// @ts-check
// hands: observe an app, act on one control, and prove the action landed.
//
// Two rules do most of the work, and both are about refusing to guess.
//
// FRESH BINDING. A control found in one observation belongs to THAT observation. Between
// reading the screen and the action landing, a menu can open, a dialog can appear, focus can
// move. Acting on a path from a stale observation is how an agent confidently acts on the wrong
// thing while every component behaved correctly. So act always observes first, re-finds the
// control by identity rather than position, and the helper checks role and name once more at
// the moment it acts.
//
// PROOF, NOT REPORTS. The accessibility API saying yes means the app accepted a message. Only a
// second observation says whether anything happened, so act always observes again and the
// answer carries `verified` from that observation alone. When it cannot be verified, the answer
// says so and why; it never rounds a maybe up to a success.

import { of, resolve, describe } from "./selector.js";
import { verdict, diff, signature } from "./verify.js";
import { HandsError } from "./runner.js";

export const KINDS = ["press", "set", "focus", "type", "key"];

/**
 * @typedef {import("./selector.js").Element} Element
 * @typedef {import("./selector.js").Selector} Selector
 * @typedef {import("./verify.js").Snap} Snap
 * @typedef {(request: Record<string, unknown>) => Promise<any>} Runner
 */

const VALUE_MAX = 200;           // what a caller sees of a value
const VALUE_FULL = 100000;       // what verification reads, so long text is not cut before it is checked
const clip = (/** @type {unknown} */ v) => v == null ? undefined : String(v).length > VALUE_MAX ? String(v).slice(0, VALUE_MAX) + "…" : String(v);

/** One element as a caller sees it: the selector to hand back, and its state. */
export function present(/** @type {Element} */ e) {
  /** @type {Record<string, unknown>} */
  const out = { selector: of(e), enabled: e.enabled !== false };
  if (e.focused) out.focused = true;
  if (e.secure) out.secure = true;
  else if (e.value != null) out.value = clip(e.value);
  if (e.frame) out.frame = e.frame;
  return out;
}

/** Which app to talk to. A pid wins over a name; neither means the frontmost app. */
function target(/** @type {{ app?: string, pid?: number, window?: string }} */ i) {
  /** @type {Record<string, unknown>} */
  const t = {};
  if (i.pid != null) t.pid = i.pid; else if (i.app) t.app = i.app;
  if (i.window) t.window = i.window;
  return t;
}

export class Hands {
  /**
   * @param {{ run: Runner, sleep?: (ms: number) => Promise<void>, emit?: (type: string, payload: any) => void }} deps
   */
  constructor({ run, sleep = ms => new Promise(r => setTimeout(r, ms)), emit = () => {} }) {
    this.run = run; this.sleep = sleep; this.emit = emit;
  }

  /** @param {Record<string, unknown>} t @param {{ limit?: number, valueMax?: number }} [o] @returns {Promise<Snap>} */
  snap(t, { limit, valueMax } = {}) {
    return this.run({ cmd: "snap", ...t, ...(limit ? { limit } : {}), ...(valueMax ? { valueMax } : {}) });
  }

  /** @param {{ app?: string, pid?: number, window?: string, limit?: number }} input */
  async observe(input = {}) {
    const s = await this.snap(target(input), { limit: input.limit });
    return {
      app: s.app, pid: s.pid, window: s.window, front: s.front,
      elements: (s.elements || []).map(present), texts: s.texts || [],
      truncated: Boolean(s.truncated),
    };
  }

  /**
   * @param {{ selector: Selector, kind: string, value?: string, key?: string, modifiers?: string[],
   *   app?: string, pid?: number, window?: string, limit?: number, settleMs?: number }} input
   */
  async act(input) {
    const { selector, kind } = input;
    if (!KINDS.includes(kind)) throw new HandsError("bad_input", `kind must be one of ${KINDS.join(", ")}`);
    if ((kind === "set" || kind === "type") && typeof input.value !== "string") throw new HandsError("bad_input", `${kind} needs a value`);
    if (kind === "key" && typeof input.key !== "string") throw new HandsError("bad_input", "key needs a key, e.g. return");
    if (!selector || typeof selector.role !== "string") throw new HandsError("bad_input", "selector needs at least a role; take it from hands.observe");

    // The fresh frame. Whatever observation the selector came from may no longer exist.
    const opts = { limit: input.limit || 300, valueMax: VALUE_FULL };
    const before = await this.snap(target(input), opts);
    // Pin the app by pid from here on. Otherwise "the frontmost app" could be a different app
    // by the time the action runs, and the check after it would read a third.
    const pinned = { pid: before.pid, ...(input.window ? { window: input.window } : {}) };
    const bound = resolve(selector, before.elements || []);
    const miss = (/** @type {string} */ reason) => this.finish({ input, before, after: null, acted: false, verified: false, reason });
    if (!bound.element) return miss(`nothing was done: ${"why" in bound ? bound.why : ""}`);
    const el = bound.element;
    if (el.enabled === false) return miss(`nothing was done: ${describe(selector)} is disabled right now`);

    let acted = false, refused = "";
    try {
      const r = await this.run({
        cmd: "act", ...pinned, path: el.path, role: el.role, ...(el.name ? { name: el.name } : {}),
        kind, value: input.value, key: input.key, modifiers: input.modifiers,
      });
      acted = r.acted === true;
      if (!acted) refused = `the app refused the action${r.axError != null ? ` (accessibility error ${r.axError})` : ""}`;
    } catch (e) {
      // The helper's last-moment check found a different control at that path, or the app went
      // away. Nothing was done, and saying so is the whole answer.
      if (!(e instanceof HandsError) || !["moved", "disabled", "not_found", "no_window", "no_app"].includes(e.code)) throw e;
      refused = e.message;
    }

    // Always look again, whatever the helper said. Apps repaint asynchronously, so a check made
    // at once can see the screen from before the action and report a working action as a miss;
    // poll briefly until the effect shows or the time is up.
    // A refused action gets one look, not a wait for an effect it cannot have caused.
    const budget = acted ? Math.max(0, input.settleMs ?? 1500) : 0;
    let waited = 0, after = before, v = { verified: false, reason: "", target: /** @type {Element|null} */ (null) };
    do {
      const step = Math.min(250, Math.max(budget - waited, 0)) || 0;
      if (step) { await this.sleep(step); waited += step; }
      after = await this.snap({ ...pinned }, opts);
      v = verdict({ kind, value: input.value, selector, before, after });
    } while (!v.verified && waited < budget);

    // An action that was refused is never verified, even if the window changed meanwhile: a
    // change nobody caused is something else happening, and crediting it would be the silent
    // success this module exists to prevent.
    const verified = acted && v.verified;
    const reason = acted ? v.reason : `${refused}${v.verified ? "; the window did change meanwhile, but not because of this action" : ""}`;
    return this.finish({ input, before, after, acted, verified, reason, bound: el, target: v.target });
  }

  /**
   * @param {{ input: any, before: Snap, after: Snap | null, acted: boolean, verified: boolean, reason: string, bound?: Element, target?: Element | null }} r
   */
  finish({ input, before, after, acted, verified, reason, bound, target: now }) {
    // Recorded for the audit trail: which app, what kind of action, on what, and whether it
    // was proven. Never the value or the keys: typed text can be a password.
    const { role, name, identifier, container } = input.selector || {};
    this.emit("hands.acted", { app: before.app, kind: input.kind, selector: { role, name, identifier, container }, acted, verified });
    const side = (/** @type {Snap} */ s, /** @type {Element|null|undefined} */ e) => ({ window: s.window, signature: signature(s), target: e ? present(e) : null });
    return {
      acted, verified, reason,
      before: side(before, bound),
      after: after ? side(after, now) : null,
      changes: after ? diff(before, after) : null,
    };
  }
}
