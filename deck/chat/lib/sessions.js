// @ts-check
// Chat's session list, from two sources: projects.catalog (every Claude Code session on this
// device, from its transcript, with the projects it belongs to) and threads.list (the headless
// threads the Switchboard runs). A Switchboard thread's id is its Claude Code session id, so one
// session is one row: the Switchboard knows what is live about it (status, open questions, who
// types), the catalogue knows the rest. Pure functions, so they can be tested without a page.

/**
 * @typedef {{ id: string, name: string, projects: string[], project: string|null, agent: string|null,
 *   status: string|null, last: number, turns: number, asks: number, holder: string|null, human: boolean,
 *   cwd: string|null, live: boolean }} Row
 * live: the Switchboard has a record of it, so threads.get works and thread.* events flow.
 */

/**
 * @param {any[]} sessions projects.catalog's sessions
 * @param {any[]} threads threads.list
 * @returns {Row[]} newest first
 */
export function mergeSessions(sessions, threads) {
  /** @type {Map<string, Row>} */
  const rows = new Map();
  for (const s of sessions || []) {
    if (!s || !s.id) continue;
    const projects = Array.isArray(s.projects) ? s.projects.filter(Boolean) : [];
    rows.set(s.id, { id: s.id, name: s.label || s.name || s.title || "", projects, project: projects[0] || null, agent: null,
      status: null, last: s.last || s.started || 0, turns: s.turns || 0, asks: 0, holder: null, human: !!s.human, cwd: s.cwd || null, live: false });
  }
  for (const t of threads || []) {
    if (!t || !t.id) continue;
    const had = rows.get(t.id);
    const projects = had ? [...had.projects] : [];
    if (t.project && !projects.includes(t.project)) projects.unshift(t.project);
    rows.set(t.id, { id: t.id, name: t.name || had?.name || "", projects, project: t.project || projects[0] || null, agent: t.agent || null,
      status: t.status || null, last: Math.max(t.last || t.started || 0, had?.last || 0), turns: Math.max(t.turns || 0, had?.turns || 0),
      asks: t.asks || 0, holder: t.holder || null, human: had ? had.human : !t.agent, cwd: t.cwd || had?.cwd || null, live: true });
  }
  return [...rows.values()].sort((a, b) => b.last - a.last);
}

/**
 * The rail's groups: each project's sessions (a session in two projects is under both), the
 * sessions in no project, and the agents' threads.
 * @param {Row[]} rows
 * @param {{ slug: string }[]} projects
 * @param {number} [loose] how many sessions in no project to keep, newest first
 */
export function groupSessions(rows, projects, loose = 50) {
  /** @type {Map<string, Row[]>} */
  const byProject = new Map(projects.map(p => [p.slug, []]));
  /** @type {Row[]} */ const noProject = [];
  /** @type {Map<string, Row[]>} */ const byAgent = new Map();
  for (const r of rows) {
    const mine = r.projects.filter(p => byProject.has(p));
    for (const p of mine) /** @type {Row[]} */ (byProject.get(p)).push(r);
    // Sessions in no project: the ones a person started, and the Switchboard's own. A subagent's
    // or a watcher's headless run in no project would only be noise here.
    if (!mine.length && !r.projects.length && (r.human || r.live) && noProject.length < loose) noProject.push(r);
    if (r.agent) { if (!byAgent.has(r.agent)) byAgent.set(r.agent, []); /** @type {Row[]} */ (byAgent.get(r.agent)).push(r); }
  }
  return { byProject, noProject, byAgent };
}

/** @param {Row} r */
export const title = r => r.name || r.id.slice(0, 8);
