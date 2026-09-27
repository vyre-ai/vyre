// @ts-check
// `vyre memory [about] [<thing>]`, `vyre memory ask "<question>"`, `vyre memory correct|merge|split|pin|mute ...`
// and `vyre why <fact>`.
// Everything shown here came from memory rather than a model, so it is drawn in the Recall gold.
// --project <slug> reads (or corrects) one project's room; "unfiled" is the room of no project.

import { call } from "../../daemon/client.js";
import { out, dim, bold, recall, beacon } from "../style.js";
import { json, emit, failTool, usage, fail as failed } from "../kit.js";

const fail = r => failTool(r.error);

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

/** Facts as a table, for --view: what each says, how sure, where from, how old. Each row keeps the fact's id. */
function factsView(facts, title, empty) {
  return { kind: "table", title, columns: [{ key: "text", label: "Fact" }, { key: "confidence", label: "Confidence" }, { key: "source", label: "Source" }, { key: "age", label: "Age" }],
    rows: (facts || []).map(f => ({ id: f.id, text: String(f.text ?? "") + (f.until ? ` (until ${new Date(f.until).toISOString().slice(0, 10)})` : "") + (f.conflict ? " (two projects disagree)" : "") + (f.stale ? " (stale)" : ""),
      confidence: f.confidence ?? "", source: f.ref ? `${f.source} #${f.ref.seq}` : f.source || "", age: f.stale && f.seen_age ? `last said ${f.seen_age} ago` : f.age ? `${f.age} ago` : "" })),
    empty };
}

/** Flags that take no value. */
const BOOLEAN = new Set(["all", "off", "json", "sources"]);
/** Pull --name value flags (and bare --flag) out of args. */
function flags(args, names) {
  const rest = [], opt = /** @type {Record<string, string|true>} */ ({});
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(args[i]);
    if (m && m[1] === "json") continue;
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

/** What a correction did, in words. */
const whatOf = c => (c.action === "merge" ? `${c.src} is ${c.dst}` : c.action === "split" ? (c.dst ? `${c.src} and ${c.dst} are two` : `${c.src} in ${c.object} is someone else`)
  : `${c.src} ${c.rel} ${c.dst}${c.object ? " -> " + c.object : ""}`);

/** What one correction row says, on one line. */
function said(c) {
  const what = whatOf(c);
  out(`  ${recall(String(c.id))} ${c.undone ? dim(c.action + " " + what + " (undone)") : c.action + " " + dim(what)}${c.scope !== "*" ? dim(" · " + c.scope) : ""}`);
  if (c.note) out(dim(`      ${c.note}`));
}

/** The sub-commands that change memory: the user's own, so no presence prompt (an agent is refused). */
async function change(sub, args) {
  const { rest, opt } = flags(args, ["project", "at", "note", "all", "off"]);
  const project = typeof opt.project === "string" ? { project: opt.project } : {};
  if (sub === "correct") {
    const [fact, action, ...obj] = rest;
    if (!fact || !ACTIONS.includes(action)) return usage("vyre memory correct <fact> wrong|ended|replace|confirm", "vyre help memory");
    // The CLI prints the fact as it now reads, so it waits for the graph to have it.
    const input = { fact, action, wait: true, ...project, ...(obj.length ? { object: obj.join(" ") } : {}),
      ...(typeof opt.at === "string" ? { at: opt.at } : {}), ...(typeof opt.note === "string" ? { note: opt.note } : {}) };
    const r = await call("memory.correct", input);
    if (r.error) return fail(r);
    if (json()) return emit(r.data);
    out(`  ${recall("corrected")} ${dim("· undo with vyre memory uncorrect " + r.data.correction.id)}`);
    for (const f of r.data.facts) line(f);
    return 0;
  }
  if (sub === "corrections") {
    const r = await call("memory.corrections", { ...project, all: opt.all === true });
    if (r.error) return fail(r);
    // --json: [{ id, action, src, rel, dst, object, scope, note, undone }]
    if (json()) {
      return emit(r.data, { kind: "table", title: "Corrections", columns: [{ key: "id", label: "Correction" }, { key: "action", label: "Action" }, { key: "what", label: "What" },
        { key: "scope", label: "Where" }, { key: "state", label: "State" }],
      rows: r.data.map(c => ({ id: c.id, action: c.action, what: whatOf(c), scope: c.scope === "*" ? "everywhere" : c.scope, state: c.undone ? "undone" : "" })),
      empty: "Nothing corrected yet" });
    }
    if (!r.data.length) { out(dim("  nothing corrected yet")); return 0; }
    for (const c of r.data) said(c);
    return 0;
  }
  if (sub === "uncorrect") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id) || id < 1) return usage("vyre memory uncorrect needs a correction number", "vyre memory corrections lists them");
    const r = await call("memory.uncorrect", { id });
    if (r.error) return fail(r);
    if (json()) return emit(r.data);
    said(r.data);
    return 0;
  }
  if (sub === "merge") {
    const [node, into] = rest;
    if (!node || !into) return usage(USAGE.merge, "vyre help memory");
    const r = await call("memory.merge", { node, into });
    if (r.error) return fail(r);
    if (json()) return emit(r.data);
    out(`  ${recall("merged")} ${dim("· undo with vyre memory uncorrect " + r.data.correction.id)}`);
    return 0;
  }
  if (sub === "split") {
    const [node, other] = rest;
    if (!node || (!other && !project.project)) return usage("vyre memory split <node> --project <slug> | <other>", "vyre help memory");
    const r = await call("memory.split", { node, ...(other ? { other } : project) });
    if (r.error) return fail(r);
    if (json()) return emit(r.data);
    out(`  ${recall("split")} ${dim("· undo with vyre memory uncorrect " + r.data.correction.id)}`);
    return 0;
  }
  // pin, mute: steering, everywhere or in one project's folder.
  const node = rest.join(" ").trim();
  if (!node) return usage(`vyre memory ${sub} needs a node`, `vyre memory ${sub} <node> [--off]`);
  const r = await call(`memory.${sub}`, { node, ...(opt.off === true ? { off: true } : {}) });
  if (r.error) return fail(r);
  if (json()) return emit(r.data);
  out(`  ${recall(r.data.label)} ${dim(r.data.mode === "mute" ? "muted" : r.data.mode === "pin" ? "pinned" : "back to normal")}`);
  return 0;
}
const CHANGES = new Set(["correct", "corrections", "uncorrect", "merge", "split", "pin", "mute"]);

