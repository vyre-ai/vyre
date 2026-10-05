// Vault against the real vyred: vault.list and vault.uses to read (names and counts, never a value), vault.revoke for Remove, and vault.reveal
// for Reveal, which is a person's own call: the box asks for presence and the app's person session answers it with the device's own prompt.
import { callT as call } from "../../src/real/call-tool";
import { vaultSource } from "./source";

export const { listReal, usesReal, revealReal, revokeReal, stateReal, unlockReal, unlockPersonalReal, putReal, grantReal, revealHeldReal } = vaultSource(call);
