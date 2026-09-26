// @ts-check
// Projects and threads from the terminal. `vyre` alone lands here: inside a project's folder it
// opens that project, anywhere else it lists them.
//
// Every command is a call to vyred's projects tools, so the terminal and the Deck never disagree.
// Every interactive step also has a flag, and prompts read piped stdin line by line when there
// is no terminal, so tests and scripts can drive the same flows a person does.
//
// Handing a thread to Claude Code is a real handoff: `vyre resume` runs `claude --resume` in the
// folder the thread ran in (Claude Code finds a transcript by that folder, so resuming anywhere
// else finds nothing), with the project's brief appended to its system prompt, and this
// terminal's keyboard and screen go straight to it until it exits.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { call } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";
import { out, dim, bold, signal, recall, beacon } from "../style.js";
import { untilde } from "../../config/index.js";

// ------------------------------------------------------------ small helpers

const tilde = p => { const h = os.homedir(); const s = String(p || ""); return s === h || s.startsWith(h + "/") ? "~" + s.slice(h.length) : s; };
const ago = t => {
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 3600 ? Math.max(1, Math.round(s / 60)) + "m" : s < 86400 ? Math.round(s / 3600) + "h" : Math.round(s / 86400) + "d";
};
const cut = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
/** A path keeps its end, where the folder's own name is. */
const tail = (s, n) => { const t = String(s || ""); return t.length > n ? "…" + t.slice(t.length - n + 1) : t; };
const fail = msg => { out(beacon("  " + msg)); return 1; };

/**
 * Flags: `--home x`, `--thread a --thread b`, `--no-pick`. Everything else is positional.
 * @param {string[]} args
 * @param {{ multi?: string[], bool?: string[] }} [spec]
 */
export function parse(args, { multi = [], bool = [] } = {}) {
  /** @type {Record<string, any>} */
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (bool.includes(k)) { flags[k] = true; continue; }
    const v = inline !== undefined ? inline : args[++i];
    if (v === undefined) throw new Error(`--${k} needs a value`);
    if (multi.includes(k)) (flags[k] ||= []).push(v); else flags[k] = v;
  }
  return { flags, pos };
}

/** "Dana Reyes <dana@harlowlegal.com>", or a bare name or address. */
export function person(s) {
  const m = String(s).trim().match(/^(.*?)\s*<([^>]+)>$/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim() };
  const t = String(s).trim();
  return t.includes("@") ? { name: t, email: t } : { name: t };
}

/**
 * Ask questions of a person, or of piped stdin. Piped input is read once and served a line per
 * question: readline drops lines that arrive before a question is asked, which lost answers.
 * An exhausted pipe answers "", which every prompt treats as "done" or "skip".
 */
async function prompter() {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return { ask: async q => (await rl.question(q)).trim(), close: () => rl.close() };
  }
  let raw = "";
  for await (const c of process.stdin) raw += c;
  const lines = raw.split(/\r?\n/);
  let i = 0;
  return { ask: async q => { const a = (lines[i++] ?? "").trim(); out(q + a); return a; }, close: () => {} };
}

async function up() {
  const r = await ensureUp();
  if (!r.ok) { out(beacon("  vyred did not start") + dim(r.log ? ` · see ${r.log}` : "")); return false; }
  return true;
}

/** A tool call that prints its error and returns null on failure. */
async function tool(name, input) {
  const r = await call(name, input);
  if (r.error) { out(beacon(`  ${r.error.message}`)); return null; }
  return r.data;
}

// ------------------------------------------------------------ screens

function threadRow(t, i, { mark = "", extra = "" } = {}) {
  const n = i === undefined ? "" : String(i + 1).padStart(3) + "  ";
  const title = t.name ? cut(t.name, 44) : cut(t.title || "(untitled)", 44);
  const said = t.said ? `${t.said}×` : "";
  out(`  ${n}${mark}${title.padEnd(44)} ${dim(said.padStart(4) + " " + ago(t.last).padStart(4) + "  " + tail(tilde(t.cwd), 30))}${extra}`);
  // The /rename name is the identifier; the first message is the description, shown under it.
  if (t.name && t.title) out(`  ${" ".repeat(n.length + mark.length)}${dim(cut(t.title, 76))}`);
}

