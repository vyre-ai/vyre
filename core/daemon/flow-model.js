// @ts-check
// A Flow's AI step, on the account of the person the Flow runs as (kernel/flows/runs-as.js decides who; this decides which of THEIR accounts and gets its key). The account is resolved the way a chat's is, for that
// person only (sessions.accounts.resolve filters by person: the home's own rows serve only the home's owner, a member's own rows only that member). A member's key is lent from her own vault for this one call
// (core/daemon/lend-key.js); a home account's key comes from the Switchboard's accountKey, which reads only the home's own rows. The inference door is then called as that person's chain with that key. Nothing
// is sent when there is no account: the caller gets code no_account and the runner says "Connect an AI account to run this Flow".
//
// The door can call the API-key providers only (openrouter, openai-compatible): a sign-in account (Claude, Codex, Grok) cannot run a Flow's AI step yet, and is refused in words.

import { isLoopbackHost } from "../../lib/api-endpoint.js";
import { modelFor } from "../sessions/drivers/openrouter.js";   // the chat driver's own pick of an OpenRouter model (its default when the account names none)
import { modelErrorKind, FALLBACK_KINDS, kindWords } from "../../lib/model-errors.js";   // the one set of failure kinds every door driver returns

/** The providers the inference door has a driver for, in the order a default is looked for. */
export const DOOR_PROVIDERS = Object.freeze(["openrouter", "openai-compatible"]);
/** The sign-in providers: their accounts are found (so a Flow's AI accounts may name one), and run once their door drivers land (work/0.6.4/lead/door-signins). */
const SIGNIN_PROVIDERS = Object.freeze(["claude", "codex", "grok"]);
const PERSON = /^per_[a-z0-9]{1,64}$/;
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** A test's own OpenRouter on this machine (plain http to loopback only), as the chat drivers allow (core/sessions/index.js testBase). @returns {string | null} */
function testBase() {
  const u = process.env.VYRE_OPENROUTER_URL;
  try { const x = new URL(String(u)); return x.protocol === "http:" && isLoopbackHost(x.hostname) ? String(u) : null; } catch { return null; }
}

