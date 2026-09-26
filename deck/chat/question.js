// @ts-check
// A question ask (contract 1, kind "question": Claude Code's AskUserQuestion), as a card. One
// step per question, a stepper ("1 of 2") when there are several, then a review step, then
// Submit. Each option is a row with its label and description; multi-select rows are checkboxes.
// An "Other" row takes typed text. When options carry previews, the focused option's preview
// sits beside the list on a wide screen and under it on a phone (markdown or code, through
// lib/markdown.js, in a mono panel).
//
// Keys (routed by session.js when focus is not in the composer): 1-9 pick an option, arrow keys
// move, space toggles (multi-select) or picks, Enter picks and moves on (on the last step it
// submits), Esc steps back. Submit calls threads.answer { ask, decision: "allow", answers,
// surface: "deck" } with a passkey proof; Decline sends "deny". Answered here or elsewhere
// (ask.answered), the card folds to what was answered.

import { h, put, add } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon } from "../js/icons.js";
import { renderMarkdown } from "./lib/markdown.js";
import { problemLine } from "./presence.js";
import { emptyPick, choose, answerText, answered, answerInput } from "./lib/answers.js";

/**
 * @param {{ id: string, questions?: any[], agent?: string|null }} ask
 * @returns {HTMLElement & { update: (a: any) => void, answered: (decision: string, answers?: any) => void, onKey: (e: KeyboardEvent) => boolean, isOpen: () => boolean }}
 */
