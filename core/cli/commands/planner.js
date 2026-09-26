// @ts-check
// `vyre alarm`, `timer`, `remind`, `todo`, `notes`, `agenda` and `snooze`: the planner from the
// terminal (docs/adr/0025-planner.md). Words go to planner.parse and planner.add; times print in
// the planner's zone, never this machine's, since the box keeps the time.

import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { json, emit, fail, failTool, usage } from "../kit.js";

const EXIT_FAILED = 1;

// ---- Times in the planner's zone ------------------------------------------------------------

const parts = (ms, tz, o) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...o }).formatToParts(ms).map(p => [p.type, p.value]));
/** "07:00" in the zone. */
export const clock = (ms, tz) => { const p = parts(ms, tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); return `${p.hour}:${p.minute}`; };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Fri 25 Sep" in the zone. Names are ours: ICU versions disagree ("Sep" or "Sept"). */
export const day = (ms, tz) => {
  const p = parts(ms, tz, { year: "numeric", month: "numeric", day: "numeric" });
  const y = Number(p.year), m = Number(p.month), d = Number(p.day);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
};
/** "2026-09-25" in the zone. */
export const dateIn = (ms, tz) => { const p = parts(ms, tz, { year: "numeric", month: "2-digit", day: "2-digit" }); return `${p.year}-${p.month}-${p.day}`; };
const when = (ms, tz) => `${day(ms, tz)} ${clock(ms, tz)}`;
/** "Fri 25 Sep" for a YYYY-MM-DD due date, read as a calendar day. */
const dueDay = d => { const ms = Date.parse(d + "T12:00:00Z"); return Number.isNaN(ms) ? d : day(ms, "UTC"); };

/** "weekdays", "every day", "Sun and Sat". */
export function repeatWords(r) {
  if (!r) return "";
  const n = r.interval && r.interval > 1 ? r.interval : 1;
  if (r.every === "day") return n > 1 ? `every ${n} days` : "every day";
  if (r.every === "weekday") return "weekdays";
  if (r.every === "week") {
    const days = [...(r.days || [])].sort();
    if (days.join() === "0,6") return "weekends";
    const names = days.map(d => WEEKDAYS[d]).join(", ");
    return (n > 1 ? `every ${n} weeks` : "every week") + (names ? ` on ${names}` : "");
  }
  if (r.every === "month") return n > 1 ? `every ${n} months` : "monthly";
  if (r.every === "year") return "yearly";
  return String(r.every || "");
}

const PRIORITY = ["", "!", "!!", "!!!"];

// ---- Shared -----------------------------------------------------------------------------------

/** The planner's zone. @returns {Promise<{ tz?: string, error?: any }>} */
async function zone() {
  const r = await call("planner.settings", {});
  if (r.error) return { error: r.error };
  return { tz: r.data.timezone };
}

/** Words and --json apart. */
const words = args => args.filter(a => a !== "--json");

/** Try each text with planner.parse; the first that reads as `kind` (with a time, when `timed`). */
async function readAs(kind, texts, timed = true) {
  for (const text of texts) {
    const r = await call("planner.parse", { text });
    if (r.error) return { error: r.error };
    const p = r.data;
    if (p && p.kind === kind && (!timed || p.at)) return { text, parsed: p };
  }
  return { text: texts[0], parsed: null };
}

const notUnderstood = (what, text, next) => fail(`could not read ${what} in "${text}"`, { code: "not_understood", exit: EXIT_FAILED, next });

/** One timed item, as it was set. */
function setLine(kind, item, tz) {
  const t = item.next_fire ?? item.at;
  const rep = item.repeat ? dim(" · " + repeatWords(item.repeat)) : "";
  const title = item.title && !["Alarm", "Timer"].includes(item.title) ? `  ${item.title}` : "";
  out(`  ${signal(kind)} ${bold(when(t, tz))}${rep}${title}  ${dim(item.id)}`);
}

// ---- alarm ------------------------------------------------------------------------------------

async function alarm(args) {
  const w = words(args);
  if (!w.length || w[0] === "list" || w[0] === "ls") return listAlarms();
  if (w[0] === "off") {
    if (!w[1]) return usage("vyre alarm off needs an alarm's id", "vyre alarm lists them");
    const r = await call("planner.update", { item: w[1], state: "cancelled" });
    if (r.error) return failTool(r.error);
    if (json()) return emit(r.data);
    out(`  alarm off ${dim(r.data.id)}`);
    return 0;
  }
  const z = await zone();
  if (z.error) return failTool(z.error);
  const said = w.join(" ");
  const got = await readAs("alarm", ["alarm " + said, said]);
  if (got.error) return failTool(got.error);
  if (!got.parsed) return notUnderstood("a time", said, "vyre alarm 7am, vyre alarm 6:30 weekdays");
  const r = await call("planner.add", { text: got.text });
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data);
  setLine("alarm", r.data, /** @type {string} */ (z.tz));
  return 0;
}

