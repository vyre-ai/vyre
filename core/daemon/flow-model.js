// @ts-check
// A Flow's AI step, on the account of the person the Flow runs as (kernel/flows/runs-as.js decides who; this decides which of THEIR accounts and gets its key). The account is resolved the way a chat's is, for that
// person only (sessions.accounts.resolve filters by person: the home's own rows serve only the home's owner, a member's own rows only that member). A member's key is lent from her own vault for this one call
// (core/daemon/lend-key.js); a home account's key comes from the Switchboard's accountKey, which reads only the home's own rows. The inference door is then called as that person's chain with that key. Nothing
// is sent when there is no account: the caller gets code no_account and the runner says "Connect an AI account to run this Flow".
//
// The door has a driver for every kind of account a person holds: the API keys (openrouter, openai-compatible: core/sessions/drivers/openrouter.js) and the sign-ins (a Claude setup token or login, a Codex
// login, a Grok login, and the keys those CLIs take: core/sessions/drivers/signin-door.js, one non-interactive turn of the provider's own CLI). The driver is picked by the account's provider, and the call is
// never moved to another account or provider when this one fails. This port is generic: any caller with a person (a Flow's AI step, a Routine, a Watcher) calls `call` with that person.

import { isLoopbackHost } from "../../lib/api-endpoint.js";
import { ACCOUNT_ENV } from "../../lib/credential-env.js";
import { modelFor } from "../sessions/drivers/openrouter.js";   // the chat driver's own pick of an OpenRouter model (its default when the account names none)

/** The API-key providers (an HTTP call with the key) and the sign-in providers (the provider's own CLI, on the person's subscription or key). */
export const KEY_PROVIDERS = Object.freeze(["openrouter", "openai-compatible"]);
export const SIGNIN_PROVIDERS = Object.freeze(["claude", "codex", "grok"]);
/** The providers the inference door has a driver for, in the order a default is looked for: a key first (as before), then a sign-in. */
export const DOOR_PROVIDERS = Object.freeze([...KEY_PROVIDERS, ...SIGNIN_PROVIDERS]);
const PERSON = /^per_[a-z0-9]{1,64}$/;
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** A test's own OpenRouter on this machine (plain http to loopback only), as the chat drivers allow (core/sessions/index.js testBase). @returns {string | null} */
function testBase() {
  const u = process.env.VYRE_OPENROUTER_URL;
  try { const x = new URL(String(u)); return x.protocol === "http:" && isLoopbackHost(x.hostname) ? String(u) : null; } catch { return null; }
}

/**
 * @param {{ registry: any }} o the daemon's registry: sessions.accounts.resolve (as the daemon), deps.lendKey (a member's own key), deps.accountKey (a home account's key)
 */
