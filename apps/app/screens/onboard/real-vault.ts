// The Vault screens' real calls: the personal vault account (vault.account.create / unlock on the box, docs/using/vault.md "Your personal vault"). The master password IS the account password.
// There is no Secret Key in the new flow: the box makes one when the account is created and keeps it in its own store, and the answer carries it back once. It is dropped here at once: never
// kept, shown, logged or sent anywhere. In MOCK every call answers from flow-model.js.

import { Platform } from "react-native";
import { MOCK, tool } from "../../src/real/box";
import { masterStatus } from "./flow-model.js";
import { personalUnlockRefusal } from "../vault/real-model";
import type { Outcome } from "./real-identity";

type Failure = { code?: string; message?: string; detail?: { retry_after_s?: number } };
const fail = (e: unknown): Failure => (e && typeof e === "object" ? (e as Failure) : {});
const slow = (ms: number) => new Promise((r) => setTimeout(r, ms));

const noBox = "Vyre cannot reach your vault yet, so nothing was saved. Check your connection, then try again.";
const unreachable = (c: string | undefined) => !c || ["offline", "unreachable", "bad_response", "error", "timeout"].includes(c);

/** The vault is open: read the person's space list once and connect the servers this device lacks. Never blocks or fails the sign-in; a list that cannot be read is simply not applied. */
const opened = (): void => { void import("../../src/real/space-list-app").then((m) => m.onVaultOpened()).catch(() => {}); };

// The vault recovery secret a person types to set a new master password: held here between the Create screen and the call, then dropped. Not in the flow's state, not stored.
let resetKit = "";
export const holdResetKit = (text: string): void => { resetKit = text.trim(); };

/** Create the personal vault with the master password (`reset`: it is the new one after a recovery kit). Nothing but the password is sent; the Secret Key the box answers with is not read. */
export async function createVault(password: string, reset = false): Promise<Outcome<{ recoverySecret?: string }>> {
  if (MOCK) { await slow(600); return { ok: true, recoverySecret: "R1-DEMO42-ABCDEFGHIJKLMNOPQRSTUVWXYZ-23" }; }
  try {
    const made = await tool<{ recoverySecret?: string }>(reset ? "vault.account.reset" : "vault.account.create", reset ? { password, recovery: resetKit } : { password });
    resetKit = "";
    opened();
    return { ok: true, ...(made?.recoverySecret ? { recoverySecret: made.recoverySecret } : {}) };
  } catch (e) {
    const c = fail(e).code;
    if (c === "bad_recovery" || c === "wrong_recovery" || c === "wrong_account") return { ok: false, say: "That is not the vault recovery secret for this vault. Check the kit you saved and type it again." };
    if (c === "throttled") return { ok: false, say: personalUnlockRefusal(c, fail(e).detail) };
    if (c === "weak_password") return { ok: false, say: "That password is too short. Use at least 12 characters." };
    if (c === "presence_required" || c === "needs_presence") return { ok: false, say: "That needs you. Approve on this device, then try again." };
    // There is no tool that changes an account's password yet, so a vault that already has one cannot take a new one here.
    if (/already has an account/i.test(fail(e).message ?? "")) return { ok: false, say: reset ? "Nothing was changed. Try your recovery kit again." : "This vault already has a master password. Go back and type it to open the vault." };
    if (unreachable(c)) return { ok: false, say: noBox };
    return { ok: false, say: "Your vault was not created and nothing was saved. Try again." };
  }
}

/**
 * Open the personal vault with the master password. A phone uses the phone's own unlock (it also asks for the person's presence); a computer or browser uses the desk tool, where the password is the proof.
 * `expected` is the prototype's pretend password and is read only in MOCK.
 */
export async function openVault(password: string, expected?: string): Promise<Outcome> {
  if (MOCK) { await slow(400); return masterStatus(password, expected) === "ok" ? { ok: true } : { ok: false, say: "That is not your master password. Try again, or use your recovery kit to set a new one." }; }
  try {
    await tool(Platform.OS === "ios" || Platform.OS === "android" ? "vault.account.unlock-phone" : "vault.account.unlock", { password });
    opened();
    return { ok: true };
  } catch (e) {
    const f = fail(e);
    if (f.code === "wrong_password") return { ok: false, say: "That is not your master password. Try again, or use your recovery kit to set a new one." };
    // The box needs the account's Secret Key on this device. It is not part of the recovery kit in this flow, so say what is true and where the person stands.
    if (f.code === "no_secret_key") return { ok: false, say: "This device cannot open your vault with the password alone yet. Open Vyre on a device that already has your vault and add this one from there." };
    if (unreachable(f.code)) return { ok: false, say: noBox };
    return { ok: false, say: personalUnlockRefusal(f.code, f.detail) };
  }
}
