// @ts-check
// The pure half of the Chat screen's one list: chats, group chats, agents and teammates as one row type, newest first, with the project chips and the search. No tool is called here.
// A chat is a group when two or more others are in it. An agent or a teammate you already talk to alone is that chat's row, not a second one.

/** @typedef {{ id: string, title: string, project: string, people: string[], agents: string[], status: string, last: number, line: string, asks: number, unread: number, open: boolean, pinned?: string }} ChatRow */
/** @typedef {{ id: string, kind: "chat" | "group" | "agent" | "person" | "flow", title: string, sub: string, last: number, project: string, projects: string[], chat: string, agent: string, person: string, open: boolean, asks: number, unread: number, pinned: boolean, status: string, dot: "" | "ask" | "unread", names: string[], look: string, section: "pinned" | "people" | "groups" | "agents" | "flows", threads: number }} Convo */

const KIND_WORDS = { chat: "Chat", group: "Group chat", agent: "Agent", person: "Teammate", flow: "Flow" };
/** @param {Convo["kind"]} k */
export const convoKindWord = (k) => KIND_WORDS[k];

/** @typedef {{ title: string, live?: boolean, needs?: boolean }} ThreadInfo */

/**
 * The second line of an agent's row: its live thread (and that it needs you), else its latest, then how many threads it has. @param {readonly ThreadInfo[]} ts @param {string} fallback
 */
export function agentLine(ts, fallback) {
  if (!ts || !ts.length) return fallback;
  const live = ts.find((t) => t.live), t = live || ts[0];
  return `${t.title}${live && live.needs ? " \u00b7 needs you" : ""}${ts.length > 1 ? ` \u00b7 ${ts.length} threads` : ""}`;
}

/**
 * @param {{ chats: readonly ChatRow[], agents: readonly { name: string, role?: string, projects?: string[], status?: string, look?: string, threads?: readonly ThreadInfo[] }[], people: readonly { id: string, name: string, role?: string }[], flows?: readonly { id: string, title: string, line?: string, last?: number, runs?: number, needs?: number }[] }} i
 * @returns {Convo[]}
 */
export function convosFrom(i) {
  /** @type {Convo[]} */ const out = [];
  const aloneAgent = new Set();
  const alonePerson = new Set();
  const infoOf = new Map(i.agents.map((a) => [a.name, a.threads ?? []]));
  for (const c of i.chats) {
    const others = c.people.length + c.agents.length;
    if (others === 1 && c.agents.length === 1 && c.title === c.agents[0]) aloneAgent.add(c.agents[0]);
    if (others === 1 && c.people.length === 1 && c.title === c.people[0]) alonePerson.add(c.people[0]);
    const pinned = c.pinned === "assistant";
    const agentOnly = others === 1 && c.agents.length === 1;
    const ts = agentOnly ? infoOf.get(c.agents[0]) ?? [] : [];
    out.push({
      id: `chat:${c.id}`, kind: others >= 2 ? "group" : "chat", title: c.title, sub: agentOnly ? agentLine(ts, c.line) : c.line, last: c.last, project: c.project,
      projects: c.project ? [c.project] : [], chat: c.id, agent: "", person: "", open: c.open, asks: c.asks, unread: c.unread, pinned, status: c.status, dot: c.asks > 0 ? "ask" : c.unread > 0 ? "unread" : "", names: [...c.people, ...c.agents], look: "",
      section: pinned ? "pinned" : others >= 2 ? "groups" : agentOnly ? "agents" : "people", threads: agentOnly ? Math.max(1, ts.length) : 1,
    });
  }
  for (const a of i.agents) {
    if (aloneAgent.has(a.name)) continue;
    const ts = a.threads ?? [];
    out.push({ id: `agent:${a.name}`, kind: "agent", title: a.name, sub: agentLine(ts, a.role ?? ""), last: 0, project: "", projects: (a.projects ?? []).map(String), chat: "", agent: a.name, person: "", open: true, asks: 0, unread: 0, pinned: false, status: a.status ?? "", dot: "", names: [a.name], look: a.look ?? "", section: "agents", threads: Math.max(1, ts.length) });
  }
  for (const p of i.people) {
    if (alonePerson.has(p.name)) continue;
    out.push({ id: `person:${p.id}`, kind: "person", title: p.name, sub: p.role ?? "", last: 0, project: "", projects: [], chat: "", agent: "", person: p.id, open: true, asks: 0, unread: 0, pinned: false, status: "", dot: "", names: [p.name], look: "", section: "people", threads: 1 });
  }
  for (const f of i.flows ?? []) {
    out.push({ id: `flow:${f.id}`, kind: "flow", title: f.title, sub: f.line ?? "", last: f.last ?? 0, project: "", projects: [], chat: f.id, agent: "", person: "", open: true, asks: f.needs ?? 0, unread: 0, pinned: false, status: "", dot: (f.needs ?? 0) > 0 ? "ask" : "", names: [], look: "", section: "flows", threads: Math.max(1, f.runs ?? 1) });
  }
  return out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.last - a.last);
}

/** The filter row above the list. @type {{ id: "all" | "people" | "groups" | "agents" | "flows", label: string }[]} */
export const CONVO_TYPES = [{ id: "all", label: "All" }, { id: "people", label: "People" }, { id: "groups", label: "Groups" }, { id: "agents", label: "Agents" }, { id: "flows", label: "Flows" }];
const SECTION_ORDER = [["pinned", "Pinned"], ["people", "People"], ["groups", "Groups"], ["agents", "Agents"], ["flows", "Flows"]];

/** The rows in their sections, in the list's order: Pinned, People, Groups, Agents, Flows; an empty section is left out. Inside a section the rows keep their order. @param {readonly Convo[]} items @returns {{ id: string, label: string, rows: Convo[] }[]} */
export function convoSections(items) {
  return SECTION_ORDER.map(([id, label]) => ({ id, label, rows: items.filter((c) => c.section === id) })).filter((s) => s.rows.length);
}

/** All, each project once (in the order it first appears), then No project. @param {readonly Convo[]} items @returns {{ id: string, label: string }[]} */
export function convoChips(items) {
  const names = [...new Set(items.flatMap((c) => c.projects))];
  return [{ id: "all", label: "All" }, ...names.map((n) => ({ id: n, label: n })), { id: "none", label: "No project" }];
}

/** The rows a type, a project and a search leave. The search reads the title, the line and the project. The pinned Assistant stays under Agents when that type is chosen. @param {readonly Convo[]} items @param {{ project: string, query: string, type?: string }} f */
export function convosShown(items, f) {
  const word = f.query.trim().toLowerCase();
  const type = f.type ?? "all";
  return items.filter((c) => {
    if (type !== "all" && !(c.section === type || (c.section === "pinned" && type === "agents"))) return false;
    if (f.project === "none" ? c.projects.length > 0 : f.project !== "all" && !c.projects.includes(f.project)) return false;
    return !word || [c.title, c.sub, ...c.projects].join(" ").toLowerCase().includes(word);
  });
}
