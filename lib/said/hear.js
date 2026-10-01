// @ts-check
// hear: what the person's own turn asked for, as the intents to record (P17, "asking is approving").
//
// This is the one place the recorders meet the facts they need: the thread's project and PR, the
// project's real roster, the cards shown in this thread. The switchboard calls it when a person's
// turn arrives and records what comes back; nothing here writes, so it runs in a test with a fake
// `call`. Every recorder only ever sees the person's unquoted typed words (pasted spans are cut out
// first), and a source that fails or does not exist records nothing.
//
//   pr        prIntents, the thread's PR from github.session.pr (used only when it is exactly one) and
//             github.act.target for the key
//   team      teamIntents against team.roster {project}: live roles (retire, fill, team.add), duties
//             with their own hashes, the agents that may fill a role
//   watchers  watchersIntents against watchers.shown {thread}: the cards shown in this thread with the
//             hash each carried WHEN SHOWN (never a fresh watchers.card or list), kinds from watchers.preset,
//             and shownTurnsAgo counted from this thread's own turns, never defaulted
//   setting   settingIntents against settings.schema's keys, read when the turn is heard: the key, the
//             canonical value and the level (account, or this project) go into the intent

import { prIntents } from "./pr.js";
import { teamIntents } from "./team.js";
import { watchersIntents } from "./watchers.js";
import { settingIntents } from "./setting.js";

const PR = /\b(?:prs?|pull[\s-]+requests?|merge|merging)\b/i;
const TEAM = /\b(?:retire|retiring|duty|duties|fill|staff|role|teammate|teammates)\b/i;
const SETTING = /\b(?:turn|use|set|enable|disable|switch|change|make|stop|start|activate|deactivate)\b/i;
const WATCH = /\b(?:watch|watchers?|monitor|eye\s+on|turn|switch|enable|activate|start)\b/i;

/**
 * @param {{ text: string, pasted?: string[], project?: string|null, thread: string,
 *   call: (tool: string, input?: any) => Promise<any>,
 *   turnsSince: (at: number) => number }} a
 *   turnsSince: how many of this thread's assistant turns have ended since `at` (ms)
 * @returns {Promise<any[]>} intents, each with kind, channel, to, what, when
 */
export async function heardActs({ text, pasted = [], project, thread, call, turnsSince }) {
  if (!project) return [];
  const pr = PR.test(text), team = TEAM.test(text), watch = WATCH.test(text), setting = SETTING.test(text);
  if (!pr && !team && !watch && !setting) return [];
  let typed = String(text);
  for (const span of pasted || []) if (typeof span === "string" && span) typed = typed.split(span).join(" ");
  /** @type {any[]} */ let intents = [];

  if (pr) {
    const where = /** @type {{ project: string, session: string, pr?: number }} */ ({ project, session: thread });
    const cur = await call("github.session.pr", { project, session: thread }).catch(() => null);
    const prs = cur && !cur.error && cur.data && Array.isArray(cur.data.prs) ? cur.data.prs : [];
    if (prs.length === 1 && Number.isInteger(Number(prs[0]))) where.pr = Number(prs[0]);
    const target = async (tool, input) => {
      const r = await call("github.act.target", { tool, input }).catch(() => null);
      return r && !r.error && r.data && Array.isArray(r.data.to) ? r.data.to : null;
    };
    intents = intents.concat((await prIntents(typed, where, target).catch(() => ({ intents: [] }))).intents);
  }

  if (team) {
    // What the project really has: the words name none of it.
    const roster = await call("team.roster", { project }).catch(() => null);
    const agents = await call("agents.list", {}).catch(() => null);
    if (roster && !roster.error && roster.data) {
      const rd = roster.data;
      const fillers = agents && !agents.error && Array.isArray(agents.data)
        ? agents.data.filter(a => a && a.kind !== "assistant" && (a.projects === "*" || (Array.isArray(a.projects) && (a.projects.includes("*") || a.projects.includes(project))))).map(a => String(a.name)) : [];
      intents = intents.concat(teamIntents(typed, { project, roles: Array.isArray(rd.roles) ? rd.roles : [], agents: fillers, duties: Array.isArray(rd.duties) ? rd.duties : [] }).intents);
    }
  }

  if (watch) {
    // Only the cards shown in THIS thread, with the hash as shown; no such tool, or none shown, records
    // only what needs no card (a preset). shownTurnsAgo is the ended assistant turns since the card
    // (the turn that showed it is turn 0), and a card whose time is unknown has none: no pronoun.
    const shown = await call("watchers.shown", { thread }).catch(() => null);
    const d = shown && !shown.error && shown.data ? shown.data : null;
    if (d) {
      const cards = (Array.isArray(d.watchers) ? d.watchers : []).filter(c => c && (!c.project || c.project === project)).map(c => ({
        name: c.name, hash: c.hash, title: c.title, state: c.state,
        ...(Number.isFinite(c.at) ? { shownTurnsAgo: Math.max(0, turnsSince(Number(c.at)) - 1) } : {}),
      }));
      intents = intents.concat(watchersIntents(typed, { project, kinds: Array.isArray(d.kinds) ? d.kinds : [], watchers: cards }).intents);
    }
  }
  if (setting) {
    // The keys, types, choices and levels as the settings module declares them now; none, or no module, records nothing.
    const schema = await call("settings.schema", {}).catch(() => null);
    const keys = schema && !schema.error && schema.data && Array.isArray(schema.data.keys) ? schema.data.keys : [];
    if (keys.length) intents = intents.concat(settingIntents(typed, keys, { project }).intents);
  }
  return intents;
}
