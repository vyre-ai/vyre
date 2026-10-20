// @ts-check
// A Flow's AI step, on the accounts of the person the Flow runs as (kernel/flows/runs-as.js decides who; this decides which of THEIR accounts and gets its key). The account is resolved the way a chat's is, for
// that person only (sessions.accounts.resolve filters by person: the home's own rows serve only the home's owner, a member's own rows only that member). A member's key is lent from her own vault for this one
// call (core/daemon/lend-key.js); a home account's key comes from the Switchboard's accountKey, which reads only the home's own rows. The inference door is then called as that person's chain with that key.
// Nothing is sent when there is no account: the caller gets code no_account and the runner says "Connect an AI account to run this Flow".
//
// The door has a driver for every kind of account a person holds: the API keys (openrouter, openai-compatible, opencode) and the sign-ins (a Claude setup token or login, a Codex
// login, a Grok login, and the keys those CLIs take: core/sessions/drivers/signin-door.js, one non-interactive turn of the provider's own CLI). The driver is picked by the account's provider.
//
// Main and fallback: a Flow names a MAIN account and, if it wants, a FALLBACK one (its AI accounts tab). The fallback answers only when the main one's failure is of a class another account could help with
// (lib/ai-errors.js, the one class every driver gives: credits, rate_limit after one more try, auth, unavailable); a bad request, a content refusal and a refusal by the door itself fail the step. This port is
// generic: any caller with a person (a Flow's AI step, a Routine, a Watcher) calls `call` with that person.

import { isLoopbackHost } from "../../lib/api-endpoint.js";
import { KEY_ACCOUNTS } from "../../lib/ai-ids.js";
import { ACCOUNT_ENV } from "../../lib/credential-env.js";
import { aiErrorClass } from "../../lib/ai-errors.js";
import { FALLBACK_CLASSES, kindWords } from "../../kernel/flows/runs-as.js";
import { modelFor } from "../sessions/drivers/openrouter.js";   // the chat driver's own pick of an OpenRouter model (its default when the account names none)

/** The API-key providers (an HTTP call with the key) and the sign-in providers (the provider's own CLI, on the person's subscription or key). */
export const KEY_PROVIDERS = KEY_ACCOUNTS;
export const SIGNIN_PROVIDERS = Object.freeze(["claude", "codex", "grok"]);
/** The providers the inference door has a driver for, in the order a default is looked for: a key first (as before), then a sign-in. */
export const DOOR_PROVIDERS = Object.freeze([...KEY_PROVIDERS, ...SIGNIN_PROVIDERS]);
const PERSON = /^per_[a-z0-9]{1,64}$/;
/** This port's own refusals that mean the account cannot be used now (gone, not finished, no key lent): another account may still answer. */
const ACCOUNT_CODES = new Set(["no_account", "no_credential", "signin_expired"]);
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code, ...(ACCOUNT_CODES.has(code) ? { aiClass: "auth" } : code === "bad_request" ? { aiClass: "bad_request" } : {}) });

/** A test's own OpenRouter on this machine (plain http to loopback only), as the chat drivers allow (core/sessions/index.js testBase). @returns {string | null} */
function testBase() {
  const u = process.env.VYRE_OPENROUTER_URL;
  try { const x = new URL(String(u)); return x.protocol === "http:" && isLoopbackHost(x.hostname) ? String(u) : null; } catch { return null; }
}

/** OpenCode messages are text before the door sees them, so a tool part is not scanned as an array. @param {unknown} c */
function flatText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : b && typeof b === "object" ? String(/** @type {any} */ (b).text || /** @type {any} */ (b).content || "") : "")).join("");
  return c == null ? "" : String(c);
}

/**
 * @param {{ registry: any, retryMs?: number }} o the daemon's registry: sessions.accounts.resolve (as the daemon), deps.lendKey (a member's own key), deps.accountKey (a home account's key); retryMs: the wait before
 *   a rate-limited main account is tried once more
 */
