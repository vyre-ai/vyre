// @ts-check
// The screen's state and what each key does to it. Pure: no terminal, no vyred. A key returns
// the next state and, when it needs the outside world, an effect for the driver to run (resume
// a session, answer an ask, send a line). The driver runs one effect at a time and reads no
// further keys until it is done, so a key typed during a slow call lands on the state it saw.
//
// The list is a tree: Inbox (asks and held drafts), Projects (each opens to New session in it,
// its headless threads and its sessions), New session without a project, headless threads in no
// project, and Agents. Typing filters every selectable item at once, ranked by fuzzy score.

import os from "node:os";
import { rank } from "./fuzzy.js";

/**
 * @typedef {{ key: string, kind: string, label: string, detail?: string, depth?: number, value?: any,
 *   open?: boolean, count?: number, positions?: number[] }} Item
 * kinds: header, note (never selected); ask, draft, project, new-in, thread, session, new, agent
 * @typedef {{ projects: any[], agents: any[]|null, here: string|null, threads: any[], asks: any[], drafts: any[]|null,
 *   sessions: Record<string, any[]>, health?: any, link?: string }} Data
 * @typedef {{ data: Data, open: string[], filter: string, cursor: string|null, focus: "list"|"compose", compose: string,
 *   help: boolean, action: string|null, status: string, scroll: number }} State
 */

const SELECTABLE = new Set(["ask", "draft", "project", "new-in", "thread", "session", "new", "agent"]);
export const selectable = (/** @type {Item} */ it) => SELECTABLE.has(it.kind);

const tilde = p => { const h = os.homedir(); const s = String(p || ""); return s === h || s.startsWith(h + "/") ? "~" + s.slice(h.length) : s; };
export const ago = t => {
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? "now" : s < 3600 ? Math.round(s / 60) + "m" : s < 86400 ? Math.round(s / 3600) + "h" : Math.round(s / 86400) + "d";
};
/** "just now" or "5m ago": for sentences, where "1m" for a second-old item reads wrong. */
export const since = t => (!t ? "" : Date.now() - t < 60_000 ? "just now" : ago(t) + " ago");
/** This terminal, as it names itself to vyred on everything that touches a keyboard. */
export const SURFACE = "cli:" + process.pid;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** A cli:<pid> surface whose process has exited holds nothing: a terminal closed without releasing. */
export function liveHolder(holder, alive = pidAlive) {
  const m = /^cli:(\d+)$/.exec(String(holder || ""));
  if (m && !alive(Number(m[1]))) return null;
  return holder || null;
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === "EPERM"; } }

export const threadLabel = t => t.name || (t.cwd ? tilde(t.cwd).split("/").slice(-2).join("/") : String(t.id).slice(0, 8));

function threadItem(t, depth) {
  const bits = [t.status, t.asks ? plural(t.asks, "ask") : "", ago(t.last)].filter(Boolean);
  return { key: "thread:" + t.id, kind: "thread", label: threadLabel(t), detail: bits.join(" · "), depth, value: t };
}

/**
 * Every item, in tree order, with projects in `open` expanded.
 * @param {Data} d @param {string[]} open
 * @returns {Item[]}
 */
