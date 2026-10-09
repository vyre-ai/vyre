// signing: the Flow that signs a document from a stage (R032-05). Flows orchestrate, Documents files, Comms delivers; this is the wiring a firm asks for in one sentence ("when a matter reaches
// Out for signature, send the engagement letter; when it is signed, move it on"), written as a plain Flow definition the person reads, edits and approves like any other.
//
// When a <type> enters <out stage>: if it has not been sent yet, make the signing request on the Documents connection (no e-mail from the signing engine), remember its number on the record, email
// the signer their link through Comms (held for the person's yes, so the final words are theirs), then WAIT for Documents to say that document was signed and move the record to <signed stage>.
// The signed copy is filed on the client by the Documents Flow that ships with the app, and the signer is emailed a link to it that stops working after 30 days. Nothing here runs anything; it only returns the definition.
//
// (An expression that calls a function on an indexed member is too deep for the Flow language, so the number is joined to text with +.)

const NAME = /^[a-z][a-z0-9_-]{0,40}$/;
const bad = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "bad_input" });

/**
 * @param {{ type: string, out_stage: string, signed_stage: string, template_id: number, email_field?: string, name_field?: string, submission_field?: string, base: string, connection?: string, subject?: string, wait_days?: number }} o
 * @returns {any} the Flow definition
 */
export function signingFlow(o) {
  const type = String(o.type || ""), email = o.email_field || "email", name = o.name_field || "", field = o.submission_field || "signature_submission";
  for (const [k, v] of Object.entries({ type, email, field })) if (!NAME.test(String(v))) throw bad(`${k} must be a record type or field name (lowercase letters, digits, - and _)`);
  if (name && !NAME.test(name)) throw bad("name_field must be a field name");
  if (!o.out_stage || !o.signed_stage) throw bad("name the stage that sends it and the stage it moves to once signed");
  if (!Number.isInteger(o.template_id) || o.template_id < 1) throw bad("template_id is the number of the signing template in Documents");
  const days = o.wait_days === undefined ? 30 : o.wait_days;
  if (!Number.isInteger(days) || days < 1 || days > 365) throw bad("wait_days is how many days to wait for the signature (1 to 365)");
  let base;
  try { const u = new URL(String(o.base)); if (!/^https?:$/.test(u.protocol)) throw 0; base = u.origin; } catch { throw bad("base is the address people sign at, such as https://harlow.vyre.run"); }
  const conn = o.connection || "documents";
  const first = "steps.send.response.json[0]";
  const mine = `steps.rec.record.data.${email}`;
  return {
    format: 1, name: `sign_${type}`, label: `Send a ${type} for signature`, authorship: "human",
    description: `When a ${type} enters ${o.out_stage}, ask Documents for a signature, remember it on the ${type}, email the signer their link, and move the ${type} to ${o.signed_stage} when it is signed.`,
    trigger: { on: "stage", type, stage: o.out_stage },
    steps: [
      { id: "rec", kind: "pick", type, where: "record.id == trigger.id" },
      // sent once: a record that already carries a signing request (or is being sent one) is left alone
      { id: "once", kind: "decide", if: `steps.rec.found and not steps.rec.record.data.${field}`, then: [
        { id: "claim", kind: "update", type, record: { expr: "trigger.id" }, set: { [field]: "sending" } },
        { id: "send", kind: "service", connection: conn, operation: "submissions.create", input: { body: { template_id: o.template_id, send_email: false, submitters: [{ email: { expr: mine }, ...(name ? { name: { expr: `steps.rec.record.data.${name}` } } : {}) }] } } },
        { id: "mark", kind: "update", type, record: { expr: "trigger.id" }, set: { [field]: { expr: `"" + ${first}.submission_id` } } },
        { id: "link", kind: "call", action: "comms.send", resource: "vyre://space/comms", input: { via: "email", to: { expr: mine }, subject: o.subject || "Your document is ready to sign",
          body: { expr: `"Your document is ready to sign: ${base}/sign/" + ${first}.submission_id + "/" + ${first}.slug` } } },
        { id: "signed", kind: "wait", event: "documents.signed", where: `"" + event.data.submission == "" + ${first}.submission_id`, timeout_ms: days * 86_400_000, on_timeout: "fail" },
        { id: "move", kind: "stage", type, record: { expr: "trigger.id" }, to: o.signed_stage },
        // the finished copy goes to the signer by a link that stops working after 30 days (they ask for a new one by replying); both are the person's yes
        { id: "copy", kind: "call", action: "documents.signed-link", resource: "vyre://space/documents", input: { slug: { expr: `${first}.slug` }, days: 30 } },
        { id: "thanks", kind: "call", action: "comms.send", resource: "vyre://space/comms", input: { via: "email", to: { expr: mine }, subject: "Your signed copy",
          body: { expr: '"Thank you for signing. Your signed copy is here, and the link works for 30 days (reply if you need a new one): " + steps.copy.url' } } },
      ], else: [] },
    ],
  };
}
