// @ts-check
// extract: turn the person's own words into intents the Gate can match (P17, "asking is approving").
//
// Pipeline: cut the turn to its first 2 KB, take out what the person quoted or pasted
// (quote.js), ask a fast model that sees nothing but those words and the local time (prompt.js),
// then validate() its answer. validate() is the security core. The model is never trusted: every
// recipient, amount, channel, time and the ask itself must be backed by the person's own unquoted
// words, or the intent is dropped. Dropping is always safe: a dropped intent means the act is held
// for the person's confirmation, as it would be without P17.
//
// No state, no I/O, no imports from core. The model call is injected as ask(system, user).

import { unquoted } from "./quote.js";
import { SYSTEM, userMessage } from "./prompt.js";

export const KINDS = ["send", "post", "pay", "act_out", "change"];
export const CHANNELS = ["email", "slack", "sms", "calendar", "github", "web"];
export const MAX_INTENTS = 10;
export const MAX_BYTES = 2048;
export const MAX_DAYS = 400;
export const DEFAULT_WINDOW = 120;
export const MIN_WINDOW = 5;
export const MAX_WINDOW = 1440;
/** How far in the past a named time may be (a model resolving "at 9" at 9:20). */
export const PAST_SLACK_MIN = 60;

const DAY = 86_400_000;
const MIN = 60_000;

// ------------------------------------------------------------------ words

const norm = s => String(s ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does phrase appear in text as a whole word or phrase? Case-insensitive, whitespace-normalised.
 * "Sam" is not in "same", "priya" is not in "priya@harlow.example".
 * @param {string} text @param {string} phrase
 */
export function appears(text, phrase) {
  const p = norm(phrase);
  if (!p) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}_@.#+-])${esc(p)}($|[^\\p{L}\\p{N}_@-])`, "u").test(norm(text));
}

/** Every number written in the text, commas removed: "$1,200.50" is 1200.5. */
export function numbers(text) {
  return (String(text).match(/\d[\d,]*(?:\.\d+)?/g) || []).map(n => Number(n.replace(/,/g, ""))).filter(Number.isFinite);
}

// A channel counts only when a word for it is in the person's text.
const CHANNEL_WORDS = {
  email: /\b(e-?mails?|mail|gmail|inbox)\b|[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}/i,
  slack: /\bslack\b|(^|[\s(])#[a-z][\w-]*/i,
  sms: /\b(text|texts|texting|sms|imessage)\b/i,
  calendar: /\b(calendar|invite|invites|invitation|meeting|meetings)\b/i,
  github: /\b(github|pr|prs|pull\s+requests?|issues?|comments?)\b/i,
  web: /\b(web|website|site|form|page|online|browser|portal|checkout|cart)\b|https?:\/\//i,
};

// The verbs that make each kind an ask. A verb counts only when it is not negated, not a noun
// ("a reply", "Priya's email"), not in a question the person asked, not in a conditional, and not
// the person talking about themselves ("I need to pay").
const V = s => new RegExp(`\\b(?:${s})\\b`, "gi");
const VERBS = {
  send: V("send|resend|remind|nudge|email|e-mail|mail|reply|respond|forward|fwd|text|message|ping|dm|tell|invite|answer|accept|decline|rsvp|cc|let\\s+[\\w@.'-]+(?:\\s+[\\w@.'-]+)?\\s+know|write\\s+back|get\\s+back\\s+to|confirm\\s+with|share"),
  post: V("post|share|publish|announce|tweet|comment|reply|put|drop|pin|push|open|file|merge|approve|close|react|send|leave|add"),
  pay: V("pay|transfer|send|tip|venmo|reimburse|refund|wire|buy|purchase|settle|cover"),
  act_out: V("submit|buy|purchase|order|book|reserve|sign\\s+up|register|apply|fill\\s+(?:in|out)|complete|check\\s*out|place|rsvp|post|click|pay|subscribe|cancel|renew|accept|confirm|enroll|donate|send"),
  change: V("allow|let|permit|enable|disable|turn|stop|start|set|change|grant|revoke|mute|unmute|trust|untrust|switch|remove|add|block|unblock|give|make|update|pause|resume"),
};
const ALL_VERBS = V(Object.values(VERBS).map(v => v.source.slice(5, -3)).join("|"));
const REPLY = V("reply|respond|answer|write\\s+back|get\\s+back\\s+to|tell\\s+(?:him|her|them)|let\\s+(?:him|her|them)\\s+know");
const STANDING = /\b(from\s+now\s+on|going\s+forward|always|whenever|every\s*(time|day|week|month|morning|evening|friday|monday|tuesday|wednesday|thursday|saturday|sunday)?|each\s+(time|day|week|month)|any\s*time|auto(matically)?|without\s+(asking|checking)|don'?t\s+(need\s+to\s+)?ask|no\s+need\s+to\s+ask|standing|until|recurring|weekly|monthly|daily|you\s+can|you\s+may|feel\s+free|(are|you'?re)\s+allowed|ok(ay)?\s+to|permission)\b/i;

