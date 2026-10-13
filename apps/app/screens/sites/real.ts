import { call as boxCall } from "../../src/api/box";
import { callT } from "../../src/real/call-tool";
import { hasBoxOverride } from "../../src/real/box";
import { sitesSource, type Call } from "./real-source";

// A stand-in box (the gallery's canned answers) goes through `tool`, which it overrides; every real build uses the app's own connection.
const send: Call = (t, i) => (hasBoxOverride() ? callT(t, i ?? {}) : boxCall(t, i));

export const { list, status, create, preview, act, decide, retire, domainAdd, domainVerify, domainRemove, secretGrant, secretRevoke, vaultItems, door, jobRun, jobRuns, jobAttention, edgeUp, edgeDown } = sitesSource(send);
