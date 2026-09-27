// @ts-check
// `vyre learn`: the lessons Vyre learned from the user, and the ones it proposed. Adding,
// accepting, retiring and re-levelling a lesson are the user's calls, so they live here too.
// Raising a level or widening a scope is learn.edit, which anyone may do; lowering one or
// narrowing one is learn.relax, which needs the user. So do accepting, installing, retiring and
// dismissing: vyred asks for a person's proof (ADR 0004), which callAsPerson gets from this
// terminal and which a script or Claude's own shell cannot give.

import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { callAsPerson } from "../presence.js";
import { json, emit, fail as kitFail, failTool, usage, viewing, EXIT } from "../kit.js";

const LEVELS = ["remind", "ask", "block"];
const USAGE = "vyre learn [list|show|add|accept|retire|level|scope|relax|stats|signals|skills] [--json]";

/**
 * A human-only call. Under --view nothing may open a terminal, so it goes as a plain call and
 * vyred's presence_required comes back as an error frame (exit 3) for the surface to handle.
 * @param {string} tool @param {any} input
 */
const asPerson = (tool, input) => (viewing() ? call(tool, input) : callAsPerson(tool, input));

/** A lesson's effect as a plain word, for a view. */
const effectWord = s => (!s ? "" : s.verdict === "working" ? "working" : s.verdict === "not working" ? "not working" : "measuring");

/** One lesson as a card, for --view. */
const lessonCard = (l, stats) => ({ kind: "card", title: `Lesson ${l.id}`, state: l.status === "active" ? "ok" : l.status === "proposed" ? "wait" : "off", fields: [
  { label: "Rule", value: String(l.rule ?? "") },
  { label: "Status", value: String(l.status ?? "") + (l.dormant ? " (dormant)" : "") },
  { label: "Level", value: String(l.level ?? "") + (l.max_level ? `, at most ${l.max_level}` : "") },
  { label: "Where", value: where(l.scope) },
  { label: "Check", value: l.check ? String(l.check.label || l.check.kind) : "no check, a reminder" },
  { label: "Counts", value: `applied ${l.applied ?? 0} · caught ${l.caught ?? 0} · broken ${l.broken ?? 0}` },
  ...(stats ? [{ label: "Effect", value: `${effectWord(stats)} · before ${stats.before ?? "?"} · after ${stats.after ?? "?"} per 100 turns` }] : []),
] });
const fail = r => failTool(r.error);
/** A line that says why nothing was done: as it always read, or the JSON error under --json. */
const say = (text, message, code = "bad_input") => { if (json()) kitFail(message, { code }); else out(text); };

/** A lesson's effect, in a word. */
const effect = s => (!s ? "" : s.verdict === "working" ? signal("working") : s.verdict === "not working" ? beacon("not working") : dim("measuring"));
/** Where a lesson holds. */
const where = scope => (scope === "all" ? "everywhere" : scope && scope.project ? `project ${scope.project}` : scope && scope.agent ? `agent ${scope.agent}` : "everywhere");

/** One lesson on one line, with its check, counts and effect underneath. */
function line(l, stats) {
  const mark = l.status === "proposed" ? beacon("?") : signal("·");
  const eff = l.status === "active" && stats ? ` ${effect(stats)}` : "";
  out(`  ${mark} ${bold(String(l.id))} ${l.status === "retired" ? dim(l.rule) : l.rule} ${dim(`[${l.level}]`)}${eff}${l.dormant ? dim(" dormant") : ""}`);
  const counts = `applied ${l.applied} · caught ${l.caught} · broken ${l.broken}`;
  out(dim(`      ${[l.check ? `checks ${l.check.label || l.check.kind}` : "no check, a reminder", counts].join(" · ")}`));
  if (l.status === "proposed") out(dim(`      vyre learn accept ${l.id} · vyre learn retire ${l.id}`));
}

/** An id from args, or a usage line and null. */
const idOf = (args, line) => {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id < 1) { usage(line, "vyre learn lists them with their numbers"); return null; }
  return id;
};

/** Run a tool that returns one lesson, and show it. A human-only tool asks for the person's proof. */
async function one(tool, input, said) {
  const r = await asPerson(tool, input);
  if (r.error) return fail(r);
  if (json()) return emit(r.data, lessonCard(r.data));
  out(`  ${said} ${bold(String(r.data.id))}`);
  line(r.data);
  return 0;
}

