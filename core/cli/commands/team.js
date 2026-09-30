// @ts-check
// Teammates from the terminal (docs/adr/0031-teammates.md): a project's teammates, adding one,
// sending it work, and reading back a request's state and result. Everything here is a call to
// the team.* tools; a project is implied from the current folder unless --project says otherwise.

import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { parse, tool } from "./projects.js";
import { json, emit, fail as kitFail, failTool, usage } from "../kit.js";
import { callAsPerson } from "../presence.js";

const fail = (msg, next) => kitFail(msg, { next });
const id8 = s => String(s || "").slice(0, 8);
const cut = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

const USAGE = "vyre team [add|ask|status|cancel|notes] … [--project slug] [--json]";
const FLAGS = { values: ["project", "brief", "instructions", "isolation", "priority", "part"], bool: ["urgent", "wait", "edit"], cmd: "team" };

/** The project this terminal is in, unless --project overrides it. */
async function projectFlag(flags) {
  if (flags.project) return String(flags.project);
  const here = await call("projects.of", { cwd: process.cwd() });
  if (here.error || !here.data) return null;
  return here.data.slug;
}

function showTeammate(tm) {
  const state = tm.state === "working" ? signal(String(tm.state).padEnd(8)) : tm.state === "waiting" ? beacon(String(tm.state).padEnd(8)) : dim(String(tm.state || "").padEnd(8));
  out(`  ${String(tm.role).padEnd(16)} ${state} ${dim(`queued ${tm.queued}`.padEnd(10))} ${cut(tm.brief || "", 48)}`);
}

async function list(args) {
  const { flags } = parse(args, FLAGS);
  const project = await projectFlag(flags);
  if (!project) return usage("vyre team: say --project, or run this inside a project folder", USAGE);
  const r = await tool("team.list", { project });
  if (!r) return 1;
  const teammates = Array.isArray(r) ? r : [];
  if (json()) return emit(teammates);
  if (!teammates.length) { out(dim(`  no teammates yet · vyre team add <role> --brief "..."`)); return 0; }
  for (const tm of teammates) showTeammate(tm);
  return 0;
}

async function add(args) {
  const { flags, pos } = parse(args, FLAGS);
  const role = pos.join(" ").trim();
  if (!role) return usage("vyre team add needs a role", `vyre team add <role> [--brief text] [--instructions text] [--isolation worktree|folder|none] [--project slug]`);
  const project = await projectFlag(flags);
  if (!project) return usage("vyre team add: say --project, or run this inside a project folder", USAGE);
  const input = { project, role, ...(flags.brief !== undefined ? { brief: flags.brief } : {}), ...(flags.instructions !== undefined ? { instructions: flags.instructions } : {}), ...(flags.isolation ? { isolation: flags.isolation } : {}) };
  // team.add is PERSON_ONLY: Touch ID or a code typed at this terminal.
  const r = await callAsPerson("team.add", input);
  if (r.error) { failTool(r.error); return 1; }
  if (json()) return emit(r.data);
  out(`  ${signal("made")} ${bold(r.data.agent)}  ${dim([r.data.project, r.data.brief].filter(Boolean).join(" · "))}`);
  if (r.data.notice) out(dim(`  ${r.data.notice}`));
  return 0;
}

async function ask(args) {
  const { flags, pos } = parse(args, FLAGS);
  const [role, ...words] = pos;
  const text = words.join(" ").trim();
  if (!role || !text) return usage("vyre team ask <role> <text>", "vyre team lists a project's teammates");
  const project = await projectFlag(flags);
  if (!project) return usage("vyre team ask: say --project, or run this inside a project folder", USAGE);
  const input = { to: role, text, project, ...(flags.urgent ? { priority: "urgent" } : flags.priority ? { priority: flags.priority } : {}), ...(flags.wait ? { wait: true } : {}) };
  const r = await tool("team.ask", input);
  if (!r) return 1;
  if (json()) return emit(r);
  if (r.result !== undefined) out(`  ${signal(r.state)} ${bold(r.request)}\n\n${r.result || dim("(no result)")}`);
  else out(`  ${dim(r.state)} ${bold(r.request)}  ${dim(r.position ? `position ${r.position}` : "")}`);
  return 0;
}

async function status(args) {
  const [request] = args;
  if (!request) return usage("vyre team status <request>", "the id team ask gave back");
  const r = await tool("team.status", { request });
  if (!r) return 1;
  if (json()) return emit(r);
  out(`  ${signal(r.state)} ${bold(r.id)}  ${dim(`${r.teammate} · from ${r.from}`)}`);
  if (r.result) out(`\n${r.result}`);
  return 0;
}

async function cancel(args) {
  const [request] = args;
  if (!request) return usage("vyre team cancel <request>", "");
  const r = await tool("team.cancel", { request });
  if (!r) return 1;
  if (json()) return emit(r);
  out(`  ${signal("cancelled")} ${bold(r.id)}`);
  return 0;
}

async function notes(args) {
  const { flags, pos } = parse(args, FLAGS);
  const [agent] = pos;
  if (!agent) return usage("vyre team notes <role-project agent>", "vyre team lists agents");
  const part = flags.part || "general";
  const r = await tool("team.notes", { action: "get", agent, part });
  if (!r) return 1;
  if (json()) return emit(r);
  out(r.text || dim("(no notes yet)"));
  return 0;
}

/** @type {import("../index.js").Command} */
const cmd = {
  name: "team",
  summary: "Project teammates: add one, send it work, read what came back",
  usage: USAGE,
  help: "vyre team                     this project's teammates, states and queues\nvyre team add <role>          add a teammate\nvyre team ask <role> <text>   send it work; --urgent, --wait\nvyre team status <request>    one request's state and result\nvyre team cancel <request>    cancel a queued request\nvyre team notes <agent>       read its notes",
  async run(args) {
    const [sub, ...rest] = args;
    if (!sub || sub === "list" || sub === "ls") return list(sub ? rest : args);
    if (sub === "add") return add(rest);
    if (sub === "ask") return ask(rest);
    if (sub === "status") return status(rest);
    if (sub === "cancel") return cancel(rest);
    if (sub === "notes") return notes(rest);
    return usage(`vyre team: unknown command "${sub}"`, USAGE);
  },
};

export default cmd;
