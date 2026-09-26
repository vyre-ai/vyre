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

  tool("vault.account.unlock", [...PEOPLE, "deck", "capsule"], "Unlock your personal vault (logins, cards, notes, one-time codes) with its password.",
    obj({ password }, ["password"]), (input, { caller }) => vault.unlockAccount(input, caller),
    presence("Unlock your personal vault", () => "Unlock your personal vault"));

  tool("vault.account.lock", null, "Lock your personal vault now. Agents keep what is granted to them.",
    obj({}), (_input, { caller }) => vault.lockAccount(caller));
}
