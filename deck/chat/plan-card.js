// @ts-check
// A plan to approve (docs/design/system/components/plan-card.md): Claude Code's ExitPlanMode ask,
// read by core/plan.js into a title, numbered steps, what it will not touch and the files it
// expects, then the mode it continues in (Asks first | Edits allowed) and three answers:
// Start building (primary, Cmd/Ctrl+Enter): threads.answer allow, then threads.mode with the
// chosen mode; Revise (outline, R): a line under the plan, prefilled "Change the plan: ", sent as
// a deny with that message, so the agent keeps planning with it; Keep planning (ghost): a deny
// with no note. No passkey: answering is the owner's own action (ADR 0024).
//
// Revise writes in the card, not the composer (the spec's composer prefill needs a hook in
// composer.js, native-core's): the words and Enter are the same, and the card stays open.

import { kbd } from "../js/platform.js";
import { h, put, isPhone } from "../js/dom.js";
import { attempt, queued } from "../js/api.js";
import { icon } from "../js/icons.js";
import { problemLine } from "./presence.js";
import { cardHead, keyHint, busyLabel, widthOf, fromLine } from "./ask-item.js";
import { parsePlan, planText, filesSummary, fileCounts, inlinePieces, PLAN_MODES, planModeLabel } from "./core/plan.js";

/** Steps shown on a phone before "Show all N steps". */
export const PHONE_STEPS = 4;
const REVISE_PREFIX = "Change the plan: ";
const BUSY = { start: "Starting", revise: "Sending", keep: "Declining" };

/** Inline markdown of one line (code and bold only) as nodes. @param {string} s */
function inline(s) {
  return inlinePieces(s).map(p => p.kind === "code" ? h("code", { class: "cv-plan-code" }, p.text) : p.kind === "strong" ? h("strong", null, p.text) : p.text);
}

/**
 * @param {{ id: string, tool?: string, agent?: string|null, at?: any, created_at?: any, detail?: any, thread?: string|null }} ask
 * @param {{ thread?: string|null, phone?: boolean }} [opts] thread: for threads.mode after Start building
 * @returns {HTMLElement & { update: (a: any) => void, answered: (decision: string, answers?: any, from?: { where: string, at?: number|null }|null) => void,
 *   onKey: (e: KeyboardEvent) => boolean, isOpen: () => boolean }}
 */
