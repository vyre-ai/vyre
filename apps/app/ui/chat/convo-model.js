// @ts-check
import { agentWords } from "../../src/state/agent-name.js";
// The pure half of the Chat screen's one list: chats, group chats, agents and teammates as one row type, newest first, with the project chips and the search. No tool is called here.
// A chat is a group when two or more others are in it. An agent or a teammate you already talk to alone is that chat's row, not a second one.

/** An agent's id said as words: "engineer" is "Engineer", "desk-helper" is "Desk Helper" (src/state/agent-name.js, the one way an agent is named to a person). A name that is already someone's words ("Qi") is left alone. */
export const displayName = agentWords;

/** @typedef {{ id: string, title: string, project: string, people: string[], agents: string[], status: string, last: number, line: string, asks: number, unread: number, open: boolean, pinned?: string, place?: string, engineer?: boolean }} ChatRow */
/** @typedef {{ id: string, kind: "chat" | "group" | "agent" | "person" | "flow", title: string, sub: string, last: number, project: string, projects: string[], chat: string, agent: string, person: string, open: boolean, asks: number, unread: number, pinned: boolean, status: string, dot: "" | "ask" | "unread", names: string[], look: string, lone: "agent" | "person" | "", section: "pinned" | "personal" | "space" | "projects" | "flows", threads: number }} Convo */

const KIND_WORDS = { chat: "Chat", group: "Group chat", agent: "Agent", person: "Teammate", flow: "Flow" };
/** @param {Convo["kind"]} k */
export const convoKindWord = (k) => KIND_WORDS[k];

/** @typedef {{ title: string, live?: boolean, needs?: boolean, at?: number }} ThreadInfo */
/** What work.chat.summary says of an agent: how many threads, the latest and the live one. @typedef {{ count: number, latest?: string, at?: number, live?: string, needs?: boolean }} AgentSummary */

/**
 * Where a chat lives, which the person never has to think about: Personal (only you: your agent threads), Space (it only has the people in it), Projects (a project's chat, everyone on it).
 * The box says it (`place`); until a row has one it is worked out from who is in the chat.
 * @param {{ place?: string, project?: string, people: readonly string[], agents: readonly string[] }} c @returns {"personal" | "space" | "projects"}
 */
export function placeOf(c) {
  if (c.place === "personal" || c.place === "space") return c.place;
  if (c.place === "project" || c.place === "projects") return "projects";
  if (c.project) return "projects";
  return c.people.length ? "space" : "personal";
}

/**
 * The second line of an agent's row: its live thread (and that it needs you), else its latest, then how many threads it has. @param {readonly ThreadInfo[]} ts @param {string} fallback
 */
export function agentLine(ts, fallback) {
  if (!ts || !ts.length) return fallback;
  const live = ts.find((t) => t.live), t = live || ts[0];
  return `${t.title}${live && live.needs ? " \u00b7 needs you" : ""}${ts.length > 1 ? ` \u00b7 ${ts.length} threads` : ""}`;
}

/** The same line from work.chat.summary's counts. @param {AgentSummary | undefined} s @param {string} fallback */
export function summaryLine(s, fallback) {
  if (!s || !(s.count > 0)) return fallback;
  const t = s.live ?? s.latest;
  if (!t) return `${s.count} ${s.count === 1 ? "thread" : "threads"}`;
  return `${t}${s.live && s.needs ? " \u00b7 needs you" : ""}${s.count > 1 ? ` \u00b7 ${s.count} threads` : ""}`;
}

/** A thread title that says nothing yet ("New chat"): never shown as a row's second line. @param {unknown} t */
const untitled = (t) => /^(new chat|new thread|chat)$/i.test(String(t ?? "").trim());

/** The second line of an agent's row when its newest thread has no last message: the live or latest thread when it has a real title, else only how many threads. @param {AgentSummary | undefined} sum @param {readonly ThreadInfo[]} ts */
function threadsLine(sum, ts) {
  if (sum && sum.count > 0) {
    const clean = { ...sum, ...(untitled(sum.latest) ? { latest: undefined } : {}), ...(untitled(sum.live) ? { live: undefined } : {}) };
    return clean.live || clean.latest || sum.count > 1 ? summaryLine(clean, "") : "";
  }
  const titled = ts.filter((t) => !untitled(t.title));
  if (titled.length === ts.length) return agentLine(ts, "");
  return ts.length > 1 ? `${ts.length} threads` : "";
}

/**
 * @param {{ assistantName?: string, assistantAgent?: string, chats: readonly ChatRow[], agents: readonly { name: string, title?: string, role?: string, projects?: string[], status?: string, look?: string, threads?: readonly ThreadInfo[], summary?: AgentSummary }[], people: readonly { id: string, name: string, role?: string }[], flows?: readonly { id: string, title: string, line?: string, last?: number, runs?: number, needs?: number }[] }} i
 * @returns {Convo[]}
 */
