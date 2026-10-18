// The Space's skills a slot may name (skills.list rows { id, name, level, description }): only the Space's own, by name, and a stored id that is no longer there stays choosable so it is not lost.

/** @param {any} data skills.list's answer @param {string[]} chosen ids already on the slot @returns {{ id: string, name: string, description: string, on: boolean, gone?: boolean }[]} */
export function spaceSkills(data, chosen) {
  const rows = (data && Array.isArray(data.skills) ? data.skills : []).filter((/** @type {any} */ s) => s && s.level === "space" && typeof s.id === "string");
  const seen = new Set(rows.map((/** @type {any} */ s) => s.id));
  const list = rows.map((/** @type {any} */ s) => ({ id: String(s.id), name: String(s.name || s.id), description: String(s.description || ""), on: chosen.includes(s.id) }));
  for (const id of chosen) if (!seen.has(id)) list.push({ id, name: id, description: "", on: true, gone: true });
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/** Turn one id on or off, at most ten. @param {string[]} ids @param {string} id */
export function toggledSkill(ids, id) {
  return ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= 10 ? ids : [...ids, id];
}
