// @ts-check
// routing: who answers a message in a group chat (ADR 0052). Pure: no clock, no I/O.
//
// Rules, in order:
//  1. An assistant that is @mentioned answers (by `mentions` or an @name in the text). Several can.
//  2. The assistant a task is assigned to answers.
//  3. A person's message that mentions nobody: the default assistant answers ONLY when the chat has
//     no other person talking to a person. If the previous speaker was another person, or the message
//     mentions a person, no assistant answers. With no `previous` given, other people in the chat mean no.
//  4. An assistant's own message never wakes the default assistant, and nobody wakes themselves.

/**
 * @typedef {{ id: string, name?: string }} Participant  id is "person:<id>", "assistant:<id>" or "model:<id>"
 * @param {{ participants: readonly Participant[], defaultAssistant?: string|null, text?: string, mentions?: readonly string[],
 *   assigned?: string|readonly string[]|null, author: string, previous?: string|null }} a
 * @returns {string[]} the assistants (and models) that answer, in the order they were asked
 */
export function whoAnswers(a) {
  const parts = a.participants || [];
  const isBot = (/** @type {string} */ id) => id.startsWith("assistant:") || id.startsWith("model:");
  /** @type {Map<string, string>} */ const byToken = new Map();
  for (const p of parts) {
    byToken.set(p.id.toLowerCase(), p.id);
    byToken.set(p.id.slice(p.id.indexOf(":") + 1).toLowerCase(), p.id);
    if (p.name) byToken.set(p.name.toLowerCase(), p.id);
  }
  const resolve = (/** @type {string} */ t) => byToken.get(String(t).replace(/^@/, "").toLowerCase());
  /** @type {string[]} */ const mentioned = [];
  const add = (/** @type {string|undefined} */ id) => { if (id && !mentioned.includes(id)) mentioned.push(id); };
  for (const m of a.mentions || []) add(resolve(m));
  for (const m of String(a.text || "").matchAll(/(^|[^\w@])@([\w][\w.-]*)/g)) add(resolve(m[2]));
  const out = /** @type {string[]} */ ([]);
  const push = (/** @type {string} */ id) => { if (id !== a.author && isBot(id) && !out.includes(id)) out.push(id); };
  for (const id of mentioned) push(id);
  const assigned = a.assigned ? (Array.isArray(a.assigned) ? a.assigned : [a.assigned]) : [];
  for (const t of assigned) { const id = resolve(t); if (id) push(id); }
  if (out.length) return out;
  // Nobody asked: only the default assistant, only for a person, only outside a conversation between people.
  const dflt = a.defaultAssistant && resolve(a.defaultAssistant);
  if (!dflt || !isBot(dflt) || isBot(a.author) || dflt === a.author) return [];
  if (mentioned.some(id => id !== a.author && !isBot(id))) return []; // the message is for a person
  const others = parts.filter(p => p.id.startsWith("person:") && p.id !== a.author);
  const between = a.previous !== undefined && a.previous !== null
    ? a.previous.startsWith("person:") && a.previous !== a.author
    : others.length > 0;
  return between ? [] : [dflt];
}

/**
 * Everyone a message names, people and assistants: the explicit list and the @names in the text,
 * each resolved to a participant id, in order, without repeats. A message names nobody it cannot find.
 * @param {{ participants: readonly Participant[], text?: string, mentions?: readonly string[] }} a
 * @returns {string[]}
 */
export function mentionedIn(a) {
  /** @type {Map<string, string>} */ const byToken = new Map();
  for (const p of a.participants || []) {
    byToken.set(p.id.toLowerCase(), p.id);
    byToken.set(p.id.slice(p.id.indexOf(":") + 1).toLowerCase(), p.id);
    if (p.name) byToken.set(p.name.toLowerCase(), p.id);
  }
  const out = /** @type {string[]} */ ([]);
  const add = (/** @type {string} */ t) => { const id = byToken.get(String(t).replace(/^@/, "").toLowerCase()); if (id && !out.includes(id)) out.push(id); };
  for (const m of a.mentions || []) add(m);
  for (const m of String(a.text || "").matchAll(/(^|[^\w@])@([\w][\w.-]*)/g)) add(m[2]);
  return out;
}
