// @ts-check
// Planner: today's agenda, the next alarms, open todos and notes, from the planner module
// (core/planner, docs/adr/0025-planner.md). A minimal panel in the Deck's idiom; the pwa team
// builds the real phone and Now views on the same contract.
//
// Tools: planner.agenda, planner.list, planner.get, planner.add { text }, planner.done,
// planner.snooze. Events: planner.added, planner.changed, planner.removed (redraw),
// planner.fired (a banner with Done and Snooze, one per firing), planner.acked (the banner goes).
//
// /planner/<firing> is where a push notification opens (ADR 0025, decision 9): the firing's item
// sits on top, with Done and Snooze while it still rings.
//
// Light by default: no polling. Events redraw only while the page is visible; a hidden page
// remembers that something changed and redraws once when it is looked at again.

import { h, put, head, empty } from "../js/dom.js";
import { attempt as liveAttempt } from "../js/api.js";
import { clock, when } from "../js/fmt.js";

/** Events that change what the lists show. */
export const CHANGES = ["planner.added", "planner.changed", "planner.removed", "planner.acked"];

const KIND_WORD = { alarm: "Alarm", timer: "Timer", reminder: "Reminder", todo: "Todo", note: "Note", event: "Event" };
export const kindWord = k => KIND_WORD[k] || "Item";

/** When an item next rings (a snooze wins), or its time. */
export const nextAt = it => it.snooze_until ?? it.next_fire ?? it.at ?? null;

/** Open alarms and timers that will ring, soonest first. */
export function nextAlarms(items, limit = 5) {
  return items.filter(i => (i.kind === "alarm" || i.kind === "timer") && i.state === "open" && nextAt(i) != null)
    .sort((a, b) => nextAt(a) - nextAt(b)).slice(0, limit);
}

/** Pinned notes first, then the newest. */
export const sortNotes = notes => [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.updated || 0) - (a.updated || 0));

/** A repeat rule in words: "Daily", "Weekdays". */
export function repeatWord(r) {
  if (!r) return "";
  const n = r.interval && r.interval > 1 ? r.interval : 1;
  const W = { day: "Daily", weekday: "Weekdays", week: "Weekly", month: "Monthly", year: "Yearly" };
  const U = { day: "days", week: "weeks", month: "months", year: "years" };
  return n > 1 && U[r.every] ? `Every ${n} ${U[r.every]}` : W[r.every] || "";
}

/** @param {any} ctx */
export default async function view(ctx) {
  await drawPlanner(ctx.root, ctx);
}

/**
 * Draw the planner into el and follow its events.
 * @param {HTMLElement} el
 * @param {{ params?: any, on: Function, cleanup: Function, alive: () => boolean }} ctx
 * @param {{ attempt?: (tool: string, input?: any) => Promise<{ data?: any, error?: any }>, doc?: any }} [deps]
 */
