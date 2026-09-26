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

const LEVELS = ["remind", "ask", "block"];
const USAGE = "vyre learn [show|add|accept|retire|level|scope|relax|stats|signals|skills]";
const unreachable = r => r.error && ["unreachable", "timeout"].includes(r.error.code);
const fail = r => { out(unreachable(r) ? `  vyred is not running ${dim("· vyre up to start it")}` : beacon(`  ${r.error.code}: `) + r.error.message); return 1; };

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
const idOf = (args, usage) => {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id < 1) { out(`  ${usage}`); return null; }
  return id;
};

/** Run a tool that returns one lesson, and show it. A human-only tool asks for the person's proof. */
async function one(tool, input, said) {
  const r = await callAsPerson(tool, input);
  if (r.error) return fail(r);
  out(`  ${said} ${bold(String(r.data.id))}`);
  line(r.data);
  return 0;
}

/** The lesson as it is now, or null after saying why not. */
async function current(id) {
  const all = await call("learn.lessons", { status: "all" });
  if (all.error) { fail(all); return null; }
  const l = all.data.find(x => x.id === id);
  if (!l) { out(beacon(`  no lesson ${id}`)); return null; }
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
    out(`  this folder is in no project ${dim("· vyre learn scope <id> project <slug>")}`);
    return null;
  }
  out("  vyre learn scope <id> all|project [slug]|agent <name>");
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
    if (!l.check) { out("  that lesson has no check to narrow"); return null; }
    return { check: { ...l.check, paths: rest[0] } };
  }
  if (what === "scope") { const scope = await scopeOf(rest); return scope ? { scope } : null; }
  out(`  ${usage}`);
  return null;
}

/** `vyre learn signals`: what Learning heard, as counts; the jobs waiting, in the user's own words. */
async function signals() {
  const r = await call("learn.signals", { limit: 20 });
  if (r.error) return fail(r);
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
  if (!l.data.length) { out(dim("  no active lessons")); return 0; }
  const by = new Map(s.data.map(x => [x.id, x]));
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
  if (!["show", "install", "retire", "dismiss"].includes(sub)) { out(`  vyre learn skills [show|install|retire|dismiss] <id>`); return 1; }
  const id = idOf(rest, `vyre learn skills ${sub} <id>`);
  if (id === null) return 1;
  if (sub === "show") {
    const r = await call("learn.skills", {});
    if (r.error) return fail(r);
    const s = r.data.skills.find(x => x.id === id);
    if (!s) { out(beacon(`  no skill ${id}`)); return 1; }
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
    const r = await callAsPerson("learn.skill-install", input);
    if (r.error) return fail(r);
    out(`  installed skill ${bold(String(r.data.id))} ${dim(r.data.path)}`);
    return 0;
  }
  const tool = sub === "retire" ? "learn.skill-retire" : "learn.skill-dismiss";
  const r = await callAsPerson(tool, { id });
  if (r.error) return fail(r);
  out(`  ${sub === "retire" ? "retired" : "dismissed"} skill ${bold(String(r.data.id))}`);
  return 0;
}

export default {
  name: "learn", aliases: ["lessons"], order: 32, usage: USAGE, summary: "the lessons Vyre learned from you, and what it proposed",
  async run(args) {
    const [sub, ...rest] = args;
    if (!sub) {
      const r = await call("learn.lessons", {});
      if (r.error) return fail(r);
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
      if (!text) { out("  vyre learn add <text>"); return 1; }
      return one("learn.add", { text }, "learned lesson");
    }
    if (sub === "accept" || sub === "retire") {
      const id = idOf(rest, `vyre learn ${sub} <id>`);
      if (id === null) return 1;
      const l = await current(id);
      if (!l) return 1;
      return one(`learn.${sub}`, { id }, sub === "accept" ? "accepted lesson" : "retired lesson");
    }
    if (sub === "show") {
      const id = idOf(rest, "vyre learn show <id>");
      if (id === null) return 1;
      const l = await current(id);
      if (!l) return 1;
      const s = await call("learn.stats", { id });
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
      if (id === null) return 1;
      if (!LEVELS.includes(rest[1])) { out("  vyre learn level <id> <remind|ask|block>"); return 1; }
      const all = await call("learn.lessons", { status: "all" });
      if (all.error) return fail(all);
      const now = all.data.find(l => l.id === id);
      const lower = now && LEVELS.indexOf(rest[1]) < LEVELS.indexOf(now.level);
      return one(lower ? "learn.relax" : "learn.edit", { id, level: rest[1] }, "changed lesson");
    }
    if (sub === "scope") {
      const id = idOf(rest, "vyre learn scope <id> all|project [slug]|agent <name>");
      if (id === null) return 1;
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
      if (id === null) return 1;
      const l = await current(id);
      if (!l) return 1;
      const change = await relaxOf(l, rest.slice(1));
      if (!change) return 1;
      return one("learn.relax", { id, ...change }, "relaxed lesson");
    }
    if (sub === "stats") return stats();
    if (sub === "signals") return signals();
    if (sub === "skills") return skills(rest);
    out(`  vyre learn ${sub}: ${dim("show, add, accept, retire, level, scope, relax, stats, signals or skills")}`);
    return 1;
  },
};
