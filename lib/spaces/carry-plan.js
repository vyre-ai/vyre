// @ts-check
// lib/spaces/carry-plan: what "move my Home to my Cloud" carries, in one plan the person reads before the one yes (G16, team/0.3.3/GAPS-0.3.3.md). The move itself is done piece by piece by the
// owners of each kind (projects with their records, files, chats and memory: core/work/project-move.js; Flows, assistants and the Vault: below); this file is the one place that says WHAT moves,
// counts it, hashes it (the hash is what the person approves: a plan that changed since is refused) and puts it in plain words. Pure: the lists come in as arguments.
//
// The rules the plan writes into the words, so the person is never surprised:
//   - A Flow arrives as a DRAFT. A turned-on Flow carries no standing approval across: the person says yes to it again in the Cloud, one by one. Nothing runs there until they do.
//   - A Vault item is sealed again to the Cloud's own key as it goes (the plain value never leaves the sealing process); an item that cannot be re-sealed is a blocker, not a silent skip.
//   - Assistants arrive without their sessions' history (their chats move with their projects) and without any grant: grants are the Cloud's to make.
import crypto from "node:crypto";

const canonical = (/** @type {any} */ v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const bytesWords = (/** @type {number} */ b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${Math.round(b / 1024 ** 2)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} bytes`);

/**
 * @typedef {{ id: string, name?: string, files?: number, bytes?: number, records?: number, chats?: number }} ProjectRow
 * @typedef {{ id: string, name?: string, on?: boolean, versions?: number }} FlowRow            on: turned on (approved) in the Home
 * @typedef {{ name: string, role?: string }} AgentRow
 * @typedef {{ name: string, kind?: string, resealable?: boolean }} VaultRow                        resealable false: the sealing process cannot carry it
 * @param {{ from?: string, to?: string, projects?: ProjectRow[], flows?: FlowRow[], agents?: AgentRow[], vault?: VaultRow[] }} o
 */
export function carryPlan({ from = "", to = "", projects = [], flows = [], agents = [], vault = [] } = {}) {
  const files = projects.reduce((n, p) => n + (p.files || 0), 0), bytes = projects.reduce((n, p) => n + (p.bytes || 0), 0);
  const records = projects.reduce((n, p) => n + (p.records || 0), 0), chats = projects.reduce((n, p) => n + (p.chats || 0), 0);
  const reapprove = flows.filter(f => f.on).map(f => f.name || f.id).sort();
  const stuck = vault.filter(v => v.resealable === false).map(v => v.name).sort();
  /** @type {string[]} */ const blockers = [];
  if (stuck.length) blockers.push(`${plural(stuck.length, "Vault item")} cannot be sealed again for the Cloud (${stuck.slice(0, 3).join(", ")}${stuck.length > 3 ? ", ..." : ""}): remove or re-enter ${stuck.length === 1 ? "it" : "them"} first`);
  if (!to) blockers.push("pick where it goes: the Cloud to move to");
  const counts = { projects: projects.length, files, bytes, records, chats, flows: flows.length, flowsOn: reapprove.length, agents: agents.length, vault: vault.length };
  /** @type {string[]} */ const lines = [];
  lines.push(`${plural(counts.projects, "project")}, with ${plural(files, "file")} (${bytesWords(bytes)}), ${plural(records, "record")} and ${plural(chats, "chat")}`);
  lines.push(counts.flows ? `${plural(counts.flows, "Flow")}${reapprove.length ? `: ${reapprove.length} ${reapprove.length === 1 ? "was" : "were"} turned on here, and you say yes to ${reapprove.length === 1 ? "it" : "each"} again in the Cloud (nothing runs there until you do)` : ", all drafts"}` : "no Flows");
  lines.push(counts.agents ? `${plural(counts.agents, "assistant")}, without grants (the Cloud makes its own)` : "no assistants");
  lines.push(counts.vault ? `${plural(counts.vault, "Vault item")}, sealed again to the Cloud's key as they go` : "no Vault items");
  const hash = crypto.createHash("sha256").update(canonical({ from, to, projects: projects.map(p => p.id).sort(), flows: flows.map(f => `${f.id}:${f.versions || 1}:${f.on ? 1 : 0}`).sort(), agents: agents.map(a => a.name).sort(), vault: vault.map(v => v.name).sort(), counts })).digest("hex");
  return { from, to, counts, lines, reapprove, blockers, ok: blockers.length === 0, hash };
}

/** Is the plan the person approved still the plan? @param {{ hash: string }} approved @param {{ hash: string }} now */
export const planStands = (approved, now) => Boolean(approved && now && approved.hash === now.hash);
