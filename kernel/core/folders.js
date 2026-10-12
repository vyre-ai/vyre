// @ts-check
// A chat's folders (`Projects/<project id>/chat|made/<chat id>/`) are its participants' only (CONTRACT-one-chat.md section 6). A Drive decision there is allowed only to a participant, or an assistant
// the chat lists acting for one; an owner, admin or anyone holding the exact path gets not_found. A module's service chain may write them and never read them. One more way in: a participant's share
// of ONE file (`oracle.sharedRead`), which lets a member read that file and nothing else.
import { isChain } from "./chain.js";

const FOLDER = /^Projects\/([^/]+)\/(chat|made)\/([^/]+)(?:\/(.*))?$/;

/** @param {unknown} resource @param {string} space @returns {{ chat: string, rest: string | null } | null} */
export function chatFolderOf(resource, space) {
  const p = `vyre://${space}/file/`;
  if (typeof resource !== "string" || !resource.startsWith(p)) return null;
  let path = resource.slice(p.length);
  try { path = decodeURIComponent(path); } catch { return null; }
  const m = FOLDER.exec(path.replace(/\/{2,}/g, "/"));
  return m ? { chat: m[3], rest: m[4] === undefined ? null : m[4] } : null;
}

const FILES = /^Projects\/([^/]+)\/files(?:\/.*)?$/;
/** A project's own file area (`Projects/<project id>/files/`): the project id, or null. @param {unknown} resource @param {string} space */
export function projectFilesOf(resource, space) {
  const p = `vyre://${space}/file/`;
  let path = typeof resource === "string" && resource.startsWith(p) ? resource.slice(p.length) : "";
  try { path = decodeURIComponent(path); } catch { return null; }
  const m = FILES.exec(path.replace(/\/{2,}/g, "/"));
  return m ? m[1] : null;
}

/** The project a call is about: a specific project's reach, or a record that belongs to one (its kernel attribute `project`). @param {any} input @param {string} space @param {{ projectOf?: (resource: string) => string | null }} oracle */
function projectReachOf(input, space, oracle) {
  const m = new RegExp(`^vyre://${space}/project/([A-Za-z0-9_-]{1,64})$`).exec(String(input.resource));
  if (m) return m[1];
  const p = input.action.startsWith("records.") && oracle.projectOf ? oracle.projectOf(String(input.resource)) : null;
  return typeof p === "string" && p ? p.replace(/^.*\//, "") : null;
}

/** @param {any} base @param {string} space @param {{ projectOf?: (resource: string) => string | null, noteReach?: (chain: any, data: any, resource: string) => void, chatHas: (p: string, c: string) => boolean, chatAssistants: (c: string) => string[] | null, projectViewer?: (person: string, project: string) => Promise<boolean>, sharedRead: (r: string, p: string) => Promise<boolean> }} oracle */
export function folderGuard(base, space, oracle) {
  const deny = (/** @type {any} */ d) => Object.freeze({ ...d, effect: "deny", reason: "not_found", obligations: Object.freeze([]) });
  return Object.create(base, { authorize: { value: async (/** @type {any} */ input) => {
    const d = await base.authorize(input), where = chatFolderOf(input && input.resource, space), project = oracle.projectHas ? projectFilesOf(input && input.resource, space) : null;
    const hops = isChain(input.chain) ? input.chain.hops : [];
    // A project's reach and its records (and so its memory and chats) are an agent's only while it is a teammate with a task there, as its files are (G22): a grant of its own opens nothing more.
    if (d.effect !== "deny" && oracle.projectAgent && typeof input.action === "string" && (input.action === "project.reach" || input.action.startsWith("records."))) {
      const agent = hops.slice(1).find((/** @type {any} */ h) => h.actor.kind === "agent"), at = projectReachOf(input, space, oracle);
      if (agent && at && !(await oracle.projectAgent(agent.actor.id, at))) return deny(d);
      // every allowed read by an agent is in the log with its chain; a read that cannot be logged is not made
      if (agent && at && d.effect === "allow") { try { oracle.noteReach?.(input.chain, { project: at, agent: agent.actor.id, action: input.action }, input.resource); } catch { return deny(d); } }
    }
    // a viewer (seat level, lib/seat-levels.js) reads a project and writes nothing in it: not its files, and not a record filed under it (a create is judged in ownership.js mayAttrs); gate.js says it in words
    const writes = typeof input.action === "string" && /^(drive\.(write|restore|delete)|records\.(update|remove|restore))$/.test(input.action), me = hops[0] && hops[0].actor.kind === "person" ? hops[0].actor.id : null;
    if (d.effect !== "deny" && writes && me && oracle.projectViewer) { const at = projectFilesOf(input.resource, space) || projectReachOf(input, space, oracle); if (at && await oracle.projectViewer(me, at)) return Object.freeze({ ...deny(d), reason: "read_only" }); }
    if ((!where && !project) || typeof input.action !== "string" || !input.action.startsWith("drive.")) return d;
    if (hops.length && hops[0].actor.kind === "service") return input.action === "drive.write" ? d : deny(d);
    const person = hops[0] && hops[0].actor.kind === "person" ? hops[0].actor : null, agents = hops.slice(1).filter((/** @type {any} */ h) => h.actor.kind === "agent").map((/** @type {any} */ h) => h.actor);
    const shape = Boolean(person) && hops.slice(1).every((/** @type {any} */ h) => h.actor.kind === "agent" || h.actor.kind === "service") && agents.length <= 1;
    // a project's files are its members' only, their default assistant's, and a teammate's while it works a task there (the adapter in gateway/project-members.js); an owner or admin who is not a member gets not_found
    let ok = project ? Boolean(shape && person && await oracle.projectHas?.(person.id, project)) : shape && person && oracle.chatHas(person.id, where.chat);
    if (ok && agents.length) ok = project ? Boolean(await oracle.projectAgent?.(agents[0].id, project)) : Boolean((a => a && a.includes(agents[0].id))(oracle.chatAssistants(where.chat)));
    if (!ok && where && shape && !agents.length && where.rest !== null && input.action === "drive.read" && await oracle.sharedRead(input.resource, person.id)) ok = true;
    if (!ok) return deny(d);
    // a participant reads and writes the chat's own files with no grant of their own (a member's role has no Drive actions); restore, delete and backups stay the base's
    if (d.effect !== "allow" && (input.action === "drive.read" || input.action === "drive.write")) return Object.freeze({ ...d, effect: "allow", reason: "chat_participant", obligations: Object.freeze(d.obligations.filter((/** @type {any} */ o) => !(o.type === "audit" && o.class === "deny"))) });
    return d;
  } } });
}
