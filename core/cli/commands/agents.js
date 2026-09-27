// @ts-check
// Agents from the terminal: list them, make and change them, ask one something, read what was
// asked before, see, stop and resume its threads, and look after its computer. Each agent runs as
// headless threads vyred owns, so everything here is a call to the agents and computers tools and
// nothing runs Claude Code in this terminal.

import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { parse, up, tool } from "./projects.js";
import { json, emit, fail as kitFail, failTool, usage } from "../kit.js";
import { callAsPerson } from "../presence.js";

const SURFACE = "cli:" + process.pid;
const id8 = s => String(s || "").slice(0, 8);
const fail = (msg, next) => kitFail(msg, { next });
const cut = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

const USAGE = "vyre agents [list|create|update|ask|history|threads|resume|computer|usage|stop|delete] … [--json]";
const AGENT_FLAGS = { bool: ["assistant"], values: ["projects", "model", "vault", "fallback", "budget", "instructions"], cmd: "agents" };
const SUBS = ["list", "ls", "create", "update", "ask", "history", "threads", "resume", "computer", "usage", "stop", "delete", "rm", "remove"];
const HISTORY_FLAGS = { values: ["limit", "before"], cmd: "agents" };
const COMPUTER_FLAGS = { values: ["cpus", "memory"], cmd: "agents" };
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
  // Both are on the floor's human-only list: Touch ID or a code typed at this terminal.
  const r = await callAsPerson(which === "create" ? "agents.create" : "agents.update", { name, ...fields });
  if (r.error) { failTool(r.error); return 1; }
  const a = r.data;
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

/** `vyre agents history <name> [--limit n] [--before id]`: what was asked of it and what it said, oldest first. */
async function history(args) {
  const { flags, pos } = parse(args, HISTORY_FLAGS);
  const name = pos.join(" ").trim();
  if (!name) return usage("vyre agents history needs an agent's name", "vyre agents lists them");
  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) return usage(`--limit ${flags.limit} is not a count`, "vyre agents history <name> --limit 10");
  const before = flags.before === undefined ? undefined : Number(flags.before);
  if (before !== undefined && !(Number.isInteger(before) && before > 0)) return usage(`--before ${flags.before} is not an exchange id`, "vyre agents history <name> --json shows each id");
  const rows = await tool("agents.history", { agent: name, ...(limit ? { limit } : {}), ...(before ? { before } : {}) });
  if (!rows) return 1;
  if (json()) return emit(rows);
  if (!rows.length) { out(dim(`  nothing asked of ${name} yet · vyre agents ask ${name} <text>`)); return 0; }
  for (const x of rows) {
    const when = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(x.at);
    out(`\n  ${dim(`${when} · ${x.surface || "?"} · thread ${id8(x.thread)} · #${x.id}`)}`);
    out(`  ${bold("you")} › ${cut(x.text, 200)}`);
    out(x.answer ? `  ${bold(x.agent)} › ${cut(x.answer, 400)}` : dim(`  ${x.agent} has not answered`));
  }
  out(dim(`\n  older: vyre agents history ${name} --before ${rows[0].id}`));
  return 0;
}

/** `vyre agents resume <name> [thread]`: its latest thread (or the one named) back, idle, with its own credentials. */
async function resume(args) {
  const [name, thread] = args;
  if (!name) return usage("vyre agents resume needs an agent's name", "vyre agents lists them");
  const r = await callAsPerson("agents.resume", { agent: name, ...(thread ? { thread } : {}) });
  if (r.error) return failTool(r.error, /no thread to resume/.test(String(r.error.message)) ? `vyre agents ask ${name} <text>` : undefined);
  if (json()) return emit(r.data);
  const t = r.data;
  out(t.running ? dim(`  ${name}'s thread ${id8(t.id)} is already running`) : `  ${signal("resumed")} ${bold(name)} ${dim("thread " + id8(t.id))}`);
  out(dim(`  vyre agents ask ${name} <text> · vyre threads watch ${id8(t.id)}`));
  return 0;
}

/** One computer, in a line and its facts. */
function showComputer(c, verb) {
  const state = c.state === "running" ? signal(c.state) : c.state === "stopped" || c.state === "none" ? dim(c.state) : c.state;
  out(`  ${verb ? signal(verb) + " " : ""}${bold(c.agent)}'s computer  ${state}${c.paused ? beacon("  paused") : ""}${c.takeover ? beacon(`  keyboard with ${c.takeover.surface || c.takeover}`) : ""}`);
  const facts = [`${c.cpus} cores`, `${c.memory_gb} GB`, c.screen ? `screen ${c.screen}` : "no screen", c.thread ? `thread ${id8(c.thread)}` : "", c.viewers ? `${c.viewers} watching` : ""];
  out(dim(`      ${facts.filter(Boolean).join(" · ")}`));
}

