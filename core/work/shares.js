// @ts-check
// Chats and shares are the work module's to serve (kernel/gateway/records.js KEEPERS): a person has no raw Records route to them unless she is the owner or an admin, so each read here runs under the module's own
// chain and keeps the records this person may see (hub.mayViewChat, hub.mayViewShare). A call with no person on its chain sees none. A share is written by the module for the sharer (`on_behalf`), and is hers to take back.

/** The person on a chain (its first person hop), or "". @param {any} c */
export const personOf = (c) => { const h = c && Array.isArray(c.hops) ? c.hops.find((/** @type {any} */ x) => x.actor.kind === "person") : null; return h ? String(h.actor.id) : ""; };

/** @param {any} k the kernel handle of the Space the call runs in @param {any} hub that Space's hub */
export function readers(k, hub) {
  const viewable = async (/** @type {any} */ chain, /** @type {string} */ type, /** @type {any} */ spec, /** @type {"mayViewChat" | "mayViewShare"} */ may) => {
    const me = personOf(chain); if (!me) return [];
    const out = [];
    for (const r of (await k.records.query(k.serviceChain("work"), type, spec)).rows || []) if (await hub[may](me, r)) out.push(r);
    return out;
  };
  return {
    chatRows: (/** @type {any} */ chain, /** @type {any} */ spec) => viewable(chain, "chat-record", spec, "mayViewChat"),
    shareRows: (/** @type {any} */ chain, /** @type {any} */ spec) => viewable(chain, "file-share", spec, "mayViewShare"),
  };
}

const err = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const inChat = (/** @type {any} */ k, /** @type {any} */ chain, /** @type {string} */ chat) => { try { k.chats.read(chain, chat); return true; } catch { return false; } };

/** Share one file of a chat the caller is in with the chat's project. @param {any} k @param {any} hub @param {any} chain @param {{ path: string }} i */
export async function shareFile(k, hub, chain, i) {
  const { chatRows } = readers(k, hub), m = /^Projects\/[^/]+\/(?:chat|made)\/([^/]+)\/./.exec(String(i.path));
  // only a chat's own people can share its files: a chat that is not theirs is not there for them
  const row = m ? (await chatRows(chain, { filter: { field: "chat", op: "eq", value: m[1] }, page: { limit: 1 } }))[0] : null, me = personOf(chain);
  if (!row || !String(row.data.people || "").split(",").map((/** @type {string} */ x) => x.trim()).includes(me)) throw err("that file is not in a chat of yours (work.file.list shows the files of a chat you are in)", "not_found");
  const r = await k.records.create(k.serviceChain("work"), "file-share", { path: String(i.path) }, { on_behalf: chain });
  return { shared: true, id: r.id };
}

/** Take a shared file back: the sharer's to do, and an owner's or an admin's. @param {any} k @param {any} hub @param {any} chain @param {{ path: string }} i */
export async function unshareFile(k, hub, chain, i) {
  const { shareRows } = readers(k, hub);
  const rows = await shareRows(chain, { filter: { field: "path", op: "eq", value: String(i.path) }, page: { limit: 50 } });
  const me = personOf(chain), staff = me ? await hub.isStaff(me) : false;
  let removed = 0;
  for (const r of rows) {
    const at = (await k.records.attrsOf(r.urn)) || {}, sharer = String(at.created_for || at.created_by || "");
    if (!(staff || (me && sharer === `person:${me}`))) continue;
    try { await k.records.remove(k.serviceChain("work"), "file-share", r.id, r.version); removed++; } catch { /* already gone */ }
  }
  return { unshared: removed };
}
export { inChat };
