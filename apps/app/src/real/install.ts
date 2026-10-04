// The install flow's calls to the box (screens/install/real.js maps the answers). Each is one tool through src/real/box.ts.

import { BoxError, tool } from "./box";
import { createdFrom, identityFrom, nameAnswer } from "../../screens/install/real.js";

type Created = { state: "done" | "running" | "asking" | "failed"; id: string; address: string; say: string };

/** This device's claimed name, or null. */
export const readIdentity = async (): Promise<{ id: string; label: string; address: string } | null> => identityFrom(await tool("spaces.identity.status"));

/** Is a name free in the directory? An answer that is neither found nor not_found is "unknown". */
export async function checkName(name: string): Promise<"free" | "taken" | "unknown"> {
  try {
    await tool("spaces.identity.resolve", { name });
    return nameAnswer({ ok: true });
  } catch (e) {
    return nameAnswer({ ok: false, code: e instanceof BoxError ? e.code : "offline" });
  }
}

/** Claim the person's name. The recovery code is in this answer only: the caller shows it once and drops it. */
export const createIdentity = (name: string, deviceLabel: string) => tool<{ name: string; id: string; recoveryCode: string }>("spaces.identity.create", { name, deviceLabel });

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