export async function drawPlanner(el, ctx, deps = {}) {
  const attempt = deps.attempt || liveAttempt;
  const doc = deps.doc || document;
  const firingId = ctx.params?.firing || null;

  const banners = h("div", { class: "pl-banners", "aria-live": "assertive" });
  const focus = h("section", { class: "pl-focus" });
  const agendaBox = h("section", { class: "pl-sec", "data-sec": "agenda" });
  const alarmsBox = h("section", { class: "pl-sec", "data-sec": "alarms" });
  const todosBox = h("section", { class: "pl-sec", "data-sec": "todos" });
  const notesBox = h("section", { class: "pl-sec", "data-sec": "notes" });
  put(el, h("div", { class: "pl" }, h("div", { class: "pl-col" },
    h("div", { class: "pl-head" }, h("div", { class: "lbl" }, "Planner"), h("h1", { class: "h2 pl-title" }, "Today")),
    banners, focus, agendaBox, alarmsBox, todosBox, notesBox)));

  // ---- banners: one per firing, from planner.fired until planner.acked --------------------------

  /** @type {Map<string, HTMLElement>} */
  const shown = new Map();
  /** Done or Snooze a firing; the banner (or focus card) shows why if it fails. */
  const answer = async (/** @type {string} */ tool, /** @type {string} */ firing, /** @type {HTMLElement} */ box, /** @type {HTMLElement} */ status) => {
    for (const b of box.querySelectorAll("button")) /** @type {any} */ (b).disabled = true;
    const r = await attempt(tool, { firing });
    if (!ctx.alive()) return;
    if (r.error) {
      put(status, String(r.error.message || r.error));
      for (const b of box.querySelectorAll("button")) /** @type {any} */ (b).disabled = false;
      return;
    }
    drop(firing);
    if (firingId === firing) drawFocus();
  };
  const actions = (/** @type {string} */ firing, /** @type {HTMLElement} */ box, /** @type {HTMLElement} */ status) => h("div", { class: "pl-acts" },
    h("button", { type: "button", class: "btn btn-primary", "data-act": "done", onclick: () => answer("planner.done", firing, box, status) }, "Done"),
    h("button", { type: "button", class: "btn", "data-act": "snooze", onclick: () => answer("planner.snooze", firing, box, status) }, "Snooze"));

  /** @param {any} p a planner.fired payload */
  const ring = p => {
    if (!p?.firing) return;
    const status = h("p", { class: "small pl-status", role: "status" });
    // A second ring of the same firing redraws its banner in place.
    let box = shown.get(p.firing);
    if (!box) { box = h("div", { class: "pl-banner held", "data-firing": p.firing }); banners.append(box); shown.set(p.firing, box); }
    put(box,h("div", { class: "pl-banner-main" },
      h("span", { class: "lbl beacon pl-ring" }, h("span", { class: "dot beacon", "aria-hidden": "true" }),
        kindWord(p.kind), p.missed ? " · missed" : p.ring > 1 ? ` · ring ${p.ring}` : ""),
      h("div", { class: "pl-banner-title" }, p.title || kindWord(p.kind)),
      p.due ? h("div", { class: "code" }, clock(p.due)) : null),
      actions(p.firing, box, status), status);
  };
  const drop = (/** @type {string} */ firing) => { const b = shown.get(firing); if (b) { b.remove(); shown.delete(firing); } };

  // ---- /planner/<firing>: the item a notification opened ----------------------------------------

  async function drawFocus() {
    if (!firingId) return;
    const r = await attempt("planner.get", { firing: firingId });
    if (!ctx.alive()) return;
    if (r.error) { put(focus, empty("This reminder is not on the planner any more.", r.error.missing ? r.error : null)); return; }
    const { item, firing } = r.data || {};
    if (!item) { put(focus, empty("This reminder is not on the planner any more.")); return; }
    const status = h("p", { class: "small pl-status", role: "status" });
    const card = h("div", { class: "pl-card", "data-item": item.id });
    const ringing = firing?.state === "ringing";
    put(card,
      h("div", { class: "lbl" + (ringing ? " beacon" : "") }, kindWord(item.kind), ringing ? " · ringing" : firing?.action ? ` · ${firing.action}` : ""),
      h("div", { class: "pl-card-title" }, item.title || kindWord(item.kind)),
      item.body ? h("p", { class: "muted pl-body" }, item.body) : null,
      h("div", { class: "code" }, firing?.due ? clock(firing.due) : nextAt(item) ? clock(nextAt(item)) : ""),
      ringing ? actions(firing.id, card, status) : null, status);
    put(focus, card);
  }

  // ---- sections ---------------------------------------------------------------------------------

  const headed = (/** @type {HTMLElement} */ box, /** @type {string} */ label, /** @type {any} */ right, /** @type {any} */ body) =>
    put(box, head(label, right), body);

  async function drawAgenda() {
    const r = await attempt("planner.agenda", {});
    if (!ctx.alive()) return;
    if (r.error) return headed(agendaBox, "Agenda", null, empty("The agenda is not available.", r.error));
    const entries = r.data?.entries || [], todos = r.data?.todos || [];
    if (!entries.length && !todos.length) return headed(agendaBox, "Agenda", null, h("div", { class: "empty" }, "Nothing on today."));
    headed(agendaBox, "Agenda", h("span", { class: "lbl" }, r.data?.tz || ""), h("div", { class: "rows" },
      entries.map(e => h("div", { class: "pl-row", "data-kind": e.kind },
        h("span", { class: "code pl-time" }, e.all_day ? "All day" : clock(e.at)),
        h("span", { class: "pl-what ellipsis" }, e.title || kindWord(e.kind)),
        h("span", { class: "lbl" }, e.source === "calendar" ? "Calendar" : kindWord(e.kind) + (e.snoozed ? " · snoozed" : "")))),
      todos.map(t => h("div", { class: "pl-row", "data-kind": "todo" },
        h("span", { class: "code pl-time" }, t.due ? "Due" : ""),
        h("span", { class: "pl-what ellipsis" }, t.title),
        h("span", { class: "lbl" }, "Todo")))));
  }

  async function drawAlarms() {
    const r = await attempt("planner.list", { state: "open", limit: 200 });
    if (!ctx.alive()) return;
    const status = h("p", { class: "small pl-status", role: "status" });
    const input = /** @type {HTMLInputElement} */ (h("input", { class: "input", name: "text", autocomplete: "off",
      placeholder: "alarm 7am, timer 10 min, remind me to call kit at 6", "aria-label": "Add to the planner" }));
    const addForm = h("form", { class: "pl-add", onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      put(status);
      const a = await attempt("planner.add", { text });
      if (!ctx.alive()) return;
      if (a.error) { put(status, String(a.error.message || a.error)); return; }
      input.value = "";
      refresh();
    } }, input, h("button", { type: "submit", class: "btn" }, "Add"));
    if (r.error) return headed(alarmsBox, "Alarms", null, [empty("The planner is not available.", r.error), addForm, status]);
    const items = Array.isArray(r.data) ? r.data : [];
    const next = nextAlarms(items);
    headed(alarmsBox, "Alarms", null, [
      next.length ? h("div", { class: "rows" }, next.map(a => h("div", { class: "pl-row", "data-item": a.id },
        h("span", { class: "code pl-time" }, clock(nextAt(a))),
        h("span", { class: "pl-what ellipsis" }, a.title || kindWord(a.kind)),
        h("span", { class: "lbl" }, a.snooze_until ? "Snoozed" : repeatWord(a.repeat) || when(nextAt(a))))))
        : h("div", { class: "empty" }, "No alarms set."),
      addForm, status]);
    drawTodos(items);
    drawNotes(items);
  }

  function drawTodos(/** @type {any[]} */ items) {
    const todos = items.filter(i => i.kind === "todo" && i.state === "open");
    if (!todos.length) return headed(todosBox, "Todos", null, h("div", { class: "empty" }, "No open todos."));
    headed(todosBox, "Todos", h("span", { class: "lbl" }, String(todos.length)), h("div", { class: "rows" }, todos.map(t => {
      const row = h("label", { class: "pl-row pl-todo", "data-item": t.id });
      const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", "aria-label": `Done: ${t.title}`, onchange: async () => {
        box.disabled = true;
        const r = await attempt("planner.done", { item: t.id });
        if (!ctx.alive()) return;
        if (r.error) { box.checked = false; box.disabled = false; row.setAttribute("title", String(r.error.message || r.error)); return; }
        row.remove();
      } }));
      put(row, box, h("span", { class: "pl-what ellipsis" }, t.title), t.due ? h("span", { class: "code" }, t.due) : null);
      return row;
    })));
  }

  function drawNotes(/** @type {any[]} */ items) {
    const notes = sortNotes(items.filter(i => i.kind === "note"));
    if (!notes.length) return headed(notesBox, "Notes", null, h("div", { class: "empty" }, "No notes."));
    headed(notesBox, "Notes", null, h("div", { class: "rows" }, notes.map(n => h("div", { class: "pl-note", "data-item": n.id },
      h("div", { class: "pl-note-head" }, n.pinned ? h("span", { class: "lbl recall pl-pin" }, "Pinned") : null,
        h("span", { class: "pl-what" }, n.title || "Note"), h("span", { class: "code" }, when(n.updated))),
      n.body ? h("p", { class: "small muted pl-body" }, n.body) : null))));
  }

  // ---- refresh: on events, only while visible ---------------------------------------------------

  const refresh = () => Promise.all([drawAgenda(), drawAlarms(), drawFocus()]);
  const visible = () => doc.visibilityState !== "hidden" && !doc.hidden;
  let dirty = false, t = /** @type {any} */ (0);
  const later = () => {
    if (!visible()) { dirty = true; return; }
    clearTimeout(t);
    t = setTimeout(() => { if (ctx.alive()) refresh(); }, 300);
  };
  const onVisible = () => { if (visible() && dirty) { dirty = false; later(); } };
  doc.addEventListener("visibilitychange", onVisible);
  ctx.cleanup(() => { clearTimeout(t); doc.removeEventListener("visibilitychange", onVisible); });

  ctx.on("planner.fired", (/** @type {any} */ e) => { ring(e.payload); later(); });
  ctx.on("planner.acked", (/** @type {any} */ e) => { drop(e.payload?.firing); later(); });
  for (const type of CHANGES) if (type !== "planner.acked") ctx.on(type, later);

  await refresh();
}
