// @ts-check
// The pure half of the Chat screen's one list: chats, group chats, agents and teammates as one row type, newest first, with the project chips and the search. No tool is called here.
// A chat is a group when two or more others are in it. An agent or a teammate you already talk to alone is that chat's row, not a second one.

/** @typedef {{ id: string, title: string, project: string, people: string[], agents: string[], status: string, last: number, line: string, asks: number, unread: number, open: boolean, pinned?: string, place?: string }} ChatRow */
/** @typedef {{ id: string, kind: "chat" | "group" | "agent" | "person" | "flow", title: string, sub: string, last: number, project: string, projects: string[], chat: string, agent: string, person: string, open: boolean, asks: number, unread: number, pinned: boolean, status: string, dot: "" | "ask" | "unread", names: string[], look: string, lone: "agent" | "person" | "", section: "pinned" | "personal" | "space" | "projects" | "flows", threads: number }} Convo */

const KIND_WORDS = { chat: "Chat", group: "Group chat", agent: "Agent", person: "Teammate", flow: "Flow" };
/** @param {Convo["kind"]} k */
export const convoKindWord = (k) => KIND_WORDS[k];

/** @typedef {{ title: string, live?: boolean, needs?: boolean, at?: number }} ThreadInfo */

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
    const place = placeOf(c);
    const ts = agentOnly ? infoOf.get(c.agents[0]) ?? [] : [];
    out.push({
      id: `chat:${c.id}`, kind: others >= 2 ? "group" : "chat", title: c.title, sub: agentOnly ? agentLine(ts, c.line) : c.line, last: c.last, project: c.project,
      projects: c.project ? [c.project] : [], chat: c.id, agent: "", person: "", open: c.open, asks: c.asks, unread: c.unread, pinned, status: c.status, dot: c.asks > 0 ? "ask" : c.unread > 0 ? "unread" : "", names: [...c.people, ...c.agents], look: "", lone: agentOnly ? "agent" : others === 1 && c.people.length === 1 ? "person" : "",
      section: pinned ? "pinned" : place, threads: agentOnly ? Math.max(1, ts.length) : 1,
    });
  }
  for (const a of i.agents) {
    if (aloneAgent.has(a.name)) continue;
    const ts = a.threads ?? [];
    out.push({ id: `agent:${a.name}`, kind: "agent", title: a.name, sub: agentLine(ts, a.role ?? ""), last: Math.max(0, ...ts.map((t) => t.at ?? 0)), project: "", projects: (a.projects ?? []).map(String), chat: "", agent: a.name, person: "", open: true, asks: 0, unread: 0, pinned: false, status: a.status ?? "", dot: "", names: [a.name], look: a.look ?? "", lone: "agent", section: "personal", threads: Math.max(1, ts.length) });
  }
  for (const p of i.people) {
    if (alonePerson.has(p.name)) continue;
    out.push({ id: `person:${p.id}`, kind: "person", title: p.name, sub: p.role ?? "", last: 0, project: "", projects: [], chat: "", agent: "", person: p.id, open: true, asks: 0, unread: 0, pinned: false, status: "", dot: "", names: [p.name], look: "", lone: "person", section: "space", threads: 1 });
  }
  for (const f of i.flows ?? []) {
    out.push({ id: `flow:${f.id}`, kind: "flow", title: f.title, sub: f.line ?? "", last: f.last ?? 0, project: "", projects: [], chat: f.id, agent: "", person: "", open: true, asks: f.needs ?? 0, unread: 0, pinned: false, status: "", dot: (f.needs ?? 0) > 0 ? "ask" : "", names: [], look: "", lone: "", section: "flows", threads: Math.max(1, f.runs ?? 1) });
  }
  return out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.last - a.last);
}

/** The filter row above the list. @type {{ id: "all" | "personal" | "space" | "projects" | "flows", label: string }[]} */
export const CONVO_TYPES = [{ id: "all", label: "All" }, { id: "personal", label: "Personal" }, { id: "space", label: "Space" }, { id: "projects", label: "Projects" }, { id: "flows", label: "Flows" }];
const SECTION_ORDER = [["pinned", "Pinned"], ["personal", "Personal"], ["space", "Space chats"], ["projects", "Projects"], ["flows", "Flows"]];

/** The rows in their sections, in the list's order: Pinned, Personal, Space chats, Projects, Flows; an empty section is left out. Inside a section the newest comes first. @param {readonly Convo[]} items @returns {{ id: string, label: string, rows: Convo[] }[]} */
export function convoSections(items) {
  return SECTION_ORDER.map(([id, label]) => ({ id, label, rows: items.filter((c) => c.section === id).sort((a, b) => b.last - a.last) })).filter((s) => s.rows.length);
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
