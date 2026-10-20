// @ts-check
// The words a person sends in a chat, heard for what they ask (lib/said/hear.js decides; this records what it returns as the person, vault.said.record). Split out of index.js so the
// Switchboard stays under its size cap; Switchboard.hearActs and Switchboard.hearOwn call these.
import { heardActs } from "../../lib/said/hear.js";

/**
 * What the person asked GitHub to do in their own words ("open a PR", "merge it", "review this PR"): the assistant's
 * prIntents (lib/said/pr.js) decides what is a real ask and binds it to ONE target, github.act.target's composite key for
 * this thread's project and PR; each intent it returns is recorded as the person (vault.said.record). Doubt records
 * nothing. The thread's own PR is github.session.pr's answer, used only when it is exactly one. Pasted spans are taken
 * out first, so someone else's words never ask.
 * @param {any} sb the Switchboard @param {string} id @param {string} text @param {string} uuid @param {string[]} pasted @param {string|null|undefined} project @param {string|null} [asker] the chat turn's asker, kept with each ask this records
 */
export async function hearActsFor(sb, id, text, uuid, pasted, project, asker = null, { agent = null } = {}) {
  // lib/said/hear.js decides what was asked from the person's own words and the facts it reads through `call`
  // (never a fresh watchers.card: the hash is the card as shown); this records what it returns.
  const turnsSince = at => Number(/** @type {any} */ (sb.db.prepare("SELECT COUNT(*) AS n FROM threads_turns WHERE thread = ? AND at >= ?").get(id, at)).n) || 0;
  const intents = await heardActs({ text, pasted, project, thread: id, agent, call: (tool, input) => sb.deps.call(tool, input), turnsSince }).catch(() => []);
  for (const it of intents) {
    await sb.deps.call("vault.said.record", { thread: id, said: uuid, ...(asker ? { asker } : {}), kind: it.kind || "act_out", ...(it.channel === null ? {} : { channel: it.channel || "github" }), to: it.to, what: it.what, standing: false,
      ...(it.when && Number.isInteger(it.when.window_minutes) ? { window_minutes: it.when.window_minutes } : {}) }).catch(() => null);
  }
}

/**
 * A member's turn in an agent's chat: only her own Routine or Watcher is heard (lib/said/hear.js with member), recorded for her as the asker, so only her turn
 * in this chat can use it, and what it makes runs for her on her own account. Nothing that acts for the owner or the project is heard from her words.
 * @param {any} sb the Switchboard @param {string} id @param {string} text @param {string} uuid @param {string[]} pasted @param {string} asker @param {string} agent
 */
export async function hearOwnFor(sb, id, text, uuid, pasted, asker, agent) {
  const intents = await heardActs({ text, pasted, project: null, thread: id, agent, member: true, call: (tool, input) => sb.deps.call(tool, input), turnsSince: () => 0 }).catch(() => []);
  for (const it of intents) await sb.deps.call("vault.said.record", { thread: id, said: uuid, asker, kind: it.kind || "act_out", channel: it.channel || "watchers", to: it.to, what: it.what, standing: false, ...(it.when && Number.isInteger(it.when.window_minutes) ? { window_minutes: it.when.window_minutes } : {}) }).catch(() => null);
}
