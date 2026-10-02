// @ts-check
// One held item, full screen: a permission question (PhoneApprove) or a draft held at the Gate
// (PhoneDraft). The phone opens these from Now; on a desktop they read as a centred column.
// Floor rules 1 and 2: the user sees the final words and where they go before anything is sent.

import { h, put, link, go, isPhone } from "../js/dom.js";
import { icon } from "../js/icons.js";
import * as needs from "../js/needs.js";
import { form, gateFields } from "../js/editable.js";
import { since } from "../js/fmt.js";
import { wantSheet } from "../js/now-phone.js";
import { elsewhere, fromMac, plainSummary } from "../js/need-rows.js";

/** @param {any} ctx */
export default async function view(ctx) {
  const id = ctx.params.id;
  // A phone (a push notification's tap lands here): Now, with this item's detail sheet open.
  if (isPhone()) {
    wantSheet(id);
    history.replaceState(history.state, "", "/now");
    window.dispatchEvent(new Event("deck:navigate"));
    return;
  }
  const draw = () => {
    // The list's item, else an ask raised while this page was open (needs.find).
    const n = needs.find(id);
    if (!n) return put(ctx.root, h("div", { class: "nd" }, top(null),
      h("h1", { class: "nd-title" }, "This ask was answered or has gone."),
      h("p", { class: "muted" }, "It was answered from another screen, or it expired. ", link("/now", { class: "link" }, "Back to Now"))));
    put(ctx.root, n.kind === "draft" ? draft(n) : ask(n));
  };
  await needs.load();
  if (!ctx.alive()) return;
  draw();
  // Answered elsewhere (another screen, Lumen): this page says so rather than acting twice.
  ctx.cleanup(needs.watch(() => { if (!answering) draw(); }));
}

let answering = false;

function top(n) {
  return h("div", { class: "nd-top" },
    link("/now", { class: "nd-back" }, h("span", { class: "nd-chev", "aria-hidden": "true" }, icon("right", 14)), "Now"),
    n ? h("span", { class: "lbl beacon nd-held" }, h("span", { class: "dot beacon", "aria-hidden": "true" }),
      n.kind === "draft" ? "Held at the Gate" : `Held ${since(n.at)}`) : null);
}

/**
 * Answer, then go back to Now; on failure the buttons come back with the reason.
 * `getEdited`, when given, is asked only for the primary (approve) action: it returns
 * `{ error }` to stop and show a message, or `{ edited }` (maybe null) to send.
 */
function actions(n, buttons, status, list, getEdited) {
  return list.map(({ opt, cls }) => h("button", { type: "button", class: "btn nd-btn " + (cls || ""), onclick: async () => {
    let edited = null;
    if (opt.decision === "approve" && getEdited) {
      const r = getEdited();
      if (r.error) { put(status, r.error); return; }
      edited = r.edited;
    }
    answering = true;
    for (const b of buttons.querySelectorAll("button")) /** @type {HTMLButtonElement} */ (b).disabled = true;
    put(status);
    try { await needs.answer(n, opt, edited); go("/now"); }
    catch (e) {
      put(status, problem(e));
      // The box cannot forward answers to this Mac (needs.js): the line says where, no buttons.
      if (/** @type {any} */ (e)?.elsewhere) put(buttons);
      else for (const b of buttons.querySelectorAll("button")) /** @type {HTMLButtonElement} */ (b).disabled = false;
    } finally { answering = false; }
  } }, opt.label === "Send" ? [icon("send", 14), "Send"] : opt.label));
}

/** An error from the Gate or a module, in plain words. */
function problem(e) {
  const x = /** @type {any} */ (e);
  if (x?.missing) return `The ${x.module} module is not running, so this cannot be answered here yet.`;
  if (x?.code === "denied" || /denied/i.test(String(x?.message || x))) return "The Gate does not let the Deck read or answer this yet. Answer it from the terminal or chat.";
  return String(x?.message || x);
}

