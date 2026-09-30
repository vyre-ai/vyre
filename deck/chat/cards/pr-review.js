// @ts-check
// The PR review card (docs/design/system/components/pr-review.md): a pull request's summary, checks,
// files (diff-files.js) and review comments, with Approve and merge in the footer. Two ways in,
// one card:
//   display   render {kind: "pr_review", pr, title, branch: {from, to}, summary, checks, files,
//             comments, state}: nothing waits on it. The footer still acts.
//   ask       ask.raised kind "pr_review" (an `id`, and the same fields at the top or in `detail`):
//             the agent asks the person to review. The card also answers the ask (threads.answer):
//             a merge is allow, a change request or comment is deny with the note, so the agent
//             hears what happened.
// Approve and merge is `github.project.pr.merge`; Request changes and Comment are `github.project.pr.review` with the GitHub
// review event (REQUEST_CHANGES, COMMENT). All go through the outbox, so offline reads "Approving
// · sends when back online". No agent path: only a person's click or key acts (a script-made
// event, isTrusted false, is ignored), and update() only redraws. A collaborator's comment is
// outside text: collapsed unless it anchors to a file that is already open, text nodes only.
// Lumen's compact form reads data-compact (title, branch, checks, state) off the card.

import { kbd } from "../../js/platform.js";
import { h, put, isPhone } from "../../js/dom.js";
import { queued } from "../../js/api.js";
import { icon } from "../../js/icons.js";
import { since } from "../../js/fmt.js";
import { busyLabel, keyHint, widthOf, fromLine } from "../ask-item.js";
import { ensureCss, shell, head, chip, untrusted, problemText } from "./kit.js";
import { fileList } from "./diff-files.js";

const RUNNING = new Set(["running", "pending", "queued", "in_progress", "waiting", "requested"]);
const FAILED = new Set(["failed", "failure", "error", "timed_out", "cancelled", "action_required"]);
/** Comment authors that are not outside text: the person and their own agents. */
const OWN = new Set(["person", "you", "agent"]);
const SUMMARY_LONG = 220;

/** A check's state as one of running, failed or done. @param {any} c @returns {"running"|"failed"|"done"} */
export function checkState(c) {
  const s = String(c?.state ?? c?.status ?? c?.conclusion ?? "").toLowerCase();
  return RUNNING.has(s) ? "running" : FAILED.has(s) ? "failed" : "done";
}
const CHECK_WORD = { running: "running", failed: "failed", done: "passed" };

/** The card's fields out of a display payload or an ask (fields at the top, or in `detail`). @param {any} d */
function fields(d) {
  const x = d || {};
  const src = x.render && typeof x.render === "object" ? x.render
    : x.detail && typeof x.detail === "object" && (x.detail.pr != null || x.detail.title) ? x.detail : x;
  const st = String(src.state ?? "open").toLowerCase();
  return {
    ask: typeof x.id === "string" && x.id ? x.id : null,
    agent: x.agent || null,
    pr: src.pr ?? src.number ?? null, repo: src.repo || null, project: src.project ?? x.project ?? null,
    title: String(src.title ?? ""), summary: String(src.summary ?? src.body ?? ""),
    from: src.branch?.from ?? "", to: src.branch?.to ?? "",
    checks: Array.isArray(src.checks) ? src.checks.filter((/** @type {any} */ c) => c && c.name) : [],
    files: Array.isArray(src.files) ? src.files : [],
    comments: Array.isArray(src.comments) ? src.comments.filter((/** @type {any} */ c) => c && c.text != null) : [],
    state: /** @type {"open"|"merged"|"closed"} */ (st === "merged" || st === "closed" ? st : "open"),
    mergedBy: src.merged_by ?? null, mergedAt: src.merged_at ?? null,
  };
}

const ago = (/** @type {any} */ t) => {
  const ms = Number(new Date(t));
  if (!Number.isFinite(ms)) return "";
  return Date.now() - ms < 60_000 ? "just now" : `${since(ms)} ago`;
};