export function planCard(ask, opts = {}) {
  const who = ask.agent || "Vyre";
  const el = /** @type {any} */ (h("section", { class: "ask-card cv-ask cv-plan", tabindex: "0", "aria-label": "Plan to approve" }));
  el._kind = "card";
  const phone = opts.phone ?? isPhone();
  const state = {
    mode: PLAN_MODES[0].mode, busy: /** @type {string|null} */ (null), width: 0,
    decided: /** @type {"start"|"keep"|"revise"|"cancelled"|null} */ (null), error: /** @type {any} */ (null),
    modeError: /** @type {any} */ (null), revising: false, words: REVISE_PREFIX, allSteps: false, filesOpen: !phone,
    from: /** @type {{ where: string, at?: number|null }|null} */ (null),
  };
  let plan = parsePlan(planText(ask));

  /** @param {"start"|"revise"|"keep"} act */
  async function answer(act) {
    if (state.busy || state.decided) return;
    state.width = widthOf(el, act);
    state.busy = act; state.error = null; draw();
    const message = act === "revise" ? state.words.trim() : "";
    // Codex's plan is a question: the answer is the label of the button, Implement or Revise (anything else the box reads as Revise).
    const codex = /** @type {any} */ (ask).codex;
    // Through the outbox like the other cards (offline, it goes when the box is back).
    const r = await queued("threads.answer", codex
      ? { ask: ask.id, decision: "allow", surface: "deck", answers: { [codex.question]: act === "start" ? "Implement" : "Revise" } }
      : { ask: ask.id, decision: act === "start" ? "allow" : "deny", surface: "deck", ...(message ? { message } : {}) });
    if (r.error) { state.busy = null; state.error = r.error; draw(); return; }
    // Approved: the plan is answered whatever the mode call says; a failure is said, not undone.
    const thread = opts.thread ?? ask.thread;
    // Codex stays in plan mode when it is sent back: the words that change the plan go as the person's next message.
    if (codex && act === "revise" && message && thread) {
      const sent = await attempt("threads.send", { thread, text: message, surface: "deck" });
      if (sent.error) state.error = sent.error;
    }
    if (act === "start" && thread && !codex) {
      const m = await attempt("threads.mode", { thread, mode: state.mode, surface: "deck" });
      if (m.error) state.modeError = m.error;
    }
    state.busy = null;
    state.decided = act;
    draw();
  }

  function button(act, variant, label, key, keys, onclick) {
    const busy = state.busy === act;
    return h("button", { class: `btn ${variant} cv-ask-btn cv-plan-btn` + (busy ? " cv-ask-busy" : ""), type: "button", "data-act": act,
      disabled: !!state.busy, "aria-busy": busy ? "true" : null, "aria-keyshortcuts": keys,
      style: busy && state.width ? { minWidth: `${state.width}px` } : null, onclick },
    busy ? busyLabel(BUSY[act]) : [label, key ? keyHint(key) : null]);
  }

  function modes() {
    const group = h("div", { class: "cv-plan-seg", role: "radiogroup", "aria-label": "Then continue in",
      onkeydown: e => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const i = PLAN_MODES.findIndex(m => m.mode === state.mode);
        state.mode = PLAN_MODES[(i + (e.key === "ArrowRight" ? 1 : PLAN_MODES.length - 1)) % PLAN_MODES.length].mode;
        draw();
        /** @type {any} */ (el.querySelector?.(".cv-plan-seg [aria-checked=true]"))?.focus?.();
      } },
    PLAN_MODES.map(m => h("button", { class: "cv-plan-opt", type: "button", role: "radio", "aria-checked": String(m.mode === state.mode),
      tabindex: m.mode === state.mode ? "0" : "-1", "data-mode": m.mode, disabled: !!state.busy, onclick: () => { state.mode = m.mode; draw(); } }, m.label)));
    return h("div", { class: "cv-plan-then" }, h("span", { class: "cv-plan-then-l" }, "Then continue in"), group);
  }

  function steps() {
    if (!plan.steps.length) return null;
    const cut = phone && !state.allSteps && plan.steps.length > PHONE_STEPS;
    const shown = cut ? plan.steps.slice(0, PHONE_STEPS) : plan.steps;
    return [h("ol", { class: "cv-plan-steps" }, shown.map(s => h("li", null, inline(s)))),
      cut ? h("button", { class: "btn btn-ghost btn-sm cv-plan-more", type: "button", onclick: () => { state.allSteps = true; draw(); } },
        icon("chevron", 12), `Show all ${plan.steps.length} steps`) : null];
  }

  function files() {
    if (!plan.files.length) return null;
    const sum = filesSummary(plan.files);
    const rows = () => h("div", { class: "cv-plan-files" }, plan.files.map(f => h("div", { class: "cv-plan-file" },
      h("span", { class: "cv-plan-path", title: f.path }, f.path), h("span", { class: "cv-plan-counts" }, fileCounts(f)))));
    if (phone) {
      return h("div", { class: "cv-plan-fileset" },
        h("button", { class: "cv-plan-files-head", type: "button", "aria-expanded": String(state.filesOpen), onclick: () => { state.filesOpen = !state.filesOpen; draw(); } },
          h("span", null, `${sum.count} expected`), sum.totals ? h("span", { class: "cv-plan-counts" }, sum.totals) : null, icon("chevron", 12)),
        state.filesOpen ? rows() : null);
    }
    return h("div", { class: "cv-plan-fileset" },
      h("div", { class: "cv-plan-files-head" }, h("span", { class: "cv-plan-lbl" }, "Files it expects to change"),
        h("span", { class: "cv-plan-counts" }, [sum.count, sum.totals].filter(Boolean).join(" · "))),
      rows());
  }

  function draw() {
    const n = plan.steps.length;
    if (state.decided) {
      const line = state.decided === "start"
        ? [h("div", { class: "cv-plan-building" }, h("span", { class: "cv-spin", "aria-hidden": "true" }), /** @type {any} */ (ask).codex ? "Building" : `Building · ${planModeLabel(state.mode)}`),
          h("div", { class: "gate-resolved" }, icon("check", 14), `Plan approved on this screen${n ? ` · ${n} ${n === 1 ? "step" : "steps"}` : ""}`),
          state.modeError ? h("div", { class: "cv-plan-err" }, `The mode did not change: ${state.modeError.message || state.modeError.code}`) : null]
        : state.decided === "cancelled" ? [h("div", { class: "gate-resolved" }, icon("close", 14), "Withdrawn")]
        : state.decided === "revise" ? [h("div", { class: "gate-resolved" }, icon("edit", 14), "Sent back with your changes · still planning")]
        : [h("div", { class: "gate-resolved cv-plan-kept" }, icon("close", 14), "Kept planning · you declined this plan")];
      put(el, cardHead({ kind: "Plan to approve", who, at: ask.at ?? ask.created_at, open: false }), line, fromLine(state.from));
      el.classList.add("answered");
      return;
    }
    const revise = state.revising ? h("input", { class: "cv-why cv-plan-revise", type: "text", value: state.words, "aria-label": "What to change in the plan",
      oninput: e => { state.words = e.target.value; },
      onkeydown: e => {
        if (e.key === "Enter") { e.preventDefault(); if (state.words.trim() && state.words.trim() !== REVISE_PREFIX.trim()) answer("revise"); }
        else if (e.key === "Escape") { e.preventDefault(); state.revising = false; draw(); el.focus?.(); }
      } }) : null;
    put(el,
      cardHead({ kind: "Plan to approve", who, at: ask.at ?? ask.created_at, open: true }),
      h("div", { class: "cv-plan-body" },
        plan.title ? h("div", { class: "ask-title cv-plan-title" }, inline(plan.title)) : null,
        steps(),
        plan.notTouch ? h("div", { class: "cv-plan-not" }, inline(/^will not touch/i.test(plan.notTouch) ? plan.notTouch : `Will not touch ${plan.notTouch}`)) : null,
        !n && !plan.title && plan.rest ? h("div", { class: "cv-plan-rest" }, plan.rest) : null,
        files(),
        /** @type {any} */ (ask).codex ? null : modes()),
      revise ? h("div", { class: "cv-deny-row cv-plan-revise-row" }, revise,
        button("revise", "cv-always", "Send changes", null, null, () => answer("revise")),
        h("button", { class: "btn btn-ghost btn-sm", type: "button", disabled: !!state.busy, onclick: () => { state.revising = false; draw(); } }, "Back")) : null,
      h("div", { class: "gate-actions cv-ask-actions cv-plan-actions" },
        button("start", "btn-primary", "Start building", kbd("Enter"), "Meta+Enter Control+Enter", () => answer("start")),
        revise ? null : button("revise", "cv-always", "Revise", "R", "R", () => { state.revising = true; draw(); }),
        /** @type {any} */ (ask).codex ? null : button("keep", "btn-ghost", "Keep planning", null, null, () => answer("keep"))),
      state.error ? problemLine(state.error) : null);
    if (revise) { revise.focus?.(); try { revise.setSelectionRange?.(state.words.length, state.words.length); } catch {} }
  }

  el.update = a => { Object.assign(ask, a); plan = parsePlan(planText(ask)); if (!state.decided) draw(); };
  el.answered = (decision, answers, from) => {
    if (!state.decided && from) state.from = from;
    const codex = /** @type {any} */ (ask).codex;
    if (!state.decided) state.decided = codex && (decision === "allow" || decision === "always") && answers && answers[codex.question] !== "Implement" ? "revise"
      : decision === "allow" || decision === "always" ? "start" : decision === "deny" ? "keep" : "cancelled";
    state.busy = null; state.error = null; draw();
  };
  el.isOpen = () => !state.decided;
  /** A key routed here by the session (focus not in a text field). */
  el.onKey = e => {
    if (state.decided || state.busy) return false;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { answer("start"); return true; }
    if ((e.key === "r" || e.key === "R") && !state.revising && !e.metaKey && !e.ctrlKey) { state.revising = true; draw(); return true; }
    if (e.key === "Escape" && state.revising) { state.revising = false; draw(); return true; }
    return false;
  };
  draw();
  return el;
}
