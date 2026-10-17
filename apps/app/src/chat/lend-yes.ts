// Her yes for lending one of her own vault items to the chat's agent for a turn. When she tags a login, an API key or a connection from her own vault, the app takes her presence (the platform's
// biometric prompt) and signs a yes over exactly the call vault.me.mention.lend will make: the fields { asker, id, thread, agent }, and nothing wider. The chip carries it to the message; the
// Switchboard passes it through untouched and the Vault checks it. This file makes no decision about it. Where this device cannot take a biometric (a browser), there is no signer and no yes: the
// chip then names the item and lends nothing.
//
// The yes is the same one the other vault moments take (lib/one-yes-sign.js signOf "vault", the proof the phone's Face ID key or a browser's passkey signs): the Vault checks it with its own yes(), over
// exactly { asker, id, thread, agent }, single use and fresh. It travels as base64url of the JSON proof.

import { signOf } from "../../../../lib/one-yes-sign.js";
import { payloadHash } from "../real/payload-hash.js";
import { b64url } from "../auth/person.ts";

export const LEND_OP = "vault.me.mention.lend";

/** The fields her yes covers: the four, and `origin` exactly when the tag names a site (a login with several). The Vault checks the same set. */
export type LendFields = { asker: string; id: string; thread: string; agent: string; origin?: string };
/** What signs: the platform's prompt and the device's presence key over these exact fields (the app wires it where one exists). Returns the yes, or null when she closed the prompt. */
export type LendSigner = (op: string, fields: LendFields) => Promise<string | null>;

let signer: LendSigner | null = null;
/** The app gives its presence signer once, where the device has one. */
export function setLendSigner(s: LendSigner | null): void { signer = s; }

const PER = /^per_[A-Za-z0-9_-]{1,64}$/;
const WORD = /^[A-Za-z0-9._:-]{1,120}$/;

/** A bare https origin, exactly as the Vault checks it: equal to new URL(origin).origin, so no path, no trailing slash and no login in the address. */
export function bareOrigin(o: unknown): o is string {
  if (typeof o !== "string" || o.length > 253 || !o.startsWith("https://")) return false;
  try { return new URL(o).origin === o; } catch { return false; }
}

/** Her yes for lending `id` to `agent` on `thread`, or null: no signer, a field that is not what the Vault will check, or the prompt closed. Never throws. */
export async function lendYes(f: LendFields): Promise<string | null> {
  if (!signer) return null;
  if (f.origin !== undefined && !bareOrigin(f.origin)) return null;
  if (!PER.test(f.asker) || !f.id || f.id.length > 200 || !WORD.test(f.thread) || !/^[a-z][a-z0-9_-]{0,39}$/.test(f.agent)) return null;
  try {
    const yes = await signer(LEND_OP, { asker: f.asker, id: f.id, thread: f.thread, agent: f.agent, ...(f.origin ? { origin: f.origin } : {}) });
    return typeof yes === "string" && yes && yes.length <= 4096 ? yes : null;
  } catch { return null; }
}

/** A picked chip with her yes on it, for a vault item only; any other kind is returned as it was. */
export function withYes<T extends { kind: string }>(mention: T, yes: string | null): T & { yes?: string } {
  return mention.kind === "vault" && yes ? { ...mention, yes } : mention;
}

/** What a device that can sign a yes offers (src/personal/signer.ts yesSigner). */
export type YesDevice = { signPresence(req: any): Promise<any> };

/**
 * A LendSigner over a device that signs a yes: the vault moment, for op vault.me.mention.lend and exactly these fields, with the card's words for the prompt. Returns base64url of the JSON proof (the
 * form the Vault reads), or null when the prompt was closed. The same one-copy helpers the other vault yeses use make the request, so the Vault checks exactly what was signed.
 */
export function lendSignerFor(o: { device: YesDevice; person: string; space: string }): LendSigner {
  return async (op, fields) => {
    const sign = signOf("vault", { op, fields });
    const proof = await o.device.signPresence({ op: sign.op, space: o.space, fields: sign.fields, payload_hash: payloadHash(sign.op, o.space, sign.fields), prompt: `Let ${fields.agent} use ${JSON.stringify(fields.id)} for this turn, without seeing it`, person: o.person });
    if (!proof) return null;
    return b64url(new TextEncoder().encode(JSON.stringify(proof)));
  };
}

/**
 * Tagging one of her own items. `sites` are the origins the Vault listed for a login (names only, no value), or null for an item that has none to list (a connection, an API key). A login with no saved
 * site cannot be lent: the answer says so (needsSite) and nothing is signed, and the composer offers to open the item so she can add the site. One site needs no choice (the Vault uses it). Several: she
 * picks one, it must be in the list, and it is signed into her yes with the rest, which the Vault checks as the same set. Null when she closed the picker or the prompt.
 */
export async function lendWithSite(f: Omit<LendFields, "origin">, sites: readonly string[] | null, choose: (sites: readonly string[]) => Promise<string | null>): Promise<{ yes: string; origin?: string } | { needsSite: true } | null> {
  if (sites && sites.length === 0) return { needsSite: true };
  let origin: string | undefined;
  if (sites && sites.length > 1) {
    const picked = await choose(sites);
    if (!picked || !sites.includes(picked)) return null;
    origin = picked;
  }
  const yes = await lendYes({ ...f, ...(origin ? { origin } : {}) });
  return yes ? { yes, ...(origin ? { origin } : {}) } : null;
}