export function convosFrom(i) {
  const asst = typeof i.assistantName === "string" && i.assistantName ? i.assistantName : "";
  // the assistant's id (its look and its threads go by it); a list that only knows the name it is said by uses that
  const asstId = typeof i.assistantAgent === "string" && i.assistantAgent ? i.assistantAgent : asst;
  /** @type {Convo[]} */ const out = [];
  const aloneAgent = new Set();
  const alonePerson = new Set();
  const infoOf = new Map(i.agents.map((a) => [a.name, a.threads ?? []]));
  const sumOf = new Map(i.agents.map((a) => [a.name, a.summary]));
  // how an agent is said to a person (its name is its id); a chat that is only with it carries that id as its title
  const said = new Map(i.agents.map((a) => [a.name, a.title || displayName(a.name)]));
  // Threads with one agent are that agent's threads: ONE row per agent, which opens its newest thread; the others are under Threads in the chat's panel.
  /** @type {Map<string, { newest: ChatRow, n: number }>} */ const byAgent = new Map();
  const ownThread = (/** @type {ChatRow} */ c) => c.people.length === 0 && c.agents.length === 1 && c.pinned !== "assistant" && c.engineer !== true;
  for (const c of i.chats) {
    if (!ownThread(c)) continue;
    const g = byAgent.get(c.agents[0]);
    byAgent.set(c.agents[0], { newest: !g || c.last > g.newest.last ? c : g.newest, n: (g?.n ?? 0) + 1 });
  }
  for (const c of i.chats) {
    const others = c.people.length + c.agents.length;
    if (others === 1 && c.agents.length === 1 && c.title === c.agents[0]) aloneAgent.add(c.agents[0]);
    if (others === 1 && c.people.length === 1 && c.title === c.people[0]) alonePerson.add(c.people[0]);
    const pinned = c.pinned === "assistant";
    const eng = c.engineer === true;
    const agentOnly = others === 1 && c.agents.length === 1;
    const mine = ownThread(c);
    const g = mine ? byAgent.get(c.agents[0]) : undefined;
    if (g && g.newest !== c) continue;
    if (g) aloneAgent.add(c.agents[0]);
    // the Engineer's own chat is that agent's row, whatever its title says: no second row from the agents list
    if (eng && agentOnly) aloneAgent.add(c.agents[0]);
    const place = placeOf(c);
    const ts = agentOnly ? infoOf.get(c.agents[0]) ?? [] : [];
    const sum = agentOnly ? sumOf.get(c.agents[0]) : undefined;
    // the second line is the last message, or what its threads say, or nothing: never the title again, never "New chat"
    const last = untitled(c.line) ? "" : c.line;
    // the assistant's own chat is said and drawn as the assistant (its face, not initials)
    const asAsst = pinned && !!asst;
    out.push({
      id: `chat:${c.id}`, kind: others >= 2 ? "group" : "chat", title: eng ? "Engineer" : asAsst ? displayName(asst) : mine ? (said.get(c.agents[0]) ?? displayName(c.agents[0])) : c.title === c.agents[0] && agentOnly ? (said.get(c.title) ?? c.title) : c.title,
      sub: mine ? last || threadsLine(sum, ts) : agentOnly ? (sum ? summaryLine(sum, last) : agentLine(ts, last)) : last, last: Math.max(c.last, agentOnly ? sum?.at ?? 0 : 0), project: c.project,
      projects: c.project ? [c.project] : [], chat: c.id, agent: mine ? c.agents[0] : asAsst ? asstId : "", person: "", open: c.open, asks: c.asks, unread: c.unread, pinned: pinned || eng, status: c.status, dot: c.asks > 0 ? "ask" : c.unread > 0 ? "unread" : "",
      names: asAsst && !c.agents.length ? [asstId] : [...c.people, ...c.agents], look: "", lone: agentOnly || asAsst ? "agent" : others === 1 && c.people.length === 1 ? "person" : "",
      section: pinned ? "pinned" : place, threads: agentOnly ? Math.max(1, ts.length, sum?.count ?? 0, g?.n ?? 0) : 1,
    });
  }
  for (const a of i.agents) {
    if (aloneAgent.has(a.name)) continue;
    const ts = a.threads ?? [];
    out.push({ id: `agent:${a.name}`, kind: "agent", title: a.title || displayName(a.name), sub: a.summary ? summaryLine(a.summary, a.role ?? "") : agentLine(ts, a.role ?? ""), last: Math.max(0, a.summary?.at ?? 0, ...ts.map((t) => t.at ?? 0)), project: "", projects: (a.projects ?? []).map(String), chat: "", agent: a.name, person: "", open: true, asks: 0, unread: 0, pinned: false, status: a.status ?? "", dot: "", names: [a.name], look: a.look ?? "", lone: "agent", section: "personal", threads: Math.max(1, ts.length, a.summary?.count ?? 0) });
  }
  for (const p of i.people) {
    if (alonePerson.has(p.name)) continue;
    out.push({ id: `person:${p.id}`, kind: "person", title: p.name, sub: p.role ?? "", last: 0, project: "", projects: [], chat: "", agent: "", person: p.id, open: true, asks: 0, unread: 0, pinned: false, status: "", dot: "", names: [p.name], look: "", lone: "person", section: "space", threads: 1 });
  }
  for (const f of i.flows ?? []) {
    out.push({ id: `flow:${f.id}`, kind: "flow", title: f.title, sub: f.line ?? "", last: f.last ?? 0, project: "", projects: [], chat: f.id, agent: "", person: "", open: true, asks: f.needs ?? 0, unread: 0, pinned: false, status: "", dot: (f.needs ?? 0) > 0 ? "ask" : "", names: [], look: "", lone: "", section: "flows", threads: Math.max(1, f.runs ?? 1) });
  }
  // Your assistant is always at the top: with no chat of its own yet, a row that starts a new thread with it.
  if (asst && !out.some((r) => r.pinned && r.section === "pinned" && r.chat)) {
    out.push({ id: "assistant:new", kind: "agent", title: displayName(asst), sub: "Your assistant", last: Number.MAX_SAFE_INTEGER, project: "", projects: [], chat: "", agent: asst, person: "", open: true, asks: 0, unread: 0, pinned: true, status: "", dot: "", names: [asst], look: "", lone: "agent", section: "pinned", threads: 1 });
  }
  // The second line never repeats the name above it: an agent says what it is, the assistant says whose it is, anything else says nothing rather than its title twice.
  for (const r of out) {
    const same = !r.sub || r.sub.trim().toLowerCase() === r.title.trim().toLowerCase() || r.sub.trim().toLowerCase() === r.agent.trim().toLowerCase() || untitled(r.sub);
    if (same && r.kind === "agent") r.sub = "Agent";
    else if (same && r.section === "pinned" && asst) r.sub = "Your assistant";
    else if (same) r.sub = "";
  }
  // One row per agent, from whatever source: the row that opens a chat beats the bare agent row, then the newer one wins.
  const keyOf = (/** @type {Convo} */ r) => (r.lone === "agent" && (r.kind === "chat" || r.kind === "agent") ? (r.agent || (r.names.length === 1 ? r.names[0] : "")) : "");
  const best = new Map();
  for (const r of out) {
    const k = keyOf(r);
    if (!k) continue;
    const b = best.get(k);
    if (!b || (r.chat !== "" && b.chat === "") || ((r.chat !== "") === (b.chat !== "") && r.last > b.last)) best.set(k, r);
  }
  const kept = out.filter((r) => { const k = keyOf(r); return !k || best.get(k) === r; });
  return kept.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.last - a.last);
}

