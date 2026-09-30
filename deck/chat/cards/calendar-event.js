// @ts-check
// The calendar event card (docs/design/system/components/calendar.md): an existing meeting, read
// only. render kind "calendar_event" {id, title, start, end, tz?, place, join?, attendees:[{name,
// response}], response, needsResponse?, recurring?}. Time is always drawn in the viewer's own zone;
// when the organizer's zone (tz) differs, their clock time sits beside it in the label colour.
//
// The one input this card takes is the person's own answer to the invite: Accept, Maybe, Decline
// call calendar.respond through the outbox, never with a passkey (a real answer to a real invite the
// person is reading, "asking is approving"). There is no agent path: nothing here listens for an
// agent's response, and calendar.respond is a person-only tool at the floor. Past events show no
// footer and no join link.

import { h, put } from "../../js/dom.js";
import { queued } from "../../js/api.js";
import { icon } from "../../js/icons.js";
import { initial } from "../../js/fmt.js";
import { ensureCss, shell, head, untrusted, problemText } from "./kit.js";

/** The join link shows this long before the start. */
export const JOIN_WINDOW = 15 * 60_000;
export const ANSWERS = [
  { act: "accepted", label: "Accept", busy: "Accepting", done: "You accepted" },
  { act: "tentative", label: "Maybe", busy: "Saving", done: "You said maybe" },
  { act: "declined", label: "Decline", busy: "Declining", done: "You declined" },
];
const NEEDS = new Set(["", "needsaction", "needs_action", "none", "invited", "new"]);
const WORD = { accepted: "accepted", tentative: "maybe", declined: "declined", needsaction: "no answer yet", needs_action: "no answer yet", none: "no answer yet", invited: "no answer yet" };

const clockFmt = (/** @type {string|undefined} */ tz) => { try { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false, ...(tz ? { timeZone: tz } : {}) }); } catch { return null; } };

/** "Thu 2 Oct" in the viewer's zone. @param {any} t */
export function dayLabel(t) {
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(d) : "";
}

/**
 * "10:00-10:30 PST" in the viewer's zone, with "13:00 organizer's time" when tz is another zone
 * whose clock differs.
 * @param {any} start @param {any} end @param {string} [tz]
 */
export function timeRange(start, end, tz) {
  const s = new Date(start), e = new Date(end);
  if (!Number.isFinite(s.getTime())) return "";
  const f = clockFmt();
  if (!f) return "";
  let out = f.format(s);
  if (Number.isFinite(e.getTime())) out += `–${f.format(e)}`;
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(s).find(p => p.type === "timeZoneName")?.value;
  if (zone) out += ` ${zone}`;
  const theirs = tz ? clockFmt(tz) : null;
  if (theirs && theirs.format(s) !== f.format(s)) out += ` · ${theirs.format(s)} organizer's time`;
  return out;
}

/** The response word for an attendee: never colour alone. @param {any} r */
export const responseWord = r => WORD[String(r ?? "").toLowerCase().replace(/-/g, "_")] || "no answer yet";
/** @param {any} r */
const responseKind = r => ({ accepted: "done", declined: "failed", tentative: "needs" }[String(r ?? "").toLowerCase()] || "neutral");

/**
 * @param {any} data render payload
 * @param {{ phone?: boolean, open?: (href: string) => void, now?: () => number, readOnly?: boolean }} [ctx]
 */
