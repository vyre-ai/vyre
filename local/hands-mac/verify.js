// @ts-check
// verify: did the action do anything?
//
// The accessibility API reports success when the app accepted the message. That does not mean
// a button was pressed, that it was the button meant, or that anything changed. Pressing a
// disabled control and pressing a live one used to produce identical output, so every miss was
// reported as a win, and the only way to notice was for a person to look at the screen.
//
// So the only evidence is a second observation. For an action with a checkable end state (a
// value set, text typed, focus moved) the rule checks that state on the re-found control. For a
// press or a key, where predicting the effect would be a second guess that can be wrong in the
// same direction as the first, the rule is blunt on purpose: the window must be different
// afterwards.

import crypto from "node:crypto";
import { resolve } from "./selector.js";

/**
 * @typedef {import("./selector.js").Element} Element
 * @typedef {import("./selector.js").Selector} Selector
 * @typedef {{ app: string, pid?: number, window: string, front?: boolean, elements: Element[], texts?: string[], truncated?: boolean }} Snap
 */

/**
 * A fingerprint of everything about a window an action could plausibly move.
 *
 * Frames are left out. A window that reflows by a pixel, a caret blinking, a progress bar
 * advancing on its own: all of those move geometry without anything having happened, and
 * counting them would let every verification pass whatever the action did. What counts is
 * what an action changes: the title, which controls exist, their names, whether they are
 * enabled, what they hold, where focus sits, and the text on screen.
 */
export function signature(/** @type {Snap} */ snap) {
  const parts = [snap.window || ""];
  for (const e of snap.elements || []) {
    parts.push([e.path, e.role, e.name || "", e.enabled === false ? "0" : "1", e.focused ? "f" : "", e.value == null ? "" : String(e.value)].join("\u0001"));
  }
  parts.push("\u0003", ...(snap.texts || []));
  return crypto.createHash("sha256").update(parts.join("\u0002")).digest("hex").slice(0, 16);
}

const label = (/** @type {Element} */ e) => e.name || e.role.replace(/^AX/, "").toLowerCase();
const cap = (/** @type {string[]} */ a, n = 10) => a.length > n ? [...a.slice(0, n), `and ${a.length - n} more`] : a;

/**
 * What specifically moved, in names a person can read. Values are not repeated here: this is
 * the part of the answer most likely to be logged, and a value may be something typed.
 */
export function diff(/** @type {Snap} */ before, /** @type {Snap} */ after) {
  const key = (/** @type {Element} */ e) => e.path + "\u0001" + e.role;
  const was = new Map((before.elements || []).map(e => [key(e), e]));
  const now = new Map((after.elements || []).map(e => [key(e), e]));
  /** @type {string[]} */ const appeared = [], vanished = [], altered = [];
  for (const [k, e] of now) if (!was.has(k)) appeared.push(label(e));
  for (const [k, e] of was) if (!now.has(k)) vanished.push(label(e));
  for (const [k, e] of now) {
    const p = was.get(k);
    if (p && (p.enabled !== e.enabled || String(p.value ?? "") !== String(e.value ?? "") || p.name !== e.name || !!p.focused !== !!e.focused)) altered.push(label(e));
  }
  const tb = new Set(before.texts || []), ta = new Set(after.texts || []);
  return {
    title: (before.window || "") !== (after.window || "") ? { from: before.window || "", to: after.window || "" } : null,
    appeared: cap(appeared), vanished: cap(vanished), altered: cap(altered),
    textChanged: [...ta].some(t => !tb.has(t)) || [...tb].some(t => !ta.has(t)),
  };
}

