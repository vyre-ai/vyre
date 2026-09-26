// @ts-check
// `vyre recall <query>` and `vyre index`: search every session, and index new ones now.

import { call } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";
import { out, dim, bold, beacon, recall as gold } from "../style.js";

/** "3h ago", "2d ago": how long since a session was last active. */
export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const d = Math.round(s / 86400);
  return d < 60 ? `${d}d ago` : `${Math.round(d / 30)}mo ago`;
}

/** Split argv into words and --flags. */
function parse(args) {
  const flags = /** @type {Record<string, string|boolean>} */ ({}), words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { words.push(a); continue; }
    const k = a.slice(2);
    if (["user", "assistant", "keyword", "json", "here"].includes(k)) flags[k] = true;
    else flags[k] = args[++i] ?? "";
  }
  return { flags, words };
}

async function up() {
  const r = await ensureUp();
  if (!r.ok) out(beacon("  vyred did not start") + dim(` · its output is in ${r.log}`));
  return r.ok;
}

export default [
  {
    name: "recall", order: 20, usage: "vyre recall <query>", summary: "search every session for what was said",
    async run(args) {
      const { flags, words } = parse(args);
      const q = words.join(" ").trim();
      if (!(await up())) return 1;
      if (!q) {
        const s = await call("recall.status");
        if (s.error) { out(beacon(`  ${s.error.code}: `) + s.error.message); return 1; }
        const d = s.data;
        out(`  ${d.sessions} sessions · ${d.turns} turns indexed${d.indexing ? dim(" · indexing now") : ""}`);
        out(dim(`  vectors: ${d.vectors.why}${d.vectors.on ? ` · ${d.vectors.embedded} embedded, ${d.vectors.pending} to go` : ""}`));
        out(dim("  vyre recall <query> to search"));
        return 0;
      }
      const input = /** @type {any} */ ({ q, limit: Number(flags.limit || 10), per_session: 1 });
      if (flags.user) input.role = "user";
      if (flags.assistant) input.role = "assistant";
      if (flags.keyword) input.hybrid = false;
      if (flags.here) input.project_cwds = [process.cwd()];
      const r = await call("recall.search", input);
      if (r.error) { out(beacon(`  ${r.error.code}: `) + r.error.message); return 1; }
      if (flags.json) { out(JSON.stringify(r.data, null, 2)); return 0; }
      if (!r.data.length) {
        const s = await call("recall.status");
        out(`  nothing matching ${JSON.stringify(q)}` + (s.data && s.data.indexing ? dim(" · still indexing, try again in a moment") : ""));
        return 0;
      }
      for (const h of r.data) {
        out(`\n  ${bold(h.name || h.title || "(untitled)")}`);
        // The full id, because that is what --resume takes; a subagent resumes through its parent.
        const [id, agent] = h.session.split("/");
        out(dim(`    ${id}${agent ? " (subagent)" : ""} · ${ago(h.ts)} · ${h.role} · ${h.cwd || "?"}`));
        // What came from the index is shown in the memory colour: it is a quote, not a model's words.
        out(`    ${h.snippet.slice(0, 200).replace(/«([^»]*)»/g, (_, w) => gold(w))}`);
      }
      out(dim(`\n  resume one with: claude --resume <id>  ·  vyre call recall.thread '{"session":"<id>"}'`));
      return 0;
    },
  },
  {
    name: "index", order: 21, summary: "index new and changed sessions now",
    async run() {
      if (!(await up())) return 1;
      const r = await call("recall.index", {}, { timeout: 30 * 60_000 });
      if (r.error) { out(beacon(`  ${r.error.code}: `) + r.error.message); return 1; }
      const d = r.data;
      if (!d) { out("  vyred is stopping"); return 1; }
      out(`  ${d.sessions} sessions · ${d.added} new · ${d.appended} grew · ${d.reindexed} rewritten · ${d.skipped} unchanged` +
        (d.failed ? beacon(` · ${d.failed} unreadable`) : "") + dim(` · ${d.turns} turns in ${d.ms}ms`));
      return 0;
    },
  },
];