/** `vyre memory ask "<question>"`: one line about the user's life, how sure, and where it came from. */
async function ask(args) {
  const { rest, opt } = flags(args, ["sources"]);
  const q = rest.join(" ").trim();
  if (!q) return usage("vyre memory ask needs a question", 'vyre memory ask "what car do I drive"');
  const r = await call("memory.answer", { q, ...(opt.sources === true ? { sources: true } : {}) });
  if (r.error) return fail(r);
  const d = r.data;
  // --json: { answer, kind, confidence, from, sources?: [{ session, name, seq, quote }] }
  if (json()) {
    const from = d.from ? `${d.from} conversation${d.from === 1 ? "" : "s"}` : d.kind === "fact" ? "your setup" : "";
    emit(d, { kind: "card", title: q, state: d.answer ? "ok" : "off", fields: d.answer ? [
      { label: "Answer", value: String(d.answer) },
      ...(d.kind ? [{ label: "Kind", value: d.kind === "said" ? "your own words" : String(d.kind) }] : []),
      { label: "Confidence", value: String(d.confidence ?? "") },
      ...(from ? [{ label: "From", value: from }] : []),
      ...(d.sources || []).map(x => ({ label: `${x.name || String(x.session || "").slice(0, 8)} #${x.seq}`, value: String(x.quote ?? "") })),
    ] : [{ label: "Answer", value: "memory does not know that yet" }] });
    return d.answer ? 0 : 1;
  }
  if (!d.answer) { out(dim("  memory does not know that yet")); return 1; }
  out(`\n  ${bold(recall(d.answer))}`);
  const from = d.from ? `from ${d.from} conversation${d.from === 1 ? "" : "s"}` : d.kind === "fact" ? "from your setup" : "";
  out(dim(`  ${[d.kind === "said" ? "your own words" : null, "confidence " + d.confidence, from].filter(Boolean).join(" · ")}`));
  for (const s of d.sources || []) out(dim(`    ${s.name || s.session.slice(0, 8)} #${s.seq}: `) + s.quote);
  out("");
  return 0;
}

