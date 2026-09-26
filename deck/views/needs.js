// @ts-check
// One held item, full screen: a permission question (PhoneApprove) or a draft held at the Gate
// (PhoneDraft). The phone opens these from Now; on a desktop they read as a centred column.
// Floor rules 1 and 2: the user sees the final words and where they go before anything is sent.

import { h, put, link, go } from "../js/dom.js";
import { icon } from "../js/icons.js";
import * as needs from "../js/needs.js";
import { since } from "../js/fmt.js";

/** @param {any} ctx */
export default async function view(ctx) {
  const id = ctx.params.id;
  const draw = () => {
    const n = needs.current().find(x => x.id === id);
    if (!n) return put(ctx.root, h("div", { class: "nd" }, top(null),
      h("h1", { class: "nd-title" }, "This is not waiting any more."),
      h("p", { class: "muted" }, "It was answered from another screen, or it expired. ", link("/now", { class: "link" }, "Back to Now"))));
    put(ctx.root, n.kind === "draft" ? draft(n) : ask(n));
  };
  await needs.load();
  if (!ctx.alive()) return;
  draw();
  // Answered elsewhere (another screen, the Capsule): this page says so rather than acting twice.
  ctx.cleanup(needs.watch(() => { if (!answering) draw(); }));
}

let answering = false;

function top(n) {
  return h("div", { class: "nd-top" },
    link("/now", { class: "nd-back" }, h("span", { class: "nd-chev", "aria-hidden": "true" }, icon("right", 14)), "Now"),
    n ? h("span", { class: "lbl beacon nd-held" }, h("span", { class: "dot beacon", "aria-hidden": "true" }),
      n.kind === "draft" ? "Held at the Gate" : `Held ${since(n.at)}`) : null);
}

/** Answer, then go back to Now; on failure the buttons come back with the reason. */
function actions(n, buttons, status, list) {
  return list.map(({ opt, cls, text }) => h("button", { type: "button", class: "btn nd-btn " + (cls || ""), onclick: async () => {
    if (opt.decision === "edit") return text();
    answering = true;
    for (const b of buttons.querySelectorAll("button")) /** @type {HTMLButtonElement} */ (b).disabled = true;
    try { await needs.answer(n, opt, typeof text === "string" ? text : undefined); go("/now"); }
    catch (e) {
      const err = /** @type {any} */ (e);
      put(status, err.missing ? `The ${err.module} module is not running, so this cannot be answered here yet.` : String(err.message));
      for (const b of buttons.querySelectorAll("button")) /** @type {HTMLButtonElement} */ (b).disabled = false;
    } finally { answering = false; }
  } }, opt.label === "Send as drafted" ? [icon("send", 14), "Send"] : opt.label));
}

function ask(n) {
  const where = [n.projectName, n.threadName].filter(Boolean).join(" / ");
  const status = h("p", { class: "small muted nd-status", role: "status" });
  const buttons = h("div", { class: "nd-actions" });
  const opts = [...n.options];
  // "Always" becomes a rule in this project (Learning); offered only when the ask is in one.
  if (n.project && !opts.some(o => o.decision === "always")) opts.splice(Math.max(1, opts.length - 1), 0, { label: "Always in this project", decision: "always" });
  put(buttons, actions(n, buttons, status, opts.map((o, i) => ({ opt: o, cls: i === 0 ? "btn-primary" : "" }))));
  const threadHref = n.thread ? (n.project ? `/projects/${encodeURIComponent(n.project)}/${encodeURIComponent(n.thread)}` : `/threads/${encodeURIComponent(n.thread)}`) : null;
  return h("div", { class: "nd" }, top(n),
    h("p", { class: "nd-who" }, h("b", null, n.agent || "A session"), ` asks${where ? ", in " + where : ""}`),
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
  const d = n.draft || { to: "", body: "", sources: [] };
  const name = d.toName || d.to;
  const status = h("p", { class: "small muted nd-status", role: "status" });
  const bodyBox = h("div", { class: "nd-body" });
  const buttons = h("div", { class: "nd-actions nd-sticky" });
  const showBody = () => bodyBox.classList.remove("editing") || put(bodyBox, d.segments?.length
    ? h("p", null, d.segments.map(s => s.source
      ? h("span", { class: "nd-src" }, s.text, h("sup", { "aria-label": `source ${s.source}` }, String(s.source)))
      : s.text))
    : h("p", null, d.body));
  const edit = () => {
    const ta = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "input nd-edit", rows: "8", "aria-label": "Edit the draft" }));
    ta.value = d.body;
    bodyBox.classList.add("editing");
    put(bodyBox, ta);
    put(buttons,
      h("button", { type: "button", class: "btn btn-primary nd-btn nd-grow", onclick: () => sendEdited(ta.value) }, icon("send", 14), "Send this version"),
      h("button", { type: "button", class: "btn nd-btn", onclick: () => { showBody(); drawButtons(); } }, "Cancel"));
    ta.focus();
  };
  const sendEdited = async text => {
    answering = true;
    for (const b of buttons.querySelectorAll("button")) /** @type {HTMLButtonElement} */ (b).disabled = true;
    try { await needs.answer(n, { label: "Send", decision: "approve" }, text); go("/now"); }
    catch (e) {
      const err = /** @type {any} */ (e);
      put(status, err.missing ? `The ${err.module} module is not running, so this cannot be sent from here yet.` : String(err.message));
      for (const b of buttons.querySelectorAll("button")) /** @type {HTMLButtonElement} */ (b).disabled = false;
    } finally { answering = false; }
  };
  const drawButtons = () => put(buttons, actions(n, buttons, status, [
    { opt: n.options[0], cls: "btn-primary nd-grow" },
    { opt: n.options[1], text: edit },
    { opt: n.options[2] },
  ]));
  showBody();
  drawButtons();
  const title = /^Re:/i.test(d.subject || "") ? `Reply to ${name}` : `Email to ${name}`;
  return h("div", { class: "nd nd-draft" }, top(n),
    h("h1", { class: "nd-title" }, title),
    h("p", { class: "small muted" }, `${n.agent || "An agent"} wrote this ${since(n.at)} ago. Client email waits here until you send it.`),
    h("div", { class: "nd-rows nd-mail" },
      h("div", { class: "nd-row" }, h("span", { class: "lbl" }, "To"), h("span", null, name, d.toName ? h("span", { class: "code faint" }, " " + d.to) : null)),
      d.subject ? h("div", { class: "nd-row" }, h("span", { class: "lbl" }, "Subject"), h("span", null, d.subject)) : null),
    bodyBox,
    d.sources?.length ? [
      h("div", { class: "nd-memhead" }, h("span", { class: "lbl recall" }, `From memory · ${d.sources.length}`), h("span", { class: "lbl" }, "No model used")),
      h("ol", { class: "recalled nd-mem" }, d.sources.map((s, i) => h("li", null, h("span", { class: "nd-n" }, String(i + 1)),
        h("span", null, h("span", { class: "nd-memtext" }, s.text), s.from ? h("span", { class: "nd-from" }, s.from) : null))))]
      : d.recalled ? h("div", { class: "recalled small" }, d.recalled) : null,
    status, buttons);
}