function showProject(p, threads, brief) {
  out("");
  out(`  ${bold(p.name)}  ${dim([p.org, tilde(p.home)].filter(Boolean).join(" · "))}`);
  out("");
  if (brief) {
    out(recall("  What a new thread here is told"));
    for (const l of brief.split("\n")) out(dim("  │ ") + l);
    out("");
  }
  out(`  Threads (${threads.length})`);
  threads.slice(0, 20).forEach((t, i) => threadRow(t, i, { extra: dim("  " + t.how.join("+")) }));
  if (threads.length > 20) out(dim(`       and ${threads.length - 20} more · vyre threads --project ${p.slug}`));
  out("");
  out(dim(`  vyre resume <number>   vyre start [name]   vyre pick ${p.slug} <thread>`));
}

function showList(list) {
  out("");
  out(`  ${signal("▌▌")} ${bold("vyre")}  ${dim(`${list.projects.length} project${list.projects.length === 1 ? "" : "s"}`)}`);
  out("");
  for (const p of list.projects) {
    out(`   ${p.name.padEnd(28)} ${dim(String(p.threads).padStart(3) + " threads " + ago(p.last).padStart(4) + "  " + tilde(p.home))}`);
  }
  for (const x of list.problems || []) out(beacon(`   ${tilde(x.home)}: ${x.error}`));
  if (!list.projects.length) out(dim("   none yet · vyre new makes one from the sessions on this machine"));
  out("");
  out(dim("  vyre open <project>   vyre new   vyre threads [search]"));
}

// ------------------------------------------------------------ finding threads and projects

async function hereProject() {
  const r = await call("projects.of", { cwd: process.cwd() });
  return r.data || null;
}

/**
 * A thread from what a person typed: a number from the project's list, an id or the start of
 * one, or a /rename name (exact first, then a unique partial match).
 */
async function findThread(ref, projectSlug) {
  const q = String(ref || "").trim();
  if (!q) return { error: "which thread? give a number, a name or an id" };
  if (/^\d{1,3}$/.test(q)) {
    if (!projectSlug) return { error: "a thread number means a thread of this folder's project, and this folder is in none" };
    const ts = await call("projects.threads", { project: projectSlug });
    const t = ts.data && ts.data[Number(q) - 1];
    return t ? { thread: t } : { error: `no thread ${q} in ${projectSlug}` };
  }
  const c = await call("projects.catalog", { limit: 100000 });
  if (c.error) return { error: c.error.message };
  const rows = c.data.sessions;
  const low = q.toLowerCase();
  const pickOne = list => list.length === 1 ? { thread: list[0] } : list.length > 1
    ? { error: `${list.length} threads match "${q}": ${list.slice(0, 4).map(r => r.label).join("; ")}` } : null;
  return (rows.find(r => r.id === q) && { thread: rows.find(r => r.id === q) })
    || (q.length >= 4 && pickOne(rows.filter(r => r.id.startsWith(low))))
    || pickOne(rows.filter(r => (r.name || "").toLowerCase() === low))
    || pickOne(rows.filter(r => (r.name || "").toLowerCase().includes(low)))
    || { error: `no thread matches "${q}"` };
}

async function openProject(ref) {
  const [ctx, threads] = await Promise.all([call("projects.context", { project: ref }), call("projects.threads", { project: ref })]);
  if (threads.error) return fail(threads.error.message);
  const list = await call("projects.list", {});
  const p = list.data.projects.find(x => x.slug === ctx.data.project);
  showProject(p, threads.data, ctx.data.text);
  return 0;
}

// ------------------------------------------------------------ handing off to Claude Code

/** Run Claude Code here, interactively, and return its exit code. */
function claude(args, cwd) {
  const r = spawnSync("claude", args, { cwd, stdio: "inherit" });
  if (r.error) return fail(/** @type {any} */ (r.error).code === "ENOENT" ? "Claude Code is not installed: no claude on PATH" : r.error.message);
  return r.status ?? 1;
}

async function resume(t, { project, name } = {}) {
  if (!t.cwd || !fs.existsSync(t.cwd)) return fail(`${t.label} ran in ${tilde(t.cwd) || "an unknown folder"}, which is gone; Claude Code can only resume it there`);
  const ctx = await call("projects.context", { ...(project ? { project } : {}), cwd: t.cwd, session: t.id });
  const brief = ctx.data?.text || "";
  const args = ["--resume", t.id];
  if (brief) args.push("--append-system-prompt", brief);
  if (name) args.push("-n", name);
  out(dim(`  resuming ${t.label} · ${tilde(t.cwd)}${ctx.data?.project ? " · " + ctx.data.project : ""}`));
  return claude(args, t.cwd);
}

// ------------------------------------------------------------ new: make a project by picking

