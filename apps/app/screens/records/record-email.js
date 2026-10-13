// @ts-check
// The pure half of a record's Email: who it can be sent from, the one tool call each choice makes (the existing ones: comms.email through the firm's sending service, mail.send through a mail
// login), the two address searches that find the contact's mail, and the plain words for a send that is held at the Gate. Nothing here sends.

const EMAIL = /^[^\s@<>(),;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}$/;
/** @param {unknown} v */
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? /** @type {any} */ (v) : null);

/** The From picker: comms.credentials' answer as choices. @param {unknown} list */
export function fromChoices(list) {
  return (Array.isArray(list) ? list : []).filter((c) => obj(c) && c.id && c.step).map((c) => ({ id: String(c.id), step: String(c.step), provider: String(c.provider || ""), label: c.account ? `${c.name} (${c.account})` : String(c.name || c.id) }))
    .sort((a, b) => Number(b.step === "comms.email") - Number(a.step === "comms.email"));
}

/** @param {{ to: string, subject: string, body: string }} d @returns {string | null} */
export function checkDraft(d) {
  if (!EMAIL.test(String(d.to || "").trim())) return "Type an email address to send to.";
  if (!String(d.subject || "").trim()) return "Give it a subject.";
  if (!String(d.body || "").trim()) return "Write something to say.";
  return null;
}

/** The call a choice makes. @param {{ id: string, step: string }} choice @param {{ to: string, subject: string, body: string }} d */
export function sendCall(choice, d) {
  const to = [String(d.to).trim()];
  if (choice.step === "comms.email") return { tool: "comms.email", input: { to, subject: d.subject, text: d.body } };
  return { tool: "mail.send", input: { to, subject: d.subject, body: d.body, account: choice.id } };
}

/** The searches that find a contact's mail: from the address and to it. @param {string} email */
export function threadQueries(email) { const e = String(email).trim().toLowerCase(); return [`from:${e}`, `to:${e}`]; }

/** The searches' messages as one list: no repeats, newest first, junk dropped. @param {unknown[]} lists */
export function mergeThreads(lists) {
  /** @type {Map<string, any>} */ const seen = new Map();
  for (const l of lists) for (const m of Array.isArray(l) ? l : []) { const o = obj(m); if (o && o.id) seen.set(`${o.account || ""}:${o.id}`, o); }
  return [...seen.values()].sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
}

/** What the person is told after pressing Send. @param {unknown} r */
export function heldWords(r) {
  const o = obj(r);
  return o && o.held ? "It is waiting for your yes. Nothing has gone out yet; open Approvals to read the final words and send it." : "Vyre did not hold that email, so nothing was sent.";
}

/** The one line a member sees where the owner sees Email. */
export const MEMBER_LINE = "Sending from the firm's account is for owners.";

/** Did the box refuse this person (a member on the owner's door), as opposed to failing? @param {unknown} e */
export function refusedForMember(e) {
  const o = obj(e);
  if (!o) return false;
  if (["denied", "forbidden", "not_allowed", "no_such_tool", "not_found_for_member"].includes(String(o.code))) return true;
  return /for the owner|owner and admins|owners only|not allowed for/i.test(String(o.message || ""));
}
