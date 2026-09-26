// @ts-check
// The `vyre` home (docs/SPEC.md, section 10): what `vyre` with no arguments opens, from any
// folder. Every project, New session without a project, and every agent. Picking a project shows
// its sessions, newest first, with New session in it; picking a session resumes it in Claude Code.
// Inside a project's folder that project is preselected, not opened: a person who typed `vyre`
// there may still want a different project, and opening it straight away hid the rest.
//
// In a terminal it is the live screen (core/cli/screen): the Inbox, projects, sessions and
// agents on the left, the selected session streaming on the right, drawn with plain ANSI on
// raw-mode stdin, so it behaves the same over SSH. Piped, it prints the list below as plain text
// and exits; --json prints the same data as JSON.
//
// The plain list (homeItems, projectItems, render, choose) predates the screen and is kept for
// the pipe and for anything that wants a one-shot picker.

import os from "node:os";
import readline from "node:readline/promises";
import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { up, claude, resume, startThread } from "./projects.js";
import { runScreen } from "../screen/index.js";
import { load } from "../screen/live.js";

// ------------------------------------------------------------ what is on the list

const tilde = p => { const h = os.homedir(); const s = String(p || ""); return s === h || s.startsWith(h + "/") ? "~" + s.slice(h.length) : s; };
const ago = t => {
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 3600 ? Math.max(1, Math.round(s / 60)) + "m" : s < 86400 ? Math.round(s / 3600) + "h" : Math.round(s / 86400) + "d";
};

/**
 * @typedef {{ kind: "header"|"note"|"project"|"new"|"agent"|"thread"|"new-in", label: string, detail?: string, value?: any }} Item
 * Headers and notes are shown but never selected.
 */
const selectable = it => !["header", "note"].includes(it.kind);

/**
 * The home's items, and which one starts selected.
 * @param {{ projects: any[], agents: any[]|null, here?: string|null, selected?: string|null }} x
 *   agents null: no agents tool yet. here: this folder's project. selected: the project to start
 *   on, when it is not the folder's (coming back from one).
 */
export function homeItems({ projects, agents, here = null, selected = here }) {
  /** @type {Item[]} */
  const items = [{ kind: "header", label: "Projects" }];
  if (!projects.length) items.push({ kind: "note", label: "none yet · vyre new makes one from your sessions" });
  for (const p of projects) {
    items.push({ kind: "project", label: p.name, value: p.slug,
      detail: `${p.threads} thread${p.threads === 1 ? "" : "s"}${p.last ? " · " + ago(p.last) : ""}${p.slug === here ? " · this folder" : ""}` });
  }
  items.push({ kind: "new", label: "New session without a project", detail: "claude in this folder" });
  items.push({ kind: "header", label: "Agents" });
  if (agents === null) items.push({ kind: "note", label: "agents arrive with the switchboard" });
  else if (!agents.length) items.push({ kind: "note", label: "none yet" });
  else for (const a of agents) items.push({ kind: "agent", label: a.name, value: a.name, detail: a.doing || a.status || a.kind || "" });
  const pre = selected ? items.findIndex(i => i.kind === "project" && i.value === selected) : -1;
  return { items, selected: pre >= 0 ? pre : items.findIndex(selectable) };
}

/** A project's items: New session in it, then its sessions, newest first. */
export function projectItems(project, threads) {
  /** @type {Item[]} */
  const items = [{ kind: "new-in", label: `New session in ${project.name}`, value: project.slug, detail: tilde(project.home) }];
  items.push({ kind: "header", label: `Sessions (${threads.length})` });
  if (!threads.length) items.push({ kind: "note", label: "none yet" });
  for (const t of threads) {
    items.push({ kind: "thread", label: t.label, value: t, detail: [ago(t.last), t.how && t.how.join("+")].filter(Boolean).join(" · ") });
  }
  return { items, selected: 0 };
}

// ------------------------------------------------------------ moving through it

