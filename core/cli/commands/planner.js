// @ts-check
// `vyre alarm`, `timer`, `remind`, `todo`, `notes`, `agenda`, `snooze`, `ringing` and `dismiss`:
// the planner from the terminal (docs/adr/0025-planner.md). Words go to planner.parse and
// planner.add; `edit <id>` and `rm <id>` on each kind are planner.update and planner.delete. Times
// print in the planner's zone, never this machine's, since the box keeps the time.

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

/** An item id as the planner makes them ("i_..."), so `edit` and `rm` are never read as words. */
const isId = s => /^i_\S+$/.test(String(s || ""));

/** A kind's name as a person says it, and the command that owns it. */
const NAMES = { alarm: ["alarm", "alarm"], timer: ["timer", "timer"], reminder: ["reminder", "remind"], todo: ["todo", "todo"], note: ["note", "notes"] };

/**
 * The item behind an id, when it is of this kind. A todo's id given to `vyre alarm rm` is refused
 * with the command that does own it, so an rm never deletes something the person did not mean.
 * @returns {Promise<{ item?: any, code?: number }>}
 */
async function itemOf(kind, id, verb) {
  const r = await call("planner.get", { item: id });
  if (r.error) return { code: failTool(r.error, r.error.code === "not_found" ? `vyre ${NAMES[kind][1]} lists them` : undefined) };
  const item = r.data.item;
  if (item.kind !== kind) {
    const [said, cmd] = NAMES[item.kind] || [item.kind, "agenda"];
    const an = w => (/^[aeiou]/.test(w) ? "an " : "a ") + w;
    return { code: fail(`${id} is ${an(said)}, not ${an(NAMES[kind][0])}`, { code: "bad_input", next: `vyre ${cmd} ${verb} ${id}` }) };
  }
  return { item };
}

/** `vyre <cmd> rm <id>`: planner.delete, after checking the kind. */
async function removeItem(kind, id) {
  const cmd = NAMES[kind][1];
  if (!isId(id)) return usage(`vyre ${cmd} rm needs a ${NAMES[kind][0]}'s id`, `vyre ${cmd} rm i_...`);
  const got = await itemOf(kind, id, "rm");
  if (got.code !== undefined) return got.code;
  const r = await call("planner.delete", { item: id });
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data);
  out(`  ${signal("deleted")} ${got.item.title}  ${dim(id)}`);
  return 0;
}

/** Send a change for an item of this kind, and hand back the item as it is now, or an exit code. */
async function change(kind, id, patch) {
  const r = await call("planner.update", { item: id, ...patch });
  if (r.error) return { code: failTool(r.error) };
  if (json()) return { code: emit(r.data) };
  return { item: r.data };
}

/** The first words that read as a length, and what follows: `10m bread` is 10 minutes, "bread". */
async function lengthOf(w) {
  for (let n = Math.min(w.length, 6); n >= 1; n--) {
    const got = await readAs("timer", ["timer " + w.slice(0, n).join(" ")]);
    if (got.error) return { error: got.error };
    if (got.parsed && got.parsed.duration_ms) return { found: { ms: got.parsed.duration_ms, rest: w.slice(n), title: got.parsed.title !== "Timer" ? got.parsed.title : "" } };
  }
  return { found: null };
}

