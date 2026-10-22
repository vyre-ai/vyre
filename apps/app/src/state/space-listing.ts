// Whether the names directory was told that a Space's server serves its name, as the claim last saw it. The claim (real/install.ts makeServerSpace) notes it and the host reads it once (host/space-ports.ts):
// a first run is never stopped by a listing that did not land; it carries on, says so in one plain line, and the app tries again on every unlock (host-core.js ensureServers).
const seen = new Map<string, { listed: boolean; why: string }>();

/** @param {string} space @param {boolean} listed @param {string} [why] */
export function noteListing(space: string, listed: boolean, why = ""): void { seen.set(space, { listed, why }); }

/** What the claim saw for this Space, once: undefined when nothing was noted (a claim with no server route to list). */
export function takeListing(space: string): { listed: boolean; why: string } | undefined { const v = seen.get(space); seen.delete(space); return v; }