/** The lesson as it is now, or null after saying why not. */
async function current(id) {
  const all = await call("learn.lessons", { status: "all" });
  if (all.error) { fail(all); return null; }
  const l = all.data.find(x => x.id === id);
  if (!l) { kitFail(`no lesson ${id}`, { code: "not_found" }); return null; }
  return l;
}

/** Stats by lesson id; an empty map when vyred cannot say. */
async function statsById() {
  const r = await call("learn.stats", {});
  return new Map(!r.error && Array.isArray(r.data) ? r.data.map(s => [s.id, s]) : []);
}

/** `scope <id> all|project [slug]|agent <name>`: the scope asked for, or null after the usage line. */
async function scopeOf(args) {
  const [what, name] = args;
  if (what === "all" || what === "everywhere") return "all";
  if (what === "agent" && name) return { agent: name };
  if (what === "project") {
    if (name) return { project: name };
    const r = await call("projects.of", { cwd: process.cwd() });
    if (r.data && r.data.slug) return { project: r.data.slug };
    say(`  this folder is in no project ${dim("· vyre learn scope <id> project <slug>")}`, "this folder is in no project; vyre learn scope <id> project <slug>");
    return null;
  }
  say("  vyre learn scope <id> all|project [slug]|agent <name>", "vyre learn scope <id> all|project [slug]|agent <name>");
  return null;
}

/** `relax <id> level <l> | max <l> | pin | paths <pattern> | when <text> | scope ...`: the change, or null. */
async function relaxOf(l, args) {
  const [what, ...rest] = args;
  const usage = "vyre learn relax <id> level <remind|ask> | max <level> | pin | paths <pattern> | when <text> | scope all|project [slug]|agent <name>";
  if (what === "level" && LEVELS.includes(rest[0])) return { level: rest[0] };
  if (what === "max" && LEVELS.includes(rest[0])) return { max_level: rest[0] };
  if (what === "pin") return { pinned: true };
  if (what === "when" && rest.length) return { when: rest.join(" ") };
  if (what === "paths" && rest[0]) {
    if (!l.check) { say("  that lesson has no check to narrow", "that lesson has no check to narrow"); return null; }
    return { check: { ...l.check, paths: rest[0] } };
  }
  if (what === "scope") { const scope = await scopeOf(rest); return scope ? { scope } : null; }
  say(`  ${usage}`, usage);
  return null;
}

/** `vyre learn signals`: what Learning heard, as counts; the jobs waiting, in the user's own words. */
async function signals() {
  const r = await call("learn.signals", { limit: 20 });
  if (r.error) return fail(r);
  // --json: { counts: [{ kind, n }], repeats: [{ n, sessions, lesson }], corrected: [{ rule, n }], jobs: [{ id, kind, status, text }] }
  if (json()) {
    return emit(r.data, { kind: "table", title: "What Learning heard", columns: [{ key: "kind", label: "Signal" }, { key: "n", label: "Count" }],
      rows: (r.data.counts || []).map(c => ({ id: c.kind, kind: c.kind, n: c.n })), empty: "Nothing heard yet" });
  }
  const { counts, repeats, corrected, jobs } = r.data;
  if (!counts.length && !jobs.length) { out(dim("  nothing heard yet")); return 0; }
  out(`\n  ${signal("signals")} ${dim(counts.map(c => `${c.kind} ${c.n}`).join(" · "))}`);
  if (repeats.length) {
    out(`\n  ${bold("said again")}`);
    for (const x of repeats) out(`  ${dim("·")} ${x.n} times in ${x.sessions} session${x.sessions === 1 ? "" : "s"}${x.lesson ? dim(` · lesson ${x.lesson}`) : ""}`);
  }
  if (corrected.length) {
    out(`\n  ${bold("Memory corrections")} ${dim("by the rule that made the fact; a rule corrected often is a curation bug")}`);
    for (const c of corrected) out(`  ${dim("·")} ${c.rule ?? "unknown rule"} ${c.n}`);
  }
  const waiting = jobs.filter(j => j.status === "queued" || j.status === "running");
  if (waiting.length) {
    out(`\n  ${beacon("waiting for a model")} ${dim("· without the Switchboard, write the lesson yourself: vyre learn add <text>")}`);
    for (const j of waiting) out(`  ${dim(`${j.id} ${j.kind} ${j.status}`)} ${j.text ? `"${j.text}"` : ""}`);
  }
  out("");
  return 0;
}

