// @ts-check
// `vyre recall <query>` and `vyre index`: search every session, and index new ones now.

import fs from "node:fs";
import { call } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";
import { out, dim, bold, beacon, recall as gold } from "../style.js";
import { json, emit, fail, failTool, usage } from "../kit.js";
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
  if (!r.ok) fail("vyred did not start", { code: "unreachable", exit: 5, next: `its output is in ${r.log}` });
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
    name: "recall", order: 20, usage: "vyre recall <query> [--limit n] [--here] [--json]",
    help: "--user or --assistant: only what that side said · --keyword: no vectors\nvyre recall with no query: how much is indexed\nvyre recall --setup: install the search model now (it installs itself on first use)\nvyre recall eval <labelled.json> [--k 10]: measure search against a labelled set", summary: "search every session for what was said (vyre recall eval <file> to measure it)",
    async run(args) {
      if (args[0] === "eval") return evalCommand(args.slice(1));
      const { flags, words } = parse(args);
      if (flags.setup) return setup();
      const q = words.join(" ").trim();
      if (!(await up())) return 5;
      if (!q) {
        const s = await call("recall.status");
        if (s.error) return failTool(s.error);
        const d = s.data;
        if (flags.json) return emit(d);
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
      if (flags.json) return emit(r.data);
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
