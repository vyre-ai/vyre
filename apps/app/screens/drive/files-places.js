// @ts-check
// The Files screen's places and what a selected file says about itself, as plain data. Places: All files, Recent, Shared with me, the projects the person can see, and the Sites section. A file's
// details are only what is known (who put it there, where it is, how many versions, where it is used, who can see it): a line with nothing behind it is not drawn. The Quick Look is a small state
// that Space or a double click opens, the arrows move through the shown files, and Esc closes.

import { agentWords } from "../../src/state/agent-name.js";

/** @typedef {{ id: string, label: string, kind: "all" | "recent" | "shared" | "with" | "project" | "agent" | "site" | "newsite", live?: boolean, draft?: boolean, path?: string }} Place */

/**
 * The left column, in groups. A group with nothing in it is left out (no Projects heading over an empty list). Projects and Agents are the ones `files.places` returned for this person, each with the
 * Drive folder it opens; an agent is named as a person reads it ("Engineer", never "engineer"). Sites is half built here (its own page is Sites), so it shows only with Labs on, where "New site" is always there.
 * @param {{ projects?: readonly { name: string, path: string }[], agents?: readonly { name: string, path: string }[], sites?: readonly { id: string, name: string, live?: boolean }[], labs?: boolean }} [o]
 * @returns {{ id: string, heading: string | null, places: Place[] }[]}
 */
export function placeGroups(o = {}) {
  const folders = (/** @type {readonly any[] | undefined} */ xs, /** @type {"project" | "agent"} */ kind) => (xs || []).filter((x) => x && x.name && typeof x.path === "string" && x.path).map((x) => /** @type {Place} */ ({ id: `${kind}:${x.path}`, label: kind === "agent" ? agentWords(x.name) : x.name, kind, path: x.path }));
  const projects = folders(o.projects, "project"), agents = folders(o.agents, "agent");
  const sites = (o.sites || []).filter((s) => s && s.id && s.name);
  return [
    { id: "top", heading: null, places: [{ id: "all", label: "All files", kind: "all" }, { id: "recent", label: "Recent", kind: "recent" }, { id: "shared-links", label: "Your shared links", kind: "shared" }, { id: "shared-with-me", label: "Shared with me", kind: "with" }] },
    ...(projects.length ? [{ id: "projects", heading: "Projects", places: projects }] : []),
    ...(agents.length ? [{ id: "agents", heading: "Agents", places: agents }] : []),
    ...(!o.labs ? [] : [{ id: "sites", heading: "Sites", places: [...sites.map((s) => /** @type {Place} */ ({ id: `site:${s.id}`, label: s.name, kind: "site", ...(s.live ? { live: true } : { draft: true }) })), /** @type {Place} */ ({ id: "new-site", label: "New site", kind: "newsite" })] }]),
  ];
}

/**
 * The Files place that opens an agent's own folder, for a link such as /u/files?agent=engineer: the agent's id (or its name as shown) matched to the folder files.places gave, as the open place
 * ("space:<path>"). null when that agent has no folder this person can see, so the page stays where it was.
 * @param {readonly { name: string, path: string }[] | undefined} agents @param {string | undefined | null} who
 * @returns {string | null}
 */
export function agentPlace(agents, who) {
  const w = String(who ?? "").trim().toLowerCase();
  if (!w) return null;
  const hit = (agents || []).find((a) => a && typeof a.path === "string" && a.path && (String(a.name).toLowerCase() === w || agentWords(a.name).toLowerCase() === w));
  return hit ? `space:${hit.path}` : null;
}

/** The files changed most recently, newest first: folders are not "recent". @template {{ dir: boolean, modified: number }} T @param {readonly T[]} rows @param {number} [n] @returns {T[]} */
export const recentOf = (rows, n = 30) => rows.filter((r) => !r.dir && r.modified > 0).sort((a, b) => b.modified - a.modified).slice(0, n);

/**
 * The lines of a selected file's preview column. `ctx` carries what the screen could look up: the place's name, the versions, where the file is used, who can see it, a friendly time. Only known lines come back.
 * @param {{ dir: boolean, by?: string, modified: number, ver?: number }} row
 * @param {{ where?: string, usedIn?: readonly string[], whoCanSee?: string, when?: (at: number) => string, versions?: number }} [ctx]
 * @returns {{ k: string, v: string }[]}
 */
