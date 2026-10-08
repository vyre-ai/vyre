// @ts-check
// A sent email is logged on the client it went to (team/0.3 SPEC part 11.9). When the Gate sends a held email, one Communication is filed for it, linked to every Contact the recipients
// belong to (by main address, then by contact point), with the subject and the first words of the body; the body itself is not copied. It is the same record the "Log communications" Flow
// files for mail it reads, keyed on the Gate item, so a sent message is logged once however many times this runs. It reads the Gate item for what went out and writes records under the
// Space owner's chain; it sends nothing.
import { logCommunication, normalizeEmail } from "../../records/comms/log.js";

/** The recipients of an email from what the Gate finally sent: the approved `to` first, then cc and bcc as written. @param {string[]} dest @param {any} final */
export function recipientsOf(dest, final) {
  const split = (/** @type {any} */ v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : []).map((/** @type {any} */ x) => String(x).trim()).filter(Boolean);
  const pick = (/** @type {string} */ a) => { const m = /<([^>]+)>/.exec(a); return normalizeEmail(m ? m[1] : a); };
  /** @type {{ address: string, how: string }[]} */ const out = [];
  const seen = new Set();
  for (const [how, list] of /** @type {[string, string[]][]} */ ([["to", dest], ["cc", split(final && final.cc)], ["bcc", split(final && final.bcc)]])) {
    for (const a of list.map(pick)) if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) && !seen.has(a)) { seen.add(a); out.push({ address: a, how }); }
  }
  return out;
}

/** One sent email, filed. @param {{ kernel: any, chain: () => any, call: (tool: string, input: any) => Promise<any>, log?: (m: string) => void, now?: () => number }} d @param {{ id: string, kind?: string, via?: string, to?: string[] }} released */
export async function logSent(d, released) {
  if (!released || released.kind !== "send") return null;
  const r = await d.call("gate.get", { id: released.id });
  const item = r && r.data;
  if (!item || item.state !== "sent") return null;
  const final = item.final || item.draft || {};
  // an email has a subject and a body and goes to addresses; a payment or a post does not
  if (typeof final.subject !== "string" || typeof final.body !== "string") return null;
  const people = recipientsOf(Array.isArray(item.to) ? item.to : released.to || [], final);
  if (!people.length) return null;
  const at = new Date((d.now || Date.now)()).toISOString();
  const excerpt = final.body.replace(/\s+/g, " ").trim().slice(0, 240);
  const via = String(item.via || released.via || "");
  const done = await logCommunication(d.kernel, d.chain(), { kind: "email", direction: "outbound", at, subject: final.subject.slice(0, 300), ...(excerpt ? { excerpt } : {}), source_key: `gate:${released.id}`,
    ...(via ? { mailbox: via } : {}), people });
  return { id: released.id, logged: done.participants.filter(p => p.contact).length, of: people.length, communication: done.communication && done.communication.urn };
}

/**
 * Listen for released emails and log each. Never throws into the Gate: a failure is a line in the log, and the email is already gone.
 * @param {{ events: { on: (type: string, f: (e: any) => void) => any }, kernel: any, chain: () => any, call: (tool: string, input: any) => Promise<any>, log?: (m: string) => void }} d
 */
export function watchSentMail(d) {
  const log = d.log || (() => {});
  return d.events.on("gate.released", (/** @type {any} */ e) => {
    logSent(d, { id: e.payload.id, kind: e.payload.kind, via: e.payload.via, to: e.payload.to }).catch(err => log(`sent-mail log: ${err && err.message ? err.message : err}`));
  });
}
