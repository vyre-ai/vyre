// @ts-check
// `vyre memory [about]`, `vyre memory correct|merge|split|pin|mute ...` and `vyre why <fact>`.
// Everything shown here came from memory rather than a model, so it is drawn in the Recall gold.
// --project <slug> reads (or corrects) one project's room; "unfiled" is the room of no project.

import { call } from "../../daemon/client.js";
import { out, dim, bold, recall, beacon } from "../style.js";

const unreachable = r => r.error && ["unreachable", "timeout"].includes(r.error.code);
const fail = r => { out(unreachable(r) ? `  vyred is not running ${dim("· vyre up to start it")}` : beacon(`  ${r.error.code}: `) + r.error.message); return 1; };

/** One fact on one line, with where it came from underneath. */
function line(f) {
  const past = f.until ? dim(" (until " + new Date(f.until).toISOString().slice(0, 10) + ")") : "";
  const src = f.ref ? `${f.source} #${f.ref.seq}` : f.source || "";
  const marks = [f.conflict && beacon("two projects disagree"), f.stale && dim("stale")].filter(Boolean).join(" ");
  out(`  ${recall("·")} ${f.until || f.stale ? dim(f.text) : recall(f.text)}${past}${marks ? " " + marks : ""}`);
  const said = f.stale && f.seen_age ? "last said " + f.seen_age + " ago" : f.age && f.age + " ago";
  out(dim(`      ${[said, "confidence " + f.confidence, src].filter(Boolean).join(" · ")}`));
  out(dim(`      vyre why '${f.id}' · vyre memory correct '${f.id}' wrong|ended|replace|confirm`));
}

/** Flags that take no value. */
const BOOLEAN = new Set(["all", "off"]);
/** Pull --name value flags (and bare --flag) out of args. */
function flags(args, names) {
  const rest = [], opt = /** @type {Record<string, string|true>} */ ({});
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(args[i]);
    if (m && names.includes(m[1])) { opt[m[1]] = m[2] ?? (!BOOLEAN.has(m[1]) && args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true); continue; }
    rest.push(args[i]);
  }
  return { rest, opt };
}

const ACTIONS = ["wrong", "ended", "replace", "confirm", "add"];
const USAGE = {
  correct: "vyre memory correct <fact> wrong|ended|replace|confirm [new object] [--at <date>] [--note <why>] [--project <slug>]\n  vyre memory correct '<subject>|<rel>|<object>' add [--project <slug>]",
  merge: "vyre memory merge <node> <into>",
  split: "vyre memory split <node> --project <slug>   (that project's one is someone else)\n  vyre memory split <node> <other>             (keep two nodes apart)",
};

/** What one correction row says, on one line. */
function said(c) {
  const what = c.action === "merge" ? `${c.src} is ${c.dst}` : c.action === "split" ? (c.dst ? `${c.src} and ${c.dst} are two` : `${c.src} in ${c.object} is someone else`)
    : `${c.src} ${c.rel} ${c.dst}${c.object ? " -> " + c.object : ""}`;
  out(`  ${recall(String(c.id))} ${c.undone ? dim(c.action + " " + what + " (undone)") : c.action + " " + dim(what)}${c.scope !== "*" ? dim(" · " + c.scope) : ""}`);
  if (c.note) out(dim(`      ${c.note}`));
}

/** The sub-commands that change memory. Each is the user's own call, from their own terminal. */
async function change(sub, args) {
  const { rest, opt } = flags(args, ["project", "at", "note", "all", "off"]);
  const project = typeof opt.project === "string" ? { project: opt.project } : {};
  if (sub === "correct") {
    const [fact, action, ...obj] = rest;
    if (!fact || !ACTIONS.includes(action)) { out("  " + USAGE.correct); return 1; }
    const input = { fact, action, ...project, ...(obj.length ? { object: obj.join(" ") } : {}),
      ...(typeof opt.at === "string" ? { at: opt.at } : {}), ...(typeof opt.note === "string" ? { note: opt.note } : {}) };
    const r = await call("memory.correct", input);
    if (r.error) return fail(r);
    out(`  ${recall("corrected")} ${dim("· undo with vyre memory uncorrect " + r.data.correction.id)}`);
    for (const f of r.data.facts) line(f);
    return 0;
  }
  if (sub === "corrections") {
    const r = await call("memory.corrections", { ...project, all: opt.all === true });
    if (r.error) return fail(r);
    if (!r.data.length) { out(dim("  nothing corrected yet")); return 0; }
    for (const c of r.data) said(c);
    return 0;
  }
  if (sub === "uncorrect") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id) || id < 1) { out("  vyre memory uncorrect <id>"); return 1; }
    const r = await call("memory.uncorrect", { id });
    if (r.error) return fail(r);
    said(r.data);
    return 0;
  }
  if (sub === "merge") {
    const [node, into] = rest;
    if (!node || !into) { out("  " + USAGE.merge); return 1; }
    const r = await call("memory.merge", { node, into });
    if (r.error) return fail(r);
    out(`  ${recall("merged")} ${dim("· undo with vyre memory uncorrect " + r.data.correction.id)}`);
    return 0;
  }
  if (sub === "split") {
    const [node, other] = rest;
    if (!node || (!other && !project.project)) { out("  " + USAGE.split); return 1; }
    const r = await call("memory.split", { node, ...(other ? { other } : project) });
    if (r.error) return fail(r);
    out(`  ${recall("split")} ${dim("· undo with vyre memory uncorrect " + r.data.correction.id)}`);
    return 0;
  }
  // pin, mute: steering, everywhere or in one project's folder.
  const node = rest.join(" ").trim();
  if (!node) { out(`  vyre memory ${sub} <node> [--off]`); return 1; }
  const r = await call(`memory.${sub}`, { node, ...(opt.off === true ? { off: true } : {}) });
  if (r.error) return fail(r);
  out(`  ${recall(r.data.label)} ${dim(r.data.mode ? r.data.mode + "ned" : "back to normal")}`);
  return 0;
}
const CHANGES = new Set(["correct", "corrections", "uncorrect", "merge", "split", "pin", "mute"]);

