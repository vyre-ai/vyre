// @ts-check
// The pure half of the shared date and time picker: days as 2026-10-28, a time as 14:15, the month grid, the 15-minute steps and the quick choices. The picker (DateTimePicker.tsx) only draws these.

const p2 = (/** @type {number} */ n) => String(n).padStart(2, "0");
/** 2026-10-28 for a Date, in this device's zone. @param {Date} d */
export const dayText = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
/** The day a text is, or null: 2026-10-28 only, and only a real day. @param {string} s */
export function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? dayText(d) : null;
}

/** A typed time as 24-hour HH:MM, or null: "14:15", "2:15pm", "2pm", "1415", "9". @param {string} s */
export function parseTime(s) {
  const m = /^\s*(\d{1,2})(?::?(\d{2}))?\s*([ap])?\.?m?\.?\s*$/i.exec(String(s ?? ""));
  if (!m) return null;
  let h = Number(m[1]); const min = m[2] === undefined ? 0 : Number(m[2]);
  if (min > 59) return null;
  if (m[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (m[3].toLowerCase() === "p" ? 12 : 0); }
  if (h > 23) return null;
  return `${p2(h)}:${p2(min)}`;
}

/** The time one 15-minute step on, or back (wraps within the day). @param {string} t HH:MM @param {1 | -1} dir */
export function stepTime(t, dir) {
  const v = parseTime(t) ?? "09:00";
  const mins = Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
  const next = dir > 0 ? (Math.floor(mins / 15) + 1) * 15 : (Math.ceil(mins / 15) - 1) * 15;
  const w = ((next % 1440) + 1440) % 1440;
  return `${p2(Math.floor(w / 60))}:${p2(w % 60)}`;
}

/** "2:15 pm" for 14:15. @param {string} t */
export const timeWords = (t) => { const v = parseTime(t); if (!v) return ""; const h = Number(v.slice(0, 2)); return `${h % 12 || 12}:${v.slice(3)} ${h < 12 ? "am" : "pm"}`; };

/** The grid of a month, Monday first: blanks, then each day as 2026-10-28. @param {number} y @param {number} m 0 to 11 */
export function monthCells(y, m) {
  const lead = (new Date(y, m, 1).getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  return /** @type {(string | null)[]} */ ([...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => dayText(new Date(y, m, i + 1)))]);
}

/** The month n months on, or back. @param {{ y: number, m: number }} s @param {number} n */
export const shiftMonth = (s, n) => { const d = new Date(s.y, s.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; };

/** Today, Tomorrow and Next week (the coming Monday). @param {number} now @returns {{ label: string, value: string }[]} */
export function quickDays(now) {
  const at = (/** @type {number} */ n) => { const d = new Date(now); d.setDate(d.getDate() + n); return dayText(d); };
  const w = new Date(now); const toMon = (8 - w.getDay()) % 7 || 7;
  return [{ label: "Today", value: at(0) }, { label: "Tomorrow", value: at(1) }, { label: "Next week", value: at(toMon) }];
}

/** The key a calendar day answers: arrows move by a day or a week. Returns the new day, or null for any other key. @param {string} day @param {string} key */
export function keyDay(day, key) {
  const by = /** @type {Record<string, number>} */ ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 })[key];
  const d = parseDay(day);
  if (by === undefined || !d) return null;
  const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + by);
  return dayText(x);
}

/** The zone a value is read in, by name (the Space's when given, else this device's). @param {string} [zone] */
export const zoneName = (zone) => zone || (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "") || "UTC";
