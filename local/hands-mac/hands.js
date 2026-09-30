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
//
// Three more rules come from the floor (SPEC section 11), and they run before anything is done:
//
// NOT THERE. Some places are off limits whatever a model asks: Vyre's own surfaces, system
// sign-in and permission dialogs, password managers, the security panes of System Settings. An
// agent that can press the button approving its own request has walked around every human-only
// tool without calling one. There, observe returns the app and window and nothing else, and act
// refuses (code floor). A secure field is refused too (code secure): signing in is vault.fill's job.
//
// NOT ALONE. An act that sends something as the person (a Send button, Return in a chat) is held,
// not done. It goes through hands.commit, which needs a person's proof, and the summary they see
// says what will be pressed and where.
//
// STOPPABLE. While Vyre acts, a pill says so and Escape or a double Control stops it at once. A
// stop aborts the act in flight and refuses every later act until the caller passes resume: true,
// which it should do only after asking the person.
//
// The floor list itself is shared with the screen module and lives beside it: importing
// ../screen-mac/floor.js is a deliberate exception to "modules talk only through the contract",
// because two copies of the floor would drift, and a floor that drifts is not a floor.

import { of, resolve, describe } from "./selector.js";
import { verdict, diff, signature, ACTIONS } from "./verify.js";
import { HandsError } from "./runner.js";
import { NO_OVERLAY, center } from "./overlay.js";
import { untouchable, outward } from "../screen-mac/floor.js";

export const KINDS = ["press", "set", "focus", "action", "type", "key"];
export { ACTIONS };

/**
 * @typedef {import("./selector.js").Element} Element
 * @typedef {import("./selector.js").Selector} Selector
 * @typedef {import("./verify.js").Snap} Snap
 * @typedef {(request: Record<string, unknown>) => Promise<any>} Runner
 * @typedef {{ box?: string | null }} Known
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
  if (Array.isArray(e.actions) && e.actions.length) out.actions = e.actions;
  return out;
}

/** Where an observation says it is, in the words the floor reads. */
const placeOf = (/** @type {any} */ s) => ({ bundle: s.bundle || null, app: s.app || null, window: s.window || null, url: s.origin || null });

/** The longest an act keeps re-observing for its effect. Slow apps (Catalyst, Electron) get up to this. */
export const SETTLE_MAX = 5000;
/** How many controls a filtered observation reads before filtering, so a filter sees past the default cap. */
const MATCH_READ = 500;

const centre = (/** @type {any} */ f) => f ? { x: f.x + f.w / 2, y: f.y + f.h / 2 } : null;
const lower = (/** @type {unknown} */ v) => String(v ?? "").toLowerCase();

/**
 * The controls a filter asks for, best first. role is exact (the AX prefix optional); name is a
 * case-insensitive substring of the control's label or identifier, never of its value, which can
 * be anything a person typed. near names another control (by selector path or label): matches are
 * ordered by how close their centres are to its centre, and with no such control, left in order.
 * @param {Element[]} elements
 * @param {{ role?: string, name?: string, near?: string }} m
 */
export function filterControls(elements, m) {
  const role = m.role ? (m.role.startsWith("AX") ? m.role : `AX${m.role}`) : null;
  const name = m.name ? lower(m.name) : null;
  let out = elements.filter(e => (!role || e.role === role) &&
    (!name || lower(e.name).includes(name) || lower(e.identifier).includes(name)));
  if (m.near) {
    const n = lower(m.near);
    const anchor = elements.find(e => e.path === m.near) || elements.find(e => lower(e.name) === n) || elements.find(e => lower(e.name).includes(n));
    const a = anchor && centre(anchor.frame);
    if (a) {
      const d = (/** @type {Element} */ e) => { const c = centre(e.frame); return c ? Math.hypot(c.x - a.x, c.y - a.y) : Infinity; };
      out = out.filter(e => e !== anchor).map((e, i) => ({ e, i, d: d(e) })).sort((p, q) => p.d - q.d || p.i - q.i).map(x => x.e);
    }
  }
  return out;
}