/** `vyre learn stats`: each active lesson's effect. */
async function stats() {
  const [l, s] = [await call("learn.lessons", { status: "active" }), await call("learn.stats", {})];
  if (l.error) return fail(l);
  if (s.error) return fail(s);
  const by = new Map(s.data.map(x => [x.id, x]));
  // --json: [{ ...lesson, stats: { id, verdict, before, after, escapes, attempts, turns } | null }]
  if (json()) {
    return emit(l.data.map(x => ({ ...x, stats: by.get(x.id) ?? null })), { kind: "table", title: "Lesson effects",
      columns: [{ key: "id", label: "Lesson" }, { key: "rule", label: "Rule" }, { key: "effect", label: "Effect" }, { key: "before", label: "Before" }, { key: "after", label: "After" }, { key: "turns", label: "Turns" }],
      rows: l.data.map(x => { const st = by.get(x.id); return { id: x.id, rule: x.rule, effect: effectWord(st), before: st?.before ?? "", after: st?.after ?? "", turns: st?.turns ?? "" }; }),
      empty: "No active lessons" });
  }
  if (!l.data.length) { out(dim("  no active lessons")); return 0; }
  out("");
  for (const x of l.data) {
    const st = by.get(x.id);
    out(`  ${bold(String(x.id))} ${x.rule} ${effect(st)}${x.dormant ? dim(" dormant") : ""}`);
    if (st) out(dim(`      before ${st.before ?? "?"} · after ${st.after ?? "?"} per 100 turns · ${st.escapes} escapes · ${st.attempts} caught · ${st.turns} turns measured`));
  }
  out("");
  return 0;
}

/** `vyre learn skills [show|install|retire|dismiss <id>]`. */
async function skills(args) {
  const [sub, ...rest] = args;
  if (!sub) {
    const r = await call("learn.skills", {});
    if (r.error) return fail(r);
    // --json: { skills: [{ id, name, status, scope, sessions, path, body }], drift: [{ id, state }] }
    if (json()) {
      const moved = new Map((r.data.drift || []).map(d => [d.id, d.state]));
      return emit(r.data, { kind: "table", title: "Skills", columns: [{ key: "id", label: "Skill" }, { key: "name", label: "Name" }, { key: "status", label: "Status" },
        { key: "where", label: "Where" }, { key: "sessions", label: "Sessions" }, { key: "drift", label: "Drift" }],
      rows: (r.data.skills || []).map(s => ({ id: s.id, name: s.name, status: s.status, where: where(s.scope), sessions: s.sessions, drift: moved.get(s.id) || "" })),
      empty: "No skills yet" });
    }
    const { skills: list, drift } = r.data;
    const live = list.filter(s => s.status === "proposed" || s.status === "installed");
    if (!live.length) { out(dim("  no skills yet · Vyre proposes one when a procedure repeats cleanly in 3 sessions")); return 0; }
    const moved = new Map(drift.map(d => [d.id, d.state]));
    out("");
    for (const s of live) {
      const mark = s.status === "proposed" ? beacon("?") : signal("·");
      out(`  ${mark} ${bold(String(s.id))} ${s.name} ${dim(`[${s.status}] ${where(s.scope)} · ${s.sessions} sessions`)}${moved.has(s.id) ? beacon(` ${moved.get(s.id)}`) : ""}`);
      if (s.status === "proposed") out(dim(`      vyre learn skills show ${s.id} · install ${s.id} · dismiss ${s.id}`));
    }
    out("");
    return 0;
  }
  if (!["show", "install", "retire", "dismiss"].includes(sub)) { return usage(`vyre learn skills ${sub}: not a subcommand`, "vyre learn skills show, install, retire or dismiss <id>"); }
  const id = idOf(rest, `vyre learn skills ${sub} <id>`);
  if (id === null) return EXIT.USAGE;
  if (sub === "show") {
    const r = await call("learn.skills", {});
    if (r.error) return fail(r);
    const s = r.data.skills.find(x => x.id === id);
    if (!s) return kitFail(`no skill ${id}`, { code: "not_found" });
    // --json: { id, name, status, scope, sessions, path, body }
    if (json()) {
      return emit(s, { kind: "card", title: `Skill ${s.id}: ${s.name}`, state: s.status === "installed" ? "ok" : s.status === "proposed" ? "wait" : "off", fields: [
        { label: "Status", value: String(s.status) }, { label: "Where", value: where(s.scope) }, ...(s.path ? [{ label: "File", value: String(s.path) }] : []),
        { label: "Body", value: String(s.body ?? "") }] });
    }
    out(`\n  ${bold(String(s.id))} ${s.name} ${dim(`[${s.status}] ${where(s.scope)}${s.path ? ` · ${s.path}` : ""}`)}\n`);
    out(s.body);
    return 0;
  }
  if (sub === "install") {
    const flags = rest.slice(1);
    const input = { id };
    const at = flags.indexOf("--agent");
    if (at >= 0 && flags[at + 1]) Object.assign(input, { scope: "agent", agent: flags[at + 1] });
    else if (flags.includes("--account")) Object.assign(input, { scope: "account" });
    else if (flags.includes("--project")) Object.assign(input, { scope: "project" });
    if (flags.includes("--private")) Object.assign(input, { private: true });
    const r = await asPerson("learn.skill-install", input);
    if (r.error) return fail(r);
    if (json()) return emit(r.data);
    out(`  installed skill ${bold(String(r.data.id))} ${dim(r.data.path)}`);
    return 0;
  }
  const tool = sub === "retire" ? "learn.skill-retire" : "learn.skill-dismiss";
  const r = await asPerson(tool, { id });
  if (r.error) return fail(r);
  if (json()) return emit(r.data);
  out(`  ${sub === "retire" ? "retired" : "dismissed"} skill ${bold(String(r.data.id))}`);
  return 0;
}