/** "10m", "1h 30m", "45s". */
const lengthWords = ms => {
  const mins = Math.round(ms / 60_000);
  return mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}` : mins >= 1 ? `${mins}m` : `${Math.round(ms / 1000)}s`;
};

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
  if ((w[0] === "rm" || w[0] === "delete") && (isId(w[1]) || w.length === 1)) return removeItem("alarm", w[1]);
  if (w[0] === "edit" && (isId(w[1]) || w.length === 1)) return editAlarm(w[1], w.slice(2));
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

/** `vyre alarm edit <id> 8am`: a new time (and label, and rule, when said); a repeating alarm keeps its rule. */
async function editAlarm(id, w) {
  if (!isId(id) || !w.length) return usage("vyre alarm edit needs an alarm's id and its new time", "vyre alarm edit i_... 8am, vyre alarm edit i_... 6:30 weekdays");
  const got = await itemOf("alarm", id, "edit");
  if (got.code !== undefined) return got.code;
  const z = await zone();
  if (z.error) return failTool(z.error);
  const said = w.join(" ");
  const p = await readAs("alarm", ["alarm " + said]);
  if (p.error) return failTool(p.error);
  if (!p.parsed) return notUnderstood("a time", said, "vyre alarm edit <id> 8am");
  const { wall, date, repeat, title } = p.parsed;
  // Only the time of day for a repeating alarm told no new rule, so it keeps ringing on its days.
  const patch = { wall, ...(repeat ? { repeat } : got.item.repeat ? {} : { date }), ...(title && title !== "Alarm" ? { title } : {}) };
  const c = await change("alarm", id, patch);
  if (c.item) setLine("alarm", c.item, /** @type {string} */ (z.tz));
  return c.code ?? 0;
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
  out(dim(`\n  ${tz} · vyre alarm off <id> turns one off · vyre alarm edit <id> <time> · vyre alarm rm <id>`));
  return 0;
}

// ---- timer ------------------------------------------------------------------------------------

async function timer(args) {
  const w = words(args);
  if (!w.length) return usage("vyre timer needs a length", "vyre timer 10m, vyre timer 25m bread");
  if (w[0] === "list" || w[0] === "ls") return listTimed("timer");
  if ((w[0] === "rm" || w[0] === "delete") && (isId(w[1]) || w.length === 1)) return removeItem("timer", w[1]);
  if (w[0] === "edit" && (isId(w[1]) || w.length === 1)) return editTimer(w[1], w.slice(2));
  const z = await zone();
  if (z.error) return failTool(z.error);
  // The longest opening that reads as a duration; what follows is the label.
  const l = await lengthOf(w);
  if (l.error) return failTool(l.error);
  const found = l.found;
  if (!found) return notUnderstood("a length", w.join(" "), "vyre timer 10m, vyre timer 1h30m");
  const label = found.rest.join(" ").replace(/^for\s+/i, "").trim() || found.title || "";
  const r = await call("planner.add", { kind: "timer", in_ms: found.ms, ...(label ? { title: label } : {}) });
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data);
  const tz = /** @type {string} */ (z.tz);
  out(`  ${signal("timer")} ${bold(lengthWords(found.ms))} ${dim("rings at")} ${clock(r.data.at, tz)}${label ? "  " + label : ""}  ${dim(r.data.id)}`);
  return 0;
}

/** `vyre timer edit <id> 15m [label]`: it starts again from now with the new length. */
async function editTimer(id, w) {
  if (!isId(id) || !w.length) return usage("vyre timer edit needs a timer's id and its new length", "vyre timer edit i_... 15m");
  const got = await itemOf("timer", id, "edit");
  if (got.code !== undefined) return got.code;
  const z = await zone();
  if (z.error) return failTool(z.error);
  const l = await lengthOf(w);
  if (l.error) return failTool(l.error);
  if (!l.found) return notUnderstood("a length", w.join(" "), "vyre timer edit <id> 15m");
  const label = l.found.rest.join(" ").replace(/^for\s+/i, "").trim() || l.found.title || "";
  const c = await change("timer", id, { in_ms: l.found.ms, ...(label ? { title: label } : {}) });
  if (c.item) out(`  ${signal("timer")} ${bold(lengthWords(l.found.ms))} ${dim("rings at")} ${clock(c.item.at, /** @type {string} */ (z.tz))}${c.item.title !== "Timer" ? "  " + c.item.title : ""}  ${dim(id)}`);
  return c.code ?? 0;
}

/** `vyre timer list`, `vyre remind list`: the open ones, soonest first. */
async function listTimed(kind) {
  const r = await call("planner.list", { kind, limit: 500 });
  if (r.error) return failTool(r.error);
  const z = await zone();
  if (z.error) return failTool(z.error);
  const tz = /** @type {string} */ (z.tz);
  const rows = r.data.filter(a => (a.next_fire ?? a.at) != null).sort((a, b) => (a.next_fire ?? a.at) - (b.next_fire ?? b.at));
  if (json()) return emit({ tz, [kind + "s"]: rows });
  const cmd = NAMES[kind][1];
  if (!rows.length) { out(dim(`  no ${kind}s set · vyre ${cmd} ${kind === "timer" ? "10m" : '"call juno" at 6'} sets one`)); return 0; }
  for (const x of rows) setLine(kind, x, tz);
  out(dim(`\n  ${tz} · vyre ${cmd} edit <id> ${kind === "timer" ? "<length>" : "<what and when>"} · vyre ${cmd} rm <id>`));
  return 0;
}

// ---- remind -----------------------------------------------------------------------------------

async function remind(args) {
  const w = words(args);
  if (!w.length) return usage("vyre remind needs what and when", `vyre remind "call juno" at 6 · vyre remind me in 20 minutes to check the oven`);
  if ((w[0] === "list" || w[0] === "ls") && w.length === 1) return listTimed("reminder");
  if ((w[0] === "rm" || w[0] === "delete") && (isId(w[1]) || w.length === 1)) return removeItem("reminder", w[1]);
  if (w[0] === "edit" && (isId(w[1]) || w.length === 1)) return editReminder(w[1], w.slice(2));
  const z = await zone();
  if (z.error) return failTool(z.error);
  const said = w.join(" ");
  const got = await readAs("reminder", reminderTexts(said));
  if (got.error) return failTool(got.error);
  if (!got.parsed) return notUnderstood("a time", said, `vyre remind "call juno" at 6 · vyre remind me tomorrow at 9 to email juno`);
  const r = await call("planner.add", { text: got.text });
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data);
  setLine("reminder", r.data, /** @type {string} */ (z.tz));
  return 0;
}

/** The ways to ask planner.parse about a reminder's words. */
const reminderTexts = said => /^me\b/i.test(said) ? ["remind " + said] : ["remind me to " + said, "remind me " + said, "remind " + said];

/** `vyre remind edit <id> <what and when>`: new words; a new time when they say one. */
async function editReminder(id, w) {
  if (!isId(id) || !w.length) return usage("vyre remind edit needs a reminder's id and what it becomes", `vyre remind edit i_... "call juno" at 7`);
  const got = await itemOf("reminder", id, "edit");
  if (got.code !== undefined) return got.code;
  const z = await zone();
  if (z.error) return failTool(z.error);
  const said = w.join(" ");
  const p = await readAs("reminder", reminderTexts(said));
  if (p.error) return failTool(p.error);
  // Words with a time move it; words without one are the new title and the time stays.
  const patch = p.parsed ? { wall: p.parsed.wall, date: p.parsed.date, ...(p.parsed.repeat ? { repeat: p.parsed.repeat } : {}), ...(p.parsed.title ? { title: p.parsed.title } : {}) } : { title: said };
  const c = await change("reminder", id, patch);
  if (c.item) setLine("reminder", c.item, /** @type {string} */ (z.tz));
  return c.code ?? 0;
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
  if (verb === "rm" || verb === "delete") return removeItem("todo", rest[0]);
  if (verb === "edit") {
    if (!isId(rest[0]) || !rest[1]) return usage("vyre todo edit needs a todo's id and its new words", "vyre todo edit i_... buy rye flour !high");
    const got = await itemOf("todo", rest[0], "edit");
    if (got.code !== undefined) return got.code;
    const text = rest.slice(1).join(" ").trim();
    const p = await readAs("todo", ["todo " + text], false);
    if (p.error) return failTool(p.error);
    // Priority, due day and list change only when the words say them.
    const x = p.parsed || { title: text };
    const c = await change("todo", rest[0], { title: x.title, ...(x.priority !== undefined ? { priority: x.priority } : {}), ...(x.due ? { due: x.due } : {}), ...(x.list ? { list: x.list } : {}) });
    if (c.item) out(`  ${signal("todo")} ${todoLine(c.item)}`);
    return c.code ?? 0;
  }
  return usage(`vyre todo ${verb}: not a subcommand`, "vyre todo, vyre todo add <text>, vyre todo done <id>, vyre todo edit <id> <text>, vyre todo rm <id>");
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
  out(dim("\n  vyre todo done <id> finishes one · vyre todo edit <id> <text> · vyre todo rm <id>\n"));
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
  if (verb === "rm" || verb === "delete") return removeItem("note", rest[0]);
  if (verb === "edit") {
    if (!isId(rest[0]) || !rest[1]) return usage("vyre notes edit needs a note's id and its new text", "vyre notes edit i_... kit prefers afternoons");
    const got = await itemOf("note", rest[0], "edit");
    if (got.code !== undefined) return got.code;
    const c = await change("note", rest[0], { title: rest.slice(1).join(" ").trim() });
    if (c.item) out(`  ${signal("note")} ${c.item.title}  ${dim(c.item.id)}`);
    return c.code ?? 0;
  }
  return usage(`vyre notes ${verb}: not a subcommand`, "vyre notes, vyre notes add <text>, vyre notes show <id>, vyre notes edit <id> <text>, vyre notes rm <id>");
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

// ---- ringing and dismiss ----------------------------------------------------------------------

/** `vyre ringing`: what rings now, so a terminal can stop it. */
async function ringing() {
  const r = await call("planner.ringing", {});
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data);
  if (!r.data.length) { out(dim("  nothing is ringing")); return 0; }
  const z = await zone();
  const tz = z.tz || "UTC";
  for (const f of r.data) {
    const facts = [f.ring > 1 ? `rung ${f.ring} times` : "", f.missed ? "missed" : "", f.added_by ? `from ${f.added_by}` : ""].filter(Boolean).join(" · ");
    out(`  ${beacon(f.kind)} ${bold(clock(f.due, tz))} ${f.title}${facts ? dim("  " + facts) : ""}  ${dim(f.firing)}`);
  }
  out(dim("\n  vyre dismiss <id> stops one · vyre snooze <id> rings it again later"));
  return 0;
}

/** `vyre dismiss <id>`: stop a firing without finishing a todo; a one-off alarm, timer or reminder ends. */
async function dismiss(args) {
  const [id] = words(args);
  if (!id) return usage("vyre dismiss needs a firing's or an item's id", "vyre ringing lists what rings");
  const r = await call("planner.dismiss", id.startsWith("f_") ? { firing: id } : { item: id });
  if (r.error) return failTool(r.error, r.error.code === "not_found" ? "vyre ringing lists what rings" : undefined);
  if (json()) return emit(r.data);
  if (r.data.already) { out(dim(`  that one is already ${r.data.action || r.data.state}  ${r.data.firing}`)); return 0; }
  out(`  ${signal("dismissed")} ${r.data.item.title}  ${dim(r.data.item.id)}`);
  return 0;
}

export default [
  { name: "agenda", order: 30, usage: "vyre agenda [today|tomorrow|YYYY-MM-DD] [--json]", summary: "what is on today: alarms, reminders, events and todos due", run: agenda },
  { name: "alarm", order: 31, usage: "vyre alarm [7am|6:30 weekdays|off <id>|edit <id> <time>|rm <id>] [--json]", summary: "set an alarm, list them, change, turn off or delete one", run: alarm,
    help: "vyre alarm 7am · vyre alarm 6:30 weekdays · vyre alarm (upcoming) · vyre alarm off <id>\nvyre alarm edit <id> 8am (a repeating alarm keeps its days unless you name new ones) · vyre alarm rm <id>\nTimes are the planner's zone (vyre agenda shows it). Alarms follow the zone when it changes." },
  { name: "timer", order: 32, usage: "vyre timer <length> [label]|list|edit <id> <length>|rm <id> [--json]", summary: "a timer that rings on every device", run: timer,
    help: "vyre timer 10m · vyre timer 1h30m · vyre timer 25m bread · vyre timer list\nvyre timer edit <id> 15m (it starts again from now) · vyre timer rm <id>" },
  { name: "remind", order: 33, usage: "vyre remind <what> at|in <when>|list|edit <id> <what and when>|rm <id> [--json]", summary: "a reminder at a time", run: remind,
    help: "vyre remind \"call juno\" at 6 · vyre remind me in 20 minutes to check the oven · vyre remind me tomorrow at 9 to email juno\nvyre remind list · vyre remind edit <id> \"call juno\" at 7 (words without a time keep the time) · vyre remind rm <id>" },
  { name: "todo", order: 34, usage: "vyre todo [add <text>|done <id>|edit <id> <text>|rm <id>] [--json]", summary: "open todos by list; add, change, finish and delete them", run: todo,
    help: "vyre todo add buy flour !high · vyre todo add call kit by friday · vyre todo done <id>\nvyre todo edit <id> buy rye flour !! · vyre todo rm <id>\nPriority: !low, !!, !high." },
  { name: "notes", order: 35, usage: "vyre notes [add <text>|show <id>|edit <id> <text>|rm <id>] [--json]", summary: "notes, pinned first", run: notes },
  { name: "snooze", order: 36, usage: "vyre snooze <id> [minutes] [--json]", summary: "ring again later (9 minutes by default)", run: snooze },
  { name: "ringing", order: 37, usage: "vyre ringing [--json]", summary: "what is ringing now: alarms, timers and reminders", run: ringing },
  { name: "dismiss", order: 38, usage: "vyre dismiss <id> [--json]", summary: "stop a ringing alarm, timer or reminder without finishing a todo", run: dismiss,
    help: "vyre dismiss <firing id or item id> · vyre ringing lists what rings\nA one-off alarm, timer or reminder ends; a repeating alarm rings again at its next time." },
];
