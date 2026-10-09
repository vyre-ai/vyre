// @ts-check
// A sent email is logged on the client it went to (team/0.3 SPEC part 11.9). When the Gate sends a held email, one Communication is filed for it, linked to every Contact the recipients
// belong to (by main address, then by contact point), with the subject and the first words of the body; the body itself is not copied. It is the same record the "Log communications" Flow
// files for mail it reads, keyed on the Gate item, so a sent message is logged once however many times this runs. It reads the Gate item for what went out and writes records under the
// Space owner's chain; it sends nothing.
import { logCommunication, normalizeEmail, normalizePhone } from "../../records/comms/log.js";

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

/** The headers and plain text of an RFC 822 message as Gmail's send takes it (base64url `raw`). Null when it is not one. @param {any} raw @returns {{ subject: string, body: string, to: string, cc: string, bcc: string } | null} */
export function parseRaw(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let text;
  try { text = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { return null; }
  const cut = text.search(/\r?\n\r?\n/);
  const head = (cut < 0 ? text : text.slice(0, cut)).replace(/\r?\n[ \t]+/g, " ");
  const body = cut < 0 ? "" : text.slice(cut).replace(/^\r?\n\r?\n/, "");
  /** @param {string} n */ const h = n => { const m = new RegExp(`^${n}:[ \\t]*(.*)$`, "im").exec(head); return m ? m[1].trim() : ""; };
  const decode = (/** @type {string} */ v) => v.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_m, enc, t) => (enc.toLowerCase() === "b" ? Buffer.from(t, "base64").toString("utf8") : t.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_x, hex) => String.fromCharCode(parseInt(hex, 16)))));
  if (!h("to") && !h("subject")) return null;
  return { subject: decode(h("subject")), body, to: h("to"), cc: h("cc"), bcc: h("bcc") };
}

/**
 * What an email that went out says, from the Gate item: the Gate's own email shape (subject, body, cc), or a Gmail send made through a Connection (the raw message in the request).
 * @param {any} item @param {string[]} dest @returns {{ subject: string, body: string, dest: string[], final: any } | null}
 */
export function emailOf(item, dest) {
  const final = item.final || item.draft || {};
  if (typeof final.subject === "string" && typeof final.body === "string") return { subject: final.subject, body: final.body, dest, final };
  const req = final.request && final.request.body;
  const path = typeof final.url === "string" ? final.url : "";
  if (req && /\/gmail\/v1\/users\/[^/]+\/messages\/send(?:[?#]|$)/.test(path)) {
    const m = parseRaw(req.raw);
    if (!m) return null;
    const split = (/** @type {string} */ v) => v.split(",").map(x => x.trim()).filter(Boolean);
    return { subject: m.subject, body: m.body, dest: split(m.to), final: { cc: m.cc, bcc: m.bcc } };
  }
  return null;
}

/** One sent email, filed. @param {{ kernel: any, chain: () => any, call: (tool: string, input: any) => Promise<any>, log?: (m: string) => void, now?: () => number }} d @param {{ id: string, kind?: string, via?: string, to?: string[] }} released */
export async function logSent(d, released) {
  if (!released || released.kind !== "send") return null;
  const r = await d.call("gate.get", { id: released.id });
  const item = r && r.data;
  if (!item || item.state !== "sent") return null;
  // a text goes to numbers with only a body (Comms, via comms:sms)
  if (String(item.via || released.via || "") === "comms:sms") return logText(d, released, item);
  // an email has a subject and a body and goes to addresses; a payment or a post does not
  const mail = emailOf(item, Array.isArray(item.to) ? item.to : released.to || []);
  if (!mail) return null;
  const final = { ...mail.final, subject: mail.subject, body: mail.body };
  const people = recipientsOf(mail.dest, final);
  if (!people.length) return null;
  const at = new Date((d.now || Date.now)()).toISOString();
  const excerpt = final.body.replace(/\s+/g, " ").trim().slice(0, 240);
  const via = String(item.via || released.via || "");
  const done = await logCommunication(d.kernel, d.chain(), { kind: "email", direction: "outbound", at, subject: final.subject.slice(0, 300), ...(excerpt ? { excerpt } : {}), source_key: `gate:${released.id}`,
    ...(via ? { mailbox: via } : {}), people });
  return { id: released.id, logged: done.participants.filter(p => p.contact).length, of: people.length, communication: done.communication && done.communication.urn };
}

/** One sent text, filed on the contacts whose numbers it went to; the words are kept as the excerpt and the number as written. @param {any} d @param {any} released @param {any} item */
async function logText(d, released, item) {
  const final = item.final || item.draft || {};
  const body = typeof final.body === "string" ? final.body : "";
  const to = (Array.isArray(item.to) ? item.to : released.to || []).map((/** @type {any} */ x) => normalizePhone(String(x))).filter((/** @type {string} */ x) => /^\+?\d{7,15}$/.test(x));
  if (!body || !to.length) return null;
  const at = new Date((d.now || Date.now)()).toISOString();
  const done = await logCommunication(d.kernel, d.chain(), { kind: "text", direction: "outbound", at, subject: "", excerpt: body.replace(/\s+/g, " ").trim().slice(0, 240), source_key: `gate:${released.id}`, mailbox: "comms:sms", people: to.map((/** @type {string} */ address) => ({ address, how: "to" })) });
  return { id: released.id, logged: done.participants.filter((/** @type {any} */ p) => p.contact).length, of: to.length, communication: done.communication && done.communication.urn };
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