/** Codes the helper uses for "nothing was done, and here is why". */
const MISSES = ["moved", "disabled", "not_found", "no_window", "no_app", "not_owner", "unsupported_action"];

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
   * @param {{ run: Runner, sleep?: (ms: number) => Promise<void>, emit?: (type: string, payload: any) => void,
   *   overlay?: import("./overlay.js").Overlay, known?: () => Promise<Known>,
   *   hold?: (o: { content: Record<string, unknown>, thread?: string }) => Promise<{ id: string } | null> }} deps
   */
  constructor({ run, sleep = ms => new Promise(r => setTimeout(r, ms)), emit = () => {}, overlay = NO_OVERLAY, known = async () => ({}), hold = async () => null }) {
    this.run = run; this.sleep = sleep; this.emit = emit; this.overlay = overlay; this.known = known; this.hold = hold;
    /** Set by a stop, cleared only by an act that passes resume: true. @type {{ app: string | null, by: string } | null} */
    this.stopped = null;
    /** The app of the live control session, for the stop event. @type {string | null} */
    this.current = null;
    // Every stop bumps the generation and settles `halted`. An act compares its generation after
    // each wait, so a stop between two steps ends it there, and a wait in the settle loop is
    // cut short rather than slept out.
    this.gen = 0;
    this.newHalt();
    overlay.onStop(() => this.halt("person"));
  }

  newHalt() {
    /** @type {() => void} */
    let fire = () => {};
    /** @type {Promise<void>} */
    this.halted = new Promise(r => { fire = r; });
    this.fireHalt = fire;
  }

  /** The person carries on from the panel (not the agent's own resume: true). Idempotent. */
  resumeByPerson() {
    if (!this.stopped) return { ok: true, already: true };
    const was = this.stopped.app;
    this.stopped = null;
    this.newHalt();
    this.emit("hands.resumed", { app: was, by: "person" });
    return { ok: true, already: false };
  }

  /**
   * Stop controlling the Mac: from the person's keys (by "person") or from hands.stop (by "tool").
   * Idempotent, so Escape pressed twice is one stop.
   * @param {"person" | "tool"} by
   */
  halt(by) {
    if (!this.stopped) {
      this.stopped = { app: this.current, by };
      this.gen++;
      this.fireHalt();
      this.emit("hands.stopped", { app: this.current, by });
    }
    this.current = null;
    this.overlay.done();
    return { stopped: true, app: this.stopped.app, by: this.stopped.by };
  }

  /** The floor's view of the world: the paired box's origin, when there is one. */
  async knownPlace() {
    try { return (await this.known()) || {}; } catch { return {}; }
  }

  /**
   * Which app and window a request reaches, read without reading anything in it.
   * @param {Record<string, unknown>} t
   */
  where(t) { return this.run({ cmd: "where", ...t }); }

  /** @param {Record<string, unknown>} t @param {{ limit?: number, valueMax?: number }} [o] @returns {Promise<Snap>} */
  snap(t, { limit, valueMax } = {}) {
    return this.run({ cmd: "snap", ...t, ...(limit ? { limit } : {}), ...(valueMax ? { valueMax } : {}) });
  }

  /**
   * @param {{ app?: string, pid?: number, window?: string, limit?: number,
   *   match?: { role?: string, name?: string, near?: string, limit?: number } }} input
   */
  async observe(input = {}) {
    // The place first, and the floor on it, before a single value is read: a password manager's
    // contents must never reach this process at all, not just be dropped before the answer.
    const w = await this.where(target(input));
    const k = await this.knownPlace();
    const blind = (/** @type {any} */ s, /** @type {string} */ why) => ({ app: s.app, pid: s.pid, window: s.window, blind: why, elements: [], texts: [], truncated: false });
    const off = untouchable(placeOf(w), k);
    if (off) return blind(w, off);
    // Pinned to the pid just checked, so the snap cannot land on an app that came to the front since.
    const m = input.match && typeof input.match === "object" ? input.match : null;
    const s = await this.snap({ pid: w.pid, ...(input.window ? { window: input.window } : {}) }, { limit: m ? MATCH_READ : input.limit });
    const late = untouchable(placeOf(s), k);
    if (late) return blind(s, late);
    let elements = s.elements || [], truncated = Boolean(s.truncated);
    if (m) {
      const found = filterControls(elements, m);
      const cap = Math.max(1, Math.min(MATCH_READ, Math.floor(Number(m.limit ?? input.limit ?? 20)) || 20));
      // truncated now means either list was cut: the tree past what was read, or the matches past cap.
      truncated = truncated || found.length > cap;
      elements = found.slice(0, cap);
    }
    return {
      app: s.app, pid: s.pid, bundle: s.bundle || null, window: s.window, front: s.front,
      elements: elements.map(present), texts: s.texts || [],
      truncated,
    };
  }

  /**
   * Do one thing to one control, and prove it. `commit` is set only from hands.release, the
   * Gate's own callback once a person approved the held item; it skips the outward hold and
   * nothing else.
   *
   * @param {{ selector: Selector, kind: string, action?: string, value?: string, key?: string, modifiers?: string[],
   *   app?: string, pid?: number, window?: string, limit?: number, settleMs?: number, resume?: boolean }} input
   * @param {{ commit?: boolean, thread?: string }} [o]
   */
  async act(input, { commit = false, thread } = {}) {
    const { selector, kind } = input;
    if (!KINDS.includes(kind)) throw new HandsError("bad_input", `kind must be one of ${KINDS.join(", ")}`);
    if ((kind === "set" || kind === "type") && typeof input.value !== "string") throw new HandsError("bad_input", `${kind} needs a value`);
    if (kind === "key" && typeof input.key !== "string") throw new HandsError("bad_input", "key needs a key, e.g. return");
    if (kind === "action" && !ACTIONS.includes(String(input.action))) throw new HandsError("bad_input", `action must be one of ${ACTIONS.join(", ")}`);
    if (!selector || typeof selector.role !== "string") throw new HandsError("bad_input", "selector needs at least a role; take it from hands.observe");

    // A stop is the person's decision, and it outlives the act it cut short. Carrying on needs a
    // caller that says so in the input, which is visible in the call log and in hands.resumed.
    if (this.stopped) {
      if (input.resume !== true) {
        const where = this.stopped.app ? ` of ${this.stopped.app}` : "";
        const who = this.stopped.by === "person" ? "The person stopped" : "hands.stop stopped";
        throw new HandsError("stopped", `${who} Vyre's control${where}. Nothing was done. Ask the person whether to carry on, and only then call again with resume: true`);
      }
      const was = this.stopped.app;
      this.stopped = null;
      this.newHalt();
      this.emit("hands.resumed", { app: was });
    }
    const gen = this.gen;
    const halted = () => this.gen !== gen;

    // The place, and the floor on it, before anything in it is read.
    const k = await this.knownPlace();
    const w = await this.where(target(input));
    const off = untouchable(placeOf(w), k);
    if (off) throw new HandsError("floor", `Vyre does not act in ${off}. Nothing was done; this is for the person to do`);

    // The fresh frame. Whatever observation the selector came from may no longer exist.
    // Pin the app by pid from here on. Otherwise "the frontmost app" could be a different app
    // by the time the action runs, and the check after it would read a third.
    const opts = { limit: input.limit || 300, valueMax: VALUE_FULL };
    const pinned = { pid: w.pid, ...(input.window ? { window: input.window } : {}) };
    const before = await this.snap(pinned, opts);
    // The window can change between the two looks; the floor is checked on what was read.
    const late = untouchable(placeOf(before), k);
    if (late) throw new HandsError("floor", `Vyre does not act in ${late}. Nothing was done; this is for the person to do`);
    if (halted()) return this.cut({ input, before, acted: false });
    const bound = resolve(selector, before.elements || []);
    const miss = (/** @type {string} */ reason) => this.finish({ input, before, after: null, acted: false, verified: false, reason });
    if (!bound.element) return miss(`nothing was done: ${"why" in bound ? bound.why : ""}`);
    const el = bound.element;
    if (el.secure) throw new HandsError("secure", `${describe(selector)} is a secure field. Vyre never types, sets or reads a password through the screen; sign in with vault.fill, which fills it without the value passing through here`);
    if (el.enabled === false) return miss(`nothing was done: ${describe(selector)} is disabled right now`);
    if (kind === "action" && Array.isArray(el.actions) && !el.actions.includes(String(input.action))) {
      return miss(`nothing was done: ${describe(selector)} does not offer ${input.action} (it offers ${el.actions.join(", ") || "none"})`);
    }

    // A key goes to the app's key window, and an app in the background has none, so the key would
    // be dropped while the act looked done. Hands never raise an app on their own, so this is
    // refused before anything is held or posted, for hands.commit as much as for hands.act.
    if (kind === "key" && before.front === false) {
      throw new HandsError("needs_front", `${before.app || "The app"} is in the background, and a key only reaches the app in front. Nothing was done. Press the control instead (for example the Send button), or ask the person to bring ${before.app || "the app"} to the front`);
    }

    // Held, not refused: sending as the person needs the person, through the same one Gate every
    // other outward action goes through (PLAN.md C4): a real held card, not a bespoke path.
    // Confirm and pick are other ways to press a control, and a Send button confirmed is sent.
    const asKind = kind === "action" && (input.action === "AXConfirm" || input.action === "AXPick") ? "press" : kind;
    const out = commit ? null : outward(placeOf(before), { kind: asKind, name: el.name, role: el.role, identifier: el.identifier, key: input.key, modifiers: input.modifiers, value: input.value });
    if (out) {
      // The snapshot's own signature (verify.js) is the "did the screen move" check hands.release
      // redoes before ever acting: reviewer-2 H1's `changed` refusal. The whole input rides along
      // so release replays exactly what was approved, never a re-derived guess at it.
      const summary = await this.summary(input);
      const held = await this.hold({
        content: { app: before.app, window: before.window, control: summary, value: input.value !== undefined ? clip(input.value) : undefined, hash: signature(before), input },
        thread,
      }).catch(() => null);
      // The person's own words (or a standing permission) covered it: the Gate already replayed the act.
      if (held && held.sent) return held.result;
      const use = held && held.id ? "gate.approve" : "hands.commit";
      const reason = held && held.id
        ? `${out}, so it was held for the person to approve (${held.id}). Nothing was done.`
        : `${out}, so it was held and nothing was done. A person has to allow it: call hands.commit with the same input`;
      const r = this.finish({ input, before, after: null, acted: false, verified: false, reason, held: true });
      return { ...r, held: true, ...(held && held.id ? { id: held.id } : {}), use };
    }

    // Visible before it happens. In real use this starts the indicator and its stop keys, and
    // refuses (no_indicator) when they cannot be shown.
    const at = center(el.frame);
    await this.overlay.controlling(before.app, at);
    this.current = before.app;
    if (halted()) return this.cut({ input, before, acted: false });

    let acted = false, refused = "";
    try {
      const r = await this.run({
        cmd: "act", ...pinned, ...(before.bundle ? { bundle: before.bundle } : {}),
        path: el.path, role: el.role, ...(el.name ? { name: el.name } : {}),
        kind, action: input.action, value: input.value, key: input.key, modifiers: input.modifiers,
      });
      acted = r.acted === true;
      if (!acted) refused = `the app refused the action${r.axError != null ? ` (accessibility error ${r.axError})` : ""}`;
    } catch (e) {
      // The helper's last-moment check found a different control at that path, or the app went
      // away. Nothing was done, and saying so is the whole answer.
      if (!(e instanceof HandsError) || !MISSES.includes(e.code)) throw e;
      refused = e.message;
    }
    if (halted()) return this.cut({ input, before, acted });

    // Always look again, whatever the helper said. Apps repaint asynchronously, so a check made
    // at once can see the screen from before the action and report a working action as a miss;
    // poll briefly until the effect shows or the time is up.
    // A refused action gets one look, not a wait for an effect it cannot have caused.
    const budget = acted ? Math.min(SETTLE_MAX, Math.max(0, Number(input.settleMs ?? 1500) || 0)) : 0;
    let waited = 0, after = before, v = { verified: false, reason: "", target: /** @type {Element|null} */ (null) };
    do {
      const step = Math.min(250, Math.max(budget - waited, 0)) || 0;
      if (step) {
        await Promise.race([this.sleep(step), this.halted]);
        waited += step;
      }
      if (halted()) return this.cut({ input, before, acted });
      after = await this.snap({ ...pinned }, opts);
      if (halted()) return this.cut({ input, before, acted });
      v = verdict({ kind, value: input.value, action: input.action, selector, before, after });
    } while (!v.verified && waited < budget);

    // An action that was refused is never verified, even if the window changed meanwhile: a
    // change nobody caused is something else happening, and crediting it would be the silent
    // success this module exists to prevent.
    const verified = acted && v.verified;
    const reason = acted ? v.reason : `${refused}${v.verified ? "; the window did change meanwhile, but not because of this action" : ""}`;
    if (at) this.overlay.ring({ ...at, ok: verified });
    // The act can lead somewhere off limits (a press that opens a sign-in sheet). The verdict was
    // reached in memory; what the answer shows of that place is only that it is off limits.
    const blindAfter = untouchable(placeOf(after), k);
    if (blindAfter) {
      const r = this.finish({ input, before, after: null, acted, verified, reason, bound: el });
      return { ...r, after: { blind: blindAfter } };
    }
    return this.finish({ input, before, after, acted, verified, reason, bound: el, target: v.target });
  }

  /** The answer for an act a stop cut short: no further look, and never verified. */
  cut(/** @type {{ input: any, before: Snap, acted: boolean }} */ { input, before, acted }) {
    const reason = acted
      ? "stopped by the person after the action was sent and before its effect was checked, so it is not verified"
      : "stopped before anything was done";
    const r = this.finish({ input, before, after: null, acted, verified: false, reason });
    return { ...r, stopped: true };
  }

  /**
   * @param {{ input: any, before: Snap, after: Snap | null, acted: boolean, verified: boolean, reason: string, bound?: Element, target?: Element | null, held?: boolean }} r
   */
  finish({ input, before, after, acted, verified, reason, bound, target: now, held }) {
    // Recorded for the audit trail: which app, what kind of action, on what, and whether it
    // was proven. Never the value or the keys: typed text can be a password.
    const { role, name, identifier, container } = input.selector || {};
    this.emit("hands.acted", { app: before.app, kind: input.kind, ...(input.kind === "action" ? { action: input.action } : {}),
      selector: { role, name, identifier, container }, acted, verified, ...(held ? { held: true } : {}),
      ...(verified || !reason ? {} : { why: String(reason).replace(/\s+/g, " ").trim().slice(0, 200) }) });
    const side = (/** @type {Snap} */ s, /** @type {Element|null|undefined} */ e) => ({ window: s.window, signature: signature(s), target: e ? present(e) : null });
    return {
      acted, verified, reason,
      before: side(before, bound),
      after: after ? side(after, now) : null,
      changes: after ? diff(before, after) : null,
    };
  }

  /**
   * The Gate's own callback (hands.release) once a person approved a held act: re-check the
   * screen has not moved since it was held (reviewer-2 H1: approving something blind, from a
   * stale screenshot, is not approving what actually runs), then replay exactly the input that
   * was held, never a re-derived guess at it.
   * @param {{ input: any, hash: string }} content
   */
  async release({ input, hash }) {
    if (!input || typeof input !== "object") throw new HandsError("bad_input", "nothing to replay: the held content lost its input");
    const k = await this.knownPlace();
    const w = await this.where(target(input));
    const off = untouchable(placeOf(w), k);
    if (off) throw new HandsError("floor", `Vyre does not act in ${off}. Nothing was done`);
    const fresh = await this.snap({ pid: w.pid, ...(input.window ? { window: input.window } : {}) }, { valueMax: VALUE_FULL });
    if (!hash || signature(fresh) !== hash) {
      throw new HandsError("changed", "the screen changed since this was held. Nothing was done; ask again so the person sees what is actually there now");
    }
    return this.act(input, { commit: true });
  }

  /**
   * What a person sees before allowing hands.commit: what will be pressed or sent, in which app
   * and which window. It looks the place up (never the contents), and falls back to what the
   * input says when the look fails, because a summary that throws shows the person nothing.
   * @param {any} input
   */
  async summary(input) {
    let app = input.app || (input.pid != null ? `pid ${input.pid}` : "the frontmost app"), win = input.window || "";
    try { const w = await this.where(target(input)); app = w.app || app; win = w.window || win; } catch {}
    const sel = input.selector || {};
    const what = sel.name ? `"${String(sel.name).slice(0, 60)}"` : String(sel.role || "a control").replace(/^AX/, "").toLowerCase();
    const mods = (input.modifiers || []).map((/** @type {string} */ m) => m[0].toUpperCase() + m.slice(1)).join("-");
    const key = input.key ? (mods ? `${mods}-` : "") + String(input.key)[0].toUpperCase() + String(input.key).slice(1) : "";
    const text = String(input.value ?? "");
    const quoted = text.length > 60 ? `"${text.slice(0, 60)}..." (${text.length} characters)` : `"${text}"`;
    const verb =
      input.kind === "press" ? `Press ${what}` :
      input.kind === "key" ? `Press ${key} in ${what}` :
      input.kind === "type" ? `Type ${quoted} into ${what}` :
      input.kind === "set" ? `Set ${what} to ${quoted}` :
      input.kind === "action" ? `${String(input.action || "").replace(/^AX/, "")} ${what}` :
      `Act on ${what}`;
    return `${verb} in ${app}${win ? `, window "${String(win).slice(0, 80)}"` : ""}`;
  }
}
