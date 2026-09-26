// @ts-check
// account: the password that opens the personal vault (ADR 0006 decision 1). Creating one
// makes the Secret Key, which is returned once, to a person at a terminal or a local surface,
// for the recovery kit. Unlocking needs the password and presence; locking never does.

import { presence } from "./presence.js";

const PEOPLE = ["cli", "local"];
const obj = (properties, required = []) => ({ type: "object", properties, required });
const password = { type: "string" };

/**
 * @param {{ ctx: any, vault: import("../vault.js").Vault,
 *   tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o
 */
export function register({ vault, tool }) {
  tool("vault.account.create", PEOPLE,
    "Set the password for your personal vault. Returns your Secret Key once: print it on the recovery kit, it is not shown again.",
    obj({ password }, ["password"]),
    async (input, { caller }) => {
      const r = await vault.createAccount(input, caller);
      return { ...r, advice: "Keep the Secret Key on your recovery kit with your password. Without both, the personal vault cannot be opened on a new device." };
    },
    presence("Set a password for your personal vault", () => "Set a password for your personal vault and make its Secret Key"));

  tool("vault.account.unlock", [...PEOPLE, "deck", "capsule"], "Unlock your personal vault (logins, cards, notes, one-time codes) with its password, or with Touch ID once enrolled.",
    obj({ password, method: { type: "string", enum: ["password", "touchid"] } }), (input, { caller }) => {
      if (input.method !== "touchid" && typeof input.password !== "string") throw new Error("give the password, or method touchid");
      return vault.unlockAccount(input, caller);
    },
    presence("Unlock your personal vault", ({ method }) => method === "touchid" ? "Unlock your personal vault with Touch ID" : "Unlock your personal vault"));

  tool("vault.account.enroll-touchid", PEOPLE, "Turn on Touch ID unlock of your personal vault on this Mac. Needs your password once.",
    obj({ password }, ["password"]), (input, { caller }) => vault.enrollTouchId(input, caller),
    presence("Turn on Touch ID unlock", () => "Turn on Touch ID unlock of your personal vault on this Mac"));

  tool("vault.account.status", null, "Whether this vault has an account password, whether it is unlocked, and whether Touch ID unlock is set up here.",
    obj({}), () => vault.accountStatus());

  tool("vault.account.lock", null, "Lock your personal vault now. Agents keep what is granted to them.",
    obj({}), (_input, { caller }) => vault.lockAccount(caller));
}