async function listAlarms() {
  const r = await call("planner.list", { kind: "alarm" });
  if (r.error) return failTool(r.error);
  const z = await zone();
  if (z.error) return failTool(z.error);
  const tz = /** @type {string} */ (z.tz);
  const rows = r.data.filter(a => (a.next_fire ?? a.at) != null).sort((a, b) => (a.next_fire ?? a.at) - (b.next_fire ?? b.at));
  if (json()) return emit({ tz, alarms: rows });
  if (!rows.length) { out(dim("  no alarms set · vyre alarm 7am sets one")); return 0; }
  for (const a of rows) {
    const t = a.next_fire ?? a.at;
    const rep = a.repeat ? repeatWords(a.repeat) : "once";
    const title = a.title && a.title !== "Alarm" ? a.title : "";
    out(`  ${bold(clock(t, tz))}  ${rep.padEnd(10)} ${dim("next " + day(t, tz))}${title ? "  " + title : ""}  ${dim(a.id)}`);
  }
  out(dim(`\n  ${tz} · vyre alarm off <id> turns one off`));
  return 0;
}

// ---- timer ------------------------------------------------------------------------------------

async function timer(args) {
  const w = words(args);
  if (!w.length) return usage("vyre timer needs a length", "vyre timer 10m, vyre timer 25m bread");
  const z = await zone();
  if (z.error) return failTool(z.error);
  // The longest opening that reads as a duration; what follows is the label.
  let found = null;
  for (let n = Math.min(w.length, 6); n >= 1 && !found; n--) {
    const got = await readAs("timer", ["timer " + w.slice(0, n).join(" ")]);
    if (got.error) return failTool(got.error);
    if (got.parsed && got.parsed.duration_ms) found = { ms: got.parsed.duration_ms, rest: w.slice(n), title: got.parsed.title !== "Timer" ? got.parsed.title : "" };
  }
  if (!found) return notUnderstood("a length", w.join(" "), "vyre timer 10m, vyre timer 1h30m");
  const label = found.rest.join(" ").replace(/^for\s+/i, "").trim() || found.title || "";
  const r = await call("planner.add", { kind: "timer", in_ms: found.ms, ...(label ? { title: label } : {}) });
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data);
  const mins = Math.round(found.ms / 60_000);
  const len = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}` : mins >= 1 ? `${mins}m` : `${Math.round(found.ms / 1000)}s`;
  const tz = /** @type {string} */ (z.tz);
  out(`  ${signal("timer")} ${bold(len)} ${dim("rings at")} ${clock(r.data.at, tz)}${label ? "  " + label : ""}  ${dim(r.data.id)}`);
  return 0;
}

// ---- remind -----------------------------------------------------------------------------------

async function remind(args) {
  const w = words(args);
  if (!w.length) return usage("vyre remind needs what and when", `vyre remind "call juno" at 6 · vyre remind me in 20 minutes to check the oven`);
  const z = await zone();
  if (z.error) return failTool(z.error);
  const said = w.join(" ");
  const texts = /^me\b/i.test(said) ? ["remind " + said] : ["remind me to " + said, "remind me " + said, "remind " + said];
  const got = await readAs("reminder", texts);
  if (got.error) return failTool(got.error);
  if (!got.parsed) return notUnderstood("a time", said, `vyre remind "call juno" at 6 · vyre remind me tomorrow at 9 to email juno`);
  const r = await call("planner.add", { text: got.text });
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data);
  setLine("reminder", r.data, /** @type {string} */ (z.tz));
  return 0;
}

// ---- todo -------------------------------------------------------------------------------------

async function todo(args) {
  const [verb, ...rest] = words(args);
  if (!verb || verb === "list" || verb === "ls") return listTodos();
  if (verb === "add") {
    const text = rest.join(" ").trim();
    if (!text) return usage("vyre todo add needs what to do", "vyre todo add buy flour !high");
    const got = await readAs("todo", ["todo " + text], false);
    if (got.error) return failTool(got.error);
    const r = await call("planner.add", got.parsed ? { text: got.text } : { kind: "todo", title: text });
    if (r.error) return failTool(r.error);
    if (json()) return emit(r.data);
    out(`  ${signal("todo")} ${todoLine(r.data)}`);
    return 0;
  }
  if (verb === "done") {
    if (!rest[0]) return usage("vyre todo done needs a todo's id", "vyre todo lists them");
    const r = await call("planner.done", { item: rest[0] });
    if (r.error) return failTool(r.error);
    if (json()) return emit(r.data);
    if (r.data.already) { out(dim(`  already ${r.data.action || r.data.state}`)); return 0; }
    out(`  ${signal("done")} ${r.data.item.title}  ${dim(r.data.item.id)}`);
    return 0;
  }
  return usage(`vyre todo ${verb}: not a subcommand`, "vyre todo, vyre todo add <text>, vyre todo done <id>");
}

const todoLine = t => [t.title, t.priority ? beacon(PRIORITY[t.priority]) : "", t.due ? dim("due " + dueDay(t.due)) : "", dim(t.id)].filter(Boolean).join("  ");

async function listTodos() {
  const r = await call("planner.list", { kind: "todo", limit: 500 });
  if (r.error) return failTool(r.error);
  /** @type {Map<string, any[]>} */
  const lists = new Map();
  for (const t of r.data) {
    const k = t.list || "";
    if (!lists.has(k)) lists.set(k, []);
    /** @type {any[]} */ (lists.get(k)).push(t);
  }
  // The unnamed list first, then the rest by name; inside each, highest priority then soonest due.
  const names = [...lists.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  const order = (a, b) => b.priority - a.priority || (a.due || "9999").localeCompare(b.due || "9999") || a.created - b.created;
  const groups = names.map(n => ({ list: n || null, todos: /** @type {any[]} */ (lists.get(n)).sort(order) }));
  if (json()) return emit({ lists: groups });
  if (!groups.length) { out(dim("  nothing to do · vyre todo add <text> adds one")); return 0; }
  for (const g of groups) {
    out(`\n  ${bold(g.list || "todo")} ${dim(String(g.todos.length))}`);
    for (const t of g.todos) out(`    ${dim("[ ]")} ${todoLine(t)}`);
  }
  out(dim("\n  vyre todo done <id> finishes one\n"));
  return 0;
}

// ---- notes ------------------------------------------------------------------------------------

async function notes(args) {
  const [verb, ...rest] = words(args);
  if (!verb || verb === "list" || verb === "ls") return listNotes();
  if (verb === "add") {
    const text = rest.join(" ").trim();
    if (!text) return usage("vyre notes add needs the note", "vyre notes add kit prefers mornings");
    const r = await call("planner.add", { kind: "note", title: text });
    if (r.error) return failTool(r.error);
    if (json()) return emit(r.data);
    out(`  ${signal("note")} ${r.data.title}  ${dim(r.data.id)}`);
    return 0;
  }
  if (verb === "show") {
    if (!rest[0]) return usage("vyre notes show needs a note's id", "vyre notes lists them");
    const r = await call("planner.get", { item: rest[0] });
    if (r.error) return failTool(r.error);
    if (json()) return emit(r.data);
    const n = r.data.item;
    const z = await zone();
    const tz = z.tz || "UTC";
    out(`\n  ${n.pinned ? signal("pinned ") : ""}${bold(n.title)}`);
    if (n.body) out("\n" + String(n.body).split("\n").map(l => "  " + l).join("\n"));
    const facts = [n.tags && n.tags.length ? n.tags.map(x => "#" + x).join(" ") : "", "updated " + when(n.updated, tz), n.id].filter(Boolean);
    out(dim(`\n  ${facts.join(" · ")}\n`));
    return 0;
  }
  return usage(`vyre notes ${verb}: not a subcommand`, "vyre notes, vyre notes add <text>, vyre notes show <id>");
}

async function listNotes() {
  const r = await call("planner.list", { kind: "note", limit: 500 });
  if (r.error) return failTool(r.error);
  const rows = [...r.data].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated);
  if (json()) return emit(rows);
  if (!rows.length) { out(dim("  no notes yet · vyre notes add <text> adds one")); return 0; }
  for (const n of rows) {
    const title = n.title.length > 70 ? n.title.slice(0, 69) + "…" : n.title;
    out(`  ${n.pinned ? signal("*") : " "} ${title}  ${dim(n.id)}`);
  }
  return 0;
}

// ---- agenda -----------------------------------------------------------------------------------

async function agenda(args) {
  const [which] = words(args);
  let input = {};
  if (which === "tomorrow") {
    const today = await call("planner.agenda", {});
    if (today.error) return failTool(today.error);
    // The middle of tomorrow in the zone: a day is 23 to 25 hours, so 36 hours on is always tomorrow.
    const d = dateIn(today.data.from + 36 * 3_600_000, today.data.tz);
    input = { from: d, to: d };
  } else if (which && /^\d{4}-\d{2}-\d{2}$/.test(which)) input = { from: which, to: which };
  else if (which && which !== "today") return usage(`vyre agenda ${which}: not a day`, "vyre agenda, vyre agenda tomorrow, vyre agenda 2026-10-01");
  const r = await call("planner.agenda", input);
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data);
  const { tz, from, entries, todos } = r.data;
  const label = which === "tomorrow" ? "tomorrow" : which && which !== "today" ? "" : "today";
  out(`\n  ${bold(day(from, tz))} ${dim([label, tz].filter(Boolean).join(" · "))}`);
  if (!entries.length && !todos.length) { out(dim(`  nothing on ${label || "that day"}\n`)); return 0; }
  if (entries.length) out("");
  for (const e of entries) {
    const time = e.all_day ? "all day" : e.end ? `${clock(e.at, tz)}-${clock(e.end, tz)}` : clock(e.at, tz);
    const kind = e.source !== "planner" ? "calendar" : e.kind;
    const facts = [e.repeat ? "repeats" : "", e.snoozed ? "snoozed" : "", e.state && e.state !== "open" ? e.state : "", e.where || ""].filter(Boolean).join(" · ");
    out(`  ${bold(time.padEnd(11))} ${dim(kind.padEnd(9))} ${e.title}${facts ? dim("  " + facts) : ""}`);
  }
  if (todos.length) {
    out(`\n  ${bold("due")}`);
    for (const t of todos) out(`    ${dim("[ ]")} ${todoLine(t)}`);
  }
  out("");
  return 0;
}

// ---- snooze -----------------------------------------------------------------------------------

async function snooze(args) {
  const [id, mins] = words(args);
  if (!id) return usage("vyre snooze needs a firing's or an item's id", "vyre snooze <id> [minutes]");
  const minutes = mins === undefined ? undefined : Number(mins);
  if (minutes !== undefined && !(minutes > 0)) return usage(`vyre snooze: ${mins} is not a number of minutes`, "vyre snooze <id> 10");
  const r = await call("planner.snooze", { ...(id.startsWith("f_") ? { firing: id } : { item: id }), ...(minutes ? { minutes } : {}) });
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data);
  if (r.data.already) { out(dim(`  that one is already ${r.data.action || r.data.state}  ${r.data.firing}`)); return 0; }
  const z = await zone();
  out(`  ${signal("snoozed")} ${r.data.item.title} ${dim("until")} ${clock(r.data.until, z.tz || "UTC")}  ${dim(r.data.item.id)}`);
  return 0;
}

export default [
  { name: "agenda", order: 30, usage: "vyre agenda [today|tomorrow|YYYY-MM-DD] [--json]", summary: "what is on today: alarms, reminders, events and todos due", run: agenda },
  { name: "alarm", order: 31, usage: "vyre alarm [7am|6:30 weekdays|off <id>] [--json]", summary: "set an alarm, list them, or turn one off", run: alarm,
    help: "vyre alarm 7am · vyre alarm 6:30 weekdays · vyre alarm (upcoming) · vyre alarm off <id>\nTimes are the planner's zone (vyre agenda shows it). Alarms follow the zone when it changes." },
  { name: "timer", order: 32, usage: "vyre timer <length> [label] [--json]", summary: "a timer that rings on every device", run: timer,
    help: "vyre timer 10m · vyre timer 1h30m · vyre timer 25m bread" },
  { name: "remind", order: 33, usage: "vyre remind <what> at|in <when> [--json]", summary: "a reminder at a time", run: remind,
    help: "vyre remind \"call juno\" at 6 · vyre remind me in 20 minutes to check the oven · vyre remind me tomorrow at 9 to email juno" },
  { name: "todo", order: 34, usage: "vyre todo [add <text>|done <id>] [--json]", summary: "open todos by list; add and finish them", run: todo,
    help: "vyre todo add buy flour !high · vyre todo add call kit by friday · vyre todo done <id>\nPriority: !low, !!, !high." },
  { name: "notes", order: 35, usage: "vyre notes [add <text>|show <id>] [--json]", summary: "notes, pinned first", run: notes },
  { name: "snooze", order: 36, usage: "vyre snooze <id> [minutes] [--json]", summary: "ring again later (9 minutes by default)", run: snooze },
];
