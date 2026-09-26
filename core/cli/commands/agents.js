// @ts-check
// Agents from the terminal: list them, make and change them, ask one something, see and stop
// its threads. Each agent runs as headless threads vyred owns, so everything here is a call to
// the agents tools and nothing runs Claude Code in this terminal.

import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { parse, up, tool } from "./projects.js";
import { json, emit, fail as kitFail, failTool, usage } from "../kit.js";

const SURFACE = "cli:" + process.pid;
const id8 = s => String(s || "").slice(0, 8);
const fail = (msg, next) => kitFail(msg, { next });
const cut = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

const USAGE = "vyre agents [list|create|update|ask|threads|usage|stop|delete] … [--json]";
const AGENT_FLAGS = { bool: ["assistant"], values: ["projects", "model", "vault", "fallback", "budget", "instructions"], cmd: "agents" };
const SUBS = ["list", "ls", "create", "update", "ask", "threads", "usage", "stop", "delete", "rm", "remove"];
const FLAGS = "--assistant --projects a,b|* --model m --vault item --fallback item --budget 20 --instructions text";

/**
 * The fields create and update share, from flags. Only what was given is sent, so an update
 * changes exactly the fields named and leaves the rest as they were.
 * @param {Record<string, any>} flags
 */
export function agentFields(flags) {
  /** @type {Record<string, any>} */
  const f = {};
  if (flags.assistant) f.kind = "assistant";
  if (flags.projects !== undefined) {
    const p = String(flags.projects).trim();
    f.projects = p === "*" ? "*" : p.split(",").map(s => s.trim()).filter(Boolean);
  }
  if (flags.model) f.model = flags.model;
  if (flags.instructions !== undefined) f.instructions = flags.instructions;
  /** @type {Record<string, any>} */
  const auth = {};
  if (flags.vault) auth.vault = flags.vault;
  if (flags.fallback) auth.fallback = flags.fallback;
  if (flags.budget !== undefined) {
    const n = Number(flags.budget);
    if (!Number.isFinite(n) || n < 0) throw new Error("--budget is dollars, e.g. --budget 20");
    auth.budget_usd = n;
  }
  if (Object.keys(auth).length) f.auth = auth;
  return f;
}

function showAgent(a, verb) {
  const projects = a.projects === "*" ? "every project" : Array.isArray(a.projects) ? a.projects.join(", ") || "no projects" : "";
  out(`  ${signal(verb)} ${bold(a.name)}  ${dim([a.kind, projects, a.model].filter(Boolean).join(" · "))}`);
}

async function list() {
  const r = await tool("agents.list", {});
  if (!r) return 1;
  const agents = Array.isArray(r) ? r : [];
  if (json()) return emit(agents);
  if (!agents.length) { out(dim(`  no agents yet · vyre agents create <name> [${FLAGS}]`)); return 0; }
  for (const a of agents) {
    const status = a.status === "waiting" ? beacon(String(a.status).padEnd(8)) : a.status === "working" ? signal(String(a.status).padEnd(8)) : dim(String(a.status || "").padEnd(8));
    const projects = a.projects === "*" ? "*" : Array.isArray(a.projects) ? a.projects.join(",") : "";
    out(`  ${String(a.name).padEnd(20)} ${dim(String(a.kind || "").padEnd(9))} ${status} ${cut(a.doing || "", 40).padEnd(40)} ${dim([projects, a.thread ? id8(a.thread) : "", a.auth || ""].filter(Boolean).join("  "))}`);
  }
  return 0;
}

async function createOrUpdate(which, args) {
  const { flags, pos } = parse(args, AGENT_FLAGS);
  const name = pos.join(" ").trim();
  if (!name) return usage(`vyre agents ${which} needs a name`, `vyre agents ${which} <name> [${FLAGS}]`);
  let fields;
  try { fields = agentFields(flags); } catch (e) { return usage(/** @type {Error} */ (e).message, "vyre help agents"); }
  if (which === "update" && !Object.keys(fields).length) return usage("vyre agents update: nothing to change", FLAGS);
  const a = await tool(which === "create" ? "agents.create" : "agents.update", { name, ...fields });
  if (!a) return 1;
  if (json()) return emit(a);
  showAgent(a, which === "create" ? "made" : "updated");
  return 0;
}