export function questionCard(ask) {
  const el = /** @type {any} */ (h("div", { class: "ask-card cv-q", tabindex: "-1" }));
  el._kind = "card";
  let questions = Array.isArray(ask.questions) ? ask.questions : [];
  let picks = questions.map(() => emptyPick());
  let cursor = questions.map(() => 0);
  const state = { step: 0, busy: false, error: /** @type {any} */ (null), decided: /** @type {string|null} */ (null), shown: /** @type {Record<string, string>|null} */ (null) };
  const who = ask.agent || "Vyre";
  const many = () => questions.length > 1;
  const reviewStep = () => questions.length; // only reached when there are several
  const onReview = () => many() && state.step === reviewStep();
  /** @type {HTMLElement|null} */ let nextBtn = null;
  /** @type {HTMLInputElement|null} */ let otherInput = null;

  function rows(i) { return questions[i].options.length + 1; } // the options, then "Other"

  function pickAt(i, row, advance) {
    const q = questions[i];
    const label = row < q.options.length ? q.options[row].label : null;
    cursor[i] = row;
    if (label == null) {
      if (!q.multiSelect || !picks[i].other) picks[i] = choose(q, picks[i], null);
      draw(); otherInput?.focus?.(); return;
    }
    picks[i] = choose(q, picks[i], label);
    if (advance && !q.multiSelect) { next(); return; }
    draw();
  }

  function next() {
    const i = state.step;
    if (!onReview() && !answered(questions[i], picks[i])) return;
    if (!many() || onReview()) { submit(); return; }
    state.step = Math.min(state.step + 1, reviewStep());
    draw(); el.focus?.();
  }
  function back() { if (state.step > 0) { state.step--; draw(); el.focus?.(); } }

  async function submit() {
    if (state.busy || state.decided) return;
    let input;
    try { input = answerInput(ask.id, questions, picks); } catch (e) { state.error = e; draw(); return; }
    state.busy = true; state.error = null; draw();
    const r = await attempt("threads.answer", input, { presence: true });
    state.busy = false;
    if (r.error) state.error = r.error; else { state.decided = "allow"; state.shown = input.answers; }
    draw();
  }
  async function decline() {
    if (state.busy || state.decided) return;
    state.busy = true; state.error = null; draw();
    const r = await attempt("threads.answer", { ask: ask.id, decision: "deny", surface: "deck" }, { presence: true });
    state.busy = false;
    if (r.error) state.error = r.error; else state.decided = "deny";
    draw();
  }

  function draw() {
    const title = h("div", { class: "gate-row" },
      h("span", { class: "ask-title" }, `${who} asks`),
      many() && !state.decided ? h("span", { class: "cv-q-step" }, onReview() ? "Review" : `${state.step + 1} of ${questions.length}`) : null);
    otherInput = null; nextBtn = null;
    if (state.decided) { put(el, title, folded()); el.classList.add("answered"); return; }
    if (!questions.length) { put(el, title, h("div", { class: "cv-note" }, "Reading the question…")); return; }
    put(el, title, onReview() ? review() : stepView(state.step), actions(), state.error ? problemLine(state.error) : null);
  }

  function folded() {
    const a = state.shown;
    const list = a && Object.keys(a).length ? h("dl", { class: "cv-q-done" }, Object.entries(a).map(([k, v]) => [h("dt", null, headerFor(k)), h("dd", null, v)])) : null;
    return [list, h("div", { class: "gate-resolved" }, icon(state.decided === "deny" ? "close" : "check", 14),
      state.decided === "deny" ? "Declined" : state.decided === "cancelled" ? "Withdrawn" : "Answered")];
  }
  const headerFor = question => { const q = questions.find(x => x.question === question); return (q && q.header) || question; };

  function stepView(i) {
    const q = questions[i];
    const pick = picks[i];
    const focusRow = cursor[i];
    const hasPreview = q.options.some(o => o.preview);
    const list = h("div", { class: "cv-q-opts", role: q.multiSelect ? "group" : "radiogroup" },
      q.options.map((o, n) => {
        const on = pick.chosen.includes(o.label);
        return h("button", { class: "cv-q-opt cv-choice" + (on ? " cv-choice-on" : "") + (n === focusRow ? " cv-focus" : ""), type: "button", role: q.multiSelect ? "checkbox" : "radio",
          "aria-checked": String(on), onclick: () => pickAt(i, n, false) },
          h("span", { class: "cv-q-num" }, n < 9 ? String(n + 1) : ""),
          h("span", { class: "cv-q-mark" + (q.multiSelect ? " cv-q-box cv-chk" + (on ? " cv-chk-on" : "") : " cv-q-dot cv-radio" + (on ? " cv-radio-on" : "")) }, on && q.multiSelect ? "✓" : ""),
          h("span", { class: "cv-q-txt" }, h("span", { class: "cv-q-label" }, o.label), o.description ? h("span", { class: "cv-q-desc" }, o.description) : null),
        );
      }),
      otherRow(i),
    );
    const preview = hasPreview ? previewPanel(q.options[Math.min(focusRow, q.options.length - 1)]) : null;
    return h("div", { class: "cv-q-q" },
      h("div", { class: "cv-q-head" }, q.header ? h("span", { class: "cv-q-chip" }, q.header) : null, h("span", { class: "cv-q-text" }, q.question),
        q.multiSelect ? h("span", { class: "cv-note" }, "Pick any") : null),
      h("div", { class: "cv-q-body" + (hasPreview ? " cv-q-has-preview" : "") }, list, preview),
    );
  }

  function otherRow(i) {
    const q = questions[i], pick = picks[i];
    const n = q.options.length;
    const row = h("button", { class: "cv-q-opt cv-choice cv-q-other" + (pick.other ? " cv-choice-on" : "") + (cursor[i] === n ? " cv-focus" : ""), type: "button", role: q.multiSelect ? "checkbox" : "radio",
      "aria-checked": String(pick.other), onclick: () => pickAt(i, n, false) },
      h("span", { class: "cv-q-num" }, n < 9 ? String(n + 1) : ""),
      h("span", { class: "cv-q-mark" + (q.multiSelect ? " cv-q-box cv-chk" + (pick.other ? " cv-chk-on" : "") : " cv-q-dot cv-radio" + (pick.other ? " cv-radio-on" : "")) }, pick.other && q.multiSelect ? "✓" : ""),
      h("span", { class: "cv-q-txt" }, h("span", { class: "cv-q-label" }, "Other")));
    if (!pick.other) return row;
    otherInput = /** @type {any} */ (h("input", { class: "cv-q-input", type: "text", placeholder: "Type your answer", value: pick.text,
      oninput: e => { picks[i] = { ...picks[i], text: e.target.value }; if (nextBtn) /** @type {any} */ (nextBtn).disabled = !answered(q, picks[i]); },
      onkeydown: e => {
        if (e.key === "Enter") { e.preventDefault(); next(); }
        else if (e.key === "Escape") { e.preventDefault(); el.focus?.(); }
      } }));
    return h("div", { class: "cv-q-other-wrap" }, row, otherInput);
  }

  function previewPanel(o) {
    const panel = h("div", { class: "cv-q-preview msg-text" });
    if (o && o.preview) add(panel, renderMarkdown(o.preview)); else add(panel, h("span", { class: "cv-note" }, "No preview"));
    return panel;
  }

  function review() {
    return h("dl", { class: "cv-q-review" }, questions.map((q, i) => [
      h("dt", null, q.header || q.question),
      h("dd", null, answerText(q, picks[i]) || "(no answer)", " ", h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => { state.step = i; draw(); } }, "Change")),
    ]));
  }

  function actions() {
    const last = !many() || onReview();
    const ready = onReview() ? questions.every((q, i) => answered(q, picks[i])) : answered(questions[state.step], picks[state.step]);
    nextBtn = h("button", { class: "btn btn-primary", disabled: state.busy || !ready, onclick: next },
      last ? "Submit" : state.step === questions.length - 1 ? "Review" : "Next", h("span", { class: "kbd" }, "⏎"));
    return h("div", { class: "gate-actions" },
      nextBtn,
      state.step > 0 ? h("button", { class: "btn btn-ghost", disabled: state.busy, onclick: back }, "Back") : null,
      h("button", { class: "btn btn-ghost", disabled: state.busy, onclick: decline }, "Decline"),
    );
  }

  el.update = a => {
    Object.assign(ask, a);
    if (Array.isArray(a.questions) && a.questions.length) {
      // A fuller copy (threads.asks has the previews the event dropped): keep what was picked.
      const had = questions;
      questions = a.questions;
      picks = questions.map((q, i) => (had[i] && had[i].question === q.question ? picks[i] : emptyPick()));
      cursor = questions.map((_, i) => cursor[i] || 0);
    }
    if (!state.decided) draw();
  };
  el.answered = (decision, answers) => {
    state.busy = false; state.error = null;
    state.decided = decision === "allow" || decision === "always" ? "allow" : decision === "deny" ? "deny" : "cancelled";
    if (answers && typeof answers === "object" && !Array.isArray(answers)) state.shown = answers;
    else if (!state.shown && state.decided === "allow") { try { state.shown = answerInput(ask.id, questions, picks).answers; } catch { state.shown = null; } }
    draw();
  };
  el.isOpen = () => !state.decided;
  el.onKey = e => {
    if (state.decided || state.busy || !questions.length) return false;
    if (e.key === "Escape") { back(); return true; }
    if (onReview()) { if (e.key === "Enter") { submit(); return true; } return false; }
    const i = state.step, q = questions[i];
    if (/^[1-9]$/.test(e.key)) { const n = Number(e.key) - 1; if (n < rows(i)) { pickAt(i, n, true); return true; } return false; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { cursor[i] = (cursor[i] + (e.key === "ArrowDown" ? 1 : rows(i) - 1)) % rows(i); draw(); return true; }
    if (e.key === " ") { pickAt(i, cursor[i], false); return true; }
    if (e.key === "Enter") {
      if (!q.multiSelect && !answered(q, picks[i])) { pickAt(i, cursor[i], true); return true; }
      next(); return true;
    }
    return false;
  };
  draw();
  return el;
}