/** What the filter leaves: every item when it is empty, else the selectable items matching every word. */
export function visible(items, filter) {
  const words = String(filter || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter(it => selectable(it) && words.every(w => `${it.label} ${it.detail || ""}`.toLowerCase().includes(w)));
}

/** Name a chunk of raw-mode input. Arrow keys come in both the normal and application forms. */
export function keyName(s) {
  if (s === "\x1b[A" || s === "\x1bOA" || s === "\x10") return "up";
  if (s === "\x1b[B" || s === "\x1bOB" || s === "\x0e") return "down";
  if (s === "\r" || s === "\n") return "enter";
  if (s === "\x1b") return "esc";
  if (s === "\x7f" || s === "\b") return "backspace";
  if (s === "\x03") return "quit";
  if (s.length === 1 && s >= " ") return "char:" + s;
  return null;
}

/**
 * One key. Returns the next state and, when the key ends the screen, what it chose:
 * { pick: item }, { back: true } or { quit: true }. q quits only when nothing is typed; while
 * filtering it is a letter like any other, or no project with a q in its name could be found.
 * @param {{ items: Item[], filter: string, cursor: number }} st cursor indexes visible(items, filter)
 * @param {string|null} key
 */
export function step(st, key) {
  const vis = visible(st.items, st.filter);
  const move = dir => {
    for (let i = st.cursor + dir; i >= 0 && i < vis.length; i += dir) if (selectable(vis[i])) return { ...st, cursor: i };
    return st;
  };
  const refilter = filter => {
    const v = visible(st.items, filter);
    // Keep the selected item when it survives the new filter, else the first that does.
    const keep = v.indexOf(vis[st.cursor]);
    return { ...st, filter, cursor: keep >= 0 ? keep : Math.max(0, v.findIndex(selectable)) };
  };
  if (!key) return { st };
  if (key === "up") return { st: move(-1) };
  if (key === "down") return { st: move(1) };
  if (key === "enter") return vis[st.cursor] && selectable(vis[st.cursor]) ? { st, pick: vis[st.cursor] } : { st };
  if (key === "esc") return st.filter ? { st: refilter("") } : { st, back: true };
  if (key === "backspace") return { st: refilter(st.filter.slice(0, -1)) };
  if (key === "quit" || (key === "char:q" && !st.filter)) return { st, quit: true };
  if (key.startsWith("char:")) return { st: refilter(st.filter + key.slice(5)) };
  return { st };
}

/** The state a screen starts in, with the given item selected. */
export function initial(items, selected) {
  return { items, filter: "", cursor: Math.max(0, selected) };
}

// ------------------------------------------------------------ drawing it

const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s);

/**
 * The screen as lines, fitted to the terminal. Lines never wrap (a wrapped line would throw off
 * the redraw, which moves the cursor up by the number of lines drawn), and a long list scrolls to
 * keep the selection in view.
 */
export function render(st, { title, status = "", columns = 80, rows = 24 }) {
  const vis = visible(st.items, st.filter);
  const width = Math.max(20, columns - 1);
  const room = Math.max(3, rows - 5);
  const start = Math.min(Math.max(0, st.cursor - room + 1), Math.max(0, vis.length - room));
  const lines = [clip(`  ${title}${st.filter ? "  " + signal("/" + st.filter) : dim("  type to filter")}`, width + 20)];
  if (!vis.length) lines.push(dim("    nothing matches"));
  vis.slice(start, start + room).forEach((it, k) => {
    const i = start + k;
    if (it.kind === "header") { lines.push(bold(clip("  " + it.label, width))); return; }
    if (it.kind === "note") { lines.push(dim(clip("    " + it.label, width))); return; }
    const on = i === st.cursor;
    const room = width - 4;
    const label = clip(it.label, Math.min(48, room));
    const rest = room - label.length - 2;
    const detail = it.detail && rest > 3 ? "  " + clip(it.detail, rest) : "";
    lines.push(`  ${on ? signal("›") : " "} ${on ? bold(label) : label}${dim(detail)}`);
  });
  if (vis.length > start + room) lines.push(dim(`    ${vis.length - start - room} more`));
  lines.push(status ? beacon(clip("  " + status, width)) : dim(clip("  ↑↓ move · type to filter · enter pick · esc back · q quit", width)));
  return lines;
}

/** The home as plain text, for a pipe: the same items, the preselected one marked. */
export function plain({ items, selected }) {
  return items.map((it, i) => it.kind === "header" ? `  ${it.label}` : it.kind === "note" ? `      ${it.label}`
    : `  ${i === selected ? "›" : " "} ${it.label}${it.detail ? "  " + it.detail : ""}`).join("\n");
}

// ------------------------------------------------------------ the terminal

/**
 * Show a list and wait for a choice. Raw mode is always undone on the way out, even on an error,
 * because a terminal left in raw mode looks broken to the person using it.
 * @param {{ items: Item[], selected: number, title: string, status?: string }} screen
 * @param {{ input: any, output: any }} io
 * @returns {Promise<{ pick?: Item, back?: boolean, quit?: boolean }>}
 */