/** The filter row above the list. @type {{ id: "all" | "personal" | "space" | "projects" | "flows", label: string }[]} */
export const CONVO_TYPES = [{ id: "all", label: "All" }, { id: "personal", label: "Personal" }, { id: "space", label: "Space" }, { id: "projects", label: "Projects" }, { id: "flows", label: "Flows" }];
const SECTION_ORDER = [["pinned", "Pinned"], ["personal", "Personal"], ["space", "Space chats"], ["projects", "Projects"], ["flows", "Flows"]];

/** The rows in their sections, in the list's order: Pinned, Personal, Space chats, Projects, Flows; an empty section is left out. Inside a section the newest comes first. @param {readonly Convo[]} items @returns {{ id: string, label: string, rows: Convo[] }[]} */
export function convoSections(items) {
  return SECTION_ORDER.map(([id, label]) => ({ id, label, rows: items.filter((c) => c.section === id).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.last - a.last) })).filter((s) => s.rows.length);
}

/** All, each project once (in the order it first appears), then No project. @param {readonly Convo[]} items @returns {{ id: string, label: string }[]} */
export function convoChips(items) {
  const names = [...new Set(items.flatMap((c) => c.projects))];
  return [{ id: "all", label: "All" }, ...names.map((n) => ({ id: n, label: n })), { id: "none", label: "No project" }];
}

/** The rows a type, a project and a search leave. The search reads the title, the line and the project. The pinned Assistant is Personal. @param {readonly Convo[]} items @param {{ project: string, query: string, type?: string }} f */
export function convosShown(items, f) {
  const word = f.query.trim().toLowerCase();
  const type = f.type ?? "all";
  return items.filter((c) => {
    if (type !== "all" && !(c.section === type || (c.section === "pinned" && type === "personal"))) return false;
    if (f.project === "none" ? c.projects.length > 0 : f.project !== "all" && !c.projects.includes(f.project)) return false;
    return !word || [c.title, c.sub, ...c.projects].join(" ").toLowerCase().includes(word);
  });
}
