// @ts-check
// Google Calendar's event shape <-> a Vyre Event record's data. Pure. An all-day event has `date`, a timed one `dateTime` with an offset.

/**
 * @param {any} g a Google Calendar event @param {string} [calendar] @param {string} [zone] the calendar's own time zone (the list's `timeZone`), used when the event names none
 * @returns {Record<string, any> | null} the Event record's data, or null for one that cannot be shown (no start). Times are UTC ISO; `time_zone` is the zone the event was made in (its own, else the calendar's), so a screen can show "9:00 am PT"; an all-day event is date only and has none.
 */
export function fromGoogle(g, calendar, zone) {
  const s = g.start || {}, e = g.end || {};
  const allDay = Boolean(s.date && !s.dateTime);
  const start = allDay ? `${s.date}T00:00:00Z` : s.dateTime;
  if (!start) return null;
  const end = allDay ? (e.date ? `${e.date}T00:00:00Z` : undefined) : e.dateTime;
  const people = (g.attendees || []).map((/** @type {any} */ a) => String(a.email || "").toLowerCase()).filter(Boolean);
  return {
    title: g.summary || "(no title)", starts_at: new Date(start).toISOString(), ...(end ? { ends_at: new Date(end).toISOString() } : {}), all_day: allDay,
    ...(!allDay && (s.timeZone || zone) ? { time_zone: String(s.timeZone || zone) } : {}), ...(g.location ? { place: g.location } : {}), ...(people.length ? { people } : {}),
    ...(g.description ? { notes: g.description } : {}), ...(typeof g.htmlLink === "string" && /^https?:\/\//.test(g.htmlLink) ? { url: g.htmlLink } : {}), source: "google", calendar, external_id: g.id,
  };
}

/** @param {Record<string, any>} d an Event record's data @returns {any} the body for Google's insert or patch */
export function toGoogle(d) {
  const tz = d.time_zone || null;
  const day = (/** @type {string} */ iso) => iso.slice(0, 10);
  const when = (/** @type {string} */ iso) => (d.all_day ? { date: day(iso) } : { dateTime: iso, ...(tz ? { timeZone: tz } : {}) });
  return {
    summary: d.title, ...(d.place ? { location: d.place } : {}), ...(d.notes ? { description: d.notes } : {}),
    start: when(d.starts_at), end: when(d.ends_at || d.starts_at),
    ...(d.people && d.people.length ? { attendees: d.people.map((/** @type {string} */ email) => ({ email })) } : {}),
  };
}
