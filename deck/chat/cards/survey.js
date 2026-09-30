// @ts-check
// A survey ask (ask.raised kind "survey"; question-card.md's Survey variant): several questions in
// one flow, each with a recommended option, an always-visible thoughts box and a progress bar in
// the header. It is question.js's card with three additions and one difference:
//   - Recommended: one option per question may carry `recommended: true`. A small tag on that row,
//     never picked for the person, at most one per question (the first wins).
//   - Thoughts: an optional multi-line box under the choices (above Other), always shown (Option A,
//     app-design.md 10.7). It rides with that question's answer and is additional to a picked choice.
//   - Progress: a bar (questions answered of the total) beside the exact "2 of 4" text.
//   - One batch: Submit is only reached after the review step, and sends every answer and every
//     thought in one threads.answer { ask, decision: "allow", answers, thoughts, surface: "deck" }
//     (no passkey, ADR 0024). `thoughts` is { [question text]: text } with only the boxes that were
//     filled, and is left out when none were. Decline sends "deny".
// Keys are question.js's (1-9 pick, arrows move, space toggles, Enter picks and moves on, Esc steps
// back) and are left alone while focus is in the thoughts box or the Other field. Answered here or
// elsewhere (.answered), the card folds to what was answered, with the thoughts under each answer.
//
// isSurvey(ask) says whether an ask should draw as this card even when its kind is "question":
// `survey: true`, or any question with a recommended option or a `thoughts` field. session.js can
// use it to choose surveyCard over questionCard.

import { h, put } from "../../js/dom.js";
import { queued } from "../../js/api.js";
import { icon } from "../../js/icons.js";
import { problemLine, macHeld, macLabel, macProblem } from "../presence.js";
import { fromLine, cardHead, keyHint, busyLabel, widthOf } from "../ask-item.js";
import { emptyPick, choose, answerText, answered, answerInput } from "../lib/answers.js";
import { ensureCss } from "./kit.js";

/** Whether an ask (of kind survey or a plain question) should draw as a survey. @param {any} ask */
export function isSurvey(ask) {
  if (!ask) return false;
  if (ask.kind === "survey" || ask.survey === true) return true;
  const qs = Array.isArray(ask.questions) ? ask.questions : [];
  return qs.some((/** @type {any} */ q) => typeof q?.thoughts === "string" || q?.thoughts === true || (q?.options || []).some((/** @type {any} */ o) => o?.recommended === true));
}

/** The row that carries the Recommended tag: the first flagged option, so never two. @param {any} q */
export const recommendedRow = q => (q.options || []).findIndex((/** @type {any} */ o) => o && o.recommended === true);

/** The thoughts map for threads.answer: only the questions whose box has words. @param {any[]} questions @param {string[]} thoughts */
export function thoughtsMap(questions, thoughts) {
  /** @type {Record<string, string>} */
  const out = {};
  questions.forEach((q, i) => { const t = String(thoughts[i] || "").trim(); if (t) out[q.question] = t; });
  return out;
}

/**
 * @param {any} ask { id, questions, agent?, machine?, elsewhere?, at? }
 * @param {any} [ctx]
 * @returns {HTMLElement & { update: (a: any) => void, answered: (decision: string, answers?: any, from?: { where: string, at?: number|null }|null) => void,
 *   onKey: (e: KeyboardEvent) => boolean, isOpen: () => boolean }}
 */