export function flowModel(o) {
  const resolve = async (/** @type {any} */ q) => {
    const r = await o.registry.call("sessions.accounts.resolve", q, "module:vyred");
    if (r && r.error) throw refuse(String(r.error.message || "the account could not be found"), r.error.code === "ambiguous" ? "no_account" : String(r.error.code || "no_account"));
    return r && r.data && !r.data.synthetic && !r.data.pending ? r.data : null;
  };
  /** The person's account: the one Runs on names (theirs only, or not found), else their default on the first door provider that has one. @param {{ person: string, account?: string, provider?: string }} q */
  const accountOf = async (q) => {
    if (q.account) {
      for (const provider of q.provider ? [q.provider] : DOOR_PROVIDERS) {
        const a = await resolve({ provider, account: q.account, person: q.person }).catch(e => { if (e.code === "not_found") return null; throw e; });
        if (a) return a;
      }
      throw refuse("the account Runs on names is not one of this person's: pick one of your own under Runs on", "no_account");
    }
    for (const provider of DOOR_PROVIDERS) { const a = await resolve({ provider, person: q.person }).catch(() => null); if (a) return a; }
    return null;
  };
  return {
    /** Whether `account` is one of `person`'s own (Runs on accepts only that). @param {{ person: string, account: string, provider?: string }} q */
    accountOk: async (q) => { if (!PERSON.test(String(q.person))) return false; try { const a = await accountOf(q); return Boolean(a && (a.person ? a.person === q.person : true)); } catch { return false; } },
    /**
     * One call through the door as `person`, on their account. `chainFor(person)` is that person's own chain in the Space's kernel, `door` that kernel's inference door.
     * @param {{ person: string, account?: string, provider?: string, purpose: string, max_tokens: number, messages: any[], expect?: any, run?: string, space: string, door: any, chainFor: (person: string) => any }} q
     */
    call: async (q) => {
      if (!PERSON.test(String(q.person))) throw refuse("this Flow has no person to run as, so nothing was sent", "no_person");
      if (!q.door) throw refuse("this home has no model door, so an AI step cannot run: ask the owner to turn on model access for this home", "unavailable");
      const a = await accountOf(q);
      if (!a) throw refuse("Connect an AI account to run this Flow", "no_account");
      // never a home row for anyone but the home's owner, never another member's row (resolve already filters; this is the second lock)
      if (a.person && String(a.person) !== q.person) throw refuse("Connect an AI account to run this Flow", "no_account");
      const provider = String(a.provider), signin = SIGNIN_PROVIDERS.includes(provider);
      if (!DOOR_PROVIDERS.includes(provider) || (!signin && a.kind !== "api-key")) throw refuse(`${a.label} cannot run AI steps: pick another of your own AI accounts under Runs on`, "no_account");
      if (signin && a.kind !== "login" && !(ACCOUNT_ENV[provider] && ACCOUNT_ENV[provider][a.kind])) throw refuse(`${a.label} cannot run AI steps: pick another of your own AI accounts under Runs on`, "no_account");
      if (signin && a.base_url) throw refuse(`${a.label} sends its key to an address of its own, which AI steps do not use yet: pick another of your own AI accounts under Runs on`, "no_account");
      if (signin && a.kind === "login" && a.needs) throw refuse(`Your ${a.label} sign-in is not finished. Sign in again in Settings, AI accounts.`, "signin_expired");
      let key = null;
      if (signin && a.kind === "login") { /* a login holds no key: the provider's own sign-in is in the account's own folder */ }
      else if (a.person) {
        const lend = o.registry.deps && o.registry.deps.lendKey;
        const lent = typeof lend === "function" ? await lend({ asker: q.person, account: String(a.id), space: q.space }) : { error: { code: "denied" } };
        if (lent.error) throw refuse(lent.error.code === "locked" ? `Unlock your own Vault so this Flow can use ${a.label}` : `${a.label} gave no key to this Flow: add the key to your own Vault again`, "no_credential");
        key = lent.data && lent.data.value;
      } else {
        const keyOf = o.registry.deps && o.registry.deps.accountKey;
        key = typeof keyOf === "function" ? await keyOf(a).catch(() => null) : null;
      }
      if (!(signin && a.kind === "login") && (typeof key !== "string" || !key)) throw refuse(`${a.label} gave no key to this Flow: add it again under Settings, AI accounts`, "no_credential");
      if (signin) {
        // the sign-in driver gets this one account: its own variable (a setup token or key, for its child only) or, for a login, its own folder (the Switchboard's accountHome: null where the spawner gives the uid's own)
        const name = a.kind === "login" ? null : ACCOUNT_ENV[provider][a.kind];
        const homeOf = o.registry.deps && o.registry.deps.accountHome;
        const home = a.kind === "login" && typeof homeOf === "function" ? homeOf(a) : null;
        const credential = { account: { id: String(a.id), provider, kind: String(a.kind), label: String(a.label), person: a.person ? String(a.person) : null, ...(typeof a.uid === "number" ? { uid: a.uid } : {}) }, env: name ? { [name]: /** @type {string} */ (key) } : {}, home };
        return q.door.call({ chain: await q.chainFor(q.person), purpose: q.purpose, provider, model: a.model ? String(a.model) : "default", max_output_tokens: q.max_tokens, messages: q.messages, credential, ...(q.expect ? { expect: q.expect } : {}) });
      }
      const base = a.base_url ? String(a.base_url) : a.provider === "openrouter" ? testBase() : null;
      const model = a.provider === "openrouter" ? modelFor({ model: a.model ? String(a.model) : "" }, {}) : a.model ? String(a.model) : null;
      if (!model) throw refuse(`${a.label} has no model chosen: choose one for it under Settings, AI accounts`, "no_account");
      return q.door.call({ chain: await q.chainFor(q.person), purpose: q.purpose, provider: String(a.provider), model, max_output_tokens: q.max_tokens, messages: q.messages, credential: { key, ...(base ? { base } : {}) } });
    },
  };
}
