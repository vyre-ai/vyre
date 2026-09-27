// @ts-check
// Small formatters shared by the views. Plain words, as TOKENS.md's voice asks.

const WORDS = ["Nothing", "One thing", "Two things", "Three things", "Four things", "Five things", "Six things",
  "Seven things", "Eight things", "Nine things", "Ten things"];
const NUM = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** "Two things" for 2; digits past ten. */
export const things = n => WORDS[n] || `${n} things`;
/** "Three" for 3; digits past ten. */
export const count = n => NUM[n] || String(n);
export const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** "14:20" */
// One formatter, made once: toLocaleTimeString builds a new one on every call, which a transcript
// of 2,000 rows scrolled fast felt (chat, native bar budget 6).
let clockFmt = /** @type {Intl.DateTimeFormat|null} */ (null);
export const clock = t => (clockFmt ||= new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })).format(new Date(t));

/** "Friday 26 September · 14:20" */
export function today(t = Date.now()) {
  const d = new Date(t);
  return `${d.toLocaleDateString(undefined, { weekday: "long" })} ${d.getDate()} ${d.toLocaleDateString(undefined, { month: "long" })} · ${clock(t)}`;
}

/** "14:11" today, "Thu" this week, "12 Sep" before that. */
export function when(t) {
  if (!t) return "";
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(t);
  if (now.getTime() - t < 6 * 86400_000) return d.toLocaleDateString(undefined, { weekday: "short" });
  return `${d.getDate()} ${d.toLocaleDateString(undefined, { month: "short" })}`;
}

/** "6 min", "3 h", "2 d" since t. */
export function since(t, now = Date.now()) {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 60) return `${m} min`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr} h`;
  return `${Math.round(hr / 24)} d`;
}

export const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** The last folder of a path, for showing where a thread ran. */
export const base = p => String(p || "").split("/").filter(Boolean).pop() || String(p || "");

/** The one-letter tile for an agent or person. */
export const initial = name => String(name || "?").trim().charAt(0).toLowerCase() || "?";
export const initials = name => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
