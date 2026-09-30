// @ts-check
// Today's next meetings from every calendar the person connected, for the Capsule's `next` command.
// Pure: this file shapes what Microsoft Graph and Google Calendar answer and merges it; the module
// makes the calls (through vault.request, as a reader the person named when they connected).

const toMs = v => Date.parse(String(v || "")) || 0;

/** "in 10 min", "in 3 h", or "now, ends in 20 min". @param {number} startMs @param {number} endMs @param {number} at */
export function whenText(startMs, endMs, at) {
  const mins = Math.round((startMs - at) / 60_000);
  if (mins <= 0) return `now, ends in ${Math.max(1, Math.round((endMs - at) / 60_000))} min`;
  return mins < 90 ? `in ${mins} min` : `in ${Math.round(mins / 60)} h`;
}

const httpsOnly = u => (typeof u === "string" && /^https:\/\//.test(u) ? u : "");

/**
 * Graph's calendarView answer, asked with `Prefer: outlook.timezone="UTC"`, so its times are UTC
 * without a Z. All-day and cancelled events are left out.
 * @param {any} body @param {string} account
 */
export function fromGraph(body, account) {
  const out = [];
  for (const e of (body && Array.isArray(body.value) ? body.value : [])) {
    if (!e || e.isCancelled || e.isAllDay || !e.start || !e.start.dateTime) continue;
    const z = s => (/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(s)) ? String(s) : `${String(s).split(".")[0]}Z`);
    const join = httpsOnly(e.onlineMeeting && e.onlineMeeting.joinUrl) || httpsOnly(e.onlineMeetingUrl) || httpsOnly(e.location && e.location.displayName);
    out.push({ id: String(e.id), account, title: String(e.subject || "(no title)"), start: z(e.start.dateTime), end: z((e.end && e.end.dateTime) || e.start.dateTime),
      ...(join ? { join } : {}), link: join || httpsOnly(e.webLink) });
  }
  return out;
}

/** Google Calendar's events.list answer. @param {any} body @param {string} account */
export function fromGoogle(body, account) {
  const out = [];
  for (const e of (body && Array.isArray(body.items) ? body.items : [])) {
    if (!e || e.status === "cancelled" || !e.start || !e.start.dateTime) continue;
    const video = ((e.conferenceData && e.conferenceData.entryPoints) || []).find(p => p && p.entryPointType === "video");
    const join = httpsOnly(e.hangoutLink) || httpsOnly(video && video.uri) || httpsOnly(e.location);
    out.push({ id: String(e.id), account, title: String(e.summary || "(no title)"), start: String(e.start.dateTime), end: String((e.end && e.end.dateTime) || e.start.dateTime),
      ...(join ? { join } : {}), link: join || httpsOnly(e.htmlLink) });
  }
  return out;
}

/**
 * The meetings still to come or running, in order, cut to `limit`, each with its `when`.
 * @param {any[]} events @param {number} at @param {number} limit
 */
export function upNext(events, at, limit) {
  return events.filter(e => toMs(e.end || e.start) > at).sort((a, b) => toMs(a.start) - toMs(b.start)).slice(0, limit)
    .map(e => ({ ...e, when: e.when || whenText(toMs(e.start), toMs(e.end || e.start), at) }));
}

/** The two requests, for the calls the module makes. @param {string} fromIso @param {string} toIso */
export function requests(fromIso, toIso) {
  return {
    graph: { method: "GET", url: "https://graph.microsoft.com/v1.0/me/calendarView", headers: { Prefer: 'outlook.timezone="UTC"' },
      query: { startDateTime: fromIso, endDateTime: toIso, $top: 10, $orderby: "start/dateTime", $select: "id,subject,start,end,isAllDay,isCancelled,onlineMeeting,onlineMeetingUrl,location,webLink" } },
    google: { method: "GET", url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      query: { singleEvents: true, orderBy: "startTime", timeMin: fromIso, timeMax: toIso, maxResults: 10 } },
  };
}