/** How many times needle occurs in hay, without overlaps. */
function count(/** @type {string} */ hay, /** @type {string} */ needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

/** The accessibility actions hands will perform, beside press, set, focus, type and key. */
export const ACTIONS = ["AXShowMenu", "AXIncrement", "AXDecrement", "AXConfirm", "AXCancel", "AXRaise", "AXPick", "AXScrollToVisible"];

const num = (/** @type {unknown} */ v) => {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[^0-9.eE+-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const isMenu = (/** @type {Element} */ e) => e.role === "AXMenuItem" || e.role === "AXMenu";
const sameFrame = (/** @type {Element|null|undefined} */ a, /** @type {Element|null|undefined} */ b) =>
  JSON.stringify(a && a.frame || null) === JSON.stringify(b && b.frame || null);

/**
 * One rule per accessibility action. Each names the effect it looks for; where an action has no
 * effect this module can see, the rule says that instead of crediting a change nobody can tie
 * to it.
 *
 * @param {{ action: string, moved: boolean, before: Snap, after: Snap, target: Element | null, was: Element | null, found: any }} a
 * @returns {{ verified: boolean, reason: string, target: Element | null }}
 */
function actionVerdict({ action, moved, before, after, target, was, found }) {
  switch (action) {
    case "AXShowMenu": {
      // A menu is a visible, checkable end state: menu items that were not there before.
      const had = new Set((before.elements || []).filter(isMenu).map(e => e.path));
      const opened = (after.elements || []).some(e => isMenu(e) && !had.has(e.path));
      return opened
        ? { verified: true, reason: "a menu opened", target }
        : { verified: false, reason: "no menu appeared in the app after the action (a menu drawn outside the app's accessibility tree cannot be seen)", target };
    }
    case "AXIncrement":
    case "AXDecrement": {
      if (!target) return { verified: false, reason: `the control could not be found again after the action: ${"why" in found ? found.why : ""}`, target: null };
      const from = num(was && was.value), to = num(target.value);
      if (from == null || to == null) return { verified: false, reason: "the control does not publish a numeric value, so the step cannot be confirmed", target };
      const up = action === "AXIncrement";
      if (up ? to > from : to < from) return { verified: true, reason: `the value went ${up ? "up" : "down"}`, target };
      return { verified: false, reason: to === from ? "the value did not change (it may be at its limit)" : `the value went the wrong way`, target };
    }
    case "AXRaise": {
      // The end state is checkable: the window is the app's main window afterwards.
      if (!target) return { verified: false, reason: `the window could not be found again after the action: ${"why" in found ? found.why : ""}`, target: null };
      if (target.focused) return { verified: true, reason: was && was.focused ? "the window was already the main window and still is" : "the window is the main window now", target };
      return { verified: false, reason: "the window is not the main window after the action", target };
    }
    case "AXScrollToVisible": {
      // Frames are out of the window signature on purpose; here the control's own frame is the
      // effect. An unmoved frame is not a failure the code can prove, nor a success: the control
      // may already have been in view.
      if (!target) return { verified: false, reason: `the control could not be found again after the action: ${"why" in found ? found.why : ""}`, target: null };
      if (!sameFrame(was, target)) return { verified: true, reason: "the control moved, so it was scrolled", target };
      return { verified: false, reason: "the control did not move; it may already have been in view, which this cannot tell apart from a scroll that did nothing", target };
    }
    case "AXConfirm":
    case "AXPick":
    case "AXCancel":
      // Like a press: what these do is the app's business, so the window must be different.
      return moved
        ? { verified: true, reason: "the window changed after the action", target }
        : { verified: false, reason: "nothing observed changed after the action, so it did not land (or its effect is outside what the accessibility tree shows)", target };
    default:
      return { verified: false, reason: `no rule to verify ${action}`, target };
  }
}

/**
 * The verdict on one action, from the observation taken just before it and the one after.
 * Always returns a reason, because "it did not work" and "it worked" are both things the
 * caller has to say out loud, and a bare boolean makes for a useless message.
 *
 * @param {{ kind: string, value?: string, action?: string, selector: Selector, before: Snap, after: Snap }} a
 * @returns {{ verified: boolean, reason: string, target: Element | null }}
 */
export function verdict({ kind, value, action, selector, before, after }) {
  const moved = signature(before) !== signature(after);
  const found = resolve(selector, after.elements || []);
  const target = found.element;
  const was = resolve(selector, before.elements || []).element;

  if (kind === "action") return actionVerdict({ action: String(action || ""), moved, before, after, target, was, found });

  if (kind === "press" || kind === "key") {
    if (moved) return { verified: true, reason: "the window changed after the action", target };
    return { verified: false, reason: "nothing observed changed after the action, so it did not land (or its effect is outside what the accessibility tree shows)", target };
  }

  // The rest have an end state on the control itself, so the control must still be there.
  if (!target) return { verified: false, reason: `the control could not be found again after the action: ${"why" in found ? found.why : ""}`, target: null };

  if (kind === "focus") {
    return target.focused
      ? { verified: true, reason: "the control has focus now", target }
      : { verified: false, reason: "the control does not have focus after the action", target };
  }

  if (kind === "set" || kind === "type") {
    // A secure field never reveals its contents, and guessing from the dot count would be a
    // claim this code cannot back. Unverifiable is the honest answer.
    if (target.secure) return { verified: false, reason: "this is a secure field, which does not reveal its contents, so the text cannot be confirmed", target };
    if (target.value == null) return { verified: false, reason: `the control does not publish its value, so the text cannot be confirmed${moved ? " (the window did change)" : ""}`, target };
    const now = String(target.value), text = String(value ?? "");
    if (kind === "set") {
      if (now === text || now.trim() === text.trim()) {
        return { verified: true, reason: was && String(was.value ?? "") === now ? "the control already held that value and still does" : "the control now holds the value", target };
      }
      return { verified: false, reason: "the control's value is not what was set", target };
    }
    // Typed text must be there afterwards more times than before; otherwise text that was
    // already present would pass for text that was just typed.
    const prev = was && was.value != null ? String(was.value) : "";
    if (count(now, text) > count(prev, text)) return { verified: true, reason: "the typed text is in the control now", target };
    return { verified: false, reason: count(now, text) ? "the text was already there and no new copy of it appeared" : "the typed text is not in the control", target };
  }

  return { verified: false, reason: `no rule to verify a ${kind}`, target };
}