export function items(d, open) {
  /** @type {Item[]} */
  const out = [];
  const threadName = id => { const t = d.threads.find(x => x.id === id); return t ? threadLabel(t) : String(id || "").slice(0, 8); };
  const inbox = d.asks.length + (d.drafts ? d.drafts.length : 0);
  out.push({ key: "h:inbox", kind: "header", label: "Inbox", count: inbox });
  if (!inbox) out.push({ key: "n:inbox", kind: "note", label: "nothing is waiting on you" });
  for (const a of d.asks) {
    // Claude Code's summaries often start with the tool's name already.
    const said = String(a.summary || "");
    out.push({ key: "ask:" + a.id, kind: "ask", label: said.startsWith(a.tool) ? said : `${a.tool}: ${said}`, detail: `ask · ${threadName(a.thread)}`, value: a });
  }
  for (const g of d.drafts || []) {
    const to = Array.isArray(g.to) ? g.to.join(", ") : String(g.to || "");
    out.push({ key: "draft:" + g.id, kind: "draft", label: `${g.kind} to ${to}`, detail: [g.via, g.agent, g.summary].filter(Boolean).join(" · "), value: g });
  }

  out.push({ key: "h:projects", kind: "header", label: "Projects", count: d.projects.length });
  if (!d.projects.length) out.push({ key: "n:projects", kind: "note", label: "none yet · vyre new makes one from your sessions" });
  const headless = new Set(d.threads.map(t => t.id));
  for (const p of d.projects) {
    const isOpen = open.includes(p.slug);
    const live = d.threads.filter(t => t.project === p.slug);
    const working = live.filter(t => t.status === "working").length;
    out.push({ key: "project:" + p.slug, kind: "project", label: p.name, value: p.slug, open: isOpen,
      detail: [plural(p.threads, "session"), working ? working + " working" : "", p.last ? ago(p.last) : "", p.slug === d.here ? "this folder" : ""].filter(Boolean).join(" · ") });
    if (!isOpen) continue;
    out.push({ key: "new-in:" + p.slug, kind: "new-in", label: `New session in ${p.name}`, detail: tilde(p.home), depth: 1, value: p.slug });
    for (const t of live) out.push(threadItem(t, 1));
    const ss = d.sessions[p.slug];
    if (!ss) out.push({ key: "n:loading:" + p.slug, kind: "note", label: "loading sessions", depth: 1 });
    else {
      const rest = ss.filter(s => !headless.has(s.id));
      out.push({ key: "h:sessions:" + p.slug, kind: "header", label: `Sessions (${rest.length})`, depth: 1 });
      if (!rest.length) out.push({ key: "n:sessions:" + p.slug, kind: "note", label: "none yet", depth: 1 });
      for (const s of rest) out.push({ key: `session:${p.slug}:${s.id}`, kind: "session", label: s.label, depth: 1, value: { ...s, project: p.slug },
        detail: [ago(s.last), s.how && s.how.join("+")].filter(Boolean).join(" · ") });
    }
  }
  out.push({ key: "new", kind: "new", label: "New session without a project", detail: "claude in this folder" });

  const loose = d.threads.filter(t => !t.project);
  if (loose.length) {
    out.push({ key: "h:threads", kind: "header", label: "Headless threads", count: loose.length });
    for (const t of loose) out.push(threadItem(t, 0));
  }

  out.push({ key: "h:agents", kind: "header", label: "Agents" });
  if (d.agents === null) out.push({ key: "n:agents", kind: "note", label: "agents arrive with the switchboard" });
  else if (!d.agents.length) out.push({ key: "n:agents", kind: "note", label: "none yet" });
  else for (const a of d.agents) out.push({ key: "agent:" + a.name, kind: "agent", label: a.name, value: a.name, detail: a.doing || a.status || a.kind || "" });
  return out;
}

/**
 * Every selectable item a filter can reach, including sessions of projects that are closed:
 * a person searching for a session should not have to open its project first.
 * @param {Data} d @param {string[]} open which projects are open in the tree
 */
function everything(d, open) {
  const all = items(d, d.projects.map(p => p.slug)).filter(selectable).map(it => (it.kind === "project" ? { ...it, open: open.includes(it.value) } : it));
  const seen = new Set();
  // A headless thread in a project appears once, not once per place it could be listed.
  return all.filter(it => !seen.has(it.key) && seen.add(it.key)).map(it => {
    if (it.kind !== "session" && it.kind !== "thread") return it;
    const p = d.projects.find(x => x.slug === (it.value && it.value.project));
    return { ...it, depth: 0, detail: [p && p.name, it.detail].filter(Boolean).join(" · ") };
  });
}

/**
 * What the list shows now: the tree, or with a filter, the matches best first.
 * @param {State} st
 * @returns {Item[]}
 */
export function view(st) {
  if (!st.filter.trim()) return items(st.data, st.open);
  return rank(everything(st.data, st.open), st.filter, it => ({ label: it.label, detail: it.detail }))
    .map(({ item, positions }) => ({ ...item, positions }));
}

/** The selected item, or null. */
export function current(st) {
  const v = view(st);
  return v.find(it => it.key === st.cursor) || null;
}

/**
 * The cursor made valid for what is shown: kept when its item is still there, else moved to the
 * nearest selectable item at or after where it was, else the first.
 * @param {State} st @param {Item[]} [before] the view the cursor was valid in
 */
export function settle(st, before) {
  const v = view(st);
  if (v.some(it => it.key === st.cursor && selectable(it))) return st;
  if (before && st.cursor) {
    const at = before.findIndex(it => it.key === st.cursor);
    for (let i = Math.max(0, at); i < before.length; i++) {
      const hit = v.find(it => it.key === before[i].key && selectable(it));
      if (hit) return { ...st, cursor: hit.key };
    }
  }
  const first = v.find(selectable);
  return { ...st, cursor: first ? first.key : null };
}

