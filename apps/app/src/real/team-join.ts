// Join a team from this device when it holds a Vyre name: the join steps are src/real/join-team.js (the invitee's side of the home's door), given this app's own pieces: the identity key, the relay client,
// the hardware key that gives the yes, and a small store for where the joined teams' homes are. A device with no server of its own has nothing else to join with; a name kept in this app has no box to ask.

import { loadIdentity } from "../identity/store";
import { openInvite, callTeam, type JoinDeps } from "./join-team.js";
import { WORDS } from "@vyre/relay-client/words.js";

const KEY = "vyre.team.";
const store = {
  async get(key: string) { try { const t = localStorage.getItem(KEY + key); return t ? JSON.parse(t) : undefined; } catch { return mem.get(key); } },
  async put(key: string, value: unknown) { mem.set(key, value); try { localStorage.setItem(KEY + key, JSON.stringify(value)); } catch { /* kept for this page only */ } },
  async delete(key: string) { mem.delete(key); try { localStorage.removeItem(KEY + key); } catch { /* none */ } },
};
const mem = new Map<string, unknown>();

/** The hardware key that gives the yes on this device: the Mac's or Windows' window, else the phone's. Null where there is none. */
async function yesSigner() {
  const { shellSigner } = await import("./shell-signer");
  const s = await shellSigner();
  if (s) return { kind: "shell" as const, signer: s };
  const { phoneSigner } = await import("./phone-signer");
  const p = await phoneSigner();
  return p ? { kind: "phone" as const, signer: p } : null;
}

/** The presence key to enrol on the team's server with the accept: what a signed proof names (key id, signer) and the key itself. */
async function enrolment(kind: "shell" | "phone", invite: string) {
  if (kind === "phone") {
    const m = await import("../../modules/vyre-signer");
    const key = await m.presenceKey();
    // A release server enrols a phone's first key on this invite only attested or as a secure-chip key it marks unattested; App Attest vouches for the key over "join:" + the invite id (kernel/seal/proof.js join). Where it is not available the key goes as it is.
    const attestation = await m.enrolAttestation(`join:${invite}`).catch(() => null);
    return attestation ? { ...key, attestation } : key;
  }
  const { macEnclavePublic } = await import("../identity/mac-key.ts");
  const { shellKind } = await import("../shell/shell.ts");
  const { fromB64url, keyIdOf, spkiFromXY, b64 } = await import("../../modules/vyre-signer/presence-proof.js");
  const point = await macEnclavePublic(false);
  if (!point) return null;
  const pt = fromB64url(point);
  const spki = spkiFromXY(pt.slice(1, 33), pt.slice(33, 65));
  return { key_id: keyIdOf(spki), spki: b64(spki), signer: shellKind() === "windows" ? "tpm" : "secure_enclave" };
}

export async function joinDeps(): Promise<JoinDeps | null> {
  const mine = await loadIdentity();
  if (!mine) return null;
  const { relayCrypto } = await import("../api/relay");
  const { DIRECTORY } = await import("./install");
  const client = (await import("@vyre/relay-client/client.js")) as unknown as { connect: (o: unknown) => any };
  const peer = (await import("@vyre/relay-client/peerclient.js")) as unknown as { openServerPeer: (c: any, o?: any) => Promise<any> };
  const yes = await yesSigner();
  return {
    who: { id: mine.id, name: mine.name, eid: mine.eid, sign: (m: Uint8Array) => mine.key.sign(m) },
    fetch: globalThis.fetch.bind(globalThis), base: DIRECTORY, connect: client.connect, openServerPeer: peer.openServerPeer, crypto: relayCrypto(), words: WORDS as unknown as string[],
    ...(yes ? { signPresence: (req) => yes.signer.signPresence({ ...req, prompt: req.prompt ?? "Join this team" }), presenceKey: (invite: string) => enrolment(yes.kind, invite) } : {}),
    store,
  };
}

/** Does this device keep the person's name itself (so the invite is joined from here, not by a box)? */
export const holdsName = async (): Promise<boolean> => Boolean(await loadIdentity().catch(() => null));

const open = new Map<string, Awaited<ReturnType<typeof openInvite>>>();

/** The join card for a link, read through the team's own server. The open stream is kept for the accept that follows. */
export async function previewTeamInvite(link: string) {
  const d = await joinDeps();
  if (!d) throw Object.assign(new Error("Choose your Vyre name first."), { code: "no_identity" });
  const inv = await openInvite(d, link);
  open.get(link)?.close();
  open.set(link, inv);
  const c = inv.card as Record<string, unknown>;
  return { space: String(c.space), label: String(c.label || ""), role: String(c.role || "member"), status: String(c.status || "pending"), fingerprint_words: String(c.fingerprint_words || ""), sees: c.scope ? { scope: c.scope, expires: c.expires } : undefined };
}

/** The person's yes. Opens the card again when the preview's stream is gone. */
export async function acceptTeamInvite(link: string) {
  let inv = open.get(link);
  if (!inv) { const d = await joinDeps(); if (!d) throw Object.assign(new Error("Choose your Vyre name first."), { code: "no_identity" }); inv = await openInvite(d, link); open.set(link, inv); }
  try { return await inv.accept(); } finally { inv.close(); open.delete(link); }
}

/** A call to a team space this device joined, as a member. */
export async function teamCall(space: string, call: string, args: unknown[] = []) {
  const d = await joinDeps();
  if (!d) throw Object.assign(new Error("Choose your Vyre name first."), { code: "no_identity" });
  return callTeam(d, space, call, args);
}

// ---- the owner's side: invites made, listed, confirmed and cancelled from this app over its paired session to the server (team-invite.js) ----

/** Does this app make invites itself? When it keeps the name and reaches its server over the peer wire: the server holds no identity to make them. */
export async function invitesHere(): Promise<boolean> {
  const { peerWanted } = await import("./peer");
  return peerWanted() && (await holdsName());
}

async function inviteDeps(space: string) {
  const mine = await loadIdentity();
  if (!mine) throw Object.assign(new Error("Choose your Vyre name first."), { code: "no_identity" });
  const { openPeer } = await import("./peer");
  const { kernelWire } = await import("./kernel-wire.js");
  const { DIRECTORY } = await import("./install");
  const yes = await yesSigner();
  const wire = kernelWire(await openPeer(), space, { person: mine.id, ...(yes ? { signPresence: (card) => yes.signer.signPresence(card) } : {}) });
  return { wire, fetch: globalThis.fetch.bind(globalThis), base: DIRECTORY };
}

export async function makeTeamInvite(i: { space: string; name: string; role: string; scope?: string[]; expires?: number; to?: string; ttlDays?: number }) {
  const { createTeamInvite } = await import("./team-invite.js");
  return createTeamInvite(await inviteDeps(i.space), i);
}
export async function teamInvites(space: string) {
  const { listTeamInvites } = await import("./team-invite.js");
  return { invites: await listTeamInvites(await inviteDeps(space)) };
}
export async function confirmTeamInviteWords(space: string, id: string, words: string) {
  const { confirmTeamInvite } = await import("./team-invite.js");
  return confirmTeamInvite(await inviteDeps(space), id, words);
}
export async function cancelTeamInvite(space: string, id: string) {
  const { revokeTeamInvite } = await import("./team-invite.js");
  return revokeTeamInvite(await inviteDeps(space), id);
}
