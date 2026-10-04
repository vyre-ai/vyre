// The install flow's calls to the box (screens/install/real.js maps the answers). Each is one tool through src/real/box.ts.

import { tool } from "./box";
import { claimIdentity } from "../identity/claim.js";
import { forgetIdentity, loadIdentity, saveIdentity } from "../identity/store";
import { createdFrom, directoryAnswer, identityFrom, nameAnswer } from "../../screens/install/real.js";

type Created = { state: "done" | "running" | "asking" | "failed"; id: string; address: string; say: string };

/** This device's claimed name, or null. */
export const readIdentity = async (): Promise<{ id: string; label: string; address: string } | null> => {
  // The identity this device made comes first (it needs no box); a paired box's own answer is the fallback, and no box is not an error here.
  const mine = await loadIdentity();
  if (mine) return { id: mine.id, label: mine.name, address: `${mine.name}.vyre.run` };
  try { return identityFrom(await tool("spaces.identity.status")); } catch { return null; }
};

/**
 * Where the names directory is: the public service, never a box. The identity comes first (a name, then a space, then a server), so
 * a name is checked before there is any box to ask. EXPO_PUBLIC_VYRE_NAMES_DIRECTORY points a walk at a stand-in.
 */
export const DIRECTORY: string = (process.env.EXPO_PUBLIC_VYRE_NAMES_DIRECTORY || "https://names.vyre.run").replace(/\/+$/, "");

/** Is a name free in the directory? Asked of the directory itself, no box. An answer that is neither found nor not_found is "unknown". */
export async function checkName(name: string): Promise<"free" | "taken" | "unknown"> {
  try {
    const r = await fetch(`${DIRECTORY}/v1/ids/resolve?name=${encodeURIComponent(name)}`, { headers: { accept: "application/json" }, cache: "no-store" });
    const body = await r.json().catch(() => null);
    return nameAnswer(directoryAnswer(r.status, body));
  } catch {
    // A browser cannot read an answer from a directory that sends no CORS headers: that is also "unknown", never a guess.
    return "unknown";
  }
}

/**
 * Claim the person's name from this device, with no box: the key is made here, the claim goes to the names directory, and the identity is kept
 * here. The recovery code is in this answer only: the caller shows it once and drops it.
 */
export async function createIdentity(name: string, deviceLabel: string, password = ""): Promise<{ name: string; id: string; recoveryCode: string; software: boolean }> {
  // Save first, then claim: the key is kept and read back BEFORE the name is claimed, so a failed save claims nothing and never loses the recovery code.
  let kept = false;
  try {
    const made = await claimIdentity({
      name, password, deviceLabel, base: DIRECTORY,
      beforeClaim: async (m) => {
        await saveIdentity({ name: m.name, id: m.id, eid: m.eid, ops: m.ops, pin: m.pin, key: m.key });
        const back = await loadIdentity();
        if (!back || back.eid !== m.eid) throw Object.assign(new Error("This browser would not keep your key, so no name was claimed. Try another browser or a private window turned off."), { code: "cannot_keep" });
        kept = true;
      },
    });
    return { name: made.name, id: made.id, recoveryCode: made.recoveryCode, software: made.software };
  } catch (e) {
    // The claim itself failed after the key was kept: take the key back out so no identity is left that names nothing.
    // (An unreachable directory is ambiguous: the claim may have landed, so the key stays.)
    if (kept && (e as { code?: string })?.code !== "unreachable") await forgetIdentity().catch(() => {});
    throw e;
  }
}

export async function createSpace(input: Record<string, unknown>): Promise<Created> {
  return createdFrom(await tool("spaces.create", input));
}
export async function resumeSpace(space: string): Promise<Created> {
  return createdFrom(await tool("spaces.resume", { space }));
}

export const listSpaces = () => tool<any[]>("spaces.list");
export const saveSetup = (space: string, setup: Record<string, unknown> | null) => tool("spaces.setup.save", { space, setup });
export const claimSetup = (space: string) => tool<{ space: string; setup: any; moved?: boolean }>("spaces.setup.claim", { space });
export const previewInvite = (link: string) => tool<any>("spaces.invites.preview", { link });
export const acceptInvite = (link: string) => tool<any>("spaces.invites.accept", { link });