const DETERMINERS = new Set("a an the my your his her their this that our its any no some which what those these another every each".split(" "));
const ARTICLES = new Set("a an the my your his her their this that our its".split(" "));
const NEGATIONS = new Set("don't dont not never no without can't cannot won't shouldn't mustn't hold stop avoid nobody nothing".split(" "));
const SELF = new Set("i i'll i'm i've i'd we we'll we're we've he she they he'll she'll they'll will would should might must has have had was were is are did does remind remember forgot maybe wanted".split(" "));
// Words that make a verb a description, not an ask: "juno's permission to pay", "how to reply".
for (const w of "permission access able how whether".split(" ")) SELF.add(w);
const ADDRESSED = new Set("you please pls kindly".split(" "));
const INTERROGATIVE = /^(did|do|does|have|has|had|was|were|is|are|what|when|who|whom|why|how|where|which|whose|should|shall|am)\b/i;
const CONDITIONAL_ANYWHERE = /\b(if|once|unless|as\s+soon\s+as|in\s+case|provided\s+that|assuming)\b/i;
const CONDITIONAL_START = /^(when|after|before)\b/i;
const CONDITIONAL_OK = /\b(if\s+you\s+can|if\s+possible|if\s+you\s+don'?t\s+mind|if\s+that'?s\s+(ok|okay|fine|alright)|when\s+you\s+(get\s+a\s+chance|can|have\s+a\s+(sec|second|minute|moment)))\b/gi;

/**
 * The person's text as sentences, each split into clauses, with whether each sentence may carry
 * an ask. A dot inside an address or an amount does not end a sentence.
 * @param {string} text
 * @returns {{ clause: string, sentence: string, ok: boolean }[]}
 */
