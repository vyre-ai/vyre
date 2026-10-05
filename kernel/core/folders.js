// @ts-check
// A chat's folders are its participants' only (team/0.3/CONTRACT-one-chat.md section 6): `Projects/<project id>/chat/<chat id>/` and `Projects/<project id>/made/<chat id>/`. This wraps the
// authorizer the way kernel/core/room.js does. For a file inside one of those folders a Drive decision is allowed only to a participant (read and write need no grant of their own, since a member's role has no Drive actions): a person who is
// in the chat, or an assistant (a person and an agent) whose person is in the chat and which the chat lists. An owner, an admin, a project member or someone holding the exact path and a link
// is refused, and the refusal looks like absence (`not_found`). The one other way in is a share: a participant's "Share to project" is an active kernel grant of `drive.read` on exactly that
// file, which lets a member READ that file (never list the folder, never write, never reach another file of the chat).
// The path is the only input, so a path guess, a link, a listing, a search hit and a device sync all meet the same check wherever the Drive gateway decides.
import { isChain } from "./chain.js";

const FOLDER = /^Projects\/([^/]+)\/(chat|made)\/([^/]+)(?:\/(.*))?$/;

/** Where a resource lies in a chat's folders, or null. @param {unknown} resource @param {string} space @returns {{ project: string, kind: string, chat: string, rest: string | null } | null} */
export function chatFolderOf(resource, space) {
  const p = `vyre://${space}/file/`;
  if (typeof resource !== "string" || !resource.startsWith(p)) return null;
  let path = resource.slice(p.length);
  try { path = decodeURIComponent(path); } catch { return null; }
  const m = FOLDER.exec(path.replace(/\/{2,}/g, "/"));
  return m ? { project: m[1], kind: m[2], chat: m[3], rest: m[4] === undefined ? null : m[4] } : null;
}

/**
 * @param {any} base the authorizer @param {string} space
 * @param {{ chatHas: (person: string, chat: string) => boolean, chatAssistants: (chat: string) => string[] | null, sharedRead: (person: { kind: string, id: string, space: string }, resource: string) => boolean }} oracle
 */
export function folderGuard(base, space, oracle) {
  return Object.create(base, {
    authorize: { value: async (/** @type {any} */ input) => {
      const d = await base.authorize(input);
      const where = chatFolderOf(input && input.resource, space);
      if (!where || typeof input.action !== "string" || !input.action.startsWith("drive.")) return d;
      const chain = input.chain;
      const hops = isChain(chain) ? chain.hops : [];
      // A module acting on its own service chain is governed by its manifest and the base decision (first-party code the Space installed), not by a person's place in a chat.
      if (hops.length && hops[0].actor.kind === "service") return d;
      const person = hops[0] && hops[0].actor.kind === "person" ? hops[0].actor : null;
      const agents = hops.slice(1).filter((/** @type {any} */ h) => h.actor.kind === "agent").map((/** @type {any} */ h) => h.actor);
      const shape = Boolean(person) && hops.slice(1).every((/** @type {any} */ h) => h.actor.kind === "agent" || h.actor.kind === "service") && agents.length <= 1;
      let ok = shape && person && oracle.chatHas(person.id, where.chat);
      if (ok && agents.length) { const a = oracle.chatAssistants(where.chat); ok = Boolean(a && a.includes(agents[0].id)); }
      if (!ok && d.effect === "allow" && shape && person && !agents.length && where.rest !== null && input.action === "drive.read" && oracle.sharedRead(person, input.resource)) ok = true;
      if (!ok) return Object.freeze({ ...d, effect: "deny", reason: "not_found", obligations: Object.freeze([]) });
      // A participant reads and writes the chat's own files without a grant of their own (a member's role has no Drive actions); anything beyond that (restore, delete, backups) stays the base's.
      if (d.effect !== "allow" && (input.action === "drive.read" || input.action === "drive.write")) {
        return Object.freeze({ ...d, effect: "allow", reason: "chat_participant", obligations: Object.freeze(d.obligations.filter((/** @type {any} */ o) => !(o.type === "audit" && o.class === "deny"))) });
      }
      return d;
    } },
  });
}
