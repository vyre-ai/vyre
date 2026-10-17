// Her yes for lending one of her own vault items to the chat's agent for a turn. When she tags a login, an API key or a connection from her own vault, the app takes her presence (the platform's
// biometric prompt) and signs a yes over exactly the call vault.me.mention.lend will make: the fields { asker, id, thread, agent }, and nothing wider. The chip carries it to the message; the
// Switchboard passes it through untouched and the Vault checks it. This file makes no decision about it. Where this device cannot take a biometric (a browser), there is no signer and no yes: the
// chip then names the item and lends nothing.

export const LEND_OP = "vault.me.mention.lend";

export type LendFields = { asker: string; id: string; thread: string; agent: string };
/** What signs: the platform's prompt and the device's presence key over these exact fields (the app wires it where one exists). Returns the yes, or null when she closed the prompt. */
export type LendSigner = (op: string, fields: LendFields) => Promise<string | null>;

let signer: LendSigner | null = null;
/** The app gives its presence signer once, where the device has one. */
export function setLendSigner(s: LendSigner | null): void { signer = s; }

const PER = /^per_[A-Za-z0-9_-]{1,64}$/;
const WORD = /^[A-Za-z0-9._:-]{1,120}$/;

/** Her yes for lending `id` to `agent` on `thread`, or null: no signer, a field that is not what the Vault will check, or the prompt closed. Never throws. */
export async function lendYes(f: LendFields): Promise<string | null> {
  if (!signer) return null;
  if (!PER.test(f.asker) || !f.id || f.id.length > 200 || !WORD.test(f.thread) || !/^[a-z][a-z0-9_-]{0,39}$/.test(f.agent)) return null;
  try {
    const yes = await signer(LEND_OP, { asker: f.asker, id: f.id, thread: f.thread, agent: f.agent });
    return typeof yes === "string" && yes && yes.length <= 4096 ? yes : null;
  } catch { return null; }
}

/** A picked chip with her yes on it, for a vault item only; any other kind is returned as it was. */
export function withYes<T extends { kind: string }>(mention: T, yes: string | null): T & { yes?: string } {
  return mention.kind === "vault" && yes ? { ...mention, yes } : mention;
}