/**
 * @param {any} data a render payload, or an ask of kind "pr_review"
 * @param {{ thread?: string|null, phone?: boolean, agent?: string|null, open?: (href: string) => void, readOnly?: boolean }} [ctx]
 * @returns {HTMLElement & { update: (d: any) => void, answered: (decision: string, answers?: any, from?: { where: string, at?: number|null }|null) => void,
 *   onKey: (e: KeyboardEvent) => boolean, isOpen: () => boolean }}
 */
export function prReview(data, ctx = {}) {
  ensureCss("pr-review");
  ensureCss("diff-files");
  const el = /** @type {any} */ (shell("cv-pr-review", "Pull request"));
  el.setAttribute("tabindex", "0");
  const phone = ctx.phone ?? isPhone();
  let n = fields(data);
  const state = {
    busy: /** @type {"merge"|"changes"|"comment"|null} */ (null), waiting: false, error: /** @type {any} */ (null),
    note: /** @type {"changes"|"comment"|null} */ (null), words: "", replyTo: /** @type {any} */ (null),
    merged: false, decided: /** @type {"merged"|"changes"|"comment"|"other"|null} */ (null), sent: /** @type {string|null} */ (null),
    last: /** @type {any} */ (null), from: /** @type {{ where: string, at?: number|null }|null} */ (null),
    summaryOpen: false, logs: new Set(), shown: new Set(), width: 0, word: "",
  };
  /** @type {any} */ let files = null;
  const commentsEl = h("div", { class: "cv-prr-comments" });
  const footEl = h("div", { class: "cv-prr-foot" });

  const human = (/** @type {any} */ e) => !(e && e.isTrusted === false);
  const prState = () => state.merged ? "merged" : n.state;
  const checkStates = () => n.checks.map(checkState);
  const waitingOnChecks = () => checkStates().includes("running");
  const anyFailed = () => checkStates().includes("failed");
  const canMerge = () => prState() === "open" && !state.busy && !state.decided && !waitingOnChecks();
  const mergeLabel = () => waitingOnChecks() ? "Waiting on checks" : anyFailed() ? "Approve and merge anyway" : "Approve and merge";

  function base() {
    // github's contract (CHAT.md 09:10): the project and the PR number, no repo field.
    return { project: n.project || ctx.project || undefined, pr: n.pr };
  }

  /** One action: the PR call, then (an ask) the answer. A retry skips what already went through. @param {"merge"|"changes"|"comment"} act @param {any} [again] */
  async function run(act, again) {
    if (ctx.readOnly || state.busy || state.decided || prState() !== "open") return;
    const job = again || { act, note: state.words.trim(), replyTo: state.replyTo, prDone: false };
    if (act !== "merge" && !job.note) return;
    state.width = widthOf(el, "merge");
    state.busy = act; state.waiting = false; state.error = null; state.last = job; state.sent = null;
    drawFoot();
    if (!job.prDone) {
      const onWait = () => { state.waiting = true; drawFoot(); };
      const r = act === "merge" ? await queued("github.project.pr.merge", base(), { onWait })
        : await queued("github.project.pr.review", { ...base(), event: act === "changes" ? "REQUEST_CHANGES" : "COMMENT", body: job.note,
          ...(job.replyTo?.id != null ? { in_reply_to: job.replyTo.id } : {}) }, { onWait });
      if (r.error) { state.busy = null; state.waiting = false; state.error = r.error; drawFoot(); return; }
      job.prDone = true;
    }
    if (n.ask) {
      const r = await queued("threads.answer", { ask: n.ask, decision: act === "merge" ? "allow" : "deny", surface: "deck",
        ...(act === "merge" ? {} : { message: job.note }) });
      if (r.error) { state.busy = null; state.waiting = false; state.error = r.error; drawFoot(); return; }
    }
    state.busy = null; state.waiting = false; state.last = null;
    state.note = null; state.words = ""; state.replyTo = null;
    if (act === "merge") { state.merged = true; state.decided = n.ask ? "merged" : null; }
    else if (act === "changes") { state.sent = "changes"; state.decided = "changes"; }
    else { state.sent = "comment"; state.decided = n.ask ? "comment" : null; }
    draw();
  }

  function openNote(/** @type {"changes"|"comment"} */ kind, replyTo = null) {
    if (state.busy || state.decided) return;
    state.note = kind; state.replyTo = replyTo; state.error = null;
    state.words = replyTo ? `Re ${replyTo.path ? replyTo.path + (replyTo.line != null ? ":" + replyTo.line : "") : "your comment"}: ` : "";
    drawFoot();
  }

  // ---- header, summary, checks -----------------------------------------------------------------

  function summary() {
    const long = n.summary.length > SUMMARY_LONG || n.summary.split("\n").length > 3;
    if (!n.summary) return null;
    return h("div", { class: "cv-prr-summary-wrap" },
      h("div", { class: "cv-prr-summary" + (long && !state.summaryOpen ? " clamp" : "") }, n.summary),
      long ? h("button", { class: "cv-prr-steplink", type: "button", "aria-expanded": String(state.summaryOpen),
        onclick: () => { state.summaryOpen = !state.summaryOpen; draw(); } }, state.summaryOpen ? "Show less" : "Show more") : null);
  }

  function checks() {
    if (!n.checks.length) return null;
    const failedOpen = n.checks.filter(c => checkState(c) === "failed" && c.log && state.logs.has(c.name));
    return h("div", { class: "cv-prr-checks-wrap" },
      h("div", { class: "cv-prr-checks", role: "list", "aria-label": "Checks" }, n.checks.map(c => {
        const s = checkState(c);
        const tappable = s === "failed" && c.log;
        const chipEl = /** @type {any} */ (chip(s === "done" ? "done" : s, String(c.name), {
          title: `${c.name}: ${CHECK_WORD[s]}`,
          onclick: tappable ? () => { state.logs.has(c.name) ? state.logs.delete(c.name) : state.logs.add(c.name); draw(); } : undefined }));
        chipEl.setAttribute("role", "listitem");
        chipEl.setAttribute("data-check", String(c.name));
        chipEl.setAttribute("data-state", s);
        if (tappable) chipEl.setAttribute("aria-expanded", String(state.logs.has(c.name)));
        chipEl.append(h("span", { class: "cv-sr" }, `, ${CHECK_WORD[s]}`));
        return chipEl;
      })),
      failedOpen.map(c => h("pre", { class: "cv-prr-log", "data-log": String(c.name) }, untrusted(c.log, 2000))));
  }

  // ---- comments --------------------------------------------------------------------------------

  const anchor = (/** @type {any} */ c) => c.path ? `${c.path}${c.line != null ? ":" + c.line : ""}` : "";

  function drawComments() {
    const list = n.comments;
    put(commentsEl, list.map((c, i) => {
      const own = OWN.has(String(c.by ?? ""));
      const key = String(c.id ?? i);
      const byFile = !own && !!c.path && !!files?.isOpen(c.path);
      const manual = state.shown.has(key);
      const visible = own || byFile || manual;
      const name = String(c.author ?? (own ? "You" : "Someone"));
      return h("div", { class: "cv-prr-comment" + (own ? "" : " outside") + (visible ? "" : " folded"), "data-comment": key },
        h("span", { class: "cv-prr-av", "aria-hidden": "true" }, name.trim().charAt(0).toUpperCase() || "?"),
        h("div", { class: "cv-prr-cbody" },
          h("div", { class: "cv-prr-chead" },
            h("span", { class: "cv-prr-cname" }, name),
            own ? null : h("span", { class: "tag cv-prr-tag" }, "Collaborator"),
            anchor(c) ? h("span", { class: "cv-prr-anchor" }, anchor(c)) : null),
          visible ? h("div", { class: "cv-prr-ctext" }, untrusted(c.text, 2000)) : null,
          h("div", { class: "cv-prr-cacts" },
            !visible ? h("button", { class: "cv-prr-steplink", type: "button", "aria-expanded": "false",
              onclick: () => { state.shown.add(key); drawComments(); } }, "Show comment") : null,
            visible && manual && !own && !byFile ? h("button", { class: "cv-prr-steplink", type: "button", "aria-expanded": "true",
              onclick: () => { state.shown.delete(key); drawComments(); } }, "Hide comment") : null,
            visible && prState() === "open" && !state.decided ? h("button", { class: "cv-prr-steplink", type: "button", "data-act": "reply",
              onclick: (/** @type {any} */ e) => { if (human(e)) openNote("comment", c); } }, "Reply") : null)));
    }));
  }

  // ---- footer ----------------------------------------------------------------------------------

  function resolvedLine() {
    const s = prState();
    if (s === "merged") {
      const by = state.merged ? "you" : (n.mergedBy || null);
      const t = state.merged ? "just now" : (n.mergedAt ? ago(n.mergedAt) : "");
      return h("div", { class: "cv-prr-resolved" }, icon("check", 14),
        `Merged into ${n.to || "the base branch"}${by ? ` by ${by}` : ""}${t ? ` · ${t}` : ""}`);
    }
    if (s === "closed") return h("div", { class: "cv-prr-resolved" }, icon("close", 14), "Closed, not merged");
    if (state.decided === "changes") return h("div", { class: "cv-prr-resolved" }, icon("edit", 14), "Changes requested");
    if (state.decided === "comment") return h("div", { class: "cv-prr-resolved" }, icon("chat", 14), "Comment sent");
    return h("div", { class: "cv-prr-resolved" }, icon("check", 14), state.word || "Answered on another screen");
  }

  function button(act, variant, label, opts = {}) {
    const busy = state.busy === act && (act === "merge" || !state.note);
    return h("button", { class: `btn ${variant} cv-prr-btn` + (busy ? " cv-prr-busy" : ""), type: "button", "data-act": act,
      disabled: !!state.busy || !!opts.disabled, title: opts.title || null, "aria-busy": busy ? "true" : null, "aria-keyshortcuts": opts.keys || null,
      style: busy && state.width ? { minWidth: `${state.width}px` } : null, onclick: (/** @type {any} */ e) => { if (human(e)) opts.go?.(); } },
    busy ? busyLabel(act === "merge" ? "Merging" : "Sending") : [label, opts.key ? keyHint(opts.key) : null]);
  }

  function drawFoot() {
    const s = prState();
    if (s !== "open" || state.decided) {
      put(footEl, resolvedLine(), state.decided && !state.merged ? fromLine(state.from) : null, state.error ? errorLine() : null);
      footEl.classList.add("resolved");
      return;
    }
    if (ctx.readOnly) { put(footEl, h("div", { class: "cv-prr-resolved" }, "Shown for reading only. Open the pull request on GitHub to act on it.")); footEl.classList.add("resolved"); return; }
    footEl.classList.remove("resolved");
    const noteRow = state.note ? h("div", { class: "cv-prr-note" },
      h("input", { class: "cv-why cv-prr-field", type: "text", value: state.words, "data-note": state.note, disabled: !!state.busy,
        placeholder: state.note === "changes" ? "What should change?" : "Write a comment",
        "aria-label": state.note === "changes" ? "What should change" : "Comment",
        oninput: (/** @type {any} */ e) => { state.words = e.target.value; },
        onkeydown: (/** @type {any} */ e) => {
          if (e.key === "Enter") { e.preventDefault(); if (human(e) && state.words.trim()) run(/** @type {any} */ (state.note)); }
          else if (e.key === "Escape") { e.preventDefault(); state.note = null; state.replyTo = null; drawFoot(); el.focus?.(); }
        } }),
      h("button", { class: "btn btn-primary cv-prr-btn" + (state.busy ? " cv-prr-busy" : ""), type: "button", "data-act": "send", disabled: !!state.busy,
        "aria-busy": state.busy ? "true" : null,
        onclick: (/** @type {any} */ e) => { if (human(e) && state.words.trim()) run(/** @type {any} */ (state.note)); } },
      state.busy ? busyLabel("Sending") : "Send"),
      h("button", { class: "btn btn-ghost", type: "button", disabled: !!state.busy, onclick: () => { state.note = null; state.replyTo = null; drawFoot(); } }, "Back")) : null;
    const wait = waitingOnChecks();
    put(footEl,
      noteRow,
      h("div", { class: "cv-prr-actions" },
        button("merge", "btn-primary", mergeLabel(), { key: wait ? null : kbd("Enter"), keys: "Meta+Enter Control+Enter", disabled: wait, title: wait ? "Waiting on checks" : null,
          go: () => run("merge") }),
        button("changes", "cv-prr-outline", "Request changes", { go: () => openNote("changes") }),
        button("comment", "btn-ghost", "Comment", { go: () => openNote("comment") })),
      state.sent === "comment" ? h("div", { class: "cv-prr-sent" }, icon("check", 14), "Comment sent") : null,
      state.waiting ? h("div", { class: "cv-prr-queued" }, h("span", { class: "cv-ask-spin", "aria-hidden": "true" }),
        state.busy === "merge" ? "Approving · sends when back online" : "Sending · sends when back online") : null,
      state.error ? errorLine() : null);
    if (state.note) /** @type {any} */ (footEl.querySelector?.(".cv-prr-field"))?.focus?.();
  }

  function errorLine() {
    return h("div", { class: "cv-prr-err", role: "alert" },
      h("span", { class: "cv-mark cv-mark-failed", "aria-hidden": "true" }),
      h("span", { class: "cv-prr-err-t" }, problemText(state.error)),
      state.last ? h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-act": "retry",
        onclick: (/** @type {any} */ e) => { if (human(e) && state.last) run(state.last.act, state.last); } }, "Retry") : null);
  }

  // ---- the whole card --------------------------------------------------------------------------

  function draw() {
    const label = `Pull request${n.pr != null ? " #" + n.pr : ""}${n.title ? " " + n.title : ""}`;
    el.setAttribute("aria-label", label);
    el.setAttribute("data-compact", JSON.stringify({ title: `${n.pr != null ? "#" + n.pr + " " : ""}${n.title}`.trim(), branch: n.from || n.to ? `${n.from} → ${n.to}` : "",
      checks: n.checks.map(c => ({ name: String(c.name), state: checkState(c) })), state: prState() }));
    const who = n.agent || ctx.agent;
    put(el,
      head({ icon: "branch", title: `${n.pr != null ? "#" + n.pr + " " : ""}${n.title}`.trim() || "Pull request",
        meta: n.from || n.to ? h("span", { class: "cv-prr-branch" }, `${n.from} → ${n.to}`) : null }),
      n.ask && !state.decided ? h("div", { class: "cv-prr-asks" }, `${who || "An agent"} asks you to review this`) : null,
      summary(), checks(),
      n.files.length ? h("div", { class: "cv-prr-files" }, files) : null,
      commentsEl, footEl);
    drawComments(); drawFoot();
  }

  el.update = (/** @type {any} */ d) => {
    data = d; n = fields(d);
    if (files) files.update(n.files);
    draw();
  };
  el.answered = (/** @type {string} */ decision, /** @type {any} */ _answers, /** @type {any} */ from) => {
    if (state.decided) return;
    if (from) state.from = from;
    // Answered elsewhere: whether the merge itself went through is the PR's own state, not this answer's.
    state.decided = "other";
    state.word = decision === "allow" || decision === "always" ? "Approved on another screen" : "Answered on another screen";
    state.busy = null; state.waiting = false; state.error = null; state.note = null;
    draw();
  };
  el.isOpen = () => !!n.ask && !state.decided && prState() === "open";
  /** A key routed here by the session (focus not in a text field). */
  el.onKey = (/** @type {any} */ e) => {
    if (!human(e) || state.decided) return false;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      if (!canMerge()) return false;
      run("merge"); return true;
    }
    if (e.key === "Escape" && state.note) { state.note = null; state.replyTo = null; drawFoot(); return true; }
    return false;
  };
  el.addEventListener("keydown", (/** @type {any} */ e) => {
    if (e.target && e.target !== el) return;
    if (el.onKey(e)) e.preventDefault?.();
  });

  const trusted = new Set(n.comments.filter(c => OWN.has(String(c.by ?? "")) && c.path).map(c => c.path));
  files = fileList(n.files, { openHref: ctx.open, phone, open: phone ? [] : trusted, onToggle: () => drawComments(),
    openFile: (/** @type {any} */ f) => ctx.open?.(f.href || `/files?path=${encodeURIComponent(f.path)}`) });
  draw();
  return el;
}
