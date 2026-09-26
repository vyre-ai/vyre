// @ts-check
// Agents from the terminal: list them, make and change them, ask one something, see and stop
// its threads. Each agent runs as headless threads vyred owns, so everything here is a call to
// the agents tools and nothing runs Claude Code in this terminal.

import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { parse, up, tool } from "./projects.js";

const SURFACE = "cli:" + process.pid;
const id8 = s => String(s || "").slice(0, 8);
const fail = msg => { out(beacon("  " + msg)); return 1; };
const cut = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

const USAGE = "vyre agents [create|update|ask|threads|stop] …";
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
  if (!agents.length) { out(dim(`  no agents yet · vyre agents create <name> [${FLAGS}]`)); return 0; }
  for (const a of agents) {
    const status = a.status === "waiting" ? beacon(String(a.status).padEnd(8)) : a.status === "working" ? signal(String(a.status).padEnd(8)) : dim(String(a.status || "").padEnd(8));
    const projects = a.projects === "*" ? "*" : Array.isArray(a.projects) ? a.projects.join(",") : "";
    out(`  ${String(a.name).padEnd(20)} ${dim(String(a.kind || "").padEnd(9))} ${status} ${cut(a.doing || "", 40).padEnd(40)} ${dim([projects, a.thread ? id8(a.thread) : "", a.auth || ""].filter(Boolean).join("  "))}`);
  }
  return 0;
}

async function createOrUpdate(which, args) {
  const { flags, pos } = parse(args, { bool: ["assistant"] });
  const name = pos.join(" ").trim();
  if (!name) return fail(`vyre agents ${which} <name> [${FLAGS}]`);
  const fields = agentFields(flags);
  if (which === "update" && !Object.keys(fields).length) return fail(`nothing to change · ${FLAGS}`);
  const a = await tool(which === "create" ? "agents.create" : "agents.update", { name, ...fields });
  if (!a) return 1;
  showAgent(a, which === "create" ? "made" : "updated");
  return 0;
}

async function ask(args) {
  const [name, ...words] = args;
  if (!name || !words.length) return fail("vyre agents ask <name> <text>");
  // An agent may work for minutes before it answers, so this waits far past the usual 10s.
  const r = await call("agents.ask", { agent: name, text: words.join(" "), surface: SURFACE, wait: true }, { timeout: 600_000 });
  if (r.error) return fail(r.error.message);
  const d = r.data || {};
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
  if (!name) return fail("vyre agents threads <name>");
  const ts = await tool("agents.threads", { agent: name });
  if (!ts) return 1;
  if (!ts.length) { out(dim(`  ${name} has no threads yet`)); return 0; }
  for (const t of ts) out(`  ${dim(id8(t.id))}  ${String(t.status).padEnd(8)} ${dim(String(t.holder || "-").padEnd(14))} ${cut(t.name || t.cwd, 40)}`);
  out(dim("  vyre threads watch <id>"));
  return 0;
}

async function stop(args) {
  const name = args.join(" ").trim();
  if (!name) return fail("vyre agents stop <name>");
  const r = await tool("agents.stop", { agent: name });
  if (!r) return 1;
  const ids = r.stopped || [];
  out(ids.length ? `  stopped ${ids.length} thread${ids.length === 1 ? "" : "s"} of ${r.agent || name} ${dim(ids.map(id8).join(" "))}` : dim(`  ${r.agent || name} had nothing running`));
  return 0;
}

export default {
  name: "agents", order: 30, usage: USAGE,
  summary: "agents: list, create, update, ask, threads, stop",
  /** @param {string[]} args */
  async run(args) {
    const [sub, ...rest] = args;
    if (!(await up())) return 1;
    try {
      if (!sub || sub === "list" || sub === "ls") return await list();
      if (sub === "create" || sub === "update") return await createOrUpdate(sub, rest);
      if (sub === "ask") return await ask(rest);
      if (sub === "threads") return await threads(rest);
      if (sub === "stop") return await stop(rest);
      return fail(`vyre agents ${sub}: not a subcommand · ${USAGE}`);
    } catch (err) { return fail(/** @type {Error} */ (err).message); }
  },
};
