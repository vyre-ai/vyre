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

/** @param {any} base @param {string} space @param {{ chatHas: (p: string, c: string) => boolean, chatAssistants: (c: string) => string[] | null, sharedRead: (r: string, p: string) => Promise<boolean> }} oracle */
export function folderGuard(base, space, oracle) {
  const deny = (/** @type {any} */ d) => Object.freeze({ ...d, effect: "deny", reason: "not_found", obligations: Object.freeze([]) });
  return Object.create(base, { authorize: { value: async (/** @type {any} */ input) => {
    const d = await base.authorize(input), where = chatFolderOf(input && input.resource, space);
    if (!where || typeof input.action !== "string" || !input.action.startsWith("drive.")) return d;
    const hops = isChain(input.chain) ? input.chain.hops : [];
    if (hops.length && hops[0].actor.kind === "service") return input.action === "drive.write" ? d : deny(d);
    const person = hops[0] && hops[0].actor.kind === "person" ? hops[0].actor : null, agents = hops.slice(1).filter((/** @type {any} */ h) => h.actor.kind === "agent").map((/** @type {any} */ h) => h.actor);
    const shape = Boolean(person) && hops.slice(1).every((/** @type {any} */ h) => h.actor.kind === "agent" || h.actor.kind === "service") && agents.length <= 1;
    let ok = shape && person && oracle.chatHas(person.id, where.chat);
    if (ok && agents.length) { const a = oracle.chatAssistants(where.chat); ok = Boolean(a && a.includes(agents[0].id)); }
    if (!ok && shape && !agents.length && where.rest !== null && input.action === "drive.read" && await oracle.sharedRead(input.resource, person.id)) ok = true;
    if (!ok) return deny(d);
    // a participant reads and writes the chat's own files with no grant of their own (a member's role has no Drive actions); restore, delete and backups stay the base's
    if (d.effect !== "allow" && (input.action === "drive.read" || input.action === "drive.write")) return Object.freeze({ ...d, effect: "allow", reason: "chat_participant", obligations: Object.freeze(d.obligations.filter((/** @type {any} */ o) => !(o.type === "audit" && o.class === "deny"))) });
    return d;
  } } });
}
