// @ts-check
// A chat with more than one person always runs on the space's server. Before someone new is added to a chat, a chat that runs on a computer moves to the server (runner.group-move: one line in the chat,
// the computer hands it over). Nothing is added if it cannot move. The work module calls this just before it changes who is in a chat.

/**
 * @param {{ kernel: any, chain: any, call: (tool: string, input: any) => Promise<any>, chat: string, add: unknown }} q
 * @returns {Promise<{ moved: boolean }>} resolves when it is safe to add the people; throws (with the box's own words) when it is not
 */
export async function moveBeforeJoin(q) {
  if (!Array.isArray(q.add) || !q.add.length) return { moved: false };
  /** @type {any} */ let now = null;
  try { now = q.kernel.chats.read(q.chain, q.chat); } catch { now = null; }   // a synchronous read: a chat the person is not in answers nothing, and the change itself refuses it in its own words
  const fresh = now && Array.isArray(now.people) ? q.add.map(String).filter(x => !now.people.includes(x)) : [];
  const hop = q.chain && Array.isArray(q.chain.hops) && q.chain.hops.length === 1 ? q.chain.hops[0] : null;
  const me = hop && hop.actor ? String(hop.actor.id || "") : "";
  if (!fresh.length || !me) return { moved: false };
  /** @type {any} */ const roster = await q.call("spaces.members.list", {}).catch(() => null);
  const rows = roster && roster.data && Array.isArray(roster.data.members) ? roster.data.members : [];
  const nameOf = (/** @type {string} */ id) => { const m = rows.find((/** @type {any} */ r) => r && (r.person === id || r.id === id)); return m && (m.name || m.label) ? String(m.name || m.label) : "someone"; };
  /** @type {any} */ let r;
  try { r = await q.call("runner.group-move", { chat: q.chat, person: me, names: fresh.map(nameOf) }); } catch (e) { r = { error: e }; }
  const err = r && r.error;
  if (err && err.code !== "no_such_tool") throw Object.assign(new Error(String(err.message || "This chat could not move to the server, so nobody was added.")), { code: err.code || "unavailable" });
  return { moved: Boolean(r && r.data && r.data.moved) };
}
