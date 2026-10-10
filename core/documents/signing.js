// signing: the Flow that signs a document from a stage (R032-05). Flows orchestrate, Documents files, Comms delivers; this is the wiring a firm asks for in one sentence ("when a matter reaches
// Out for signature, send the engagement letter; when it is signed, move it on"), written as a plain Flow definition the person reads, edits and approves like any other.
//
// When a <type> enters <out stage>: if it has not been sent yet, send it for signature (documents.send makes the request, with no e-mail from the signing engine, and emails the signer their link
// through Comms: one act, one yes, so the final words are the person's), remember its number on the record, then WAIT for Documents to say that document was signed and move the record to
// <signed stage>. The signed copy is filed on the client by the Documents Flow that ships with the app, and documents.send-signed emails the signer a link to it that does not expire unless the person set documents.signed_link_days
// (the second and last yes). Nothing here runs anything; it only returns the definition.
//
// (The number is joined to text with + so a record field of kind text takes it. A module's event reaches a wait as the log carries it: its facts are under event.data.payload.)

const NAME = /^[a-z][a-z0-9_-]{0,40}$/;
const bad = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "bad_input" });

/**
 * @param {{ type: string, out_stage: string, signed_stage: string, template_id: number, email_field?: string, name_field?: string, contact_field?: string, submission_field?: string, signed_field?: string, subject?: string, wait_days?: number }} o
 * @returns {any} the Flow definition
 */
export function signingFlow(o) {
  // The person who signs is on the record itself (an e-mail field) or is the Contact the record links to (contact_field: a Kit's own types, like a client or a project, hold a link, not an address).
  // With a Contact there is no field to remember the request in unless one is named, so the stage's one run per entry is the guard.
  const contact = o.contact_field || "";
  const type = String(o.type || ""), email = o.email_field || (contact ? "" : "email"), name = o.name_field || "", field = o.submission_field !== undefined ? o.submission_field : contact ? "" : "signature_submission";
  for (const [k, v] of Object.entries({ type, email, field, contact })) if (v && !NAME.test(String(v))) throw bad(`${k} must be a record type or field name (lowercase letters, digits, - and _)`);
  if (type === "" || (!email && !contact)) throw bad("name the record type and where the signer is: email_field, or contact_field for a linked Contact");
  if (contact && o.email_field) throw bad("name email_field or contact_field, not both");
  if (o.signed_field && !NAME.test(String(o.signed_field))) throw bad("signed_field must be a field name");
  if (name && !NAME.test(name)) throw bad("name_field must be a field name");
  if (!o.out_stage || !o.signed_stage) throw bad("name the stage that sends it and the stage it moves to once signed");
  if (!Number.isInteger(o.template_id) || o.template_id < 1) throw bad("template_id is the number of the signing template in Documents");
  const days = o.wait_days === undefined ? 30 : o.wait_days;
  if (!Number.isInteger(days) || days < 1 || days > 365) throw bad("wait_days is how many days to wait for the signature (1 to 365)");
  const mine = `steps.rec.record.data.${email}`;
  // who signs, as the send tools take it: an address (and a name) read off the record, or the Contact link itself, which Documents reads
  const who = contact ? { contact: { expr: `steps.rec.record.data.${contact}` } } : { email: { expr: mine }, ...(name ? { signer: { expr: `steps.rec.record.data.${name}` } } : {}) };
  const guard = field ? `steps.rec.found and not steps.rec.record.data.${field}` : "steps.rec.found";
  return {
    format: 1, name: `sign_${type}`, label: `Send a ${type} for signature`, authorship: "human",
    description: `When a ${type} enters ${o.out_stage}, send it for signature, remember it on the ${type}, move the ${type} to ${o.signed_stage} when it is signed, and email the signer their signed copy.`,
    trigger: { on: "stage", type, stage: o.out_stage },
    steps: [
      { id: "rec", kind: "pick", type, where: "record.id == trigger.id" },
      // sent once: a record that already carries a signing request (or is being sent one) is left alone
      { id: "once", kind: "decide", if: guard, then: [
        ...(field ? [{ id: "claim", kind: "update", type, record: { expr: "trigger.id" }, set: { [field]: "sending" } }] : []),
        // the request and the email that carries the link are one act with one yes: the person reads the words, and the engine sends nothing of its own
        { id: "send", kind: "call", action: "documents.send", resource: "vyre://space/documents", input: { template_id: o.template_id, ...who,
          ...(o.subject ? { subject: o.subject } : {}) } },
        ...(field ? [{ id: "mark", kind: "update", type, record: { expr: "trigger.id" }, set: { [field]: { expr: `"" + steps.send.submission` } } }] : []),
        { id: "signed", kind: "wait", event: "documents.signed", where: `"" + event.data.payload.submission == "" + steps.send.submission`, timeout_ms: days * 86_400_000, on_timeout: "fail" },
        // a type whose rules ask for it (the Estate matter: engagement_signed before Drafting) is told it was signed before the move
        ...(o.signed_field ? [{ id: "mark_signed", kind: "update", type, record: { expr: "trigger.id" }, set: { [o.signed_field]: true } }] : []),
        { id: "move", kind: "stage", type, record: { expr: "trigger.id" }, to: o.signed_stage },
        // the finished copy goes to the signer by a link that does not expire unless the person set documents.signed_link_days: the link and the email are one act, and it rides the yes to the request (`with`): the person reads both on the first card and says yes once
        { id: "copy", kind: "call", with: "send", action: "documents.send-signed", resource: "vyre://space/documents", input: { slug: { expr: "steps.send.slug" }, ...(contact ? { contact: who.contact } : { email: { expr: mine } }) } },
      ], else: [] },
    ],
  };
}
