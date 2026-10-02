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
import { attempt as liveAttempt, queued as liveQueued } from "../js/api.js";
import { clock, when } from "../js/fmt.js";
import { showToast } from "../js/toast.js";

/** Events that change what the lists show. */
export const CHANGES = ["planner.added", "planner.changed", "planner.removed", "planner.acked"];

const KIND_WORD = { alarm: "Alarm", timer: "Timer", reminder: "Reminder", todo: "Todo", note: "Note", event: "Event" };
export const kindWord = k => KIND_WORD[k] || "Item";

/** "from kit" when an agent other than the person's assistant added it; nothing otherwise. */
const from = it => (it && it.added_by ? h("span", { class: "lbl pl-from" }, `from ${it.added_by}`) : null);

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

/** "todo buy milk" and "note printer code" say what kind they are; the rest is read by the planner ("alarm 7am", "remind me to ..."). */
export function splitKind(raw) {
  const m = /^(todo|task|note|event)\b[\s:,-]*(.*)$/i.exec(String(raw || "").trim());
  if (!m) return { kind: null, text: String(raw || "").trim() };
  const k = m[1].toLowerCase();
  return { kind: k === "task" ? "todo" : k, text: m[2].trim() };
}

/** What the box read from the words, in a line the person can check before pressing Enter. @param {any} p planner.parse's answer @param {string} words */
export function previewLine(p, words) {
  if (!p) return "I cannot place a time in that. Start with todo or note to add it as one.";
  if (p.ambiguous) return String(p.reason || "That is ambiguous: say the time or day.");
  const when_ = p.at ? new Date(p.at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  return [kindWord(p.kind), p.title && p.title !== words ? p.title : "", when_, repeatWord(p.repeat)].filter(Boolean).join(" · ");
}

/** @param {any} ctx */
export default async function view(ctx) {
  await drawPlanner(ctx.root, ctx);
}

/**
 * Draw the planner into el and follow its events.
 * @param {HTMLElement} el
 * @param {{ params?: any, on: Function, cleanup: Function, alive: () => boolean }} ctx
 * @param {{ attempt?: (tool: string, input?: any) => Promise<{ data?: any, error?: any }>, write?: (tool: string, input?: any) => Promise<{ data?: any, error?: any }>, doc?: any, toast?: (o: any) => any }} [deps]
 *   write: how an item is added, changed, finished or deleted, through the outbox (ADR 0029) by default,
 *   or through a test's attempt when it gives only that. toast: how the Undo line is shown (a test gives its own).
 */
export async function drawPlanner(el, ctx, deps = {}) {
  const attempt = deps.attempt || liveAttempt;
  const write = deps.write || deps.attempt || liveQueued;
  const doc = deps.doc || document;
  const firingId = ctx.params?.firing || null;

  const toast = deps.toast || showToast;
  const quickBox = h("section", { class: "pl-quick", "aria-label": "Add" });
  const banners = h("div", { class: "pl-banners", "aria-live": "assertive" });
  const focus = h("section", { class: "pl-focus" });
  const agendaBox = h("section", { class: "pl-sec", "data-sec": "agenda" });
  const alarmsBox = h("section", { class: "pl-sec", "data-sec": "alarms" });
  const todosBox = h("section", { class: "pl-sec", "data-sec": "todos" });
  const notesBox = h("section", { class: "pl-sec", "data-sec": "notes" });
  put(el, h("div", { class: "pl" }, h("div", { class: "pl-col" },
    h("div", { class: "pl-head" }, h("div", { class: "lbl" }, "Planner"), h("h1", { class: "h2 pl-title" }, "Today")),
    quickBox, banners, focus, agendaBox, alarmsBox, todosBox, notesBox)));

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
      h("div", { class: "pl-banner-title" }, p.title || kindWord(p.kind)), from(p),
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
      h("div", { class: "pl-card-title" }, item.title || kindWord(item.kind)), from(item),
      item.body ? h("p", { class: "muted pl-body" }, item.body) : null,
      h("div", { class: "code" }, firing?.due ? clock(firing.due) : nextAt(item) ? clock(nextAt(item)) : ""),
      ringing ? actions(firing.id, card, status) : null, status);
    put(focus, card);
  }

  // ---- sections ---------------------------------------------------------------------------------

  const headed = (/** @type {HTMLElement} */ box, /** @type {string} */ label, /** @type {any} */ right, /** @type {any} */ body) =>
    put(box, head(label, right), body);

  /** What an item is called in a sentence ("Deleted ..."). */
  const nameOf = (/** @type {any} */ it) => String(it.title || kindWord(it.kind)).slice(0, 60);

  /** Run a change through the outbox; on a failure, the row says why. Resolves true when it went. */
  const change = async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {HTMLElement|null} */ row) => {
    row?.classList.add("sending");
    const r = await write(tool, input);
    row?.classList.remove("sending");
    if (!ctx.alive()) return false;
    if (r.error) { row?.setAttribute("title", String(r.error.message || r.error)); say(String(r.error.message || r.error)); return false; }
    return true;
  };
  /** One line of status for the page, for a refused change. */
  const say = (/** @type {string} */ t) => put(note, t);
  const note = h("p", { class: "small pl-status", role: "status", "aria-live": "polite" });

  /** Delete with an Undo that restores it (the box keeps a deleted item for 30 days). */
  const remove = async (/** @type {any} */ it, /** @type {HTMLElement|null} */ row) => {
    if (!(await change("planner.delete", { item: it.id }, row))) return;
    toast({ text: `Deleted “${nameOf(it)}”`, undo: async () => { if (await change("planner.delete", { item: it.id, restore: true }, null)) refresh(); } });
    refresh();
  };
  const finish = async (/** @type {any} */ it, /** @type {HTMLElement|null} */ row) => {
    if (!(await change("planner.done", { item: it.id }, row))) return false;
    toast({ text: `Done: “${nameOf(it)}”`, undo: async () => { if (await change("planner.update", { item: it.id, state: "open" }, null)) refresh(); } });
    return true;
  };

  /** The editor that replaces a row: the words, the notes under them, and when. Enter saves, Esc leaves it as it was. */
  const edit = (/** @type {any} */ it, /** @type {HTMLElement} */ row) => {
    const timed = ["alarm", "timer", "reminder", "event"].includes(it.kind);
    const title = /** @type {HTMLInputElement} */ (h("input", { class: "input", name: "title", value: it.title || "", autocomplete: "off", "aria-label": "Title" }));
    const body = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "input", name: "body", rows: "3", "aria-label": "Notes" }, it.body || ""));
    const whenIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", name: "when", autocomplete: "off", "aria-label": "When", placeholder: "tomorrow 9am, in 20 minutes, every weekday 7am",
      value: nextAt(it) ? whenWords(nextAt(it)) : "" }));
    const status = h("p", { class: "small pl-status", role: "status" });
    const close = () => { if (ctx.alive()) refresh(); };
    const form = h("form", { class: "pl-edit", "data-edit": it.id, onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      /** @type {any} */ const upd = { item: it.id };
      if (title.value.trim() && title.value.trim() !== (it.title || "")) upd.title = title.value.trim();
      if (!it.parent && body.value !== (it.body || "")) upd.body = body.value;
      const w = whenIn.value.trim();
      if (timed && w && w !== (nextAt(it) ? whenWords(nextAt(it)) : "")) {
        const p = await attempt("planner.parse", { text: w, kind: it.kind });
        const got = p.data;
        if (p.error || !got || got.ambiguous || !got.at) { put(status, got?.reason ? String(got.reason) : "I could not read that time. Try “tomorrow 9am”."); return; }
        upd.at = got.at; if (got.repeat) upd.repeat = got.repeat;
      }
      if (Object.keys(upd).length === 1) { close(); return; }
      put(status, "Saving");
      if (await change("planner.update", upd, row)) close(); else put(status, "That did not go through.");
    }, onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } } },
    title, timed ? whenIn : null, it.kind === "note" || it.kind === "todo" || it.kind === "reminder" ? body : null,
    h("div", { class: "pl-acts" }, h("button", { type: "submit", class: "btn btn-primary" }, "Save"), h("button", { type: "button", class: "btn btn-ghost", onclick: close }, "Cancel"), status));
    row.replaceChildren(form);
    title.focus();
  };

  /** The three small actions on a row of the planner's own: done (todos and reminders), edit, delete. */
  const acts = (/** @type {any} */ it, /** @type {HTMLElement} */ row) => h("span", { class: "pl-row-acts" },
    it.kind === "note" ? h("button", { type: "button", class: "ibtn", "data-act": "pin", "aria-pressed": String(!!it.pinned), "aria-label": `${it.pinned ? "Unpin" : "Pin"}: ${nameOf(it)}`, title: it.pinned ? "Unpin (p)" : "Pin (p)",
      onclick: async () => { if (await change("planner.update", { item: it.id, pinned: !it.pinned }, row)) refresh(); } }, "★") : null,
    h("button", { type: "button", class: "ibtn", "data-act": "edit", "aria-label": `Edit: ${nameOf(it)}`, title: "Edit (e)", onclick: () => edit(it, row) }, "✎"),
    h("button", { type: "button", class: "ibtn", "data-act": "delete", "aria-label": `Delete: ${nameOf(it)}`, title: "Delete (Backspace)", onclick: () => remove(it, row) }, "✕"));

  /** Decorate a row for the keyboard and the actions: its item rides on it, so a key finds what to do. */
  const mark = (/** @type {HTMLElement} */ row, /** @type {any} */ it) => {
    row.setAttribute("tabindex", "-1"); row.setAttribute("data-item", it.id); row.setAttribute("data-kind", it.kind);
    /** @type {any} */ (row)._item = it;
    return row;
  };

  async function drawAgenda() {
    const r = await attempt("planner.agenda", {});
    if (!ctx.alive()) return;
    if (r.error) return headed(agendaBox, "Agenda", null, empty("The agenda is not available.", r.error));
    const entries = r.data?.entries || [], todos = r.data?.todos || [];
    if (!entries.length && !todos.length) return headed(agendaBox, "Agenda", null, h("div", { class: "empty" }, "Nothing on today. Add something above."));
    headed(agendaBox, "Agenda", h("span", { class: "lbl" }, r.data?.tz || ""), h("div", { class: "rows" },
      entries.map((/** @type {any} */ e) => {
        const mine = e.source === "planner" && e.item;
        const row = h("div", { class: "pl-row", "data-kind": e.kind },
          h("span", { class: "code pl-time" }, e.all_day ? "All day" : clock(e.at)),
          h("span", { class: "pl-what ellipsis" }, e.title || kindWord(e.kind)),
          h("span", { class: "lbl" }, e.source !== "planner" ? "Calendar" : kindWord(e.kind) + (e.snoozed ? " · snoozed" : "")));
        if (mine) { const it = { id: e.item, kind: e.kind, title: e.title, at: e.at }; mark(row, it); row.append(acts(it, row)); }
        return row;
      }),
      todos.map((/** @type {any} */ t) => {
        const row = h("div", { class: "pl-row", "data-kind": "todo" },
          h("span", { class: "code pl-time" }, t.due ? "Due" : ""), h("span", { class: "pl-what ellipsis" }, t.title), h("span", { class: "lbl" }, "Todo"));
        if (t.id) { mark(row, t); row.append(acts(t, row)); }
        return row;
      })));
  }

  /** Words to type for a time: how the editor shows it ("Tomorrow 9:00" style), so it parses back to the same moment. */
  function whenWords(/** @type {number} */ ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  async function drawAlarms() {
    const r = await attempt("planner.list", { state: "open", limit: 200 });
    if (!ctx.alive()) return;
    if (r.error) { headed(alarmsBox, "Alarms", null, empty("The planner is not available.", r.error)); return; }
    const items = Array.isArray(r.data) ? r.data : [];
    const next = nextAlarms(items);
    headed(alarmsBox, "Alarms", null,
      next.length ? h("div", { class: "rows" }, next.map(a => {
        const row = mark(h("div", { class: "pl-row", "data-item": a.id },
          h("span", { class: "code pl-time" }, clock(nextAt(a))),
          h("span", { class: "pl-what ellipsis" }, a.title || kindWord(a.kind)), from(a),
          h("span", { class: "lbl" }, a.snooze_until ? "Snoozed" : repeatWord(a.repeat) || when(nextAt(a)))), a);
        row.append(acts(a, row));
        return row;
      })) : h("div", { class: "empty" }, "No alarms set."));
    drawTodos(items);
    drawNotes(items);
  }

  function drawTodos(/** @type {any[]} */ items) {
    const todos = items.filter(i => i.kind === "todo" && i.state === "open");
    if (!todos.length) return headed(todosBox, "Todos", null, h("div", { class: "empty" }, "No open todos. Type “todo …” above."));
    headed(todosBox, "Todos", h("span", { class: "lbl" }, String(todos.length)), h("div", { class: "rows" }, todos.map(t => {
      const row = mark(h("div", { class: "pl-row pl-todo", "data-item": t.id }), t);
      const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", "aria-label": `Done: ${t.title}`, onchange: async () => {
        box.disabled = true;
        row.classList.add("sending");
        const r = await write("planner.done", { item: t.id });
        row.classList.remove("sending");
        if (!ctx.alive()) return;
        if (r.error) { box.checked = false; box.disabled = false; row.setAttribute("title", String(r.error.message || r.error)); return; }
        row.remove();
        toast({ text: `Done: “${nameOf(t)}”`, undo: async () => { if (await change("planner.update", { item: t.id, state: "open" }, null)) refresh(); } });
      } }));
      put(row, box, h("span", { class: "pl-what ellipsis" }, t.title), from(t), t.due ? h("span", { class: "code" }, t.due) : null, acts(t, row));
      return row;
    })));
  }

  function drawNotes(/** @type {any[]} */ items) {
    const notes = sortNotes(items.filter(i => i.kind === "note"));
    if (!notes.length) return headed(notesBox, "Notes", null, h("div", { class: "empty" }, "No notes. Type “note …” above."));
    headed(notesBox, "Notes", null, h("div", { class: "rows" }, notes.map(n => {
      const row = mark(h("div", { class: "pl-note", "data-item": n.id }), n);
      put(row, h("div", { class: "pl-note-head" }, n.pinned ? h("span", { class: "lbl recall pl-pin" }, "Pinned") : null,
        h("span", { class: "pl-what" }, n.title || "Note"), from(n), h("span", { class: "code" }, when(n.updated)), acts(n, row)),
        n.body ? h("p", { class: "small muted pl-body" }, n.body) : null);
      return row;
    })));
  }

  // ---- quick add: words in, a preview of what they mean, Enter adds -----------------------------

  const quickIn = /** @type {HTMLInputElement} */ (h("input", { class: "input", name: "text", autocomplete: "off", "aria-label": "Add to the planner", "data-quick": "1",
    placeholder: "alarm 7am · remind me to call the bank at 6 · todo send the invoice · note printer code 4471" }));
  const preview = h("p", { class: "small muted pl-preview", role: "status", "aria-live": "polite" });
  let previewT = /** @type {any} */ (0), previewSeq = 0;
  const showPreview = () => {
    clearTimeout(previewT);
    const { kind, text: words } = splitKind(quickIn.value);
    if (!words) { put(preview); return; }
    previewT = setTimeout(async () => {
      const seq = ++previewSeq;
      if (kind === "todo" || kind === "note") { put(preview, `${kindWord(kind)}: ${words}`); return; }
      const p = await attempt("planner.parse", { text: words, ...(kind ? { kind } : {}) });
      if (!ctx.alive() || seq !== previewSeq) return;
      put(preview, previewLine(p.error ? null : p.data, words));
    }, 250);
  };
  quickIn.addEventListener("input", showPreview);
  const addForm = h("form", { class: "pl-add", onsubmit: async (/** @type {Event} */ e) => {
    e.preventDefault();
    const raw = quickIn.value.trim();
    if (!raw) return;
    const { kind, text: words } = splitKind(raw);
    if (!words) return;
    // Sending at once; a box out of reach gets it from the outbox when it is back.
    put(note, "Sending");
    quickIn.value = ""; put(preview);
    const a = await write("planner.add", kind ? { text: words, kind } : { text: words });
    if (!ctx.alive()) return;
    if (a.error) { put(note, String(a.error.message || a.error)); if (!quickIn.value) quickIn.value = raw; return; }
    put(note);
    refresh();
  } }, quickIn, h("button", { type: "submit", class: "btn" }, "Add"));
  put(quickBox, addForm, preview, note);

  // ---- the keyboard: n or / to add, arrows to move, Space done, e edit, Backspace delete, p pin ----

  const rowsNow = () => /** @type {HTMLElement[]} */ ([...el.querySelectorAll("[data-item]")].filter(r => /** @type {any} */ (r)._item && !r.querySelector("form")));
  const typing = (/** @type {any} */ t) => /^(INPUT|TEXTAREA|SELECT)$/.test(String(t?.tagName)) || t?.isContentEditable;
  el.addEventListener("keydown", (/** @type {any} */ e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t === quickIn && e.key === "Escape") { quickIn.value = ""; put(preview); quickIn.blur(); return; }
    if (typing(t)) return;
    if (e.key === "n" || e.key === "/") { e.preventDefault(); quickIn.focus(); return; }
    const rows = rowsNow();
    const row = t?.closest?.("[data-item]");
    const i = rows.indexOf(row);
    const go = (/** @type {number} */ j) => { const r = rows[Math.max(0, Math.min(rows.length - 1, j))]; if (r) { for (const x of rows) x.setAttribute("tabindex", "-1"); r.setAttribute("tabindex", "0"); r.focus(); } };
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); go(i < 0 ? 0 : i + 1); return; }
    if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); go(i < 0 ? 0 : i - 1); return; }
    if (e.key === "Home") { e.preventDefault(); go(0); return; }
    if (e.key === "End") { e.preventDefault(); go(rows.length - 1); return; }
    const it = row?._item;
    if (!it) return;
    if (e.key === "e" || e.key === "Enter") { e.preventDefault(); edit(it, row); return; }
    if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); const next = rows[i + 1] || rows[i - 1]; remove(it, row).then(() => { if (next?.getAttribute("data-item")) setTimeout(() => el.querySelector(`[data-item="${next.getAttribute("data-item")}"]`)?.focus?.(), 400); }); return; }
    if (e.key === "p" && it.kind === "note") { e.preventDefault(); change("planner.update", { item: it.id, pinned: !it.pinned }, row).then(ok => { if (ok) refresh(); }); return; }
    if ((e.key === " " || e.key === "x") && (it.kind === "todo" || it.kind === "reminder")) { e.preventDefault(); finish(it, row).then(ok => { if (ok) refresh(); }); }
  });

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
