// @ts-check
// "What an agent may do by itself" (standing permissions): the words for a row and the call the add sheet makes, without a screen. The box keeps the grants (gate.standing.*) and
// decides every act; this only reads what it says and builds the calls.

/** @typedef {{ id: string, agent: string, by?: string, resource: string, to?: { patterns?: string[], lists?: string[] }, daily_cap?: number, max_amount?: number, daily_amount?: number, currency?: string, expires?: number, use?: { count?: number, last?: { at: number, to?: string[] }[] } }} Permission */

export const FOLLOW_WARNING = "Anyone who can edit these lists can change who this agent sends to.";
export const NONE = "This agent asks you each time it wants to send, post or pay.";

/** "send" | "post" | "spend" and the connection, from the grant's resource. @param {string} resource */
export function kindAndVia(resource) {
  const m = /\/outbox\/(send|post|spend)(?:\/(.+))?$/.exec(String(resource || ""));
  return { kind: m ? m[1] : "send", via: m && m[2] ? m[2] : "" };
}

/** @param {string} kind */
export const kindWord = (kind) => (kind === "spend" ? "Pay" : kind === "post" ? "Post" : "Send");

/** @param {number} at @param {number} now */
const day = (at, now) => {
  const d = Math.max(0, Math.round((now - at) / 86_400_000));
  return d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

/**
 * One row: the kind and connection as the title, recipient chips, the daily cap and what it has done so far.
 * @param {Permission} p @param {(via: string) => string} [nameOf] @param {number} [now]
 */
export function rowView(p, nameOf = (v) => v, now = Date.now()) {
  const { kind, via } = kindAndVia(p.resource);
  const to = p.to || {};
  const chips = [...(to.patterns || []), ...(to.lists || []).map((l) => `List ${l}`)];
  const cap = kind === "spend"
    ? `Up to ${p.max_amount} ${p.currency || ""} each, ${p.daily_amount} a day`.replace("  ", " ")
    : `Up to ${p.daily_cap} a day`;
  const n = (p.use && p.use.count) || 0;
  const last = (p.use && p.use.last) || [];
  const used = n ? `${n} ${n === 1 ? "time" : "times"}, last ${day(last.length ? last[last.length - 1].at : now, now)}` : "Not used yet";
  const ends = p.expires ? `Ends ${new Date(p.expires).toISOString().slice(0, 10)}` : "";
  return {
    id: p.id,
    title: `${kindWord(kind)}${via ? ` from ${nameOf(via)}` : ""}`,
    chips,
    meta: [cap, used, ends].filter(Boolean).join(" · "),
    following: Boolean(to.lists && to.lists.length),
    recent: last.slice(-3).reverse().map((l) => `${day(l.at, now)}${l.to && l.to.length ? ` to ${l.to.join(", ")}` : ""}`),
  };
}

/** The recipients a person typed: addresses, *@domain, and lists (contact:id, project:id:clients), split on commas, spaces and lines. @param {string} typed */
export function splitTo(typed) {
  const items = String(typed || "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  const lists = items.filter((x) => /^(contact:|project:)/.test(x));
  return { patterns: items.filter((x) => !lists.includes(x)), lists };
}

/**
 * The call the add sheet makes, or the line to show when the form is not enough.
 * @param {{ agent: string, kind: string, via: string, to: string, cap: string, max: string, day: string, currency: string, follow: boolean, days: string }} f @param {number} [now]
 */
export function addCall(f, now = Date.now()) {
  const to = splitTo(f.to);
  if (!to.patterns.length && !to.lists.length) return { problem: "Name who it may go to: an address, *@domain, or a list." };
  const input = /** @type {Record<string, any>} */ ({ agent: f.agent, kind: f.kind, to: { ...(to.patterns.length ? { patterns: to.patterns } : {}), ...(to.lists.length ? { lists: to.lists } : {}) } });
  if (f.via) input.via = f.via;
  if (to.lists.length && f.follow) input.follow_lists = true;
  if (f.kind === "spend") {
    const max = Number(f.max), dayMax = Number(f.day);
    if (!(max > 0)) return { problem: "Set the most it may pay at once." };
    if (!(dayMax >= max)) return { problem: "The daily limit cannot be less than one payment." };
    if (!/^[A-Za-z]{3}$/.test(String(f.currency || "").trim())) return { problem: "Name the currency, like USD." };
    Object.assign(input, { max_amount: max, daily_amount: dayMax, currency: f.currency.trim().toUpperCase() });
  } else {
    const cap = Number(f.cap);
    if (!Number.isInteger(cap) || cap < 1 || cap > 1000) return { problem: "Set how many it may do a day, from 1 to 1000." };
    input.daily_cap = cap;
  }
  if (String(f.days || "").trim()) {
    const d = Number(f.days);
    if (!(d >= 1 && d <= 365)) return { problem: "Set the days it lasts from 1 to 365, or leave it empty." };
    input.expires = now + Math.round(d) * 86_400_000;
  }
  return { tool: "gate.standing.add", input };
}

/** What the page says when a call is refused. @param {string | undefined} code @param {string} message */
export const refusal = (code, message) => (code === "denied" ? message || "Only an owner, an admin or this agent's owner can do that." : code === "presence_required" || code === "presence_denied" ? "This needs your approval. Approve on this device, then try again." : message || "That did not go through.");

/** The name the Gate gives a connection when it sends through it: `mail:<id>` for a mail login, `google:<id>` for a Google account. Others cannot be named yet. @param {{ id: string, provider: string }} c */
export const viaOf = (c) => (c.provider === "imap-smtp" ? `mail:${c.id}` : /^google/.test(c.provider) ? `google:${c.id}` : "");