export function flowModel(o) {
  const resolve = async (/** @type {any} */ q) => {
    const r = await o.registry.call("sessions.accounts.resolve", q, "module:vyred");
    if (r && r.error) throw refuse(String(r.error.message || "the account could not be found"), r.error.code === "ambiguous" ? "no_account" : String(r.error.code || "no_account"));
    return r && r.data && !r.data.synthetic && !r.data.pending ? r.data : null;
  };
  /** The person's account: the one named (theirs only, or not found), else their default on the first door provider that has one. @param {{ person: string, account?: string, provider?: string }} q */
  const accountOf = async (q) => {
    if (q.account) {
      for (const provider of q.provider ? [q.provider] : DOOR_PROVIDERS) {
        const a = await resolve({ provider, account: q.account, person: q.person }).catch(e => { if (e.code === "not_found") return null; throw e; });
        if (a) return a;
      }
      throw refuse("the account the Flow's AI accounts name is not one of this person's: pick one of your own there", "no_account");
    }
    for (const provider of DOOR_PROVIDERS) { const a = await resolve({ provider, person: q.person }).catch(() => null); if (a) return a; }
    return null;
  };
  return {
    /** Whether `account` is one of `person`'s own (the AI accounts tab accepts only that). @param {{ person: string, account: string, provider?: string }} q */
    accountOk: async (q) => { if (!PERSON.test(String(q.person))) return false; try { const a = await accountOf(q); return Boolean(a && (a.person ? a.person === q.person : true)); } catch { return false; } },
    /**
     * One call through the door as `person`, on their MAIN account, or on their FALLBACK account when the main one fails with credits, rate_limit (after one more try), auth or unavailable; a bad request, a
     * content refusal or a door refusal fails the step, as it would on any account. The answer carries `answered`: which account answered (its name and provider, never a key), and, from the fallback, the
     * main account's name and the class of its failure. A step's own model (`model`) is used on the main account; the fallback uses its own. `chainFor(person)` is the chain the door is called as (the
     * run's own chain, whose first person is `person`), `door` the Space kernel's inference door.
     * @param {{ person: string, main?: { account: string, provider?: string, model?: string }, fallback?: { account: string, provider?: string, model?: string }, account?: string, provider?: string, model?: string, purpose: string, max_tokens: number, messages: any[], expect?: any, run?: string, space: string, door: any, chainFor: (person: string) => any }} q
     */
    call: async (q) => {
      if (!PERSON.test(String(q.person))) throw refuse("this Flow has no person to run as, so nothing was sent", "no_person");
      if (!q.door) throw refuse("this home has no model door, so an AI step cannot run: ask the owner to turn on model access for this home", "unavailable");
      const main = q.main || (q.account ? { account: q.account, ...(q.provider ? { provider: q.provider } : {}) } : null);
      /** One account's turn: its own checks, its key, the door. Throws with the account's name on it. @param {any} pick @param {string | undefined} model */
      const one = async (pick, model) => {
        /** @type {any} */ let a = null;
        try {
          a = await accountOf({ person: q.person, ...(pick ? { account: pick.account, ...(pick.provider ? { provider: pick.provider } : {}) } : {}) });
          if (!a) throw refuse("Connect an AI account to run this Flow", "no_account");
          // never a home row for anyone but the home's owner, never another member's row (resolve already filters; this is the second lock)
          if (a.person && String(a.person) !== q.person) throw refuse("Connect an AI account to run this Flow", "no_account");
          const provider = String(a.provider), signin = SIGNIN_PROVIDERS.includes(provider);
          if (!DOOR_PROVIDERS.includes(provider) || (!signin && a.kind !== "api-key")) throw refuse(`${a.label} cannot run AI steps: pick another of your own AI accounts under the Flow's AI accounts`, "no_account");
          if (signin && a.kind !== "login" && !(ACCOUNT_ENV[provider] && ACCOUNT_ENV[provider][a.kind])) throw refuse(`${a.label} cannot run AI steps: pick another of your own AI accounts under the Flow's AI accounts`, "no_account");
          if (signin && a.base_url) throw refuse(`${a.label} sends its key to an address of its own, which AI steps do not use yet: pick another of your own AI accounts under the Flow's AI accounts`, "no_account");
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
          const asked = model || (pick && pick.model) || (a.model ? String(a.model) : "");
          if (signin) {
            // the sign-in driver gets this one account: its own variable (a setup token or key, for its child only) or, for a login, its own folder (the Switchboard's accountHome: null where the spawner gives the uid's own)
            const name = a.kind === "login" ? null : ACCOUNT_ENV[provider][a.kind];
            const homeOf = o.registry.deps && o.registry.deps.accountHome;
            const home = a.kind === "login" && typeof homeOf === "function" ? homeOf(a) : null;
            const credential = { account: { id: String(a.id), provider, kind: String(a.kind), label: String(a.label), person: a.person ? String(a.person) : null, ...(typeof a.uid === "number" ? { uid: a.uid } : {}) }, env: name ? { [name]: /** @type {string} */ (key) } : {}, home };
            return { a, out: await q.door.call({ chain: await q.chainFor(q.person), purpose: q.purpose, provider, model: asked || "default", max_output_tokens: q.max_tokens, messages: q.messages, credential, ...(q.expect ? { expect: q.expect } : {}) }) };
          }
          const base = a.provider === "opencode" ? null : a.base_url ? String(a.base_url) : a.provider === "openrouter" ? testBase() : null;
          const m = a.provider === "openrouter" ? modelFor({ model: asked }, {}) : asked || null;
          if (!m) throw refuse(`${a.label} has no model chosen: choose one for it under the Flow's AI accounts`, "bad_request");
          const go = provider === "opencode" && Boolean(a.go_only);
          const messages = provider === "opencode" && Array.isArray(q.messages) ? q.messages.map((/** @type {any} */ msg) => ({ ...msg, content: flatText(msg && msg.content) })) : q.messages;
          return { a, out: await q.door.call({ chain: await q.chainFor(q.person), purpose: q.purpose, provider, model: m, max_output_tokens: q.max_tokens, messages, credential: { key, ...(base ? { base } : {}) }, ...(go ? { go: true, session: String(q.run || "") } : {}) }) };
        } catch (e) {
          const x = /** @type {any} */ (e) || {}, label = a ? String(a.label) : pick ? String(pick.account) : "AI account";
          // the account's name rides on the failure (for the card); a frozen error (a door refusal) is copied with its words, code and class
          if (e instanceof Error && Object.isExtensible(e)) throw Object.assign(e, { account_label: label });
          throw Object.assign(new Error(String(x.message || e)), { code: x.code, ...(x.aiClass ? { aiClass: x.aiClass } : {}), ...(x.name === "DoorRefusal" || x.refusal ? { refusal: true } : {}), account_label: label });
        }
      };
      /** The main account, once more after a short wait when it was rate limited (its retry). @returns {Promise<{ out: any, a: any }>} */
      const first = async () => {
        try { return await one(main, q.model); }
        catch (e) { if (aiErrorClass(e) !== "rate_limit") throw e; await new Promise(r => setTimeout(r, o.retryMs ?? 2000)); return one(main, q.model); }
      };
      try {
        const { out, a } = await first();
        return { ...out, answered: { which: "main", label: String(a.label), provider: String(a.provider) } };
      } catch (e) {
        const x = /** @type {any} */ (e), cls = aiErrorClass(e);
        if (!q.fallback || !cls || !FALLBACK_CLASSES.includes(cls)) throw e;
        try {
          const { out, a } = await one(q.fallback, undefined);
          return { ...out, answered: { which: "fallback", label: String(a.label), provider: String(a.provider), main_label: String(x.account_label), main_kind: cls } };
        } catch (f) {
          const y = /** @type {any} */ (f);
          // both failed: the step fails with both reasons, the main account's name and class stay on it for the card
          throw Object.assign(new Error(`Main ${x.account_label} ${kindWords(cls)}, and the fallback ${y.account_label} failed too: ${String(y.message || "").slice(0, 200)}`), { code: y.code || x.code, aiClass: cls, account_label: x.account_label });
        }
      }
    },
  };
}
