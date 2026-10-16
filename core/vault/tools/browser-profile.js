// @ts-check
// browser-profile: computers module reads wrap keys from the person's vault or the space vault (internal only).

import { PeopleVaults } from "../people.js";
import { MEMBER_BROWSER_PROFILE_KEY } from "../../../lib/browser-profile.js";
import { ensureAgentBrowserProfileKey, ensureMemberBrowserProfileKey } from "../../../lib/browser-profile-key-ensure.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

const COMPUTERS = "module:computers";

/** @param {{ people: PeopleVaults, vault: import("../vault.js").Vault, internal: (name: string, description: string, input: any, run: Function) => void }} o */
export function register({ people, vault, internal }) {
  internal(
    "vault.person.browser-profile-key",
    `Ensure and return the wrap key for ${MEMBER_BROWSER_PROFILE_KEY} in one person's own vault. { person } -> { key }. Only the computers module; creates the item when missing; the person's vault must be unlocked.`,
    obj({ person: str }, ["person"]),
    async (/** @type {any} */ input, /** @type {any} */ meta) => {
      if (String((meta && meta.caller) || "") !== COMPUTERS) {
        throw Object.assign(new Error("only the computers module may read a person's browser-profile key"), { code: "denied" });
      }
      const person = PeopleVaults.check(String(input.person || ""));
      const key = await ensureMemberBrowserProfileKey(people, person);
      return { person, key };
    },
  );
  internal(
    "vault.space.browser-profile-key",
    `Ensure and return the wrap key for the space vault's agent browser profiles. { } -> { key }. Only the computers module; creates the item when missing; the space vault must be unlocked.`,
    obj({}),
    async (/** @type {any} */ _input, /** @type {any} */ meta) => {
      if (String((meta && meta.caller) || "") !== COMPUTERS) {
        throw Object.assign(new Error("only the computers module may read the agent browser-profile key"), { code: "denied" });
      }
      const key = await ensureAgentBrowserProfileKey(vault);
      return { key };
    },
  );
}