export default [
  {
    name: "memory", order: 30, usage: "vyre memory [about] [--project <slug>] · correct|corrections|uncorrect|merge|split|pin|mute", summary: "what memory holds, or everything about one thing",
    async run(args0) {
      if (CHANGES.has(args0[0])) return change(args0[0], args0.slice(1));
      const { rest: args, opt } = flags(args0, ["project"]);
      const project = typeof opt.project === "string" ? { project: opt.project } : {};
      const about = args.join(" ").trim();
      if (!about) {
        const s = await call("memory.stats");
        if (s.error) return fail(s);
        const d = s.data;
        if (!d.recall) out(dim("  no Recall index yet, so nothing to remember from"));
        out(`  ${recall(d.facts + " facts")} ${dim(`· ${d.nodes} things · ${d.sessions} sessions read${d.lastRun ? ` · last pass ${d.lastRun.age} ago in ${d.lastRun.ms}ms` : ""}`)}`);
        if (project.project) out(dim(`  in ${project.project}`));
        const f = await call("memory.facts", { limit: 12, ...project });
        if (f.error) return fail(f);
        for (const x of f.data.facts) line(x);
        return 0;
      }
      const r = await call("memory.facts", { about, ...project });
      if (r.error) return fail(r);
      const a = r.data.about;
      if (!a) { out(`  nothing in memory matches ${JSON.stringify(about)}`); return 1; }
      const tags = [a.kind, a.role === "own" ? "yours" : a.role, `${a.sessions} session${a.sessions === 1 ? "" : "s"}`, a.age && "last " + a.age + " ago",
        a.pinned && "pinned", a.muted && "muted"].filter(Boolean);
      out(`\n  ${bold(recall(a.label))}  ${dim(tags.join(" · "))}\n`);
      for (const x of r.data.facts) line(x);
      out("");
      return 0;
    },
  },
  {
    name: "why", order: 31, usage: "vyre why <fact> [--project <slug>]", summary: "the turns a fact came from",
    async run(args0) {
      const { rest: args, opt } = flags(args0, ["project"]);
      const fact = args.join(" ").trim();
      if (!fact) { out("  vyre why <fact id or name>"); return 1; }
      const r = await call("memory.why", { fact, ...(typeof opt.project === "string" ? { project: opt.project } : {}) });
      if (r.error) return fail(r);
      const d = r.data;
      if (!d.fact) { out(`  nothing in memory matches ${JSON.stringify(fact)}`); return 1; }
      out(`\n  ${recall(d.fact.text || d.fact.label)}\n`);
      for (const t of d.turns) {
        out(dim(`  ${t.name || t.session.slice(0, 8)} #${t.seq} · ${t.role}${t.age ? " · " + t.age + " ago" : ""}`));
        out(`    ${t.text.replace(/\s+/g, " ")}`);
      }
      for (const l of d.taught || []) {
        out(dim(`  taught by ${l.module} · ${l.kind}${l.age ? " · " + l.age + " ago" : ""}`));
        if (l.text) out(`    ${l.text}`);
      }
      for (const c of d.corrections || []) out(dim(`  your ${c.action}${c.age ? " · " + c.age + " ago" : ""}${c.undone ? " · undone" : ""}${c.note ? " · " + c.note : ""}`));
      if (!d.turns.length && !(d.taught || []).length && !(d.corrections || []).length) out(dim("  no supporting turns are left"));
      if (d.gone) out(dim(`  ${d.gone} supporting turn${d.gone === 1 ? " is" : "s are"} gone (the transcript was rewritten)`));
      out("");
      return 0;
    },
  },
];