export default {
  name: "learn", aliases: ["lessons"], order: 32, usage: USAGE, summary: "the lessons Vyre learned from you, and what it proposed",
  verbs: [
    { verb: "list", aliases: ["ls"], summary: "the active lessons and the ones waiting for your yes", usage: "", read: true },
    { verb: "show", summary: "one lesson, its check and its effect", usage: "<id>", read: true },
    { verb: "add", summary: "a lesson in your own words", usage: "<text...>" },
    { verb: "accept", summary: "say yes to a proposed lesson", usage: "<id>", person: true },
    { verb: "retire", summary: "stop a lesson", usage: "<id>", person: true },
    { verb: "level", summary: "remind, ask or block; lowering one needs you", usage: "<id> remind|ask|block", person: true },
    { verb: "scope", summary: "where a lesson holds; narrowing one needs you", usage: "<id> all|project|agent [<name>]", person: true },
    { verb: "relax", summary: "lower, pin, narrow or rescope a lesson", usage: "<id> level|max|pin|paths|when|scope [<value...>]", person: true },
    { verb: "stats", summary: "each active lesson's effect", usage: "", read: true },
    { verb: "signals", summary: "what Learning heard, as counts, and the jobs waiting", usage: "", read: true },
    { verb: "skills", summary: "skills Vyre proposed from repeated work: list, show, install, retire, dismiss", usage: "[show|install|retire|dismiss] [<id>] [--agent v] [--account] [--project] [--private]", read: false, person: true },
  ],
  help: [
    "  vyre learn [list]                          the active lessons and the ones waiting for your yes",
    "  vyre learn show <id>                       one lesson, its check and its effect",
    "  vyre learn add <text>                      a lesson in your own words",
    "  vyre learn accept|retire <id>              say yes to a proposed lesson, or stop one",
    "  vyre learn level <id> remind|ask|block     how firmly it holds (lowering it needs you)",
    "  vyre learn scope <id> all|project [slug]|agent <name>",
    "  vyre learn relax <id> level <l> | max <l> | pin | paths <pattern> | when <text> | scope ...",
    "  vyre learn stats · vyre learn signals      each lesson's effect · what Learning heard",
    "  vyre learn skills [show|install|retire|dismiss <id>] [--agent name|--account|--project] [--private]",
  ].join("\n"),
  async run(args) {
    const [sub, ...rest] = args.filter(a => a !== "--json");
    if (!sub || sub === "list" || sub === "ls") {
      const r = await call("learn.lessons", {});
      if (r.error) return fail(r);
      // --json: [{ id, rule, level, status, scope, when, check, applied, caught, broken, dormant, max_level, pinned, source }]
      if (json()) {
        const by = viewing() ? await statsById() : new Map();
        return emit(r.data, { kind: "table", title: "Lessons", columns: [{ key: "id", label: "Lesson" }, { key: "rule", label: "Rule" }, { key: "level", label: "Level" },
          { key: "status", label: "Status" }, { key: "effect", label: "Effect" }],
        rows: r.data.map(l => ({ id: l.id, rule: l.rule, level: l.level, status: l.status + (l.dormant ? " (dormant)" : ""), effect: l.status === "active" ? effectWord(by.get(l.id)) : "" })),
        empty: "No lessons yet" });
      }
      const active = r.data.filter(l => l.status === "active"), proposed = r.data.filter(l => l.status === "proposed");
      if (!r.data.length) { out(dim("  no lessons yet · vyre learn add <what Claude should always or never do>")); return 0; }
      const by = await statsById();
      out(`\n  ${signal(active.length + " lesson" + (active.length === 1 ? "" : "s"))} ${dim(proposed.length ? `· ${proposed.length} waiting for your yes` : "")}\n`);
      for (const l of active) line(l, by.get(l.id));
      if (proposed.length) { out(""); out(beacon("  proposed")); for (const l of proposed) line(l); }
      out("");
      return 0;
    }
    if (sub === "add") {
      const text = rest.join(" ").trim();
      if (!text) return usage("vyre learn add needs the lesson", "vyre learn add <what Claude should always or never do>");
      return one("learn.add", { text }, "learned lesson");
    }
    if (sub === "accept" || sub === "retire") {
      const id = idOf(rest, `vyre learn ${sub} <id>`);
      if (id === null) return EXIT.USAGE;
      const l = await current(id);
      if (!l) return 1;
      return one(`learn.${sub}`, { id }, sub === "accept" ? "accepted lesson" : "retired lesson");
    }
    if (sub === "show") {
      const id = idOf(rest, "vyre learn show <id>");
      if (id === null) return EXIT.USAGE;
      const l = await current(id);
      if (!l) return 1;
      const s = await call("learn.stats", { id });
      // --json: { ...lesson, stats: { verdict, before, after, turns, ... } | null }
      if (json()) return emit({ ...l, stats: s.error ? null : s.data ?? null }, lessonCard(l, s.error ? null : s.data));
      out("");
      line(l, s.data);
      out(dim(`      ${where(l.scope)} · when ${l.when}${l.max_level ? ` · at most ${l.max_level}` : ""}${l.pinned ? " · pinned" : ""} · from ${l.source && l.source.kind}`));
      if (l.check) out(dim(`      check ${JSON.stringify(l.check)}`));
      if (s.data && l.status === "active") out(dim(`      before ${s.data.before ?? "?"} · after ${s.data.after ?? "?"} per 100 turns · ${s.data.turns} turns measured`));
      out("");
      return 0;
    }
    if (sub === "level") {
      const id = idOf(rest, "vyre learn level <id> <remind|ask|block>");
      if (id === null) return EXIT.USAGE;
      if (!LEVELS.includes(rest[1])) return usage("vyre learn level <id> remind|ask|block", `vyre learn level ${id} remind`);
      const all = await call("learn.lessons", { status: "all" });
      if (all.error) return fail(all);
      const now = all.data.find(l => l.id === id);
      const lower = now && LEVELS.indexOf(rest[1]) < LEVELS.indexOf(now.level);
      return one(lower ? "learn.relax" : "learn.edit", { id, level: rest[1] }, "changed lesson");
    }
    if (sub === "scope") {
      const id = idOf(rest, "vyre learn scope <id> all|project [slug]|agent <name>");
      if (id === null) return EXIT.USAGE;
      const scope = await scopeOf(rest.slice(1));
      if (!scope) return 1;
      // Everywhere is stricter, and free; anything narrower is the user's, with presence.
      if (scope === "all") return one("learn.edit", { id, scope }, "changed lesson");
      const l = await current(id);
      if (!l) return 1;
      return one("learn.relax", { id, scope }, "changed lesson");
    }
    if (sub === "relax") {
      const id = idOf(rest, "vyre learn relax <id> <what>");
      if (id === null) return EXIT.USAGE;
      const l = await current(id);
      if (!l) return 1;
      const change = await relaxOf(l, rest.slice(1));
      if (!change) return 1;
      return one("learn.relax", { id, ...change }, "relaxed lesson");
    }
    if (sub === "stats") return stats();
    if (sub === "signals") return signals();
    if (sub === "skills") return skills(rest);
    return usage(`vyre learn ${sub}: not a subcommand`, "vyre learn list, show, add, accept, retire, level, scope, relax, stats, signals or skills");
  },
};
