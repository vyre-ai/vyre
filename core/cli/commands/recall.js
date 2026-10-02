// @ts-check
// `vyre recall <query>` and `vyre index`: search every session, and index new ones now.

import fs from "node:fs";
import { call } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";
import { out, dim, bold, beacon, recall as gold } from "../style.js";
import { json, emit, fail, failTool, usage, viewing } from "../kit.js";
import { DOWNLOAD_MB } from "../../recall/embed.js";

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
    if (["user", "assistant", "keyword", "json", "here", "setup"].includes(k)) flags[k] = true;
    else flags[k] = args[++i] ?? "";
  }
  return { flags, words };
}

async function up() {
  const r = await ensureUp();
  if (!r.ok) fail("Vyre did not start", { code: "unreachable", exit: 5, next: `its output is in ${r.log}` });
  return r.ok;
}

/** `vyre recall eval <file>`: run a labelled set through recall.eval and print the scores. */
async function evalCommand(args) {
  const { flags, words } = parse(args);
  if (!words[0]) return usage("vyre recall eval needs a labelled set", "vyre recall eval <labelled.json> [--k 10] [--json]");
  let set;
  try { set = JSON.parse(fs.readFileSync(words[0], "utf8")); } catch (e) { return fail("could not read the labelled set: " + /** @type {Error} */ (e).message, { next: "give a JSON file with a queries list" }); }
  if (!(await up())) return 5;
  const r = await call("recall.eval", { queries: set.queries || [], nonsense: set.nonsense || [], k: Number(flags.k || 10) }, { timeout: 30 * 60_000 });
  if (r.error) return failTool(r.error);
  const d = r.data;
  // --json: recall.eval's scores { k, queries, keyword, dense, hybrid, floor, nonsense }
  if (flags.json) return emit(d);
  const row = (name, s) => out(`  ${name.padEnd(8)} ${s ? `MRR@${d.k} ${s.mrr.toFixed(3)}   recall@${d.k} ${s.recall.toFixed(3)}` : dim("no vectors")}`);
  out(`  ${d.queries} questions`);
  row("keyword", d.keyword); row("dense", d.dense); row("hybrid", d.hybrid);
  if (d.floor) out(dim(`  floor ${d.floor.value} over ${d.floor.chunks} chunks · ${d.floor.answersBelow} of ${d.floor.answers} answers below it · weakest tenth of answers ${d.floor.answerP10} · best nonsense ${d.floor.nonsenseTop}`));
  if (d.nonsense.n) out(dim(`  nonsense: ${d.nonsense.withDense} of ${d.nonsense.n} got dense candidates, ${d.nonsense.withHits} returned anything`));
  return 0;
}

/** `vyre recall --setup`: install the search model now and wait for it. */
async function setup() {
  if (!(await up())) return 5;
  if (!json()) out(dim(`  installing the search model (about ${DOWNLOAD_MB.runtime + DOWNLOAD_MB.model} MB the first time, then nothing) ...`));
  const r = await call("recall.setup", {}, { timeout: 30 * 60_000 });
  if (r.error) return failTool(r.error);
  // --json: { ready, model, ... } as recall.setup gives it
  if (json()) return r.data.ready ? emit(r.data) : fail(r.data.why, { code: "unavailable", next: "vyre recall --setup to try again" });
  if (!r.data.ready) return fail(r.data.why, { next: "check the network, then vyre recall --setup again" });
  out(`  search by meaning is on ${dim(`· ${r.data.model} · vectors fill in over the next few minutes`)}`);
  return 0;
}

/** One dim line when search is by keyword because the model is not ready yet. */
async function keywordOnly() {
  const s = await call("recall.status");
  const v = s.data && s.data.vectors;
  if (!v || v.ready || (!v.on && /config\.json/.test(v.why))) return;
  // vyred's reason already ends "search is by keyword ...": it is the whole line.
  out(dim(`\n  ${v.why} · vyre recall --setup`));
}