/**
 * @param {{ registry: any, retryMs?: number }} o the daemon's registry: sessions.accounts.resolve (as the daemon), deps.lendKey (a member's own key), deps.accountKey (a home account's key)
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
      for (const provider of q.provider ? [q.provider] : [...DOOR_PROVIDERS, ...SIGNIN_PROVIDERS]) {
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
     * One call through the door as `person`, on their MAIN account, or on their FALLBACK account when the main one fails with credits, rate_limit (after one more try), auth or unavailable
     * (lib/model-errors.js); a bad request or a content refusal fails the step, as it would on any account. The answer carries `answered`: which account answered (its name and provider, never a key),
     * and, from the fallback, the main account's name and why it failed. A step's own model (`model`) is used on the main account; the fallback uses its own. `chainFor(person)` is the chain the door is
     * called as (the run's own chain, whose first person is `person`), `door` the Space kernel's inference door.
     * @param {{ person: string, main?: { account: string, provider?: string, model?: string }, fallback?: { account: string, provider?: string, model?: string }, account?: string, provider?: string, model?: string, purpose: string, max_tokens: number, messages: any[], run?: string, space: string, door: any, chainFor: (person: string) => any }} q
     */
    call: async (q) => {
      if (!PERSON.test(String(q.person))) throw refuse("this Flow has no person to run as, so nothing was sent", "no_person");
      if (!q.door) throw refuse("this home has no model door, so an AI step cannot run: ask the owner to turn on model access for this home", "unavailable");
      const main = q.main || (q.account ? { account: q.account, ...(q.provider ? { provider: q.provider } : {}) } : null);
      /** One account's turn: its own checks, its key, the door. Throws with the account's name and the failure's kind on it. @param {any} pick @param {string | undefined} model */
      const one = async (pick, model) => {
        /** @type {any} */ let a = null;
        try {
          a = await accountOf({ person: q.person, ...(pick ? { account: pick.account, ...(pick.provider ? { provider: pick.provider } : {}) } : {}) });
          if (!a) throw refuse("Connect an AI account to run this Flow", "no_account");
          // never a home row for anyone but the home's owner, never another member's row (resolve already filters; this is the second lock)
          if (a.person && String(a.person) !== q.person) throw refuse("Connect an AI account to run this Flow", "no_account");
          if (a.kind !== "api-key" || !DOOR_PROVIDERS.includes(String(a.provider))) throw refuse(`${a.label} cannot run a Flow's AI steps yet: pick an API key (OpenRouter or OpenAI-compatible) under AI accounts`, "no_account");
          let key = null;
          if (a.person) {
            const lend = o.registry.deps && o.registry.deps.lendKey;
            const lent = typeof lend === "function" ? await lend({ asker: q.person, account: String(a.id), space: q.space }) : { error: { code: "denied" } };
            if (lent.error) throw refuse(lent.error.code === "locked" ? `Unlock your own Vault so this Flow can use ${a.label}` : `${a.label} gave no key to this Flow: add the key to your own Vault again`, "no_credential");
            key = lent.data && lent.data.value;
          } else {
            const keyOf = o.registry.deps && o.registry.deps.accountKey;
            key = typeof keyOf === "function" ? await keyOf(a).catch(() => null) : null;
          }
          if (typeof key !== "string" || !key) throw refuse(`${a.label} gave no key to this Flow: add it again under Settings, AI accounts`, "no_credential");
          const base = a.base_url ? String(a.base_url) : a.provider === "openrouter" ? testBase() : null;
          const asked = model || (pick && pick.model) || (a.model ? String(a.model) : "");
          const m = a.provider === "openrouter" ? modelFor({ model: asked }, {}) : asked || null;
          if (!m) throw refuse(`${a.label} has no model chosen: choose one for it under the Flow's AI accounts`, "bad_request");
          const out = await q.door.call({ chain: await q.chainFor(q.person), purpose: q.purpose, provider: String(a.provider), model: m, max_output_tokens: q.max_tokens, messages: q.messages, credential: { key, ...(base ? { base } : {}) } });
          return { out, a };
        } catch (e) {
          const x = /** @type {any} */ (e) || {};
          const tag = { kind: modelErrorKind(x) || undefined, account_label: a ? String(a.label) : pick ? String(pick.account) : "AI account" };
          // (a door refusal may be frozen: then a copy carries its words and code)
          try { throw Object.assign(e instanceof Error ? e : new Error(String(e)), tag); } catch (t) { if (t === e || (t instanceof Error && /** @type {any} */ (t).account_label)) throw t; throw Object.assign(new Error(String(x.message || e)), { code: x.code }, tag); }
        }
      };
      /** The main account, once more after a short wait when it was rate limited (its retry). @returns {Promise<{ out: any, a: any }>} */
      const first = async () => {
        try { return await one(main, q.model); }
        catch (e) { if (/** @type {any} */ (e).kind !== "rate_limit") throw e; await new Promise(r => setTimeout(r, o.retryMs ?? 2000)); return one(main, q.model); }
      };
      try {
        const { out, a } = await first();
        return { ...out, answered: { which: "main", label: String(a.label), provider: String(a.provider) } };
      } catch (e) {
        const x = /** @type {any} */ (e);
        if (!q.fallback || !FALLBACK_KINDS.includes(x.kind)) throw e;
        try {
          const { out, a } = await one(q.fallback, undefined);
          return { ...out, answered: { which: "fallback", label: String(a.label), provider: String(a.provider), main_label: String(x.account_label), main_kind: x.kind } };
        } catch (f) {
          const y = /** @type {any} */ (f);
          // both failed: the step fails with both reasons, and the main account's name stays on it for the card
          throw Object.assign(new Error(`Main ${x.account_label} ${kindWords(x.kind)}, and the fallback ${y.account_label} failed too: ${String(y.message || "").slice(0, 200)}`), { code: y.code || x.code, kind: x.kind, account_label: x.account_label });
        }
      }
    },
  };
}
