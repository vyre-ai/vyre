// @ts-check
// browser-profile: computers module reads one field from a person's own vault (owner or member).

import { PeopleVaults } from "../people.js";
import { MEMBER_BROWSER_PROFILE_KEY } from "../../../lib/browser-profile.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

const COMPUTERS = "module:computers";

/** @param {{ people: PeopleVaults, internal: (name: string, description: string, input: any, run: Function) => void }} o */
export function register({ people, internal }) {
  internal(
    "vault.person.browser-profile-key",
    `The wrap key for ${MEMBER_BROWSER_PROFILE_KEY} in one person's own vault (owner or member). { person } -> { key }. Only the computers module; that person's vault must be unlocked.`,
    obj({ person: str }, ["person"]),
    async (/** @type {any} */ input, /** @type {any} */ meta) => {
      if (String((meta && meta.caller) || "") !== COMPUTERS) {
        throw Object.assign(new Error("only the computers module may read a person's browser-profile key"), { code: "denied" });
      }
      const person = PeopleVaults.check(String(input.person || ""));
      const it = await people.get(person, { name: MEMBER_BROWSER_PROFILE_KEY });
      const key = it && it.fields && it.fields.key;
      if (!key) throw new Error(`no ${MEMBER_BROWSER_PROFILE_KEY} in ${person}'s vault`);
      return { person, key: String(key) };
    },
  );
}