/**
 * The state a screen opens in: the folder's project selected, else the first project, else the
 * first selectable item (the Inbox, when something waits).
 * @param {Data} data
 * @returns {State}
 */
export function initial(data) {
  /** @type {State} */
  const st = { data, open: [], filter: "", cursor: null, focus: "list", compose: "", help: false, action: null, status: "", scroll: 0 };
  const v = items(data, []);
  const pick = (data.here && v.find(it => it.key === "project:" + data.here)) || v.find(it => it.kind === "project") || v.find(selectable);
  return { ...st, cursor: pick ? pick.key : null };
}

/** New data from vyred, keeping the cursor on the same item when it is still there. */
export function withData(st, data) {
  const before = view(st);
  return settle({ ...st, data }, before);
}

/**
 * @typedef {{ type: "quit" } | { type: "new" } | { type: "new-in", project: string } | { type: "resume", session: any }
 *   | { type: "answer", ask: any, decision: "allow"|"deny" } | { type: "draft", draft: any, decision: "approve"|"reject" }
 *   | { type: "send", thread: any, text: string } | { type: "lease", thread: any } | { type: "talk", agent: string }
 *   | { type: "load", project: string }} Effect
 */

const PAGE = 10;

/**
 * One key.
 * @param {State} st @param {{ name: string, text?: string }} key
 * @returns {{ st: State, effect?: Effect }}
 */
