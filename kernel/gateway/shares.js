// @ts-check
// A participant's share of ONE file of a chat's folders with the project is a `file-share` record they made (the work module's type; records/core-types.js FILE_SHARE). The kernel's guard
// (kernel/core/folders.js) asks here, from the gateway (an adapter, not the trusted base): is there such a record for this exact path, made by someone who is in that chat, and is the asker a
// member? It reads the shares as the work module's service chain, so a Space with no work module has no shares (fail closed).

/** @param {string} resource @param {string} person @param {{ space: string, chains: any, gs: any, records: any, logical?: (p: string) => string | null }} o */
export async function sharedRead(resource, person, { space, chains, gs, records, logical }) {
  const stored = resource.slice(`vyre://${space}/file/`.length), path = (logical && logical(stored)) || stored, m = /^Projects\/[^/]+\/(?:chat|made)\/([^/]+)\//.exec(path);
  const role = gs.roleOf({ kind: "person", id: person, space });
  if (!m || !records || !role || role === "temp") return false;
  try {
    const rows = (await records.query(chains.fromFacts({ kind: "module", module: "work", first_party: true }), "file-share", { filter: { field: "path", op: "eq", value: path }, page: { limit: 20 } })).rows;
    return rows.some((/** @type {any} */ x) => { const by = String((records.attrsOf(x.urn) || {}).created_by || ""); return by.startsWith("person:") && gs.chatHas(by.slice(7), m[1]); });
  } catch { return false; }
}
