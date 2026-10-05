// @ts-check
// Who is in a chat, from work.chat.get ({ people: [person ids], agents: [agent names], ... }) and the space's actors ({ actors: [{ id, name }] }). The viewer is "You"; a person with no name behind their id
// is "Someone", never the id. An agent is named by its own name.

/** @typedef {{ id: string, name: string, family: "person" | "assistant" }} Member */

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
