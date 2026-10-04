// The install flow's calls to the box (screens/install/real.js maps the answers). Each is one tool through src/real/box.ts.

import { BoxError, tool } from "./box";
import { createdFrom, directoryAnswer, identityFrom, nameAnswer } from "../../screens/install/real.js";

type Created = { state: "done" | "running" | "asking" | "failed"; id: string; address: string; say: string };

/** This device's claimed name, or null. */
export const readIdentity = async (): Promise<{ id: string; label: string; address: string } | null> => identityFrom(await tool("spaces.identity.status"));

/**
 * Where the names directory is: the public service, never a box. The identity comes first (a name, then a space, then a server), so
 * a name is checked before there is any box to ask. EXPO_PUBLIC_VYRE_NAMES_DIRECTORY points a walk at a stand-in.
 */
export const DIRECTORY: string = ((typeof process !== "undefined" && process.env?.EXPO_PUBLIC_VYRE_NAMES_DIRECTORY) || "https://names.vyre.run").replace(/\/+$/, "");

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