function ask(n) {
  const where = [n.projectName, n.threadName].filter(Boolean).join(" / ");
  const status = h("p", { class: "small muted nd-status", role: "status" });
  const buttons = h("div", { class: "nd-actions" });
  const mac = elsewhere(n);
  const opts = mac ? [] : [...n.options];
  // "Always" becomes a rule in this project (Learning); offered only when the ask is in one.
  if (!mac && n.project && !opts.some(o => o.decision === "always")) opts.splice(Math.max(1, opts.length - 1), 0, { label: "Always in this project", decision: "always" });
  // A Mac session's ask on a box that cannot forward the answer: the line in place of the buttons.
  put(buttons, mac ? h("p", { class: "small muted" }, `Answer it on ${mac}`) : actions(n, buttons, status, opts.map((o, i) => ({ opt: o, cls: i === 0 ? "btn-primary" : "" }))));
  const threadHref = n.thread ? (n.project ? `/projects/${encodeURIComponent(n.project)}/${encodeURIComponent(n.thread)}` : `/threads/${encodeURIComponent(n.thread)}`) : null;
  return h("div", { class: "nd" }, top(n),
    h("p", { class: "nd-who" }, h("b", null, n.agent || "A session"), ` asks${where ? ", in " + where : ""}${fromMac(n) ? ` on ${n.machine || "your Mac"}` : ""}`),
    h("h1", { class: "nd-title" }, "May I run"),
    h("div", { class: "nd-cmd" }, h("span", { class: "faint", "aria-hidden": "true" }, "$ "), h("code", null, n.command || "")),
    n.intent ? [h("div", { class: "lbl nd-lbl" }, `Why ${n.agent || "it"} wants to`), h("p", { class: "nd-p" }, n.intent)] : null,
    !n.intent && n.why ? h("p", { class: "nd-p" }, n.why) : null,
    n.details?.length ? [h("div", { class: "lbl nd-lbl" }, "What it changes"),
      h("div", { class: "nd-rows" }, n.details.map(d => h("div", { class: "nd-row" }, h("span", { class: "lbl" }, d.label), h("span", { class: "code nd-val" }, d.value))))] : null,
    buttons, status,
    opts.some(o => o.decision === "always") && n.projectName ? h("p", { class: "small faint nd-note" }, `Always adds a rule to ${n.projectName}. You can remove it in Settings.`) : null,
    threadHref ? h("p", { class: "small nd-note" }, link(threadHref, { class: "link", style: { color: "var(--text-2)" } }, "Open the thread")) : null);
}

function draft(n) {
  const g = n.gate || { kind: "send", via: "", to: [], summary: "", draft: null, error: null, sources: [] };
  const name = g.toName || g.to?.join(", ") || "someone";
  const status = h("p", { class: "small muted nd-status", role: "status" });
  const buttons = h("div", { class: "nd-actions nd-sticky" });
  // Every field, To through Body, is a real input that reads as text until focused (js/editable.js).
  // There is no Edit button: Send sends what is shown.
  const f = g.draft ? form(gateFields({ to: g.to, draft: g.draft })) : null;
  const getEdited = () => {
    const err = f?.error();
    return err ? { error: err } : { edited: f?.changed() ? f.edited() : null };
  };
  put(buttons, actions(n, buttons, status, [
    { opt: n.options[0], cls: "btn-primary nd-grow" },
    { opt: n.options[1] },
  ], getEdited));
  const subject = typeof g.draft?.subject === "string" ? g.draft.subject : "";
  const title = g.kind !== "send" ? (g.kind === "spend" ? `Spend through ${g.via}` : `Delete through ${g.via}`)
    : /^Re:/i.test(subject) ? `Reply to ${name}` : `Email to ${name}`;
  const recalled = g.recalled || g.sources?.[0]?.text || "";
  return h("div", { class: "nd nd-draft" }, top(n),
    h("h1", { class: "nd-title" }, title),
    h("p", { class: "small muted" }, `${n.agent || "An agent"} wrote this ${since(n.at)} ago. It waits here until you send it.`),
    f ? [g.error ? h("p", { class: "small nd-error" }, `Held again: ${problem(g.error)}`) : null,
        h("div", { class: "nd-body nd-form" }, f.el)]
      : h("div", { class: "nd-body" },
      plainSummary(g) ? h("p", null, plainSummary(g)) : null,
      h("p", { class: "small muted" }, g.error ? `The full draft cannot be shown here: ${problem(g.error)}` : "The full draft cannot be shown here.")),
    g.sources?.length ? [
      h("div", { class: "nd-memhead" }, h("span", { class: "lbl recall" }, `From memory · ${g.sources.length}`), h("span", { class: "lbl" }, "No model used")),
      h("ol", { class: "recalled nd-mem" }, g.sources.map((s, i) => h("li", null, h("span", { class: "nd-n" }, String(i + 1)),
        h("span", null, h("span", { class: "nd-memtext" }, s.text), s.from ? h("span", { class: "nd-from" }, s.from) : null))))]
      : recalled ? h("div", { class: "recalled small" }, recalled) : null,
    status, buttons);
}
