// @ts-check
// Who is in a chat, from work.chat.get ({ people: [person ids], agents: [agent names], ... }) and the space's actors ({ actors: [{ id, name }] }). The viewer is "You"; a person with no name behind their id
// is "Someone", never the id. An agent is named by its own name.

/** How often an open chat asks whether the viewer is still in it. A removal that never arrives as a leave frame is seen on this read. */
export const MEMBERSHIP_MS = 10000;

/** @typedef {{ id: string, name: string, family: "person" | "assistant" }} Member */

/**
 * work.chat.get says this person is not in the chat. A non-member and a missing chat are both not_found
 * ("no such chat"). A missed network read, and a server that has no such tool, are not a removal.
 * @param {string | null} me @param {any} got @param {{ code?: string, message?: string } | null} err
 */
export function removedFromChat(me, got, err) {
  if (err) {
    const message = String(err.message || "");
    if (/\btool\b/i.test(message)) return false;
    if (String(err.code || "") === "not_found") return true;
    return /\bno such chat\b|\bnot found\b/i.test(message);
  }
  if (!me || !got || !Array.isArray(got.people) || got.people.length === 0) return false;
  return !got.people.includes(me);
}

/**
 * What one read does to the search hold. "out" the person is not in the chat, "in" they are, "same" this read does not say.
 * @param {string | null} me @param {any} got @param {{ code?: string, message?: string } | null} err
 * @returns {"out" | "in" | "same"}
 */
export function membershipHold(me, got, err) {
  if (removedFromChat(me, got, err)) return "out";
  if (me && got && Array.isArray(got.people) && got.people.includes(me)) return "in";
  return "same";
}

/** @param {any} got work.chat.get's answer @param {any} actors records.actors @param {string | null} me @returns {Member[]} */
export function membersFrom(got, actors, me) {
  const list = Array.isArray(actors?.actors) ? actors.actors : Array.isArray(actors) ? actors : [];
  /** @type {Map<string, string>} */ const names = new Map();
  for (const a of list) if (a && typeof a.id === "string" && typeof a.name === "string" && a.name.trim() && !/^per_/.test(a.name)) names.set(a.id, a.name.trim());
  const people = Array.isArray(got?.people) ? got.people : [];
  const agents = Array.isArray(got?.agents) ? got.agents : [];
  return [
    ...people.filter((/** @type {unknown} */ id) => typeof id === "string").map((/** @type {string} */ id) => ({ id: `person:${id}`, name: me && id === me ? "You" : names.get(id) ?? "Someone", family: /** @type {"person"} */ ("person") })),
    ...agents.filter((/** @type {unknown} */ n) => typeof n === "string").map((/** @type {string} */ n) => ({ id: `agent:${n}`, name: n, family: /** @type {"assistant"} */ ("assistant") })),
  ];
}

/** The thread of the chat's run, for the per-run controls (queue, send now, edit, retry): the first slot work.chat.get names, or null while no run has started. @param {any} got */
export function runThreadOf(got) {
  const slots = Array.isArray(got?.slots) ? got.slots : [];
  const s = slots.find((/** @type {any} */ x) => x && typeof x.thread === "string" && x.thread);
  return s ? s.thread : null;
}

const PROVIDER_WORD = { claude: "Claude", codex: "Codex", grok: "Grok" };

/** The names of the chat's model slots, keyed by slot id: "Claude", "Codex", "Grok" (the model is the engine's business, not the person's). @param {any} got work.chat.get's answer @returns {{ id: string, name: string }[]} */
export function slotNames(got) {
  const slots = Array.isArray(got?.slots) ? got.slots : [];
  return slots.filter((/** @type {any} */ x) => x && typeof x.slot === "string").map((/** @type {any} */ x) => ({ id: x.slot, name: /** @type {Record<string, string>} */ (PROVIDER_WORD)[String(x.provider)] ?? "Assistant" }));
}

/**
 * Where a chat's work runs, in words, from runner.places ({ chat, session, computer, device, online } per lent run, only for chats the caller is in): no row for the chat is the server's own run, "On <computer>"
 * for a lent computer that is up, "<computer> is offline" when it is not. A row with no computer name is not shown by an id: it reads as the server's line. A box without runner.places answers nothing, and says the same.
 * @param {any} places runner.places's answer (an array, or { places }) @param {string} chat the chat's id @returns {string}
 */
export function whereLine(places, chat) {
  const rows = Array.isArray(places) ? places : Array.isArray(places?.places) ? places.places : [];
  const row = rows.find((/** @type {any} */ r) => r && r.chat === chat && typeof r.computer === "string" && r.computer.trim());
  if (!row) return "On the server";
  const name = row.computer.trim();
  return row.online === false ? `${name} is offline` : `On ${name}`;
}

/**
 * When this chat's session is on another of your computers (runner.places), offer carry on here.
 * @param {any} places runner.places answer @param {string} chat @param {string | null} localDevice this device's id when known
 * @returns {{ machine?: string, name?: string } | null}
 */
export function awayOf(places, chat, localDevice = null) {
  const rows = Array.isArray(places) ? places : Array.isArray(places?.places) ? places.places : [];
  const row = rows.find((/** @type {any} */ r) => r && r.chat === chat && r.session);
  if (!row) return null;
  if (localDevice && row.device === localDevice) return null;
  const name = typeof row.computer === "string" && row.computer.trim() ? row.computer.trim() : null;
  if (!name && row.online !== false) return null;
  return { ...(row.device ? { machine: String(row.device) } : {}), ...(name ? { name } : {}) };
}
