import { call } from "../../src/api/box";
import { sitesSource } from "./real-source";

export const { list, status, create, preview, act, decide, retire, domainAdd, domainVerify, domainRemove, secretGrant, secretRevoke, vaultItems } = sitesSource(call);
