// @ts-check
// calendar: Google Calendar v3 reads and writes, shaped small for a model to read.
//
// Reads use calendar.readonly and go to every account unless one is named, merged and sorted by
// start. Writes use calendar.events. Whether a write needs the Gate is decided in index.js, not
// here: this file only knows how to talk to Calendar, and `sendUpdates` is always a parameter,
// so nothing here can send an invite unless the caller asked for "all".

const PRIMARY = "/calendar/v3/calendars/primary/events";
const DAY = 86_400_000;

import { meetingLink } from "../../lib/connectors/calendar.js";

/** @typedef {import("./api.js").Account} Account */

/** An event the way a model wants it: who, when, where, and a link. */
export function shapeEvent(acct, e) {
  const video = (e.conferenceData?.entryPoints || []).find(p => p.entryPointType === "video")?.uri;
  const https = u => (typeof u === "string" && /^https:\/\//.test(u) ? u : "");
  const join = https(e.hangoutLink) || https(video) || meetingLink(e.location);
  const where = e.location || e.hangoutLink || (e.conferenceData?.entryPoints || []).find(p => p.entryPointType === "video")?.uri || "";
  return {
    id: String(e.id), account: acct.name, title: String(e.summary || "(no title)"),
    start: e.start?.dateTime || e.start?.date || "", end: e.end?.dateTime || e.end?.date || "",
    ...(where ? { where: String(where) } : {}),
    // The meeting's own link: the one Google made or a conference add-on named, else a location only on a known meeting host.
    ...(join ? { join } : {}),
    ...((e.attendees || []).some(a => a && a.self && a.responseStatus === "declined") ? { declined: true } : {}),
    attendees: (e.attendees || []).filter(a => a && a.email && !a.resource).map(a => String(a.email)),
    url: String(e.htmlLink || eventUrl(acct, e.id)),
  };
}

/** Calendar's own link form, for the rare event without htmlLink: eid is base64 of "<id> <calendar>". */
const eventUrl = (acct, id) => `https://calendar.google.com/calendar/event?eid=${Buffer.from(`${id} ${acct.email}`).toString("base64url")}`;

const startMs = ev => Date.parse(ev.start) || 0;

/** A time as Calendar takes it: a date alone is all-day, anything else a dateTime. */
export function when(v, timeZone) {
  const s = String(v || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { date: s };
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw Object.assign(new Error(`"${s.slice(0, 40)}" is not a time; use ISO 8601 such as 2026-10-01T15:00:00-07:00`), { code: "bad_input" });
  return { dateTime: /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : new Date(ms).toISOString(), ...(timeZone ? { timeZone } : {}) };
}

/** The end when none was given: an hour after a timed start, the next day after an all-day one. */
export function defaultEnd(start) {
  if (start.date) return { date: new Date(Date.parse(start.date + "T00:00:00Z") + DAY).toISOString().slice(0, 10) };
  return { dateTime: new Date(Date.parse(start.dateTime) + 3_600_000).toISOString(), ...(start.timeZone ? { timeZone: start.timeZone } : {}) };
}

/**
 * @param {{ request: (acct: Account, req: import("./api.js").Request) => Promise<any>, now: () => number }} deps
 */
export function calendar({ request, now }) {
  /** Events in one account's primary calendar, as Calendar orders them. */
  async function events(acct, { from, to, q, limit }) {
    const r = await request(acct, { api: "calendar", scope: "calendar.readonly", path: PRIMARY, query: {
      singleEvents: true, orderBy: "startTime", maxResults: limit, timeMin: from, timeMax: to, q } });
    return (r.items || []).filter(e => e.status !== "cancelled").map(e => shapeEvent(acct, e));
  }

  /** The same read on every account, merged by start. One account failing does not hide the rest. */
  async function across(accts, query) {
    const errors = [];
    const lists = await Promise.all(accts.map(a => events(a, query).catch(e => { errors.push({ account: a.name, error: String(e.message || e) }); return []; })));
    if (errors.length === accts.length) throw Object.assign(new Error(errors.map(e => `${e.account}: ${e.error}`).join("; ")), { code: "google" });
    const merged = lists.flat().sort((a, b) => startMs(a) - startMs(b)).slice(0, query.limit);
    return { events: merged, ...(errors.length ? { errors } : {}) };
  }

  return {
    next: (accts, { limit = 5 } = {}) => across(accts, { from: new Date(now()).toISOString(), limit }),
    list: (accts, { from, to, limit = 25 }) => across(accts, { from: iso(from, "from"), to: iso(to, "to"), limit }),
    search: (accts, { q, from, to, limit = 10 }) => across(accts, { q, limit,
      from: from ? iso(from, "from") : new Date(now() - 30 * DAY).toISOString(), to: to ? iso(to, "to") : undefined }),

    /** One event, by id. */
    get: async (acct, id) => shapeEvent(acct, await request(acct, { api: "calendar", scope: "calendar.readonly", path: `${PRIMARY}/${encodeURIComponent(id)}` })),

    /**
     * Create or change an event. `sendUpdates` is "none" unless the Gate released it.
     * @param {Account} acct @param {{ op: "create" | "update", event_id?: string, fields: any, attendees?: string[], sendUpdates: "none" | "all" }} w
     */
    async write(acct, { op, event_id, fields, attendees, sendUpdates }) {
      const body = { ...fields, ...(attendees !== undefined ? { attendees: attendees.map(email => ({ email })) } : {}) };
      const r = op === "create"
        ? await request(acct, { api: "calendar", scope: "calendar.events", method: "POST", path: PRIMARY, query: { sendUpdates }, body })
        : await request(acct, { api: "calendar", scope: "calendar.events", method: "PATCH", path: `${PRIMARY}/${encodeURIComponent(String(event_id))}`, query: { sendUpdates }, body });
      return shapeEvent(acct, r);
    },
  };
}

/** Calendar's fields from the tool's words: title, start, end, where, description. */
export function fieldsOf(input, { create }) {
  const out = {};
  if (input.title !== undefined) out.summary = String(input.title);
  if (input.start !== undefined) out.start = when(input.start, input.time_zone);
  if (input.end !== undefined) out.end = when(input.end, input.time_zone);
  else if (create && out.start) out.end = defaultEnd(out.start);
  if (input.where !== undefined) out.location = String(input.where);
  if (input.description !== undefined) out.description = String(input.description);
  if (create && !out.start) throw Object.assign(new Error("an event needs a start"), { code: "bad_input" });
  if (create && !out.summary) throw Object.assign(new Error("an event needs a title"), { code: "bad_input" });
  return out;
}

function iso(v, what) {
  const ms = Date.parse(String(v || ""));
  if (!Number.isFinite(ms)) throw Object.assign(new Error(`${what} must be a time, such as 2026-10-01T09:00:00Z`), { code: "bad_input" });
  return new Date(ms).toISOString();
}

/** The start and end of a local day, `offset` days from today. */
export function dayRange(now, offset) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  const end = new Date(d);
  end.setDate(end.getDate() + 1);
  return { from: d.toISOString(), to: end.toISOString() };
}
