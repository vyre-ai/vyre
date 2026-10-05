// @ts-check
// A chat that moves with its project (team/0.3/DESIGN-one-chat.md, DESIGN-project-move.md): the chat is made again in the target Space under a NEW chat id, as the mover's own act in the target, with the
// same title and Project. Its people are the ones who are members of the target (never the mover, unless they were in it, or nobody else is left), its agents the ones that exist there; everyone
// else is listed as a former participant and gets nothing. Its record in the target is rewritten (new `chat`, `people`, `agents`, `former`, `drive`, `location`), and the chat's sealed files are
// carried under the NEW id by the move's own carry step, which maps the old id to the new with `chatMap`.

/**
 * @param {{ to: { space: string, chain: any, chats: { create(chain: any, o: any): Promise<any>, change(chain: any, id: string, c: any): Promise<any> }, members?: { roleOf(a: any): string | null } },
 *   src: any, newRoot: string }} o src: the old chat-record's data
 * @param {string} [o.id] a chat keeps its id when it moves between a person's own Spaces (the upgrade); a project move makes a new one
 * @returns {Promise<{ chat: string, people: string[], agents: string[], former: string[], moverOnly: boolean, skipped?: boolean }>}
 */
export async function carryChat({ to, src, newRoot, id }) {
  const ids = (/** @type {any} */ v) => String(v || "").split(",").map(x => x.trim()).filter(Boolean);
  const mover = String(to.chain && to.chain.hops && to.chain.hops[0] && to.chain.hops[0].actor && to.chain.hops[0].actor.id || "");
  const was = ids(src.people);
  const isMember = (/** @type {string} */ id) => !to.members || to.members.roleOf({ kind: "person", id, space: to.space }) != null;
  // A chat the mover was not in does not move: its files cannot be carried by someone who is not in it (the move's carry refuses them), and a record must never move without its files. It stays in the
  // source Space with its people, and the move names it.
  if (mover && !was.includes(mover)) return { skipped: true, chat: "", people: [], agents: [], former: [...was, ...ids(src.agents)], moverOnly: false };
  const keep = was.filter(isMember);
  /** @type {string[]} */ const former = was.filter(p => !isMember(p));
  // The mover never gains a chat they were not in (per-chat privacy): if nobody who was in it is a member of the target, the chat does not carry. It stays in the source Space with its people.
  if (!keep.length) return { skipped: true, chat: "", people: [], agents: [], former: [...was, ...ids(src.agents)], moverOnly: false };
  let chat = await to.chats.create(to.chain, { people: keep.filter(p => p !== mover), assistants: [], ...(id ? { id } : {}) });
  /** @type {string[]} */ const agents = [];
  for (const a of ids(src.agents)) {
    try { chat = await to.chats.change(to.chain, chat.id, { add_assistants: [a] }); agents.push(a); } catch { former.push(a); }
  }
  return { chat: String(chat.id), people: [...chat.people], agents, former, moverOnly: false };
}

/** Where a path of the old chat's folders goes: the same place under the target's root, with the chat's NEW id. @param {string} rel the path under the project's root ("/chat/<id>/x") @param {Record<string, string>} chatMap */
export function mapChatPath(rel, chatMap) {
  const m = /^\/(chat|made)\/([^/]+)(\/.*)?$/.exec(rel);
  return m && chatMap[m[2]] ? `/${m[1]}/${chatMap[m[2]]}${m[3] || ""}` : rel;
}