/** Search the catalogue and pick by number until an empty search. */
async function pickLoop(ask, chosen) {
  for (;;) {
    const q = await ask("\n  search your sessions (Enter to finish) › ");
    if (!q) return;
    const c = await call("projects.catalog", { q, limit: 15 });
    if (c.error) { out(beacon("  " + c.error.message)); continue; }
    if (c.data.note) out(dim("  " + c.data.note));
    const hits = c.data.sessions;
    if (!hits.length) { out(dim("    nothing matches")); continue; }
    hits.forEach((r, i) => threadRow(r, i, { mark: chosen.has(r.id) ? signal("✓ ") : "  ", extra: r.projects.length ? dim("  [" + r.projects.join(", ") + "]") : "" }));
    const nums = await ask("  add which (e.g. 1 3) › ");
    for (const n of nums.split(/[\s,]+/).map(Number).filter(n => n >= 1 && n <= hits.length)) chosen.set(hits[n - 1].id, hits[n - 1].label);
    out(dim(`    ${chosen.size} picked`));
  }
}

async function newProject(args) {
  const { flags, pos } = parse(args, { multi: ["thread", "workspace", "person"], bool: ["no-pick"] });
  if (!(await up())) return 1;
  const needsPrompt = !(flags.name || pos.length) || (!flags.thread && !flags["no-pick"]);
  const pr = needsPrompt ? await prompter() : null;
  try {
    out("\n  New project");
    let name = flags.name || pos.join(" ");
    if (!name) name = await /** @type {any} */ (pr).ask("  name › ");
    if (!name) { out("  cancelled"); return 1; }
    let home = flags.home;
    if (!home && pr) home = await pr.ask("  its home folder (Enter for a new folder in the projects folder) › ");
    const chosen = new Map();
    for (const ref of flags.thread || []) {
      const f = await findThread(ref);
      if (f.error) return fail(f.error);
      chosen.set(f.thread.id, f.thread.label);
    }
    if (pr && !flags.thread && !flags["no-pick"]) await pickLoop(pr.ask, chosen);
    let people = (flags.person || []).map(person);
    if (pr && !flags.person) {
      const ps = await pr.ask("\n  people (Name <email>, comma separated; Enter to skip) › ");
      people = ps.split(",").map(s => s.trim()).filter(Boolean).map(person);
    }
    const abs = d => path.resolve(untilde(d));
    const p = await tool("projects.create", {
      name, ...(home ? { home: abs(home) } : {}), ...(flags.org ? { org: flags.org } : {}),
      workspaces: (flags.workspace || []).map(abs), threads: [...chosen.keys()], people,
    });
    if (!p) return 1;
    const threads = await call("projects.threads", { project: p.slug });
    const n = threads.data ? threads.data.length : 0;
    out(`\n  ${signal("made")} ${bold(p.name)} ${dim("at " + tilde(p.home))}`);
    out(dim(`  ${chosen.size} picked · ${n} threads in all, counting those that ran in its folders`));
    out(dim(`  vyre open ${p.slug}`));
    return 0;
  } finally { pr?.close(); }
}

// ------------------------------------------------------------ the commands

