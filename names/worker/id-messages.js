// @ts-check
// The bytes an identity entry signs for the directory: a sealed record, an own-domain proof, an act. No imports on purpose: the client (lib/identity/directory.js) and
// the Worker both use these, and the Worker's own files import each other (index.js and ids.js), so a client that entered through ids.js would load them in a cycle
// and fail before its first line ("Cannot access 'ID_ROUTES' before initialization"). Nothing here may import anything.
export const RECORD_TAG = "vyre-id-record-v1";
export const ALIAS_TAG = "vyre-id-alias-v1";
export const ACT_TAG = "vyre-id-act-v1";
const enc = new TextEncoder();

/** The bytes an entry signs over a sealed record. @param {{ name: string, id: string, by: string, via?: string, ts: number|string, sealedHash: string, vseq?: number, vhead?: string }} m */
export const recordMessage = m => enc.encode(`${RECORD_TAG}\n${m.name}\n${m.id}\n${m.by}\n${m.via || "-"}\n${m.vseq ?? "-"}:${m.vhead || "-"}\n${m.ts}\n${m.sealedHash}`);
/** What an own domain's TXT carries, signed by an entry. */
export const aliasMessage = m => enc.encode(`${ALIAS_TAG}\n${m.name}\n${m.domain}\n${m.id}`);
/** A signed act that is not a chain op: clearing an alias, releasing a name. @param {{ action: string, name: string, domain?: string, ts: number|string }} m */
export const actMessage = m => enc.encode(`${ACT_TAG}\n${m.action}\n${m.name}\n${m.domain || "-"}\n${m.ts}`);