export function detailLines(row, ctx = {}) {
  const out = [];
  const when = ctx.when ? ctx.when(row.modified) : "";
  const from = [row.by, when].filter(Boolean).join(", ");
  if (from) out.push({ k: "From", v: from });
  if (ctx.where) out.push({ k: "In", v: ctx.where });
  const n = ctx.versions ?? row.ver;
  if (!row.dir && typeof n === "number" && n > 1) out.push({ k: "Versions", v: String(n) });
  if (ctx.usedIn && ctx.usedIn.length) out.push({ k: "Used in", v: ctx.usedIn.join(", ") });
  if (ctx.whoCanSee) out.push({ k: "Who can see", v: ctx.whoCanSee });
  return out;
}

/** @typedef {{ open: string | null }} QuickLook */
/**
 * The Quick Look: Space on the selected file opens it (Space again closes), a double click opens it, Esc closes, the arrows move to the next or previous shown file. A folder never opens one.
 * @param {QuickLook} s @param {{ type: "space" | "open" | "close" | "step", key?: string, by?: number }} a @param {readonly { key: string, dir: boolean }[]} shown @param {string | null} selected
 * @returns {QuickLook}
 */
export function quickLook(s, a, shown, selected) {
  const files = shown.filter((r) => !r.dir);
  const has = (/** @type {string | null | undefined} */ k) => Boolean(k) && files.some((r) => r.key === k);
  if (a.type === "close") return { open: null };
  if (a.type === "space") return s.open ? { open: null } : has(selected) ? { open: selected } : s;
  if (a.type === "open") return has(a.key) ? { open: /** @type {string} */ (a.key) } : s;
  if (a.type === "step") {
    if (!s.open || !files.length) return s;
    const i = files.findIndex((r) => r.key === s.open);
    if (i < 0) return { open: null };
    const j = Math.min(files.length - 1, Math.max(0, i + (a.by || 0)));
    return { open: files[j].key };
  }
  return s;
}

/** The agent folder a Space path is in (agents/<agent id>, or anything under it), or null. Its files are kept on the agent's computer (core/files/agent-folder.js). @param {string} path @returns {string | null} */
export function agentFolderOf(path) {
  const m = /^agents\/([A-Za-z0-9_][A-Za-z0-9_-]{0,63})(?:\/|$)/.exec(String(path || ""));
  return m ? `agents/${m[1]}` : null;
}

/** The quiet note while the agent's computer starts. */
export const OPENING_COMPUTER = "Opening this agent's computer…";

/**
 * What an open agent folder lets the person do, from files.agent.open's answer and the place's own abilities: the files are on the computer, which keeps no versions and makes no links, and
 * only Can edit changes them. Anything else is not offered (a button the server would refuse is never shown).
 * @template {{ upload: boolean, versions: boolean, move: boolean, remove: boolean, download: boolean, share: boolean, edit: boolean }} A
 * @param {A} base @param {string | undefined} can @returns {A}
 */
export function agentAbilities(base, can) {
  const change = can === "edit";
  return { ...base, versions: false, share: false, upload: change, move: change, remove: change, edit: change, download: true };
}

/**
 * One step of opening an agent's folder: files.agent.open answers "waking" until the computer is up (try again after `retryMs`), or "open" with the note to show and the level.
 * @param {{ state?: string, note?: string, can?: string } | null | undefined} r
 * @returns {{ ready: boolean, retryMs: number, note: string, can: string }}
 */
export function openStep(r) {
  if (r && r.state === "open") return { ready: true, retryMs: 0, note: String(r.note || ""), can: String(r.can || "use") };
  return { ready: false, retryMs: 3000, note: String((r && r.note) || ""), can: String((r && r.can) || "use") };
}

/**
 * The right-click menu for rows in an agent's folder: no link or version history (the computer keeps neither), and nothing that changes a file unless the person has Can edit.
 * @template {{ id: string }} I @param {I[][]} groups @param {string | undefined} can @returns {I[][]}
 */
export function agentMenu(groups, can) {
  const never = new Set(["share", "versions"]), change = new Set(["move", "rename", "duplicate", "delete"]);
  return groups.map((g) => g.filter((i) => !never.has(i.id) && (can === "edit" || !change.has(i.id)))).filter((g) => g.length);
}
