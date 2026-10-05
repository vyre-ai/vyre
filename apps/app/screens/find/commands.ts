// Find's command grammar, the same one the Mac Lumen and the native apps share, read from the words in the box (tried in this order, ignoring case):
//
//   @<agent> <text>                                    ask that agent
//   (tell|ping|notify) me when [the] <session> [thread] [is] (done|finishes|finished|asks)    watch it
//   (tell|ask) [the] <session> [thread] to <text>      type into it, then watch it
//   (watch|monitor|track) [the] <session> [thread] [and tell me ...]                          watch it
//   anything else                                      ask the assistant
//
// A session is matched by name among the rows Find already has: an exact name, then the name with punctuation dropped, then every word of it, then its letters in order. No match, and the
// words go to the assistant after all. Also here: the p, t and u prefixes, and the merge of the two session lists. Pure: no DOM, no calls, so node tests import it.

export type SessionRow = { id: string; name?: string | null; title?: string | null; project?: string | null };
export type Command =
  | { kind: "agent"; agent: string; text: string }
  | { kind: "watch"; query: string; until: "finished" | "asks" | "either"; candidates: SessionRow[] }
  | { kind: "drive"; query: string; text: string; candidates: SessionRow[] }
  | { kind: "ask"; text: string };

const squash = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const wordsOf = (s: string): string[] => String(s || "").toLowerCase().match(/[a-z0-9]+/g) || [];
/** Are the letters of `a` in `b`, in order? */
const subsequence = (a: string, b: string): boolean => { let i = 0; for (const c of b) if (c === a[i]) i++; return i === a.length; };

/** Sessions whose name fits the words, best first. */
export function rankSessions<T extends SessionRow>(query: string, rows: T[], titleOf: (r: T) => string = (r) => String(r.name || r.title || "")): T[] {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const qs = squash(q), qw = wordsOf(q);
  const scored: [number, number, T][] = [];
  rows.forEach((r, i) => {
    const name = titleOf(r).trim().toLowerCase();
    if (!name) return;
    let score = 0;
    if (name === q) score = 4;
    else if (qs && squash(name) === qs) score = 3;
    else if (qw.length && qw.every((w) => wordsOf(name).includes(w))) score = 2;
    else if (qs && subsequence(qs, squash(name))) score = 1;
    if (score) scored.push([score, i, r]);
  });
  return scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((x) => x[2]);
}

export function parseCommand(input: string, world: { agents: { name: string }[]; sessions: SessionRow[]; titleOf?: (r: SessionRow) => string }): Command {
  const text = String(input || "").trim();
  let m = /^@(\S+)\s+([\s\S]+)$/.exec(text);
  if (m) {
    const agent = world.agents.find((a) => a.name.toLowerCase() === m![1].toLowerCase());
    if (agent) return { kind: "agent", agent: agent.name, text: m[2].trim() };
  }
  const bySession = (q: string) => rankSessions(q, world.sessions, world.titleOf);
  if ((m = /^(?:tell|ping|notify) me when (?:the )?(.+?)(?: thread)?(?: is)? (done|finishes|finished|asks)$/i.exec(text))) {
    const candidates = bySession(m[1]);
    if (candidates.length) return { kind: "watch", query: m[1], until: /asks/i.test(m[2]) ? "asks" : "finished", candidates };
  }
  if ((m = /^(?:tell|ask) (?:the )?(.+?)(?: thread)? to ([\s\S]+)$/i.exec(text))) {
    const candidates = bySession(m[1]);
    if (candidates.length) return { kind: "drive", query: m[1], text: m[2].trim(), candidates };
  }
  if ((m = /^(?:watch|monitor|track) (?:the )?(.+?)(?: thread)?(?: and tell me.*)?$/i.exec(text))) {
    const candidates = bySession(m[1]);
    if (candidates.length) return { kind: "watch", query: m[1], until: "either", candidates };
  }
  return { kind: "ask", text };
}

/** The line under the box: what Enter will do. `name` is the chosen session's name, for drive and watch. */
export function plan(c: Command, name: string, assistant: string): string {
  if (c.kind === "agent") return `Enter asks ${c.agent}.`;
  if (c.kind === "drive") return `Enter types into ${name}, then watches it.`;
  if (c.kind === "watch") return c.until === "asks" ? `Enter watches ${name} and tells you when it asks.`
    : c.until === "finished" ? `Enter watches ${name} and tells you when it is done.` : `Enter watches ${name}. You hear when it finishes or asks.`;
  return `Enter asks ${assistant}.`;
}

// ---- the prefixes: `p ` narrows to projects, `t ` to threads, `u ` to people. Strict word start (the letter, a space, then the words), so "park" never reads as `p ark`. ----

export type Prefixed = { prefix: "p" | "t" | "u"; scope: "projects" | "chats" | "people"; rest: string };
const SCOPE = { p: "projects", t: "chats", u: "people" } as const;
export function parsePrefix(raw: string): Prefixed | null {
  const m = /^([ptu])\s+(.*)$/is.exec(String(raw || "").replace(/^\s+/, ""));
  if (!m) return null;
  const prefix = m[1].toLowerCase() as "p" | "t" | "u";
  return { prefix, scope: SCOPE[prefix], rest: m[2].trim() };
}

// ---- the sessions: projects.catalog's (every session on the device, from its transcript) and threads.list's (the headless threads) merged. A thread's id is its session id, so one session is one row. ----

export type Session = { id: string; name: string; projects: string[]; project: string | null; agent: string | null; status: string | null; last: number; turns: number; asks: number; holder: string | null;
  human: boolean; cwd: string | null; live: boolean; source: string | null; machine: string | null };

/** Newest first. */
export function mergeSessions(sessions: any[] | null | undefined, threads: any[] | null | undefined): Session[] {
  const rows = new Map<string, Session>();
  for (const s of sessions || []) {
    if (!s || !s.id) continue;
    const projects: string[] = Array.isArray(s.projects) ? s.projects.filter(Boolean) : [];
    rows.set(s.id, { id: s.id, name: s.label || s.name || s.title || "", projects, project: projects[0] || null, agent: null, status: null, last: s.last || s.started || 0, turns: s.turns || 0, asks: 0,
      holder: null, human: !!s.human, cwd: s.cwd || null, live: false, source: s.source || null, machine: s.machine || null });
  }
  for (const t of threads || []) {
    if (!t || !t.id) continue;
    const had = rows.get(t.id);
    const projects = had ? [...had.projects] : [];
    if (t.project && !projects.includes(t.project)) projects.unshift(t.project);
    rows.set(t.id, { id: t.id, name: t.name || had?.name || "", projects, project: t.project || projects[0] || null, agent: t.agent || null, status: t.status || null,
      last: Math.max(t.last || t.started || 0, had?.last || 0), turns: Math.max(t.turns || 0, had?.turns || 0), asks: t.asks || 0, holder: t.holder || null, human: had ? had.human : !t.agent,
      cwd: t.cwd || had?.cwd || null, live: true, source: t.source || had?.source || null, machine: t.machine || had?.machine || null });
  }
  return [...rows.values()].sort((a, b) => b.last - a.last);
}
export const title = (r: { id: string; name?: string | null }): string => r.name || r.id.slice(0, 8);