export function choose(screen, { input, output }) {
  return new Promise(resolve => {
    let st = initial(screen.items, screen.selected);
    let drawn = 0;
    let status = screen.status || "";
    const draw = () => {
      const lines = render(st, { title: screen.title, status, columns: output.columns || 80, rows: output.rows || 24 });
      output.write((drawn > 1 ? `\x1b[${drawn - 1}A` : "") + "\r\x1b[J" + lines.join("\r\n"));
      drawn = lines.length;
    };
    const done = result => {
      input.removeListener("data", onData);
      output.removeListener?.("resize", draw);
      // Leave the screen clean for whatever comes next: Claude Code, or the shell.
      output.write((drawn > 1 ? `\x1b[${drawn - 1}A` : "") + "\r\x1b[J\x1b[?25h");
      input.setRawMode?.(false);
      input.pause();
      resolve(result);
    };
    const onData = chunk => {
      const s = String(chunk);
      // Several keys can arrive in one chunk (a paste, or a slow link over SSH): split them,
      // keeping escape sequences whole.
      for (const k of s.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Z]|\x1b|[\s\S]/g) || []) {
        const r = step(st, keyName(k));
        st = r.st;
        status = "";
        if (r.pick || r.back || r.quit) return done(r);
      }
      draw();
    };
    input.setRawMode?.(true);
    input.setEncoding?.("utf8");
    input.resume();
    input.on("data", onData);
    output.on?.("resize", draw);
    output.write("\x1b[?25l");
    draw();
  });
}

// ------------------------------------------------------------ the flow

/** agents.list, or null when the switchboard has not brought agents yet. */
async function agentsNow() {
  const r = await call("agents.list", {});
  if (r.error) return null;
  return Array.isArray(r.data) ? r.data : Array.isArray(r.data?.agents) ? r.data.agents : [];
}

async function homeData() {
  const [list, agents, here] = await Promise.all([call("projects.list", {}), agentsNow(), call("projects.of", { cwd: process.cwd() })]);
  if (list.error) throw new Error(list.error.message);
  return { projects: list.data.projects, agents, here: here.data?.slug || null };
}

/**
 * A new session outside every project: Claude Code with the Harness, in this folder. No brief:
 * the Harness decides what a session outside a project is told.
 */
export function newSession() {
  out(dim(`  starting a session in ${tilde(process.cwd())}`));
  return claude([], process.cwd());
}

/** Talk to an agent a line at a time, until an empty line. */
async function talk(agent, io) {
  const rl = readline.createInterface({ input: io.input, output: io.output });
  try {
    io.input.resume();
    out(dim(`  talking to ${agent.label} · an empty line goes back`));
    for (;;) {
      const text = (await rl.question("  you › ")).trim();
      if (!text) return;
      const r = await call("agents.ask", { agent: agent.value, text }, { timeout: 600_000 });
      if (r.error) { out(beacon("  " + (r.error.code === "no_such_tool" ? "talking to agents arrives with the switchboard" : r.error.message))); return; }
      const reply = typeof r.data === "string" ? r.data : r.data?.text || r.data?.reply || JSON.stringify(r.data);
      out(`  ${agent.label} › ${reply}`);
    }
  } finally { rl.close(); }
}

/**
 * The interactive home: the live screen (core/cli/screen). Returns an exit code. io is the
 * terminal; tests pass streams.
 * @param {{ input: any, output: any }} io
 * @param {{ real?: boolean, onFrame?: (lines: string[]) => void }} [o]
 */
export function interactive(io, o = {}) {
  return runScreen(io, { ...o, newSession, startThread, resume, talk: (agent, tio) => talk({ label: agent, value: agent }, tio) });
}

export default {
  name: "home", hidden: true, summary: "your projects, a new session, and your agents",
  /** @param {string[]} args */
  async run(args = []) {
    if (!(await up())) return 1;
    if (args.includes("--json")) {
      const d = await load();
      process.stdout.write(JSON.stringify({ projects: d.projects, agents: d.agents, here: d.here, threads: d.threads, asks: d.asks, drafts: d.drafts }) + "\n");
      return 0;
    }
    // Both ends must be a terminal: raw mode needs the input, and the drawing needs the output.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      const d = await homeData();
      out("\n  vyre\n");
      out(plain(homeItems(d)));
      out("");
      return 0;
    }
    return interactive({ input: process.stdin, output: process.stdout }, { real: true });
  },
};
