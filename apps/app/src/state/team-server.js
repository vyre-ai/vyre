// @ts-check
// Which paired servers already gave their own Space to the team. My Cloud must not offer Set up on those: the server answers that its Space is already the team's.

/** The ids kept on this device, from the stored text. Anything that is not a list of ids is none. @param {unknown} raw @returns {string[]} */
export function readTeamServers(raw) {
  try {
    const a = JSON.parse(String(raw ?? ""));
    return (Array.isArray(a) ? a : []).filter((/** @type {unknown} */ x) => typeof x === "string" && x);
  } catch { return []; }
}

/** Add one server id. A repeat or an empty id leaves the list as it was. @param {readonly string[] | null | undefined} ids @param {unknown} id @returns {string[]} */
export function keptTeamServers(ids, id) {
  const cur = (Array.isArray(ids) ? ids : []).filter((/** @type {unknown} */ x) => typeof x === "string" && x);
  if (typeof id !== "string" || !id || cur.includes(id)) return cur;
  return [...cur, id];
}
