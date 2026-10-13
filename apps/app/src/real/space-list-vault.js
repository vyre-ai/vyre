// @ts-check
// Read and write the list (space-list.js) as one personal note in the vault, through the vault's own tools handed in as `tool` (name, input). Reading is one person-present reveal; writing is an update (a put
// the first time). A locked vault, or a reveal that is refused, is an empty list with the reason, and nothing is written over a list that could not be read.
import { FIELD, ITEM, entriesFromDevice, mergeLists, parseList, serializeList, toPair } from "./space-list.js";

/** @typedef {(name: string, input?: Record<string, unknown>) => Promise<any>} Tool */

/** @param {Tool} tool @returns {Promise<import("./space-list.js").List & { unavailable?: string }>} */
export async function readList(tool) {
  try { await tool("vault.item", { name: ITEM }); } catch (e) {
    const code = /** @type {any} */ (e)?.code;
    return code === "not_found" ? parseList("") : { ...parseList(""), unavailable: String(code || "unavailable") };
  }
  try {
    const r = await tool("vault.reveal", { name: ITEM, field: FIELD });
    return parseList(typeof r === "string" ? r : r && typeof r.value === "string" ? r.value : "");
  } catch (e) { return { ...parseList(""), unavailable: String(/** @type {any} */ (e)?.code || "unavailable") }; }
}

/** @param {Tool} tool @param {import("./space-list.js").List} list */
export async function writeList(tool, list) {
  const text = serializeList(list);
  let exists = true;
  try { await tool("vault.item", { name: ITEM }); } catch (e) { if (/** @type {any} */ (e)?.code === "not_found") exists = false; else throw e; }
  if (exists) await tool("vault.update", { name: ITEM, fields: { [FIELD]: text } });
  else await tool("vault.put", { name: ITEM, kind: "note", description: "Where your servers and teams are", fields: { [FIELD]: text } });
}

/**
 * Bring this device and the vault together: read the vault's list, merge in what this device holds, write it back when it changed, and say which servers this device still has to pair to. A list that could not
 * be read is never written over.
 * @param {Tool} tool @param {{ pairings: Array<{ relay: string, route: string, box: string, name?: string }>, teams: Array<{ name: string, home: { relay: string, route: string, box: string } }> }} device
 */
export async function syncList(tool, device) {
  const there = await readList(tool);
  if (there.unavailable) return { list: there, toPair: [], unavailable: there.unavailable };
  const mine = { ...there, at: Date.now(), entries: entriesFromDevice(device) };
  const list = mergeLists(there, { ...mine, removed: [] });
  if (JSON.stringify(list.entries) !== JSON.stringify(there.entries)) await writeList(tool, { ...list, at: Date.now() });
  return { list, toPair: toPair(list, device.pairings.map((p) => p.box)) };
}
