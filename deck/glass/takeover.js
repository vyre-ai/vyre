// @ts-check
// Take-over and private sign-in (ADR 0005, decisions 2 and 3; board GlassTakeover). One keyboard
// at a time: this surface asks glass.take, and while it holds, noVNC sends input and the control
// bar counts the time. Hand-back is the button, Ctrl+Enter, the lease lapsing on the box, or the
// owner's idle setting (computers.handback.*): the box warns 10 s before, and the bar counts down.
//
// Neither glass.take nor glass.release asks for a passkey: taking the keyboard only pauses the
// agent, so the owner is never stopped for Touch ID (core/presence PERSON_ONLY). The box still
// refuses an agent, never a person.

import { h, put } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { gicon, errText, clock, yourDevice } from "./util.js";

/**
 * @param {any} s the screen state from watch.js: name, target, surface, holder, phone, visible()
 * @param {{ changed: () => void, notice: (el: HTMLElement | null) => void }} hooks
 */
export function takeover(s, hooks) {
  let busy = false;
  let tick = 0;
  const elapsed = h("span", { class: "gl-elapsed mono" }, "");
  const idle = h("span", { class: "gl-chip gl-chip-idle", role: "status", "aria-live": "polite", hidden: true }, "");
  const note = /** @type {HTMLInputElement} */ (h("input", { class: "input gl-note", type: "text", maxlength: "280",
    placeholder: `Note for ${s.name} (optional)`, "aria-label": `A note for ${s.name} when you hand back` }));

  const mine = () => !!s.holder && s.holder.surface === s.surface;
  const other = () => !!s.holder && s.holder.surface !== s.surface;

  /** Count the held time once a second, only while this tab is visible and holding. */
  function timer() {
    clearInterval(tick); tick = 0;
    const draw = () => {
      put(elapsed, s.holder?.since ? clock(Date.now() - Number(s.holder.since)) : "");
      const left = s.idleAt ? Math.max(0, Math.ceil((s.idleAt - Date.now()) / 1000)) : 0;
      idle.hidden = !s.idleAt;
      put(idle, s.idleAt ? `Handing back to ${s.name} in ${left} s. Type or move to keep control.` : "");
    };
    draw();
    if (mine() && s.visible() && s.holder?.since) tick = window.setInterval(draw, 1000);
  }

  function explainPrivate() {
    hooks.notice(h("div", { class: "gl-notice", role: "region", "aria-label": "Sign in privately" },
      h("div", { class: "gl-notice-text" },
        h("div", { class: "lbl" }, "Sign in privately"),
        h("p", null, `While you sign in, ${s.name} cannot see or read the page: its hands stop, it takes no screenshots, `,
          `and nothing you type reaches its thread. When you hand back, ${s.name} keeps the signed-in session, never the password.`)),
      h("div", { class: "gl-notice-acts" },
        h("button", { type: "button", class: "btn btn-ghost", onclick: () => hooks.notice(null) }, "Cancel"),
        h("button", { type: "button", class: "btn btn-primary", onclick: () => take(true) }, gicon("shield"), "Start"))));
  }

  /** @param {boolean} priv */
  async function take(priv) {
    if (busy || mine()) return;
    busy = true; hooks.changed();
    const input = { target: s.target, surface: s.surface, ...(priv ? { private: true } : {}) };
    const r = await attempt("glass.take", input);
    busy = false;
    if (r.error) {
      hooks.notice(failed(priv ? "Private sign-in did not start" : "Take-over did not start", r.error));
      hooks.changed();
      return;
    }
    hooks.notice(null);
    s.holder = { surface: s.surface, since: r.data?.since || Date.now(), private: !!(r.data?.private ?? priv) };
    hooks.changed();
  }

  async function release() {
    if (busy || !mine()) return;
    busy = true; hooks.changed();
    const text = note.value.trim();
    const input = { target: s.target, surface: s.surface, ...(text ? { note: text } : {}) };
    const r = await attempt("glass.release", input);
    busy = false;
    if (r.error) {
      hooks.notice(failed("Hand-back did not go through", r.error));
      hooks.changed();
      return;
    }
    note.value = "";
    const held = r.data?.held_ms ? ` after ${clock(r.data.held_ms)}` : "";
    s.holder = null;
    hooks.notice(done(`You handed the keyboard back to ${s.name}${held}.${text ? " Your note is in its thread." : ""}`));
    hooks.changed();
  }

  function failed(title, err) {
    return h("div", { class: "gl-notice gl-notice-hold", role: "alert" },
      h("div", { class: "gl-notice-text" }, h("div", { class: "lbl beacon" }, title), h("p", null, errText(err))),
      h("div", { class: "gl-notice-acts" }, h("button", { type: "button", class: "btn btn-ghost", onclick: () => hooks.notice(null) }, "Dismiss")));
  }

  function done(text) {
    return h("div", { class: "gl-notice", role: "status" }, h("div", { class: "gl-notice-text" }, h("p", null, text)),
      h("div", { class: "gl-notice-acts" }, h("button", { type: "button", class: "btn btn-ghost", onclick: () => hooks.notice(null) }, "Dismiss")));
  }

  /** The header's buttons for the current state. */
  function actions() {
    // While holding, the control bar under the screen has the hand-back button.
    if (mine()) return [];
    const blocked = other() || !s.canTake();
    const why = other() ? `${yourDevice(s.holder.surface)} has control.` : !s.canTake() ? "The screen is not connected." : "";
    return [
      h("button", { type: "button", class: "btn btn-ghost", disabled: busy || blocked, title: why || `Sign in on ${s.name}'s screen without ${s.name} seeing the page`,
        onclick: explainPrivate }, gicon("shield"), "Sign in privately"),
      h("button", { type: "button", class: "btn btn-primary gl-cta", disabled: busy || blocked, title: why || undefined, "aria-keyshortcuts": "T",
        onclick: () => take(false) }, gicon("pointer"), busy ? "Taking over" : "Take over", s.phone ? null : h("span", { class: "gl-kbd-in" }, "T")),
    ];
  }

  /** The control bar under the screen while this surface holds the keyboard. */
  function bar() {
    if (!mine()) return null;
    timer();
    return h("div", { class: "gl-bar", role: "group", "aria-label": "You have control" },
      h("span", { class: "gl-chip" + (s.holder.private ? " gl-chip-private" : "") }, s.holder.private ? "Signing in privately" : "You have control"),
      elapsed,
      idle,
      note,
      h("button", { type: "button", class: "btn btn-primary", disabled: busy, onclick: release, "aria-keyshortcuts": "Control+Enter" },
        gicon("back"), `Hand back to ${s.name}`, s.phone ? null : h("span", { class: "gl-kbd-in" }, "⌃⏎")));
  }

  /** What another viewer sees while someone else holds the keyboard. */
  function banner() {
    if (!other()) return null;
    const since = s.holder.since ? ` · ${clock(Date.now() - Number(s.holder.since))}` : "";
    return h("div", { class: "gl-banner", role: "status" }, gicon("pointer"),
      h("span", null, `${yourDevice(s.holder.surface)} has the keyboard${since}. ${s.name} is paused and this view is read-only.`));
  }

  /** The side panel while holding: where the keystrokes go (board GlassTakeover). */
  function side() {
    if (!mine()) return null;
    const n = s.name;
    const rows = s.holder.private
      ? [["The page on " + n + "'s screen", "receives it", true], [`${n}'s hands and eyes`, "stopped"], [`${n}'s thread`, "never"], ["Memory", "never"], ["Other viewers", "no input"]]
      : [["The page on " + n + "'s screen", "receives it", true], [`${n}'s hands`, "paused"], [`${n}'s Chrome link`, "stays open"], ["Other viewers", "no input"]];
    return h("div", { class: "gl-side-hold" },
      h("div", { class: "gl-side-top" },
        h("span", { class: "lbl" }, "While you type"),
        h("h2", { class: "h3" }, s.holder.private ? "What you type goes to the page. Nowhere else." : `${n} is paused while you drive.`),
        h("p", { class: "small muted" }, s.holder.private
          ? `Your keystrokes travel from this browser over your tailnet into ${n}'s screen. ${n} cannot read the page until you hand back.`
          : `${n}'s hands stop until you hand back. Its link to Chrome stays open, so for a password, hand back and use Sign in privately, which cuts it.`)),
      h("div", { class: "gl-side-rows" }, rows.map(([a, b, on]) => h("div", { class: "gl-side-row" },
        h("span", { class: on ? "" : "muted" }, a), h("span", { class: "code" + (on ? " gl-on" : "") }, b)))),
      h("div", { class: "gl-side-top" },
        h("span", { class: "lbl" }, "When you hand back"),
        h("p", { class: "small muted" }, `${n} carries on from where it stopped and gets a note: who had the keyboard, for how long, and your note if you wrote one. Never what you typed.`)),
      h("div", { class: "gl-side-foot code" }, "⌃⏎ hands back"));
  }

  /** "T" takes over; Ctrl+Enter hands back when focus is outside the screen. */
  /** @param {KeyboardEvent} e */
  function key(e) {
    const t = /** @type {HTMLElement} */ (e.target);
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (mine() && e.key === "Enter" && e.ctrlKey && t?.tagName !== "CANVAS") { e.preventDefault(); release(); return; }
    if (!typing && !mine() && !other() && s.canTake() && (e.key === "t" || e.key === "T") && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); take(false); }
  }

  /** The box handed back after the idle time: say so where the bar was. */
  function idled(ms) {
    hooks.notice(done(`Handed back to ${s.name} after ${Math.round(Number(ms) / 60_000)} min idle.`));
  }

  return { take, release, actions, bar, banner, side, key, timer, mine, other, idled, stop: () => { clearInterval(tick); tick = 0; } };
}