export default [
  {
    name: "recall", order: 20, usage: "vyre recall [search <query...>|status|setup|eval <file>] [--limit n] [--here] [--json]",
    help: "vyre recall <query> or vyre recall search <query>: search · --user or --assistant: only what that side said · --keyword: no vectors\nvyre recall (or vyre recall status): how much is indexed\nvyre recall setup (or --setup): install the search model now (it installs itself on first use)\nvyre recall eval <labelled.json> [--k 10]: measure search against a labelled set", summary: "search every session for what was said (vyre recall eval <file> to measure it)",
    verbs: [
      { verb: "search", summary: "search every session for what was said", usage: "<query...> [--limit n] [--here] [--user] [--assistant] [--keyword]", read: true },
      { verb: "status", summary: "how much is indexed, and whether search by meaning is on (the default)", usage: "", read: true },
      { verb: "setup", summary: "install the search model now", usage: "" },
      { verb: "eval", summary: "measure search against a labelled set", usage: "<file> [--k n]", read: true },
    ],
    async run(args) {
      if (args[0] === "eval") return evalCommand(args.slice(1));
      const { flags, words: said } = parse(args);
      // `status` and `setup` are verbs only alone; `search` goes before a query. Any other words search.
      const alone = said.length === 1 ? said[0] : "";
      if (flags.setup || alone === "setup") return setup();
      if (said[0] === "search" && said.length === 1) return usage("vyre recall search needs what to look for", "vyre recall search <query>");
      const words = alone === "status" ? [] : said[0] === "search" ? said.slice(1) : said;
      const q = words.join(" ").trim();
      if (!(await up())) return 5;
      if (!q) {
        const s = await call("recall.status");
        if (s.error) return failTool(s.error);
        const d = s.data;
        // --json: recall.status { sessions, turns, indexing, vectors: { on, ready, why, embedded, pending, ... } }
        if (flags.json) {
          const v = d.vectors || {};
          return emit(d, viewing() ? { kind: "card", title: "Recall", fields: [{ label: "Sessions", value: String(d.sessions) }, { label: "Turns", value: String(d.turns) },
            { label: "Indexing", value: d.indexing ? "now" : "no" }, { label: "Search by meaning", value: String(v.why || (v.on ? "on" : "off")) },
            ...(v.on ? [{ label: "Embedded", value: `${v.embedded} embedded, ${v.pending} to go` }] : [])], state: v.ready ? "ok" : v.on ? "wait" : "unknown" } : undefined);
        }
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
      if (r.error) return failTool(r.error);
      // --json: [{ session, seq, role, ts, text, snippet, name, title, cwd, ... }]
      if (flags.json) {
        return emit(r.data, viewing() ? { kind: "table", title: `Recall: ${q}`, empty: `Nothing matching "${q}"`,
          columns: [{ key: "name", label: "Session" }, { key: "role", label: "Who" }, { key: "when", label: "When" }, { key: "snippet", label: "Said" }, { key: "id", label: "Session id" }],
          rows: r.data.map(h => ({ id: h.session, name: h.name || h.title || "(untitled)", role: h.role, when: ago(h.ts), snippet: String(h.snippet || "").slice(0, 200).replace(/[«»]/g, "") })) } : undefined);
      }
      if (!r.data.length) {
        const s = await call("recall.status");
        out(`  nothing matching ${JSON.stringify(q)}` + (s.data && s.data.indexing ? dim(" · still indexing, try again in a moment") : ""));
        if (!flags.keyword) await keywordOnly();
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
      if (!flags.keyword) await keywordOnly();
      return 0;
    },
  },
  {
    name: "index", order: 21, usage: "vyre index [--json]", summary: "index new and changed sessions now",
    // --json: recall.index { sessions, added, appended, reindexed, skipped, failed, turns, ms }
    async run() {
      if (!(await up())) return 5;
      const r = await call("recall.index", {}, { timeout: 30 * 60_000 });
      if (r.error) return failTool(r.error);
      const d = r.data;
      if (!d) return fail("vyred is stopping", { next: "vyre up, then vyre index" });
      if (json()) return emit(d);
      out(`  ${d.sessions} sessions · ${d.added} new · ${d.appended} grew · ${d.reindexed} rewritten · ${d.skipped} unchanged` +
        (d.failed ? beacon(` · ${d.failed} unreadable`) : "") + dim(` · ${d.turns} turns in ${d.ms}ms`));
      return 0;
    },
  },
];
