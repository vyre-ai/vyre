// @ts-check
// account: the password that opens the personal vault (ADR 0006 decision 1). Creating one
// makes the Secret Key, which is returned once, to a person at a terminal or a local surface,
// for the recovery kit. Unlocking needs the password (which is its own proof) or Touch ID; locking never does.

import { presence } from "./presence.js";

const PEOPLE = ["cli", "local"];
/** The person's paired phone or other device, whose call always carries presence (a call from one has no terminal or Mac login behind it). */
const DEVICES = ["mobile", "device"];
const obj = (properties, required = []) => ({ type: "object", properties, required });
const password = { type: "string" };

/**
 * @param {{ ctx: any, vault: import("../vault.js").Vault,
 *   tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o
 */
export function register({ vault, tool }) {
  tool("vault.account.create", [...PEOPLE, ...DEVICES],
    "Set the password for your personal vault. Returns your recovery secret once, for the recovery kit; a terminal also gets the Secret Key. Neither is shown again.",
    obj({ password }, ["password"]),
    async (input, { caller }) => {
      const { secretKey, ...r } = await vault.createAccount(input, caller);
      // The Secret Key stays in this device's own store. Only a terminal (the CLI kit) is given it; an app is not, since nothing in an app needs it and it should not cross a wire.
      return { ...r, ...(caller === "cli" ? { secretKey } : {}), advice: "Keep the recovery secret on your recovery kit. With it, a forgotten password can be replaced. Without it and the password, the personal vault cannot be opened again." };
    },
    presence("Set a password for your personal vault", () => "Set a password for your personal vault and make its recovery secret"));

  // The recovery secret from the kit replaces a forgotten password. From any of the person's own surfaces it carries the person's yes (a phone's call has no terminal or Mac login behind it);
  // five wrong secrets in a row wait 30 s and double to 15 minutes. The answer never carries a key.
  tool("vault.account.reset", [...PEOPLE, ...DEVICES], "Set a new password for your personal vault with the recovery secret from your recovery kit. Use it when you forgot the password.",
    obj({ recovery: password, password }, ["recovery", "password"]), (input, { caller }) => vault.resetAccount(input, caller),
    presence("Set a new password for your personal vault", () => "Set a new password for your personal vault with your recovery kit"));

  tool("vault.account.unlock", [...PEOPLE, "deck", "capsule"], "Unlock your personal vault (logins, cards, notes, one-time codes) with its password, or with Touch ID once enrolled.",
    obj({ password, method: { type: "string", enum: ["password", "touchid"] } }), (input, { caller }) => {
      if (input.method !== "touchid" && typeof input.password !== "string") throw new Error("give the password, or method touchid");
      return vault.unlockAccount(input, caller);
    },
    // The vault password IS the proof when it is given: asking the person to prove presence as well meant two prompts (the Mac login,
    // then the vault password) on a Mac with no Touch ID reader. The factors are the same as before: nothing opens without the password
    // and this Mac's own Secret Key. Touch ID unlock has no password in it, so its presence proof stays.
    presence("Unlock your personal vault", ({ method }) => method === "touchid" ? "Unlock your personal vault with Touch ID" : "Unlock your personal vault",
      { when: (/** @type {any} */ input) => Boolean(input) && (input.method === "touchid" || typeof input.password !== "string") }));

  // From the phone (the owner's paired device): the password AND the person's presence (Face ID), always. A device-method key alone is never enough (revised PW-1: presence is by method), and unlike the desk tool above
  // the password does not stand in for the proof here, because a phone's call arrives with no terminal or Mac login behind it. A model, a module or a browser session without presence cannot call it.
  tool("vault.account.unlock-phone", ["mobile", "device"], "Unlock your personal vault from the phone: its password, and Face ID.",
    obj({ password }, ["password"]), (input, { caller }) => {
      if (typeof input.password !== "string" || !input.password) throw new Error("give the password");
      return vault.unlockAccount({ password: input.password, method: "password" }, caller);
    },
    presence("Unlock your personal vault", () => "Unlock your personal vault from your phone"));

  tool("vault.account.enroll-touchid", PEOPLE, "Turn on Touch ID unlock of your personal vault on this Mac. Needs your password once.",
    obj({ password }, ["password"]), (input, { caller }) => vault.enrollTouchId(input, caller),
    presence("Turn on Touch ID unlock", () => "Turn on Touch ID unlock of your personal vault on this Mac"));

  // The keychain may ask the person to allow access here, so it is never run by an agent or a test.
  tool("vault.migrate-key", PEOPLE, "Move the vault's keychain items to this build of the keychain helper. macOS may ask you to allow it.",
    obj({}), (_input, { caller }) => vault.migrateKey(caller),
    presence("Move the vault key to this build of Vyre", () => "Move the vault key to this build of Vyre's keychain helper"));

  tool("vault.account.status", null, "Whether this vault has an account password, whether it is unlocked, and whether Touch ID unlock is set up here.",
    obj({}), () => vault.accountStatus());

  tool("vault.account.lock", null, "Lock your personal vault now. Agents keep what is granted to them.",
    obj({}), (_input, { caller }) => vault.lockAccount(caller));
}
