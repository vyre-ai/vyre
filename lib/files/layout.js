// @ts-check
// files/layout: the one place that says where everything lives under a Space's files root. Pure functions, no state, no disk. Every writer asks here for its folder and none builds a path by hand.
//
//   Projects/<project record id>/  files/  chat/<chat>/  made/<chat>/     (the Drive's own folder, sealed and guarded by kernel/core/folders.js and kernel/storage/sealed-drive.js)
//   agents/<agent id>/             instructions/  context/  memory/  work/
//   objects/<object>/<record id>/  a record's attachments
//   templates/<template id>/       flows/<flow id>/      space/  (the Space's own documents)
//
// Folders are named by an id that never changes, so a rename touches no path; the display name is data in the record. `Projects` keeps its capital P and its record id: that is the folder every
// existing project, its guard and its seal already use. The other roots are new and lower case.

import { SLUG_RE } from "../project-id.js";

export const ROOTS = Object.freeze({ projects: "Projects", agents: "agents", objects: "objects", templates: "templates", flows: "flows", space: "space" });
export const AGENT_PARTS = Object.freeze(["instructions", "context", "memory", "work"]);

/** The same shape member-files.js already requires of a folder's name. */
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

/** @param {unknown} v @returns {string} */
function id(v) {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new Error(`files layout: not an id: ${JSON.stringify(v)}`);
  return v;
}

/** @param {unknown} v @returns {string} */
function object(v) {
  if (typeof v !== "string" || v.length > 64 || !SLUG_RE.test(v)) throw new Error(`files layout: not an object name: ${JSON.stringify(v)}`);
  return v;
}

export const projectDir = (/** @type {string} */ project) => `${ROOTS.projects}/${id(project)}`;
export const projectFiles = (/** @type {string} */ project) => `${projectDir(project)}/files`;
export const projectChat = (/** @type {string} */ project, /** @type {string} */ chat) => `${projectDir(project)}/chat/${id(chat)}`;
export const projectMade = (/** @type {string} */ project, /** @type {string} */ chat) => `${projectDir(project)}/made/${id(chat)}`;

export const agentDir = (/** @type {string} */ agent) => `${ROOTS.agents}/${id(agent)}`;
/** @param {string} agent @param {string} part one of AGENT_PARTS */
export function agentPart(agent, part) {
  if (!AGENT_PARTS.includes(part)) throw new Error(`files layout: not an agent part: ${JSON.stringify(part)}`);
  return `${agentDir(agent)}/${part}`;
}

export const objectDir = (/** @type {string} */ obj) => `${ROOTS.objects}/${object(obj)}`;
export const recordDir = (/** @type {string} */ obj, /** @type {string} */ record) => `${objectDir(obj)}/${id(record)}`;

export const templateDir = (/** @type {string} */ template) => `${ROOTS.templates}/${id(template)}`;
export const flowDir = (/** @type {string} */ flow) => `${ROOTS.flows}/${id(flow)}`;
export const spaceDocs = () => ROOTS.space;

/**
 * What a path under the files root is, or null when it is none of the layout's places (or tries to leave one).
 * @param {string} p @returns {null | { kind: string, id?: string, object?: string, rest: string }}
 */
export function whereIs(p) {
  const s = String(p).split("/");
  if (s.some(x => x === "" || x === "." || x === "..")) return null;
  const [root, a, b, ...tail] = s;
  const ok = (/** @type {string|undefined} */ v) => typeof v === "string" && ID_RE.test(v);
  const rest = (/** @type {string[]} */ ...parts) => parts.filter(x => x !== undefined).join("/");
  switch (root) {
    case ROOTS.projects: return ok(a) ? { kind: "project", id: a, rest: rest(b, ...tail) } : null;
    case ROOTS.agents: return ok(a) ? { kind: "agent", id: a, rest: rest(b, ...tail) } : null;
    case ROOTS.templates: return ok(a) ? { kind: "template", id: a, rest: rest(b, ...tail) } : null;
    case ROOTS.flows: return ok(a) ? { kind: "flow", id: a, rest: rest(b, ...tail) } : null;
    case ROOTS.objects: return a && SLUG_RE.test(a) && ok(b) ? { kind: "record", object: a, id: /** @type {string} */ (b), rest: tail.join("/") } : null;
    case ROOTS.space: return { kind: "space", rest: rest(a, b, ...tail) };
    default: return null;
  }
}