export function surveyCard(ask, ctx = {}) {
  ensureCss("survey");
  const who = ask.agent || ctx.agent || "Vyre";
  const el = /** @type {any} */ (h("section", { class: "ask-card cv-q cv-survey", tabindex: "0", "aria-label": `Survey from ${who}` }));
  el._kind = "card";
  let questions = Array.isArray(ask.questions) ? ask.questions : [];
  const seed = () => questions.map(q => (typeof q.thoughts === "string" ? q.thoughts : ""));
  let picks = questions.map(() => emptyPick());
  let cursor = questions.map(() => 0);
  let thoughts = seed();
  const state = { step: 0, busy: /** @type {"submit"|"decline"|null} */ (null), width: 0, error: /** @type {any} */ (null), decided: /** @type {string|null} */ (null),
    shown: /** @type {Record<string, string>|null} */ (null), said: /** @type {Record<string, string>|null} */ (null),
    from: /** @type {{ where: string, at?: number|null }|null} */ (null), again: /** @type {(o: { presence?: boolean }) => void} */ (() => {}) };
  const many = () => questions.length > 1;
  const reviewStep = () => questions.length;
  const onReview = () => many() && state.step === reviewStep();
  /** @type {HTMLElement|null} */ let nextBtn = null;
  /** @type {HTMLInputElement|null} */ let otherInput = null;

  const rows = (/** @type {number} */ i) => questions[i].options.length + 1; // the options, then "Other"
  const done = () => questions.filter((q, i) => answered(q, picks[i])).length;

  function pickAt(/** @type {number} */ i, /** @type {number} */ row, /** @type {boolean} */ advance) {
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

  const onMac = () => (ask.machine ? { machine: ask.machine } : {});
  const presence = (/** @type {{ presence?: boolean }} */ o) => ({ presence: o.presence ? true : ask.machine ? false : undefined });
  /** @param {{ presence?: boolean }} [opts] */
  async function submit(opts = {}) {
    if (state.busy || state.decided) return;
    let input;
    try {
      const said = thoughtsMap(questions, thoughts);
      input = { ...answerInput(ask.id, questions, picks), ...(Object.keys(said).length ? { thoughts: said } : {}), ...onMac() };
    } catch (e) { state.error = e; draw(); return; }
    state.width = widthOf(el, "submit");
    state.busy = "submit"; state.error = null; draw();
    const r = await queued("threads.answer", input, presence(opts));
    state.busy = null;
    if (!r.error) { state.decided = "allow"; state.shown = input.answers; state.said = input.thoughts || null; }
    else failed(r.error, o => submit({ ...opts, ...o }));
    draw();
  }
  /** @param {{ presence?: boolean }} [opts] */
  async function decline(opts = {}) {
    if (state.busy || state.decided) return;
    state.width = widthOf(el, "decline");
    state.busy = "decline"; state.error = null; draw();
    const r = await queued("threads.answer", { ask: ask.id, decision: "deny", surface: "deck", ...onMac() }, presence(opts));
    state.busy = null;
    if (!r.error) state.decided = "deny";
    else failed(r.error, o => decline({ ...opts, ...o }));
    draw();
  }
  function failed(/** @type {any} */ err, /** @type {any} */ again) { if (!macHeld(ask, err)) { state.error = err; state.again = again; } }
  const problem = () => state.error ? (ask.machine ? macProblem(state.error, ask.machine, ask, state.again) : problemLine(state.error)) : null;

  /** The header's bar: answered of total, beside the exact step text in the header row. */
  function progress() {
    const total = questions.length, n = done();
    return h("div", { class: "cv-sv-progress", role: "progressbar", "aria-label": "Questions answered", "aria-valuemin": 0, "aria-valuemax": total, "aria-valuenow": n },
      h("div", { class: "cv-sv-track" }, h("div", { class: "cv-sv-fill", style: { width: `${total ? Math.round((n / total) * 100) : 0}%` } })));
  }

  function draw() {
    const q0 = questions[state.step];
    const title = cardHead({ kind: "Question", who, at: ask.at ?? ask.created_at, open: !state.decided,
      mac: ask.machine && !ask.elsewhere ? macLabel(ask.machine) : null,
      extra: [many() && !state.decided ? h("span", { class: "cv-q-step" }, onReview() ? "Review" : `${state.step + 1} of ${questions.length}`) : null,
        q0 && q0.header && !onReview() && !ask.elsewhere ? h("span", { class: "cv-q-chip" }, q0.header) : null] });
    otherInput = null; nextBtn = null;
    if (state.decided) { put(el, title, folded()); el.classList.add("answered"); return; }
    if (!questions.length) { put(el, title, h("div", { class: "cv-note" }, "Reading the questions…")); return; }
    if (ask.elsewhere) {
      put(el, title, h("dl", { class: "cv-q-review" }, questions.map(q => [h("dt", null, q.header || q.question), h("dd", null, q.options.map((/** @type {any} */ o) => o.label).join(" / "))])),
        h("div", { class: "cv-elsewhere" }, icon("laptop", 12), `Answer it on ${ask.elsewhere}`));
      return;
    }
    put(el, title, many() ? progress() : null, onReview() ? review() : stepView(state.step), actions(), problem());
  }

  function folded() {
    const a = state.shown;
    const say = state.said || {};
    const list = a && Object.keys(a).length ? h("dl", { class: "cv-q-done" }, Object.entries(a).map(([k, v]) => [
      h("dt", null, headerFor(k)), h("dd", null, v, say[k] ? h("span", { class: "cv-sv-said" }, say[k]) : null)])) : null;
    return [list, h("div", { class: "gate-resolved" }, icon(state.decided === "deny" ? "close" : "check", 14),
      state.decided === "deny" ? "Declined" : state.decided === "cancelled" ? "Withdrawn" : "Answered"), fromLine(state.from)];
  }
  const headerFor = (/** @type {string} */ question) => { const q = questions.find(x => x.question === question); return (q && q.header) || question; };

  function stepView(/** @type {number} */ i) {
    const q = questions[i], pick = picks[i], focusRow = cursor[i];
    const qid = `${ask.id}-q${i}`;
    const rec = recommendedRow(q);
    const list = h("div", { class: "cv-q-opts", role: q.multiSelect ? "group" : "radiogroup", "aria-labelledby": `${qid}-text` },
      q.options.map((/** @type {any} */ o, /** @type {number} */ n) => {
        const on = pick.chosen.includes(o.label);
        const desc = o.description ? `${qid}-d${n}` : null;
        return h("button", { class: "cv-q-opt cv-choice" + (on ? " cv-choice-on" : "") + (n === focusRow ? " cv-focus" : ""), type: "button", role: q.multiSelect ? "checkbox" : "radio",
          "aria-checked": String(on), "aria-describedby": desc, "aria-keyshortcuts": n < 9 ? String(n + 1) : null, onclick: () => pickAt(i, n, false) },
          mark(q, on),
          h("span", { class: "cv-q-txt" }, h("span", { class: "cv-q-label" }, o.label), desc ? h("span", { class: "cv-q-desc", id: desc }, o.description) : null),
          n === rec ? h("span", { class: "tag cv-sv-rec" }, "Recommended") : null,
          numChip(n));
      }));
    return h("div", { class: "cv-q-q" },
      h("div", { class: "cv-q-head" }, h("span", { class: "cv-q-text", id: `${qid}-text` }, q.question), q.multiSelect ? h("span", { class: "cv-note" }, "Pick any") : null),
      h("div", { class: "cv-q-body" }, list, thoughtsBox(i), otherRow(i)));
  }

  function mark(/** @type {any} */ q, /** @type {boolean} */ on) {
    return h("span", { class: "cv-q-mark" + (q.multiSelect ? " cv-q-box cv-chk" + (on ? " cv-chk-on" : "") : " cv-q-dot cv-radio" + (on ? " cv-radio-on" : "")), "aria-hidden": "true" }, on && q.multiSelect ? "✓" : "");
  }
  const numChip = (/** @type {number} */ n) => n < 9 ? h("span", { class: "kbd cv-q-num", "aria-hidden": "true" }, String(n + 1)) : null;

  /** The thoughts box: always there, optional, its own words per question. */
  function thoughtsBox(/** @type {number} */ i) {
    return h("div", { class: "cv-sv-thoughts" }, h("textarea", { class: "cv-sv-box", rows: 2, placeholder: "Add your thoughts (optional)", "aria-label": `Your thoughts on: ${questions[i].question}`,
      value: thoughts[i] || "",
      oninput: (/** @type {any} */ e) => { thoughts[i] = e.target.value; },
      onkeydown: (/** @type {any} */ e) => {
        if (e.key === "Escape") { e.preventDefault(); el.focus?.(); }
        else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); next(); }
      } }));
  }

  function otherRow(/** @type {number} */ i) {
    const q = questions[i], pick = picks[i], n = q.options.length;
    const row = h("button", { class: "cv-q-opt cv-choice cv-q-other" + (pick.other ? " cv-choice-on" : "") + (cursor[i] === n ? " cv-focus" : ""), type: "button", role: q.multiSelect ? "checkbox" : "radio",
      "aria-checked": String(pick.other), "aria-keyshortcuts": n < 9 ? String(n + 1) : null, onclick: () => pickAt(i, n, false) },
      mark(q, pick.other), h("span", { class: "cv-q-txt" }, h("span", { class: "cv-q-label" }, "Other")), numChip(n));
    if (!pick.other) return row;
    otherInput = /** @type {any} */ (h("input", { class: "cv-q-input", type: "text", placeholder: "Type your answer", value: pick.text,
      oninput: (/** @type {any} */ e) => { picks[i] = { ...picks[i], text: e.target.value }; if (nextBtn) /** @type {any} */ (nextBtn).disabled = !answered(q, picks[i]); },
      onkeydown: (/** @type {any} */ e) => {
        if (e.key === "Enter") { e.preventDefault(); next(); }
        else if (e.key === "Escape") { e.preventDefault(); el.focus?.(); }
      } }));
    return h("div", { class: "cv-q-other-wrap" }, row, otherInput);
  }

  function review() {
    return h("dl", { class: "cv-q-review" }, questions.map((q, i) => [
      h("dt", null, q.header || q.question),
      h("dd", null, answerText(q, picks[i]) || "(no answer)", " ", h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => { state.step = i; draw(); } }, "Change"),
        String(thoughts[i] || "").trim() ? h("span", { class: "cv-sv-said" }, String(thoughts[i]).trim()) : null),
    ]));
  }

  function actions() {
    const last = !many() || onReview();
    const ready = onReview() ? questions.every((q, i) => answered(q, picks[i])) : answered(questions[state.step], picks[state.step]);
    const sending = state.busy === "submit", declining = state.busy === "decline";
    const keep = (/** @type {boolean} */ on) => (on && state.width ? { minWidth: `${state.width}px` } : null);
    nextBtn = h("button", { class: "btn btn-primary cv-ask-btn" + (sending ? " cv-ask-busy" : ""), type: "button", "data-act": "submit",
      disabled: !!state.busy || !ready, "aria-busy": sending ? "true" : null, "aria-keyshortcuts": "Enter", style: keep(sending), onclick: next },
    sending ? busyLabel("Sending") : [last ? "Submit" : state.step === questions.length - 1 ? "Review" : "Next", keyHint("⏎")]);
    return h("div", { class: "gate-actions cv-q-actions" },
      nextBtn,
      state.step > 0 ? h("button", { class: "btn btn-ghost", type: "button", disabled: !!state.busy, onclick: back }, "Back") : null,
      h("button", { class: "btn btn-ghost cv-ask-btn" + (declining ? " cv-ask-busy" : ""), type: "button", "data-act": "decline", disabled: !!state.busy,
        "aria-busy": declining ? "true" : null, style: keep(declining), onclick: () => decline() }, declining ? busyLabel("Declining") : "Decline"));
  }

  el.update = (/** @type {any} */ a) => {
    Object.assign(ask, a);
    if (Array.isArray(a.questions) && a.questions.length) {
      // A fuller copy: keep what was picked and written for a question that is still there.
      const had = questions, hadThoughts = thoughts;
      questions = a.questions;
      picks = questions.map((q, i) => (had[i] && had[i].question === q.question ? picks[i] : emptyPick()));
      thoughts = questions.map((q, i) => (had[i] && had[i].question === q.question ? hadThoughts[i] : typeof q.thoughts === "string" ? q.thoughts : ""));
      cursor = questions.map((_, i) => cursor[i] || 0);
    }
    if (!state.decided) draw();
  };
  el.answered = (decision, answers, from) => {
    if (!state.decided && from) state.from = from;
    state.busy = null; state.error = null;
    state.decided = decision === "allow" || decision === "always" ? "allow" : decision === "deny" ? "deny" : "cancelled";
    if (answers && typeof answers === "object" && !Array.isArray(answers)) state.shown = answers;
    else if (!state.shown && state.decided === "allow") { try { state.shown = answerInput(ask.id, questions, picks).answers; } catch { state.shown = null; } }
    if (!state.said && state.decided === "allow") { const s = thoughtsMap(questions, thoughts); state.said = Object.keys(s).length ? s : null; }
    draw();
  };
  el.isOpen = () => !state.decided && !ask.elsewhere;
  el.onKey = (/** @type {any} */ e) => {
    if (state.decided || state.busy || !questions.length || ask.elsewhere) return false;
    const tag = String(globalThis.document?.activeElement?.tagName || "");
    if (tag === "TEXTAREA" || tag === "INPUT") return false; // typing in the thoughts box or Other
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
