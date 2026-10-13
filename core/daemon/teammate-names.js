// core/daemon/teammate-names: the agents a Flow step may name (`teammate:<name>`), asked of the agents module each time the catalog is read, so an agent made a minute ago is there and one removed is not.
// "assistant" is always listed, as before. An agents module that is not running leaves just that.

/** @param {((tool: string, input: any, space?: string) => Promise<any>) | undefined} callModule @param {string} space @param {(m: string) => void} [log] @returns {Promise<string[]>} */
export async function teammateNames(callModule, space, log = () => {}) {
  const names = new Set(["assistant"]);
  if (typeof callModule !== "function") return [...names];
  try {
    const r = await callModule("agents.list", {}, space);
    for (const a of Array.isArray(r) ? r : (r && Array.isArray(r.agents) ? r.agents : [])) if (a && typeof a.name === "string" && a.name) names.add(a.name);
  } catch (err) { log(`flows ${space}: agents not listed for the catalog (${/** @type {Error} */ (err).message})`); }
  return [...names];
}
