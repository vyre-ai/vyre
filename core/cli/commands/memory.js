// @ts-check
// `vyre memory [about]` and `vyre why <fact>`. Everything shown here came from memory rather
// than a model, so it is drawn in the Recall gold.

import { call } from "../../daemon/client.js";
import { out, dim, bold, recall, beacon } from "../style.js";

const unreachable = r => r.error && ["unreachable", "timeout"].includes(r.error.code);
const fail = r => { out(unreachable(r) ? `  vyred is not running ${dim("· vyre up to start it")}` : beacon(`  ${r.error.code}: `) + r.error.message); return 1; };

/** One fact on one line, with where it came from underneath. */
function line(f) {
  const past = f.until ? dim(" (until " + new Date(f.until).toISOString().slice(0, 10) + ")") : "";
  const src = f.source ? `${f.source.name || f.source.session.slice(0, 8)} #${f.source.seq}` : "";
  out(`  ${recall("·")} ${f.until ? dim(f.text) : recall(f.text)}${past}`);
  out(dim(`      ${[f.age && f.age + " ago", "confidence " + f.confidence, src].filter(Boolean).join(" · ")}`));
  out(dim(`      vyre why '${f.id}'`));
}

export default [
  {
    name: "memory", order: 30, usage: "vyre memory [about]", summary: "what memory holds, or everything about one thing",
    async run(args) {
      const about = args.join(" ").trim();
      if (!about) {
        const s = await call("memory.stats");
        if (s.error) return fail(s);
        const d = s.data;
        if (!d.recall) out(dim("  no Recall index yet, so nothing to remember from"));
        out(`  ${recall(d.facts + " facts")} ${dim(`· ${d.nodes} things · ${d.sessions} sessions read${d.lastRun ? ` · last pass ${d.lastRun.age} ago in ${d.lastRun.ms}ms` : ""}`)}`);
        const f = await call("memory.facts", { limit: 12 });
        if (f.error) return fail(f);
        for (const x of f.data.facts) line(x);
        return 0;
      }
      const r = await call("memory.facts", { about });
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
    name: "why", order: 31, usage: "vyre why <fact>", summary: "the turns a fact came from",
    async run(args) {
      const fact = args.join(" ").trim();
      if (!fact) { out("  vyre why <fact id or name>"); return 1; }
      const r = await call("memory.why", { fact });
      if (r.error) return fail(r);
      const d = r.data;
      if (!d.fact) { out(`  nothing in memory matches ${JSON.stringify(fact)}`); return 1; }
      out(`\n  ${recall(d.fact.text || d.fact.label)}\n`);
      for (const t of d.turns) {
        out(dim(`  ${t.name || t.session.slice(0, 8)} #${t.seq} · ${t.role}${t.age ? " · " + t.age + " ago" : ""}`));
        out(`    ${t.text.replace(/\s+/g, " ")}`);
      }
      if (!d.turns.length) out(dim("  no supporting turns are left"));
      if (d.gone) out(dim(`  ${d.gone} supporting turn${d.gone === 1 ? " is" : "s are"} gone (the transcript was rewritten)`));
      out("");
      return 0;
    },
  },
];
