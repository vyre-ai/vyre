// @ts-check
// How an agent's name is said to a person. The stored name is its id (lowercase letters, digits and dashes: "qi", "engineer", "juno-two"), which is not for reading. Everything that shows an agent says it
// through here, so "engineer" never appears where a person reads: "Engineer", "Juno Two", and the assistant's own name as the person typed it ("Qi").

/** An id in words: "ads-writer" is "Ads Writer". A name that is not an id (it has a capital, a space or other letters: already someone's words) is left as it is. @param {unknown} name */
export function agentWords(name) {
  const id = String(name ?? "");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return id;
  return id.split("-").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || id;
}

/**
 * The name to show for an agent row (agents.list). The assistant carries the name as the person typed it in the first line of its instructions ("Your name is Qi."), shown as typed when it is this id's;
 * any other agent is its id in words.
 * @param {any} a
 */
export function displayName(a) {
  const id = String(a?.name ?? "");
  const typed = a?.kind === "assistant" ? /^Your name is ([^.\n]{1,40})\./.exec(String(a?.instructions ?? "")) : null;
  if (typed && typed[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") === id.toLowerCase()) return typed[1].trim();
  return agentWords(id);
}