export function clauses(text) {
  const out = [];
  const sentences = [];
  let last = 0;
  const re = /([.!?]+)(?=\s|$)|\n+/g;
  let m;
  while ((m = re.exec(text))) {
    const s = text.slice(last, m.index).trim();
    if (s) sentences.push({ s, q: /\?/.test(m[1] || "") });
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) sentences.push({ s: tail, q: false });
  for (const { s, q } of sentences) {
    const plain = s.replace(/^(also|and|then|ok|okay|so|but|oh|great|thanks|cool|yes|no)\b[,\s]*/i, "");
    const question = q && INTERROGATIVE.test(plain);
    const standing = STANDING.test(s);
    const stripped = s.replace(CONDITIONAL_OK, " ");
    const conditional = !standing && (CONDITIONAL_ANYWHERE.test(stripped) || CONDITIONAL_START.test(plain.replace(CONDITIONAL_OK, " ").trim()));
    const ok = !question && !conditional;
    for (const c of s.split(/;|,\s*(?:and|then|but|also)\s+|\s+but\s+|\s+(?:and|then)\s+(?=(?:don'?t|do\s+not|never|not|no)\b)/i)) {
      if (c.trim()) out.push({ clause: c.trim(), sentence: s, ok });
    }
  }
  return out;
}

/**
 * What one verb match is: "noun" ("a reply", "the Slack post", "Priya's email"), "no" (negated,
 * drafted, the person talking about themselves, or aimed at the person: "tell me"), or "ask".
 * @param {string} clause @param {RegExpExecArray} m
 * @returns {"noun"|"no"|"ask"}
 */
function reading(clause, m) {
  // Only the words since the last comma or colon: "about a deadline, reply" is a verb.
  const before = norm(clause.slice(0, m.index)).split(/[,:;\u2014]|\s-\s/).pop().split(/\s+/).filter(Boolean);
  const prev = before.slice(-3);
  const last = prev[prev.length - 1];
  if (last && (/'s$/.test(last) || DETERMINERS.has(last) || ARTICLES.has(prev[prev.length - 2]))) return "noun";
  // Drafting is not sending: "draft a reply", "compose an email" (but "draft and send" is).
  const d = prev.findIndex(w => /^(draft|drafts|drafting|compose|composing|prepare|preparing|write|writing|unsent)$/.test(w));
  if (d >= 0 && !prev.slice(d + 1).some(w => /^(and|then)$/.test(w))) return "no";
  const n = prev.findIndex(w => NEGATIONS.has(w));
  if (n >= 0 && !prev.slice(n).some(w => /^(forget|hesitate|wait)$/.test(w))) return "no";
  if (!prev.some(w => ADDRESSED.has(w)) && prev.some(w => SELF.has(w))) return "no";
  // "tell me", "send us", "let me know": to the person, not outward.
  if (/\b(me|us|myself)\b/i.test(m[0]) || /^\s+(me|us|myself)\b/i.test(clause.slice(m.index + m[0].length))) return "no";
  return "ask";
}

/** Does the matched verb text belong to this kind's verbs? */
const isKind = (word, verbs) => new RegExp(`^(?:${verbs.source})$`, "i").test(word);

/**
 * Is there a verb in this clause, of these verbs, that reads as an ask of the assistant?
 * @param {string} clause @param {RegExp} verbs
 */
export function asks(clause, verbs) {
  const re = new RegExp(verbs.source, verbs.flags);
  let m;
  while ((m = re.exec(clause))) if (reading(clause, m) === "ask") return true;
  return false;
}

/**
 * Is the recipient at pos governed by an asked verb of this kind? The governing verb is the
 * nearest verb before it ("send Jordan the invoice and remind me to pay Maya": Maya's verb is
 * "pay", and it is not asked). In a standing sentence the verb may come after ("whenever
 * Northwind Bakery invoices, pay it").
 * @param {string} clause @param {number} pos @param {string} kind @param {boolean} standing
 */
export function governs(clause, pos, kind, standing) {
  const all = [...clause.matchAll(new RegExp(ALL_VERBS.source, "gi"))].filter(m => reading(clause, m) !== "noun");
  // A verb that starts before the recipient governs it, so "let Jordan know" covers Jordan.
  const before = all.filter(m => /** @type {number} */ (m.index) < pos);
  const after = all.filter(m => /** @type {number} */ (m.index) >= pos);
  const m = before.length ? before[before.length - 1] : (standing ? after[0] : undefined);
  return Boolean(m && isKind(m[0].replace(/\s+/g, " "), VERBS[kind]) && reading(clause, m) === "ask");
}

/** Where phrase appears in text as a whole word or phrase, as indexes into norm(text). */
function positions(text, phrase) {
  const p = norm(phrase);
  if (!p) return [];
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_@.#+-])(${esc(p)})(?=$|[^\\p{L}\\p{N}_@-])`, "gu");
  return [...norm(text).matchAll(re)].map(m => /** @type {number} */ (m.index) + m[1].length);
}

// ------------------------------------------------------------------ parsing the model

/** The model's answer as an object, leniently: code fences and chatter around the JSON ignored. */
export function parse(raw) {
  if (raw && typeof raw === "object") return raw;
  let s = String(raw ?? "").replace(/```(?:json)?/gi, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  const c = s.indexOf("["), d = s.lastIndexOf("]");
  const tries = [];
  if (a >= 0 && b > a) tries.push(s.slice(a, b + 1));
  if (c >= 0 && d > c) tries.push(s.slice(c, d + 1));
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      return Array.isArray(v) ? { intents: v } : v;
    } catch { /* try the next */ }
  }
  return null;
}

/** A time the model gave, as ms; a time without an offset takes the person's local offset. */
function when(v, localTime) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") return NaN;
  let s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/i.test(s)) return NaN;
  const off = /([+-]\d{2}:\d{2}|Z)$/i.exec(String(localTime || ""));
  if (/T/.test(s) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += off ? off[1] : "Z";
  if (!/T/.test(s)) s += "T00:00:00" + (off ? off[1] : "Z");
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/** Offset of the person's local time, to write times back in it. */
function isoIn(ms, localTime) {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(String(localTime || ""));
  if (!m) return new Date(ms).toISOString();
  const mins = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  return new Date(ms + mins * MIN).toISOString().replace(/\.\d{3}Z$/, `${m[1]}${m[2]}:${m[3]}`);
}

const CURRENCY_WORDS = {
  USD: /\$|\busd\b|\bdollars?\b|\bbucks\b/i,
  EUR: /€|\beur\b|\beuros?\b/i,
  GBP: /£|\bgbp\b|\bpounds?\b|\bquid\b/i,
};

// ------------------------------------------------------------------ validate

/**
 * @typedef {{ kind: string, channel: string|null, to: string[], what: string,
 *   when: { at: string|null, window_minutes: number },
 *   standing: boolean, limits: { amount_max: number|null, currency: string|null, count: number|null, until: string|null },
 *   reply_to_current: boolean }} Intent
 */

/**
 * Check the model's answer against the person's own unquoted words. Anything the words do not
 * back is dropped, with the reason. Never throws.
 * @param {any} raw the model's answer (text or parsed)
 * @param {string} text the person's turn after unquoted()
 * @param {{ localTime?: string, now?: number|string|Date }} [opts]
 * @returns {{ intents: Intent[], dropped: { reason: string, intent: any }[] }}
 */
export function validate(raw, text, { localTime, now } = {}) {
  const dropped = [];
  const intents = [];
  const obj = parse(raw);
  const list = obj && Array.isArray(obj.intents) ? obj.intents : null;
  if (!list) {
    if (raw !== null && raw !== undefined && String(raw).trim()) dropped.push({ reason: "unparseable", intent: String(raw).slice(0, 200) });
    return { intents, dropped };
  }
  const words = String(text ?? "");
  const nowMs = toMs(now) ?? toMs(localTime) ?? Date.now();
  const cl = clauses(words);
  const nums = numbers(words);

  for (const x of list) {
    const why = check(x);
    if (typeof why === "string") { dropped.push({ reason: why, intent: x }); continue; }
    if (intents.length >= MAX_INTENTS) { dropped.push({ reason: "cap", intent: x }); continue; }
    intents.push(why);
  }
  return { intents, dropped };

  /** @returns {string|Intent} a drop reason, or the clean intent */
  function check(x) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return "schema";
    if (!KINDS.includes(x.kind)) return "schema_kind";
    const channel = x.channel === undefined || x.channel === null || x.channel === "null" ? null : x.channel;
    if (channel !== null && !CHANNELS.includes(channel)) return "schema_channel";
    const to = x.to === undefined || x.to === null ? [] : x.to;
    if (!Array.isArray(to) || to.length > 10 || to.some(t => typeof t !== "string" || !t.trim() || t.length > 200)) return "schema_to";
    if (x.what !== undefined && x.what !== null && typeof x.what !== "string") return "schema_what";
    for (const k of ["standing", "reply_to_current"]) if (x[k] !== undefined && x[k] !== null && typeof x[k] !== "boolean") return `schema_${k}`;
    const w = x.when ?? {};
    if (typeof w !== "object" || Array.isArray(w)) return "schema_when";
    const l = x.limits ?? {};
    if (typeof l !== "object" || Array.isArray(l)) return "schema_limits";
    const amount = l.amount_max ?? null;
    if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0)) return "schema_amount";
    const count = l.count ?? null;
    if (count !== null && (!Number.isInteger(count) || count < 1 || count > 1000)) return "schema_count";
    const win = w.window_minutes ?? null;
    if (win !== null && (typeof win !== "number" || !Number.isFinite(win))) return "schema_window";
    let currency = l.currency ?? null;
    if (currency !== null && (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency))) return "schema_currency";
    currency = currency && currency.toUpperCase();

    const standing = x.standing === true;
    const reply = x.reply_to_current === true;

    // Every recipient is the person's own word, and sits in a clause where they asked for this kind.
    for (const t of to) {
      if (!appears(words, t)) return "to_not_said";
      const backed = cl.some(c => c.ok && positions(c.clause, t).some(pos => {
        const nc = norm(c.clause);
        // "the Harlow Legal invoice" names a thing, not who a message goes to.
        const lead = nc.slice(0, pos).trim().split(/\s+/).pop() || "";
        if (x.kind === "send" && ARTICLES.has(lead)) return false;
        return governs(nc, pos, x.kind, STANDING.test(c.sentence));
      }));
      if (!backed) return "to_not_asked";
    }
    // The ask itself.
    if (!cl.some(c => c.ok && asks(c.clause, VERBS[x.kind]))) return "not_asked";
    // Every intent names what it acts on: people for send and pay, the channel or place for post
    // and act_out, the setting or agent for change. Only a reply to the message in front of the
    // person may leave it out. An intent with no target would match any call of its kind.
    if (!to.length && !(reply && (x.kind === "send" || x.kind === "post"))) return "no_target";
    if (reply && !cl.some(c => c.ok && asks(c.clause, REPLY))) return "reply_not_said";
    if (channel && !CHANNEL_WORDS[channel].test(words)) return "channel_not_said";
    if (standing && !STANDING.test(words)) return "standing_not_said";
    // Money: the amount is a number the person wrote, in a currency they named.
    if (x.kind === "pay" && amount === null) return "pay_no_amount";
    if (amount !== null && !nums.includes(amount)) return "amount_not_said";
    if (x.kind === "pay" || amount !== null) {
      if (!currency) return "currency_not_said";
      const named = CURRENCY_WORDS[currency] || new RegExp(`\\b${currency}\\b`, "i");
      if (!named.test(words)) return "currency_not_said";
    }
    // Time.
    const at = when(w.at, localTime);
    if (Number.isNaN(at)) return "when_unparseable";
    if (at !== null && at > nowMs + MAX_DAYS * DAY) return "when_too_far";
    if (at !== null && at < nowMs - PAST_SLACK_MIN * MIN) return "when_past";
    const until = when(l.until, localTime);
    if (Number.isNaN(until)) return "until_unparseable";
    if (until !== null && (until > nowMs + MAX_DAYS * DAY || until < nowMs)) return "until_out_of_range";
    const window = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, win === null ? DEFAULT_WINDOW : Math.round(win)));

    return {
      kind: x.kind,
      channel,
      to: to.map(t => t.trim()),
      what: typeof x.what === "string" ? x.what.slice(0, 200) : "",
      when: { at: at === null ? null : isoIn(at, localTime), window_minutes: window },
      standing,
      limits: { amount_max: amount, currency, count, until: until === null ? null : isoIn(until, localTime) },
      reply_to_current: reply,
    };
  }
}

function toMs(v) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

// ------------------------------------------------------------------ extract

/**
 * The person's intents in one turn.
 * @param {string} text the turn as the person typed it
 * @param {{ tz?: string, localTime?: string, now?: number|string|Date }} ctx
 * @param {{ ask: (system: string, user: string) => Promise<string> }} deps
 * @returns {Promise<{ intents: Intent[], quoted: number, dropped: { reason: string, intent: any }[], truncated: boolean, error?: string }>}
 */
export async function extract(text, { tz, localTime, now } = {}, { ask }) {
  let s = String(text ?? "");
  const bytes = Buffer.from(s, "utf8");
  const truncated = bytes.length > MAX_BYTES;
  if (truncated) s = bytes.subarray(0, MAX_BYTES).toString("utf8").replace(/�+$/, "");
  const u = unquoted(s);
  const base = { quoted: u.quoted.length, truncated };
  if (!/[\p{L}\p{N}]/u.test(u.text)) return { intents: [], dropped: [], ...base };
  let raw;
  try { raw = await ask(SYSTEM, userMessage(u.text, { tz, localTime })); }
  catch (e) { return { intents: [], dropped: [], ...base, error: String(/** @type {Error} */ (e)?.message || e).slice(0, 200) }; }
  const v = validate(raw, u.text, { localTime, now });
  return { intents: v.intents, dropped: v.dropped, ...base };
}
