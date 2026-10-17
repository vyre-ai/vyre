// share-model: the rules of the Vault's share sheet, without a screen (the owner's words: Fill in, Read, Edit and rotate). Which levels each grantee may hold, which agents a member may offer, what is left
// to add, and the plain notes. The kernel decides what is allowed (kernel/seal/uses.js); this only keeps the screen from offering what the kernel would refuse.

/** The kernel's levels, in order, with the owner's words. use is Fill in, reveal is Read, edit is Edit and rotate. */
export const LEVELS = /** @type {const} */ ([["use", "Fill in"], ["reveal", "Read"], ["edit", "Edit and rotate"]]);
export const levelWord = (/** @type {string} */ l) => (LEVELS.find(x => x[0] === l) || [l, l])[1];
export const LEVEL_HELP = { use: "Uses it, never sees it", reveal: "Also sees the value", edit: "Also changes it, rotates the key" };

/** The levels one grantee may hold. An agent, and anyone on an app connection, only Fill in. @param {"person"|"group"|"agent"} kind @param {{ connection?: boolean, levels?: string[] }} [o] */
export function allowedLevels(kind, { connection = false, levels } = {}) {
  const all = LEVELS.map(l => l[0]);
  if (kind === "agent" || connection) return ["use"];
  // `levels` is what this box can honour for a person or a group (the real tools offer only what works for members; the sample world offers all three).
  return levels && levels.length ? all.filter(l => levels.includes(l)) : all;
}

/** The agents a member may share with: those she may instruct. No member named (the owner's view) means all. An agent with no instructor list is offered. @param {any[]} agents @param {string | null} me */
export function offeredAgents(agents, me) {
  return agents.filter(a => !me || !Array.isArray(a.instructors) || a.instructors.includes(me));
}

const has = (/** @type {any[]} */ shares) => new Set(shares.map(s => s.id));
/** What is left to add, by section. @param {{ people: any[], groups: any[], agents: any[], shares: any[], me: string | null, q?: string, everyone?: boolean }} d */
export function candidates({ people, groups, agents, shares, me, q = "", everyone = false }) {
  const held = has(shares), want = q.trim().toLowerCase();
  const keep = (/** @type {any[]} */ xs) => xs.filter(x => !held.has(x.id) && (!want || String(x.name).toLowerCase().includes(want)));
  return {
    people: keep(people),
    groups: keep([...groups, ...(everyone ? [{ id: "everyone", kind: "group", name: "Everyone in the Space", people: [], agents: [] }] : [])]),
    agents: keep(offeredAgents(agents, me)),
  };
}

/** Joins names as "A", "A and B", "A, B and C". @param {string[]} xs */
export const joinNames = xs => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const first = (/** @type {string} */ n) => String(n).split(" ")[0];

/** The notes under a login's share list when an agent holds it: that the agent may use it while she is away, and who else can instruct the agent. @param {any[]} shares @param {any[]} agents @param {string | null} me */
export function loginNotes(shares, agents, me) {
  const held = shares.map(s => agents.find(a => a.id === s.id)).filter(Boolean);
  if (!held.length) return [];
  const out = ["Your agent can use this login while you're away."];
  for (const a of held) {
    const others = (a.instructors || []).filter((/** @type {string} */ x) => x !== me).map((/** @type {string} */ x) => a.names && a.names[x] ? first(a.names[x]) : cap(x));
    if (others.length) out.push(`${joinNames(others)} can also instruct ${a.name}, so they can ask it to use this login.`);
  }
  return out;
}
const cap = (/** @type {string} */ s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The note on an app connection: which agents hold it, and what still waits. @param {string} app @param {any[]} shares @param {any[]} agents */
export function connectionNote(app, shares, agents) {
  const names = shares.map(s => agents.find(a => a.id === s.id)).filter(Boolean).map(a => a.name);
  return `${names.length ? joinNames(names) : "An agent you share it with"} can act in ${app} as you, and only fill in. Anything that sends or changes data still waits for your yes.`;
}

const plural = (/** @type {number} */ n, /** @type {string} */ w) => `${n} ${w}`;
/** A group's one line. @param {{ people: string[], agents: string[] }} g */
export function groupSub(g) {
  const p = g.people.length, a = g.agents.length;
  if (!p && !a) return "Nobody yet";
  return [p ? (p === 1 ? "1 person" : plural(p, "people")) : "", a ? (a === 1 ? "1 agent" : plural(a, "agents")) : ""].filter(Boolean).join(", ");
}

/** A name for any id the sheet shows. @param {string} id @param {{ people: any[], groups: any[], agents: any[] }} d */
export function nameOf(id, { people, groups, agents }) {
  if (id === "everyone") return "Everyone in the Space";
  const w = [...people, ...groups, ...agents].find(x => x.id === id);
  return w ? w.name : id;
}