export default [
  {
    name: "memory", order: 30,
    usage: "vyre memory [about [<thing...>]|ask <question...>|correct <fact> <action>|corrections|uncorrect <id>|merge <node> <into>|split <node>|pin <node>|mute <node>] [--project <slug>] [--json]",
    verbs: [
      { verb: "about", summary: "what memory holds, or everything about one thing", usage: "[<thing...>] [--project v]", read: true },
      { verb: "ask", summary: "one line about your life, from what you have said", usage: "<question...> [--sources]", read: true },
      { verb: "correct", summary: "mark a fact wrong, ended, replaced or confirmed, or add one", usage: "<fact> wrong|ended|replace|confirm|add [<object...>] [--at v] [--note v] [--project v]" },
      { verb: "corrections", summary: "what you corrected, newest first", usage: "[--all] [--project v]", read: true },
      { verb: "uncorrect", summary: "undo a correction", usage: "<id>" },
      { verb: "merge", summary: "two nodes are one", usage: "<node> <into>" },
      { verb: "split", summary: "keep two nodes apart, or one project's is someone else", usage: "<node> [<other>] [--project v]" },
      { verb: "pin", summary: "keep a thing in view", usage: "<node...> [--off]" },
      { verb: "mute", summary: "keep a thing out of view", usage: "<node...> [--off]" },
    ],
    help: "Read it:\n  vyre memory [about] [<thing>] [--project <slug>]   what it holds, or everything about one thing\nAsk it:\n  vyre memory ask \"<question>\" [--sources]   one line about your life, from what you have said\nChange what it holds:\n  " + USAGE.correct + "\n  vyre memory corrections [--all] · vyre memory uncorrect <id>\n  " + USAGE.merge + "\n  " + USAGE.split + "\n  vyre memory pin|mute <node> [--off]", summary: "what memory holds, or everything about one thing",
    async run(args0) {
      if (CHANGES.has(args0[0])) return change(args0[0], args0.slice(1));
      if (args0[0] === "ask") return ask(args0.slice(1));
      // `about` is the verb word a surface calls; bare `vyre memory` and `vyre memory <thing>` still work.
      const { rest: args, opt } = flags(args0[0] === "about" ? args0.slice(1) : args0, ["project"]);
      const project = typeof opt.project === "string" ? { project: opt.project } : {};
      const about = args.join(" ").trim();
      if (!about) {
        const s = await call("memory.stats");
        if (s.error) return fail(s);
        const d = s.data;
        // --json: { stats: { facts, nodes, sessions, recall, lastRun }, facts: [{ id, text, confidence, source, ref, age, until, stale, conflict }] }
        if (json()) {
          const f = await call("memory.facts", { limit: 12, ...project });
          if (f.error) return fail(f);
          const title = `${d.facts} facts · ${d.nodes} things · ${d.sessions} sessions read${project.project ? ` · in ${project.project}` : ""}`;
          return emit({ stats: d, facts: f.data.facts }, factsView(f.data.facts, title, d.recall ? "Nothing remembered yet" : "No Recall index yet, so nothing to remember from"));
        }
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
      // --json: { about: { label, kind, role, sessions, age, pinned, muted } | null, facts: [fact] }
      if (json()) {
        const title = a ? [a.label, a.kind, a.role === "own" ? "yours" : a.role, `${a.sessions} session${a.sessions === 1 ? "" : "s"}`, a.pinned && "pinned", a.muted && "muted"].filter(Boolean).join(" · ")
          : `Nothing in memory matches ${JSON.stringify(about)}`;
        emit(r.data, factsView(r.data.facts, title, "No facts about it yet"));
        return a ? 0 : 1;
      }
      if (!a) return failed(`nothing in memory matches ${JSON.stringify(about)}`, { code: "not_found", next: "vyre memory shows what it holds · vyre recall <words> searches what was said" });
      const tags = [a.kind, a.role === "own" ? "yours" : a.role, `${a.sessions} session${a.sessions === 1 ? "" : "s"}`, a.age && "last " + a.age + " ago",
        a.pinned && "pinned", a.muted && "muted"].filter(Boolean);
      out(`\n  ${bold(recall(a.label))}  ${dim(tags.join(" · "))}\n`);
      for (const x of r.data.facts) line(x);
      out("");
      return 0;
    },
  },
  {
    name: "why", order: 31, usage: "vyre why <fact> [--project <slug>] [--json]", summary: "the turns a fact came from",
    async run(args0) {
      const { rest: args, opt } = flags(args0, ["project"]);
      const fact = args.join(" ").trim();
      if (!fact) return usage("vyre why needs a fact id or name", "vyre memory lists facts with their ids");
      const r = await call("memory.why", { fact, ...(typeof opt.project === "string" ? { project: opt.project } : {}) });
      if (r.error) return fail(r);
      const d = r.data;
      // --json: { fact: { id, text, label } | null, turns: [{ session, name, seq, role, age, text }], taught, corrections, gone }
      if (json()) {
        emit(d, { kind: "table", title: d.fact ? String(d.fact.text || d.fact.label) : `Nothing in memory matches ${JSON.stringify(fact)}`,
          columns: [{ key: "where", label: "Conversation" }, { key: "role", label: "Who" }, { key: "age", label: "Age" }, { key: "text", label: "Said" }],
          rows: (d.turns || []).map(t => ({ id: `${t.session}#${t.seq}`, where: `${t.name || String(t.session || "").slice(0, 8)} #${t.seq}`, role: t.role, age: t.age ? `${t.age} ago` : "",
            text: String(t.text ?? "").replace(/\s+/g, " ") })),
          empty: "No supporting turns are left" });
        return d.fact ? 0 : 1;
      }
      if (!d.fact) return failed(`nothing in memory matches ${JSON.stringify(fact)}`, { code: "not_found", next: "vyre memory shows what it holds" });
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