export function reduce(st, key) {
  const k = key.name;
  const ch = k === "char" ? String(key.text) : null;
  const clearStatus = { ...st, status: "" };
  st = clearStatus;
  if (k === "ctrl-c") return { st, effect: { type: "quit" } };

  if (st.help) {
    // Any key closes help; q and Esc do nothing more than that.
    return { st: { ...st, help: false } };
  }

  const it = current(st);

  // A pending action line: the next key is the answer.
  if (st.action && it) {
    const done = { ...st, action: null };
    if (k === "esc") return { st: done };
    if (it.kind === "ask" && (ch === "a" || ch === "y")) return { st: done, effect: { type: "answer", ask: it.value, decision: "allow" } };
    if (it.kind === "ask" && (ch === "d" || ch === "n")) return { st: done, effect: { type: "answer", ask: it.value, decision: "deny" } };
    if (it.kind === "draft" && ch === "a") return { st: done, effect: { type: "draft", draft: it.value, decision: "approve" } };
    if (it.kind === "draft" && ch === "r") return { st: done, effect: { type: "draft", draft: it.value, decision: "reject" } };
    return { st };
  }
  if (st.action) st = { ...st, action: null };

  if (st.focus === "compose") {
    if (k === "esc" || k === "tab" || k === "shift-tab") return { st: { ...st, focus: "list" } };
    if (k === "enter") {
      const text = st.compose.trim();
      if (!text || !it || it.kind !== "thread") return { st };
      return { st: { ...st, compose: "" }, effect: { type: "send", thread: it.value, text } };
    }
    if (k === "backspace") return { st: { ...st, compose: st.compose.slice(0, -1) } };
    if (k === "ctrl-u") return { st: { ...st, compose: "" } };
    if (k === "ctrl-w") return { st: { ...st, compose: st.compose.replace(/\S*\s*$/, "") } };
    if (k === "ctrl-l" && it && it.kind === "thread") return { st, effect: { type: "lease", thread: it.value } };
    if (k === "pageup") return { st: { ...st, scroll: st.scroll + PAGE } };
    if (k === "pagedown") return { st: { ...st, scroll: Math.max(0, st.scroll - PAGE) } };
    if (ch) return { st: { ...st, compose: st.compose + ch } };
    if (k === "paste") return { st: { ...st, compose: st.compose + String(key.text).replace(/\r?\n/g, " ") } };
    return { st };
  }

  const v = view(st);
  const at = v.findIndex(x => x.key === st.cursor);
  const move = (dir, n = 1) => {
    let i = at, left = n, last = at;
    for (i = at + dir; i >= 0 && i < v.length; i += dir) {
      if (!selectable(v[i])) continue;
      last = i;
      if (--left === 0) break;
    }
    return last >= 0 && v[last] ? { st: { ...st, cursor: v[last].key, scroll: 0 } } : { st };
  };
  // A new filter selects its best match, as fzf does; clearing it goes back to the item that was
  // selected, so Esc after a look around lands where the look started.
  const refilter = filter => {
    const next = { ...st, filter, scroll: 0 };
    if (!filter.trim()) return settle(next, v);
    const best = view(next).find(selectable);
    return { ...next, cursor: best ? best.key : st.cursor };
  };
  const empty = !st.filter;

  if (k === "up") return move(-1);
  if (k === "down") return move(1);
  if (k === "pageup") return move(-1, PAGE);
  if (k === "pagedown") return move(1, PAGE);
  if (k === "home") { const f = v.find(selectable); return f ? { st: { ...st, cursor: f.key } } : { st }; }
  if (k === "end") { const l = [...v].reverse().find(selectable); return l ? { st: { ...st, cursor: l.key } } : { st }; }
  if (k === "backspace") return { st: refilter(st.filter.slice(0, -1)) };
  if (k === "ctrl-u") return { st: refilter("") };
  if (k === "paste") return { st: refilter(st.filter + String(key.text).replace(/\s+/g, " ")) };

  if (k === "esc") {
    if (st.filter) return { st: refilter("") };
    // Close the project the cursor is in (or on), and land on it.
    const slug = it && (it.kind === "project" ? (it.open ? it.value : null) : it.depth ? projectOf(v, at) : null);
    if (slug) return { st: { ...st, open: st.open.filter(s => s !== slug), cursor: "project:" + slug } };
    return { st };
  }
  if (k === "left" && it) {
    const slug = it.kind === "project" ? (it.open ? it.value : null) : it.depth ? projectOf(v, at) : null;
    if (slug) return { st: { ...st, open: st.open.filter(s => s !== slug), cursor: "project:" + slug } };
    return { st };
  }
  if (k === "right" && it && it.kind === "project" && !it.open) return openProject(st, it.value);

  if (k === "tab") {
    if (it && it.kind === "thread") return { st: { ...st, focus: "compose" } };
    return { st: { ...st, status: "tab types into a headless thread: select one first" } };
  }
  if (k === "ctrl-l" && it && it.kind === "thread") return { st, effect: { type: "lease", thread: it.value } };

  if (empty && ch === "?") return { st: { ...st, help: true } };
  if (empty && ch === "q") return { st, effect: { type: "quit" } };
  if (empty && it && it.kind === "ask" && (ch === "a" || ch === "d")) return { st, effect: { type: "answer", ask: it.value, decision: ch === "a" ? "allow" : "deny" } };
  if (empty && it && it.kind === "draft" && (ch === "a" || ch === "r")) return { st, effect: { type: "draft", draft: it.value, decision: ch === "a" ? "approve" : "reject" } };
  if (ch) return { st: refilter(st.filter + ch) };

  if (k === "enter" && it) {
    // Enter ends a filter: the list goes back to the tree, still on the item that was picked.
    const base = st.filter ? { ...st, filter: "" } : st;
    switch (it.kind) {
      case "project":
        if (it.open) return { st: { ...base, open: base.open.filter(s => s !== it.value), cursor: it.key } };
        return openProject({ ...base, cursor: it.key }, it.value);
      case "new-in": return { st: base, effect: { type: "new-in", project: it.value } };
      case "new": return { st: base, effect: { type: "new" } };
      case "session": return { st: base, effect: { type: "resume", session: it.value } };
      case "thread": return { st: { ...base, cursor: it.key, focus: "compose", open: withProject(base.open, it.value.project) } };
      case "agent": return { st: base, effect: { type: "talk", agent: it.value } };
      case "ask": case "draft": return { st: { ...base, cursor: it.key, action: it.kind } };
    }
  }
  return { st };
}

const withProject = (open, slug) => (slug && !open.includes(slug) ? [...open, slug] : open);

/** Open a project and put the cursor on its first child; its sessions load if they have not. */
function openProject(st, slug) {
  const next = { ...st, open: withProject(st.open, slug), cursor: "new-in:" + slug };
  return st.data.sessions[slug] ? { st: next } : { st: next, effect: { type: "load", project: slug } };
}

/** The project an indented item sits under. */
function projectOf(v, at) {
  for (let i = at; i >= 0; i--) if (v[i].kind === "project") return v[i].value;
  return null;
}

/** Every key the screen knows, for the help overlay. */
export const KEYS = [
  ["↑ ↓", "move"], ["pgup pgdn", "move a page; in the compose line, scroll the output"], ["→ ←", "open or close a project"],
  ["type", "filter every list (fuzzy); backspace and ctrl-u edit it"], ["enter", "open, resume in Claude Code, start, or act"],
  ["esc", "clear the filter, then close the project"], ["a  d", "allow or deny the selected ask"], ["a  r", "approve or reject the selected draft"],
  ["tab", "type into the selected headless thread; enter sends"], ["ctrl-l", "take the keyboard of that thread"],
  ["?", "this help"], ["q  ctrl-c", "quit"],
];