async function ask(args) {
  const [name, ...words] = args;
  if (!name || !words.length) return usage("vyre agents ask <name> <text>", "vyre agents lists them");
  // An agent may work for minutes before it answers, so this waits far past the usual 10s.
  const r = await call("agents.ask", { agent: name, text: words.join(" "), surface: SURFACE, wait: true }, { timeout: 600_000 });
  if (r.error) return failTool(r.error);
  const d = r.data || {};
  if (json()) { emit(d); return d.ok === false ? 1 : 0; }
  if (d.ask) {
    // It stopped on a permission question: say what, and how to answer it.
    const a = typeof d.ask === "object" ? d.ask : { id: d.ask };
    out(beacon(`  ${d.agent || name} is waiting on you${d.note ? ": " + d.note : ""}`));
    if (a.tool || a.summary) out(beacon(`  ? ask ${a.id}  ${a.tool || ""}: ${a.summary || ""}${a.destination ? " -> " + a.destination : ""}`));
    out(dim(`  vyre threads answer ${a.id} allow|deny   vyre threads watch ${id8(d.thread)}`));
    return 0;
  }
  if (d.text) out(`  ${bold(d.agent || name)} › ${d.text}`);
  else if (d.note) out(dim(`  ${d.note}`));
  const cost = typeof d.cost_usd === "number" ? `$${d.cost_usd.toFixed(4)}` : "";
  out(dim(`  ${[d.thread ? "thread " + id8(d.thread) : "", cost].filter(Boolean).join(" · ")}`));
  return d.ok === false ? 1 : 0;
}

async function threads(args) {
  const name = args.join(" ").trim();
  if (!name) return usage("vyre agents threads needs an agent's name", "vyre agents lists them");
  const ts = await tool("agents.threads", { agent: name });
  if (!ts) return 1;
  if (json()) return emit(ts);
  if (!ts.length) { out(dim(`  ${name} has no threads yet`)); return 0; }
  for (const t of ts) out(`  ${dim(id8(t.id))}  ${String(t.status).padEnd(8)} ${dim(String(t.holder || "-").padEnd(14))} ${cut(t.name || t.cwd, 40)}`);
  out(dim("  vyre threads watch <id>"));
  return 0;
}

/** What each agent has used: turns, time, tokens, dollars against its budget, and the last rate-limit report. */
async function usageOf(args) {
  const name = args.join(" ").trim();
  const rows = await tool("agents.usage", name ? { agent: name } : {});
  if (!rows) return 1;
  if (json()) return emit(rows);
  if (!rows.length) { out(dim("  no agents yet")); return 0; }
  const k = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
  for (const u of rows) {
    const tokens = u.tokens.input + u.tokens.output + u.tokens.cache_read + u.tokens.cache_write;
    const money = u.budget_usd != null ? `$${u.spent_usd.toFixed(2)} of $${u.budget_usd.toFixed(2)}` : u.api_cost_usd ? `$${u.api_cost_usd.toFixed(2)} on the API key` : "no API spend";
    const limit = u.limit && u.limit.status !== "allowed" ? beacon(` limit ${u.limit.status}${typeof u.limit.utilization === "number" ? " " + Math.round(u.limit.utilization * 100) + "%" : ""}`) : "";
    out(`  ${bold(String(u.agent ?? "(no agent)").padEnd(12))} ${String(u.turns).padStart(4)} turns  ${dim((Math.round(u.duration_ms / 1000) + "s").padStart(6))}  ${dim(k(tokens).padStart(6) + " tokens")}  ${money}${limit}`);
  }
  return 0;
}

async function stop(args) {
  const name = args.join(" ").trim();
  if (!name) return usage("vyre agents stop needs an agent's name", "vyre agents lists them");
  const r = await tool("agents.stop", { agent: name });
  if (!r) return 1;
  if (json()) return emit(r);
  const ids = r.stopped || [];
  out(ids.length ? `  stopped ${ids.length} thread${ids.length === 1 ? "" : "s"} of ${r.agent || name} ${dim(ids.map(id8).join(" "))}` : dim(`  ${r.agent || name} had nothing running`));
  return 0;
}

async function remove(args) {
  const name = args.join(" ").trim();
  if (!name) return usage("vyre agents delete needs an agent's name", "vyre agents lists them");
  const r = await tool("agents.delete", { agent: name });
  if (!r) return 1;
  if (json()) return emit(r);
  out(`  deleted ${r.agent} ${dim("(its threads' transcripts stay)")}`);
  return 0;
}

export default {
  name: "agents", order: 30, usage: USAGE,
  summary: "agents: list, create, update, ask, threads, usage, stop, delete",
  /** @param {string[]} args */
  async run(args) {
    const [sub, ...rest] = args.filter(a => a !== "--json");
    if (sub && !SUBS.includes(sub)) return usage(`vyre agents ${sub}: not a subcommand`, USAGE);
    // A mistyped flag is refused before vyred is started for it.
    if (sub === "create" || sub === "update") parse(rest, AGENT_FLAGS);
    if (!(await up())) return 5;
    if (!sub || sub === "list" || sub === "ls") return list();
    if (sub === "create" || sub === "update") return createOrUpdate(sub, rest);
    if (sub === "ask") return ask(rest);
    if (sub === "threads") return threads(rest);
    if (sub === "usage") return usageOf(rest);
    if (sub === "stop") return stop(rest);
    return remove(rest);
  },
};