/** `vyre agents computer <name> [restart|limits --cpus n --memory gb]`. */
async function computer(args) {
  const { flags, pos } = parse(args, COMPUTER_FLAGS);
  const [name, verb, ...extra] = pos;
  if (!name) return usage("vyre agents computer needs an agent's name", "vyre agents computer <name> [restart|limits --cpus 2 --memory 4]");
  if (verb && verb !== "restart" && verb !== "limits") return usage(`vyre agents computer ${name} ${verb}: not a subcommand`, "restart, or limits --cpus n --memory gb");
  if (extra.length) return usage(`vyre agents computer: ${extra.join(" ")} is not understood`, "vyre help agents");
  if ((flags.cpus !== undefined || flags.memory !== undefined) && verb !== "limits") return usage("--cpus and --memory go with limits", `vyre agents computer ${name} limits --cpus 2 --memory 4`);
  if (!verb) {
    const c = await tool("computers.get", { agent: name });
    if (!c) return 1;
    if (json()) return emit(c);
    showComputer(c);
    out(dim(`  vyre agents computer ${name} restart · limits --cpus n --memory gb`));
    return 0;
  }
  if (verb === "restart") {
    const r = await callAsPerson("computers.restart", { agent: name }, { timeout: 180_000 });
    if (r.error) return failTool(r.error);
    if (json()) return emit(r.data);
    showComputer(r.data, "restarted");
    return 0;
  }
  if (flags.cpus === undefined && flags.memory === undefined) {
    const c = await tool("computers.get", { agent: name });
    if (!c) return 1;
    if (json()) return emit({ agent: c.agent, cpus: c.cpus, memory_gb: c.memory_gb });
    out(`  ${bold(name)}'s computer: ${c.cpus} cores, ${c.memory_gb} GB ${dim(`· vyre agents computer ${name} limits --cpus n --memory gb changes them`)}`);
    return 0;
  }
  const num = v => (v === undefined ? undefined : Number(v));
  const input = { agent: name, ...(flags.cpus !== undefined ? { cpus: num(flags.cpus) } : {}), ...(flags.memory !== undefined ? { memory_gb: num(flags.memory) } : {}) };
  for (const [k, v] of Object.entries(input)) if (k !== "agent" && !Number.isFinite(v)) return usage(`--${k === "cpus" ? "cpus" : "memory"} is a number`, `vyre agents computer ${name} limits --cpus 2 --memory 4`);
  const r = await callAsPerson("computers.limits", input);
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data);
  showComputer(r.data, "limits set");
  out(dim(`  they apply at the next restart: vyre agents computer ${name} restart`));
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
  summary: "agents: list, create, update, ask, history, threads, resume, computer, usage, stop, delete",
  help: "vyre agents history <name> [--limit n] [--before id] · what was asked of it, and its answers\n"
    + "vyre agents resume <name> [thread] · bring its latest thread (or that one) back, with its own credentials\n"
    + "vyre agents computer <name> · its computer: state, screen, cores and memory\n"
    + "vyre agents computer <name> restart · a new container on the same home; what is open on its screen closes\n"
    + "vyre agents computer <name> limits [--cpus n] [--memory gb] · shown, or set for the next restart",
  /** @param {string[]} args */
  async run(args) {
    const [sub, ...rest] = args.filter(a => a !== "--json");
    if (sub && !SUBS.includes(sub)) return usage(`vyre agents ${sub}: not a subcommand`, USAGE);
    // A mistyped flag is refused before vyred is started for it.
    if (sub === "create" || sub === "update") parse(rest, AGENT_FLAGS);
    if (sub === "history") parse(rest, HISTORY_FLAGS);
    if (sub === "computer") parse(rest, COMPUTER_FLAGS);
    if (!(await up())) return 5;
    if (!sub || sub === "list" || sub === "ls") return list();
    if (sub === "create" || sub === "update") return createOrUpdate(sub, rest);
    if (sub === "ask") return ask(rest);
    if (sub === "history") return history(rest);
    if (sub === "threads") return threads(rest);
    if (sub === "resume") return resume(rest);
    if (sub === "computer") return computer(rest);
    if (sub === "usage") return usageOf(rest);
    if (sub === "stop") return stop(rest);
    return remove(rest);
  },
};
