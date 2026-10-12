import { call } from "../../src/api/box";
import { callT } from "../../src/real/call-tool";
import { showingJoined } from "../../src/real/team-join";
import { sitesSource } from "./real-source";

/** A joined team's Sites are read through the team's door (publish.list, the sites of her projects); her own home's and the owner's take the call they always took. */
const siteCall = (async (name: string, input?: Record<string, unknown>) => ((await showingJoined().catch(() => false)) ? callT(name, input ?? {}) : call(name, input ?? {}))) as unknown as typeof call;

export const { list, status, create, preview, act, decide, retire, domainAdd, domainVerify, domainRemove, secretGrant, secretRevoke, vaultItems } = sitesSource(siteCall);