export function calendarEvent(data, ctx = {}) {
  ensureCss("calendar-event");
  const el = /** @type {any} */ (shell("cv-calendar-event", "Calendar event"));
  const state = { busy: /** @type {string|null} */ (null), error: /** @type {any} */ (null), changing: false, people: false,
    /** what the person answered here (or the card arrived with), lower case */
    response: /** @type {string} */ (""), scope: /** @type {"this"|"all"} */ ("this"), asking: /** @type {string|null} */ (null) };
  const now = () => (ctx.now ? ctx.now() : Date.now());
  const seed = () => { state.response = String(data?.response ?? "").toLowerCase(); };
  seed();

  const past = () => { const e = new Date(data?.end ?? data?.start).getTime(); return Number.isFinite(e) && e < now(); };
  const needs = () => !past() && data?.needsResponse !== false && (state.changing || NEEDS.has(state.response));

  /** @param {string} act */
  async function respond(act) {
    if (ctx.readOnly || state.busy) return;
    if (data?.recurring && !state.asking) { state.asking = act; draw(); return; }
    state.asking = null; state.busy = act; state.error = null; draw();
    // The person's own answer: outbox, never a passkey.
    const r = await queued("calendar.respond", { event: data?.id, response: act, ...(data?.recurring ? { scope: state.scope } : {}), surface: "deck" }, { presence: false });
    state.busy = null;
    if (r.error) { state.error = r.error; draw(); return; }
    state.response = act; state.changing = false; draw();
  }

  function when_() {
    const t = timeRange(data?.start, data?.end, data?.tz);
    const startsIn = new Date(data?.start).getTime() - now();
    const join = typeof data?.join === "string" && /^https:\/\//.test(data.join) && !past() && startsIn <= JOIN_WINDOW;
    const place = data?.place ? untrusted(data.place, 200) : "";
    return h("div", { class: "cv-ce-when" },
      h("span", null, [t, place].filter(Boolean).join(" · ")),
      join ? h("button", { class: "btn btn-ghost btn-sm cv-ce-join", type: "button", "data-act": "join", onclick: () => ctx.open?.(data.join) }, "Join") : null);
  }

  function people() {
    const list = Array.isArray(data?.attendees) ? data.attendees : [];
    if (!list.length) return null;
    const shown = list.slice(0, 5), more = list.length - shown.length;
    return h("div", { class: "cv-ce-people" },
      h("button", { class: "cv-ce-stack", type: "button", "aria-expanded": String(state.people), onclick: () => { state.people = !state.people; draw(); } },
        h("span", { class: "cv-ce-avs", "aria-hidden": "true" }, shown.map((/** @type {any} */ a) => h("span", { class: "cv-ce-av" }, initial(a?.name)))),
        more > 0 ? h("span", { class: "cv-ce-more" }, `+${more}`) : null,
        h("span", { class: "cv-ce-count" }, `${list.length} ${list.length === 1 ? "person" : "people"}`)),
      state.people ? h("ul", { class: "cv-ce-list", role: "list" }, list.map((/** @type {any} */ a) => h("li", { class: "cv-ce-person" },
        h("span", { class: "cv-ce-pname ellipsis" }, untrusted(a?.name ?? a, 120)),
        h("span", { class: "cv-ce-presp" }, h("span", { class: `cv-mark cv-mark-${responseKind(a?.response)}`, "aria-hidden": "true" }), responseWord(a?.response))))) : null);
  }

  function foot() {
    if (ctx.readOnly) return null;
    if (state.asking) {
      // A recurring event asks which one first: two options inline, not a sheet.
      const a = ANSWERS.find(x => x.act === state.asking);
      return h("div", { class: "cv-ce-foot cv-ce-scope", role: "group", "aria-label": `${a?.label} for` },
        h("span", { class: "cv-ce-ask" }, `${a?.label} for`),
        h("button", { class: "btn", type: "button", "data-scope": "this", onclick: () => { state.scope = "this"; respond(/** @type {string} */ (state.asking)); } }, "This event"),
        h("button", { class: "btn", type: "button", "data-scope": "all", onclick: () => { state.scope = "all"; respond(/** @type {string} */ (state.asking)); } }, "All events"),
        h("button", { class: "btn btn-ghost", type: "button", onclick: () => { state.asking = null; draw(); } }, "Back"));
    }
    if (needs()) {
      return h("div", { class: "cv-ce-foot", role: "group", "aria-label": "Your answer" }, ANSWERS.map(a => {
        const busy = state.busy === a.act;
        return h("button", { class: "btn cv-ce-btn" + (busy ? " cv-ask-busy" : ""), type: "button", "data-act": a.act, disabled: !!state.busy, "aria-busy": busy ? "true" : null,
          onclick: () => respond(a.act) }, busy ? [h("span", { class: "cv-ask-spin", "aria-hidden": "true" }), a.busy] : a.label);
      }));
    }
    const done = ANSWERS.find(a => a.act === state.response);
    if (done && !past()) return h("div", { class: "cv-ce-foot cv-ce-done" }, icon("check", 14), h("span", null, done.done),
      h("button", { class: "cv-ce-change", type: "button", onclick: () => { state.changing = true; draw(); } }, "Change"));
    return null;
  }

  function draw() {
    put(el,
      head({ icon: "planner", title: untrusted(data?.title || "(no title)", 200), meta: [dayLabel(data?.start), data?.recurring ? "repeats" : ""].filter(Boolean).join(" · ") }),
      h("div", { class: "cv-ce-body" }, when_(), people()),
      foot(),
      state.error ? h("div", { class: "cv-ce-err", role: "alert" }, h("span", { class: "cv-mark cv-mark-failed", "aria-hidden": "true" }), problemText(state.error)) : null);
  }

  el.update = (/** @type {any} */ d) => { data = d; if (!state.busy) seed(); draw(); };
  draw();
  return el;
}
