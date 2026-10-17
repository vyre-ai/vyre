// @ts-check
// The pure half of the Chat screen's one list: chats, group chats, agents and teammates as one row type, newest first, with the project chips and the search. No tool is called here.
// A chat is a group when two or more others are in it. An agent or a teammate you already talk to alone is that chat's row, not a second one.

/** @typedef {{ id: string, title: string, project: string, people: string[], agents: string[], status: string, last: number, line: string, asks: number, unread: number, open: boolean, pinned?: string }} ChatRow */
/** @typedef {{ id: string, kind: "chat" | "group" | "agent" | "person", title: string, sub: string, last: number, project: string, projects: string[], chat: string, agent: string, person: string, open: boolean, asks: number, unread: number, pinned: boolean, status: string, dot: "" | "ask" | "unread", names: string[] }} Convo */

const KIND_WORDS = { chat: "Chat", group: "Group chat", agent: "Agent", person: "Teammate" };
/** @param {Convo["kind"]} k */
export const convoKindWord = (k) => KIND_WORDS[k];

/**
 * @param {{ chats: readonly ChatRow[], agents: readonly { name: string, role?: string, projects?: string[], status?: string }[], people: readonly { id: string, name: string, role?: string }[] }} i
 * @returns {Convo[]}
 */
export function convosFrom(i) {
  /** @type {Convo[]} */ const out = [];
  const aloneAgent = new Set();
  const alonePerson = new Set();
  for (const c of i.chats) {
    const others = c.people.length + c.agents.length;
    if (others === 1 && c.agents.length === 1 && c.title === c.agents[0]) aloneAgent.add(c.agents[0]);
    if (others === 1 && c.people.length === 1 && c.title === c.people[0]) alonePerson.add(c.people[0]);
    out.push({
      id: `chat:${c.id}`, kind: others >= 2 ? "group" : "chat", title: c.title, sub: c.line, last: c.last, project: c.project,
      projects: c.project ? [c.project] : [], chat: c.id, agent: "", person: "", open: c.open, asks: c.asks, unread: c.unread, pinned: c.pinned === "assistant", status: c.status, dot: c.asks > 0 ? "ask" : c.unread > 0 ? "unread" : "", names: [...c.people, ...c.agents],
    });
  }
  for (const a of i.agents) {
    if (aloneAgent.has(a.name)) continue;
    out.push({ id: `agent:${a.name}`, kind: "agent", title: a.name, sub: a.role ?? "", last: 0, project: "", projects: (a.projects ?? []).map(String), chat: "", agent: a.name, person: "", open: true, asks: 0, unread: 0, pinned: false, status: a.status ?? "", dot: "", names: [a.name] });
  }
  for (const p of i.people) {
    if (alonePerson.has(p.name)) continue;
    out.push({ id: `person:${p.id}`, kind: "person", title: p.name, sub: p.role ?? "", last: 0, project: "", projects: [], chat: "", agent: "", person: p.id, open: true, asks: 0, unread: 0, pinned: false, status: "", dot: "", names: [p.name] });
  }
  return out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.last - a.last);
}

/** All, each project once (in the order it first appears), then No project. @param {readonly Convo[]} items @returns {{ id: string, label: string }[]} */
export function convoChips(items) {
  const names = [...new Set(items.flatMap((c) => c.projects))];
  return [{ id: "all", label: "All" }, ...names.map((n) => ({ id: n, label: n })), { id: "none", label: "No project" }];
}

/** The rows a chip and a search leave. The search reads the title, the line and the project. @param {readonly Convo[]} items @param {{ project: string, query: string }} f */
export function convosShown(items, f) {
  const word = f.query.trim().toLowerCase();
  return items.filter((c) => {
    if (f.project === "none" ? c.projects.length > 0 : f.project !== "all" && !c.projects.includes(f.project)) return false;
    return !word || [c.title, c.sub, ...c.projects].join(" ").toLowerCase().includes(word);
  });
}
