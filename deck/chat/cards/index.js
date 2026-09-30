// @ts-check
// The registry for the common chat components (app-design.md section 10.1). Two ways in, never a third:
//   1. A blocking ask (ask.raised with a kind): askCardFor(full, opts) gives the card for kinds
//      pr_review, email_draft, calendar_draft, survey and confirmation, or null (session.js then
//      draws the permission, question or plan card it always did).
//   2. A non-blocking display: a tool block that carries `render: { kind, ... }` (renderOf(block)),
//      drawn by displayRow(render, ctx). Kinds: pr_review, email_thread, calendar_event, diff,
//      report, file_preview, link_preview, artifact.
// Every factory is (data, ctx) => an element with .update(data), and asks also .answered(decision,
// answers, from) like the cards in ask-item.js. ctx: { thread, phone, agent, open(href) }.

import { go } from "../../js/dom.js";
import { prReview } from "./pr-review.js";
import { diffFiles } from "./diff-files.js";
import { report } from "./report.js";
import { emailThread } from "./email-thread.js";
import { draftCard } from "./draft.js";
import { calendarEvent } from "./calendar-event.js";
import { surveyCard, isSurvey } from "./survey.js";
import { confirmationLine } from "./confirmation.js";
import { filePreview } from "./file-preview.js";
import { artifactCard } from "./artifact.js";

/** Where a card sends the person by default: an address in this app goes through the router, an outside http(s) link opens
 * in a new tab with no opener; anything else (a compose: or vyre: pseudo-address) is left to a ctx.open the caller gives. @param {string} href */
export function defaultOpen(href) {
  const h = String(href || "");
  if (/^https?:\/\//i.test(h)) { if (typeof window !== "undefined") window.open?.(h, "_blank", "noopener,noreferrer"); return; }
  if (h.startsWith("/")) go(h);
}

/** Non-blocking display kinds. */
export const DISPLAY = {
  pr_review: prReview, diff: diffFiles, report, email_thread: emailThread, calendar_event: calendarEvent,
  file_preview: filePreview, link_preview: filePreview, artifact: artifactCard,
};
/** Blocking ask kinds beyond permission, question and plan. */
export const ASKS = { pr_review: prReview, email_draft: draftCard, calendar_draft: draftCard, survey: surveyCard, confirmation: confirmationLine };

/** A tool block's `render` payload: on the block itself, or as `{ render }` in a JSON result. @param {any} b */
export function renderOf(b) {
  if (!b || typeof b !== "object") return null;
  let r = b.render;
  if (!r && typeof b.output === "string" && b.output.trimStart().startsWith("{")) {
    try { r = JSON.parse(b.output).render; } catch { /* plain output */ }
  }
  return r && typeof r === "object" && typeof r.kind === "string" && DISPLAY[r.kind] ? r : null;
}

/** The card for a display payload. @param {any} render @param {any} [ctx] */
export function displayRow(render, ctx = {}) {
  const make = DISPLAY[render?.kind];
  return make ? make(render, { open: defaultOpen, ...ctx }) : null;
}

/** The card for a blocking ask of one of the new kinds, else null. @param {any} full @param {any} [ctx] */
export function askCardFor(full, ctx = {}) {
  const make = ASKS[full?.kind] || (full?.kind === "question" && isSurvey(full) ? surveyCard : null);
  return make ? make(full, { open: defaultOpen, ...ctx }) : null;
}

/** A tool block whose result carries a render payload, as its card row; null when it has none.
 * .update(block) redraws in place, and the row becomes the card the moment a payload arrives. @param {any} b @param {any} [ctx] */
export function toolDisplay(b, ctx = {}) {
  const r = renderOf(b);
  if (!r) return null;
  const card = /** @type {any} */ (displayRow(r, ctx));
  if (!card) return null;
  card._ts = b.ts ?? null;
  card.setAttribute?.("data-tool", String(b.tool || ""));
  const inner = card.update;
  card.update = (/** @type {any} */ nb) => { const nr = renderOf(nb); if (nr && nr.kind === r.kind) { card._ts = nb.ts ?? card._ts; inner?.(nr); } };
  card.tick = () => {};
  return card;
}