export default [
  {
    name: "home", hidden: true, summary: "this folder's project, or all of them",
    async run() {
      if (!(await up())) return 1;
      const here = await hereProject();
      if (!here) {
        const list = await tool("projects.list", {});
        if (!list) return 1;
        showList(list);
        return 0;
      }
      const code = await openProject(here.project);
      // A person at a terminal can go straight on; a pipe or a test just gets the screen.
      if (code || !process.stdin.isTTY || !process.stdout.isTTY) return code;
      const pr = await prompter();
      const a = await pr.ask("\n  resume which (number; n for a new thread; Enter to leave) › ");
      pr.close();
      if (!a) return 0;
      if (a === "n") return startThread(["--project", here.project]);
      const f = await findThread(a, here.project);
      return f.error ? fail(f.error) : resume(f.thread, { project: here.project });
    },
  },
  {
    name: "projects", order: 20, summary: "every project",
    async run() {
      if (!(await up())) return 1;
      const list = await tool("projects.list", {});
      if (!list) return 1;
      showList(list);
      return 0;
    },
  },
  {
    name: "new", order: 21, usage: "vyre new [name]", summary: "make a project by picking sessions (flags: --home --thread --workspace --person --org --no-pick)",
    run: newProject,
  },
  {
    name: "open", order: 22, usage: "vyre open <project>", summary: "a project: what its threads are told, and its threads",
    async run(args) {
      if (!args.length) return fail("vyre open <project>");
      if (!(await up())) return 1;
      return openProject(args.join(" "));
    },
  },
  {
    name: "threads", order: 23, usage: "vyre threads [search]", summary: "every session on this machine, searched by what was said (--project, --all)",
    async run(args) {
      const { flags, pos } = parse(args, { bool: ["all"] });
      if (!(await up())) return 1;
      if (flags.project) {
        const ts = await tool("projects.threads", { project: flags.project });
        if (!ts) return 1;
        ts.forEach((t, i) => threadRow(t, i, { extra: dim("  " + t.how.join("+")) }));
        return 0;
      }
      const c = await tool("projects.catalog", { q: pos.join(" "), limit: flags.all ? 100000 : 30 });
      if (!c) return 1;
      if (c.note) out(dim("  " + c.note));
      for (const r of c.sessions) {
        out(`  ${dim(r.id.slice(0, 8))}  ${cut(r.label, 44).padEnd(44)} ${dim(((r.said ? r.said + "×" : "").padStart(4)) + " " + ago(r.last).padStart(4) + "  " + tail(tilde(r.cwd), 28))}${r.projects.length ? dim("  [" + r.projects.join(", ") + "]") : ""}`);
      }
      if (c.total > c.sessions.length) out(dim(`  ${c.total - c.sessions.length} more · --all`));
      return 0;
    },
  },
  {
    name: "resume", order: 24, usage: "vyre resume <thread>", summary: "open a thread in Claude Code where it ran, with its project's brief (--project, --name)",
    async run(args) {
      const { flags, pos } = parse(args);
      if (!(await up())) return 1;
      const here = await hereProject();
      const f = await findThread(pos.join(" "), flags.project || here?.project);
      if (f.error) return fail(f.error);
      const t = f.thread;
      // The folder's project wins when the thread is in it; otherwise the thread's own.
      const inHere = here && (t.projects ? t.projects.includes(here.project) : true);
      return resume(t, { project: flags.project || (inHere ? here.project : undefined), name: flags.name });
    },
  },
  {
    name: "start", order: 25, usage: "vyre start [name]", summary: "a new thread in this folder's project, with its brief (--project)",
    run: args => startThread(args),
  },
  {
    name: "context", order: 26, usage: "vyre context [project]", summary: "what a new thread in a project is told",
    async run(args) {
      if (!(await up())) return 1;
      const input = args.length ? { project: args.join(" ") } : { cwd: process.cwd() };
      const r = await tool("projects.context", input);
      if (!r) return 1;
      if (!r.project) return fail("this folder is in no project · vyre context <project>");
      out(r.text);
      return 0;
    },
  },
  {
    name: "pick", order: 27, usage: "vyre pick <project> <thread>...", summary: "put threads into a project by hand",
    run: args => pickCmd(args, "projects.add-threads"),
  },
  {
    name: "unpick", order: 28, usage: "vyre unpick <project> <thread>...", summary: "take picked threads out of a project",
    run: args => pickCmd(args, "projects.remove-threads"),
  },
];

async function pickCmd(args, name) {
  const [project, ...refs] = args;
  if (!project || !refs.length) return fail(`vyre ${name.endsWith("add-threads") ? "pick" : "unpick"} <project> <thread>...`);
  if (!(await up())) return 1;
  const ids = [];
  for (const ref of refs) {
    const f = await findThread(ref, project);
    if (f.error) return fail(f.error);
    ids.push(f.thread.id);
  }
  const r = await tool(name, { project, threads: ids });
  if (!r) return 1;
  if (r.added) out(`  ${r.added.length} picked into ${r.project}${r.added.length < ids.length ? dim(" · the rest were already there") : ""}`);
  if (r.removed) out(`  ${r.removed.length} unpicked from ${r.project}`);
  if (r.stillByFolder?.length) out(dim(`  ${r.stillByFolder.length} still in it: they ran in its folders`));
  return 0;
}

/** A new thread: Claude Code in the project's home, named when a name is given, with the brief. */
async function startThread(args) {
  const { flags, pos } = parse(args);
  if (!(await up())) return 1;
  const ref = flags.project || (await hereProject())?.project;
  if (!ref) return fail("this folder is in no project · vyre start --project <project> [name]");
  const ctx = await tool("projects.context", { project: ref });
  if (!ctx) return 1;
  const list = await call("projects.list", {});
  const p = list.data.projects.find(x => x.slug === ctx.project);
  const name = flags.name || pos.join(" ");
  const cliArgs = [...(name ? ["-n", name] : []), "--append-system-prompt", ctx.text];
  out(dim(`  starting a thread in ${p.name} · ${tilde(p.home)}`));
  return claude(cliArgs, p.home);
}
