// @ts-check
// ai-errors: the ONE way a model call's failure is named, for every inference door driver (the API-key HTTP drivers and the Claude, Codex and Grok sign-in drivers), so a caller decides what to do
// next (a Flow's fallback account, a card for the person) from a class and never from a provider's own wording. Six classes:
//   credits      out of credits, quota or spending limit: another account may still have some
//   rate_limit   too many requests, or a subscription's usage limit for now: later, or another account
//   auth         the key or sign-in is wrong, expired or revoked: the person signs in again or adds the key again
//   unavailable  the provider is down, overloaded, unreachable, or did not answer in time; or its CLI is not installed
//   bad_request  the request itself was refused as malformed (too long, a model that does not exist): another account will likely refuse it too
//   refused      a content filter or a safety refusal
// A driver throws `aiError(class, words, { code })`; anything else is read with `aiErrorClass(e)`, which classifies a plain error by its HTTP status and words. A refusal by the door itself (DoorRefusal:
// budget, residency, a sealed value) is not a provider's failure and has no class (null). Nothing here keeps or repeats what a provider said: it is read only to pick the class.

export const AI_ERROR_CLASSES = Object.freeze(/** @type {const} */ (["credits", "rate_limit", "auth", "unavailable", "bad_request", "refused"]));
/** @typedef {typeof AI_ERROR_CLASSES[number]} AiErrorClass */

// What the providers say, as measured from their documented error bodies and CLI outputs (the table in lib/ai-errors.test.js has each one). Read in this order: a content refusal first, then
// credits (OpenAI and OpenRouter say "quota" and "credits" with a 429 or a 402), then a sign-in or key, then a limit, then a provider that is down, then a bad request.
const REFUSED = /content[_ ]?(policy|filter|management)|moderation|flagged|safety (system|policy)|output blocked|responsible ai|cyber_policy|stop_reason"?:\s*"?refusal|declined to (answer|respond)/i;
const CREDITS = /insufficient[_ ](quota|credits?|balance|funds)|credit balance (is )?too low|out of credits|(requires|need) more credits|exceeded your current quota|billing (details|hard limit)|spending limit|doesn'?t have any credits|used all available credits|payment required|\b402\b/i;
const AUTH = /\b401\b|unauthori[sz]ed|authentication[_ ](error|failed|required)|invalid[_ ](api[_ ]?key|x-api-key|bearer|token|grant|credentials?)|incorrect api key|no auth credentials|api key (is )?(invalid|not valid|revoked|expired)|permission[_ ]error|(token|session|credential|login)s? (has |have |was |were )?(expired|been revoked|revoked)|expired (oauth )?(token|session|credential|login)|refresh[_ ]token|token[_ ]expired|log ?out and sign ?in|log ?in again|sign ?in again|run \/login|not (logged|signed) in|login required|please (log|sign) ?in|user not found/i;
const LIMIT = /\b429\b|rate[_ -]?limit|too many requests|usage[_ ]limit|limit (reached|exceeded)|hit your (usage )?limit/i;
const DOWN = /\b(500|502|503|504|520|522|524|529)\b|overloaded|server[_ ]error|internal error|service unavailable|bad gateway|gateway time-?out|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|stream disconnected|no endpoints|provider returned error|high demand|temporarily unavailable|not installed/i;
const BAD = /\b(400|404|413|422)\b|invalid[_ ]request|bad[_ ]request|context[_ ]length|too long|maximum context|model[_ ](not[_ ]found|does not exist)|unknown model|not a valid model/i;

/**
 * The class of one failure, from its HTTP status (when there is one) and its words.
 * @param {{ status?: number | string | null, text?: unknown, timedOut?: boolean, notFound?: boolean }} f @returns {AiErrorClass}
 */
export function classifyAiError(f) {
  if (f.timedOut || f.notFound) return "unavailable";
  const t = String(f.text ?? "");
  const s = Number(f.status) || 0;
  if (REFUSED.test(t)) return "refused";
  if (s === 402 || CREDITS.test(t)) return "credits";
  if (s === 401 || AUTH.test(t)) return "auth";
  if (s === 429 || LIMIT.test(t)) return "rate_limit";
  if (s === 403) return "auth";
  if (s === 408 || s >= 500 || DOWN.test(t)) return "unavailable";
  if ((s >= 400 && s < 500) || BAD.test(t)) return "bad_request";
  return "unavailable";   // a failure nobody named: the provider did not answer as it should
}

/**
 * A driver's failure: plain words for the person, the class for the caller, and the step's code.
 * @param {AiErrorClass} cls @param {string} message @param {{ code?: string, provider?: string }} [o] @returns {Error & { aiClass: AiErrorClass, code?: string }}
 */
export function aiError(cls, message, o = {}) {
  const e = /** @type {any} */ (new Error(message));
  e.aiClass = AI_ERROR_CLASSES.includes(cls) ? cls : "unavailable";
  if (o.code) e.code = o.code;
  if (o.provider) e.provider = o.provider;
  return e;
}

/** The class of anything a door call threw: the class a driver gave it, else read from its words; null for the door's own refusal. @param {unknown} e @returns {AiErrorClass | null} */
export function aiErrorClass(e) {
  const x = /** @type {any} */ (e);
  if (!x) return null;
  if (typeof x.aiClass === "string" && AI_ERROR_CLASSES.includes(x.aiClass)) return x.aiClass;
  if (x.name === "DoorRefusal" || x.refusal) return null;
  return classifyAiError({ status: x.status, text: `${x.code || ""} ${x.message || ""}`, timedOut: x.code === "timeout" || x.name === "TimeoutError" || x.name === "AbortError" });
}
