// @ts-check
// find: what the Capsule's words mean for Google, and the rows it shows.
//
// The Capsule asks every results provider as the person types (ModuleProviders.swift in
// local/capsule/native), so this stays small and predictable: a few phrases with a fixed meaning
// ("what's next", "today", "email from dana"), and anything else is a search of both the calendar
// and the mail, a few rows each. A row's id carries the account, the kind and Google's id, so google.open needs nothing
// else to find it again.

/**
 * What a query asks for.
 * @param {string} q
 * @returns {{ kind: "next" } | { kind: "day", offset: number } | { kind: "mail", q: string } | { kind: "both", q: string }}
 */
export function parse(q) {
  const s = String(q || "").trim().toLowerCase().replace(/[?!.]+$/, "").replace(/\s+/g, " ");
  if (/^(?:what'?s |what is )?(?:up )?next(?: (?:meeting|event|call|thing|on (?:my )?calendar))?$/.test(s) || /^(?:upcoming|my next meeting|next up)$/.test(s)) return { kind: "next" };
  const day = /^(?:(?:what'?s|what is) (?:on )?|(?:my )?(?:meetings?|events?|calendar|schedule|agenda) (?:for )?)?(today|tomorrow)$/.exec(s)
    || /^(today|tomorrow)'?s? (?:meetings?|events?|calendar|schedule|agenda)$/.exec(s);
  if (day) return { kind: "day", offset: day[1] === "today" ? 0 : 1 };
  const from = /^(?:(?:e-?mails?|mails?|messages?) )?from (.+)$/.exec(s);
  if (from) return { kind: "mail", q: `from:${quote(from[1])}` };
  const about = /^(?:e-?mails?|mails?|messages?) (?:about|re|on|with|regarding) (.+)$/.exec(s);
  if (about) return { kind: "mail", q: about[1] };
  if (/^(?:e-?mails?|mail|inbox|unread)$/.test(s)) return { kind: "mail", q: s === "unread" ? "is:unread" : "in:inbox" };
  return { kind: "both", q: String(q).trim() };
}

/** One Gmail operand: a single word as is, several words quoted, quotes dropped. */
const quote = v => { const t = v.replace(/"/g, "").trim(); return /\s/.test(t) ? `"${t}"` : t; };

/** A row id: google:<account>:<event|mail>:<google id>. */
export const rowId = (account, kind, id) => `google:${account}:${kind}:${id}`;

/** @returns {{ account: string, kind: "event" | "mail", id: string } | null} */
export function parseRowId(v) {
  const m = /^(?:google:)?([a-z][a-z0-9-]{0,31}):(event|mail):([A-Za-z0-9_@.-]{1,256})$/.exec(String(v || ""));
  return m ? { account: m[1], kind: /** @type {"event" | "mail"} */ (m[2]), id: m[3] } : null;
}

const pad = n => String(n).padStart(2, "0");

/** "Mon 28 Sep 10:00" in this machine's time, or the date alone for an all-day event. */
export function whenText(v, now = Date.now()) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
    const d = new Date(`${v}T00:00:00`);
    return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}, all day`;
  }
  const d = new Date(String(v));
  if (!Number.isFinite(d.getTime())) return "";
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const days = Math.round((that.getTime() - today.getTime()) / 86_400_000);
  const label = days === 0 ? "Today" : days === 1 ? "Tomorrow" : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return `${label} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** How long ago a message came, in words a glance can take. */
export function agoText(date, now = Date.now()) {
  const ms = now - Date.parse(String(date));
  if (!Number.isFinite(ms)) return "";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 14 ? `${d} d ago` : new Date(Date.parse(String(date))).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** A Capsule row for an event. */
export function eventRow(e, now, many) {
  const bits = [whenText(e.start, now), e.where, many ? e.account : ""].filter(Boolean);
  return { id: rowId(e.account, "event", e.id), name: e.title, kind: "event", sub: bits.join(" · ") };
}

/** A Capsule row for a message. */
export function mailRow(m, now, many, nameOf) {
  const bits = [nameOf(m.from), agoText(m.date, now), many ? m.account : ""].filter(Boolean);
  return { id: rowId(m.account, "mail", m.id), name: m.subject, kind: "email", sub: bits.join(" · ") };
}
