// @ts-check
// signing: the two Flows that sign a document from a stage (R032-05). Flows orchestrate, Documents files, Comms delivers; this is the wiring a firm asks for in one sentence ("when a matter reaches
// Out for signature, send the engagement letter; when it is signed, move it on"), written as plain Flow definitions the person reads, edits and approves like any other.
//
//   1. When a <type> enters <out stage>: make the signing request on the Documents connection (no e-mail from the signing engine), remember its number on the record, and email the signer their link
//      through Comms (held for the person's yes, so the final words are theirs).
//   2. When Documents says a document was signed: find the record that holds that number and move it to <signed stage>. The signed copy is filed on the client by the Documents Flow that ships with the app.
//
// Nothing here runs anything; it only returns the definitions.

const NAME = /^[a-z][a-z0-9_-]{0,40}$/;
const bad = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "bad_input" });

/**
 * @param {{ type: string, out_stage: string, signed_stage: string, template_id: number, email_field?: string, name_field?: string, submission_field?: string, base: string, connection?: string, subject?: string }} o
 * @returns {{ send: any, signed: any }}
 */
export function signingFlows(o) {
  const type = String(o.type || ""), email = o.email_field || "email", name = o.name_field || "", field = o.submission_field || "signature_submission";
  for (const [k, v] of Object.entries({ type, email, field })) if (!NAME.test(String(v))) throw bad(`${k} must be a record type or field name (lowercase letters, digits, - and _)`);
  if (name && !NAME.test(name)) throw bad("name_field must be a field name");
  if (!o.out_stage || !o.signed_stage) throw bad("name the stage that sends it and the stage it moves to once signed");
  if (!Number.isInteger(o.template_id) || o.template_id < 1) throw bad("template_id is the number of the signing template in Documents");
  let base;
  try { const u = new URL(String(o.base)); if (!/^https?:$/.test(u.protocol)) throw 0; base = u.origin; } catch { throw bad("base is the address people sign at, such as https://harlow.vyre.run"); }
  const conn = o.connection || "documents";
  const first = "steps.send.response.json[0]";
  const send = {
    format: 1, name: `sign_${type}`, label: `Send a ${type} for signature`, authorship: "human",
    description: `When a ${type} enters ${o.out_stage}, ask Documents for a signature, remember it on the ${type}, and email the signer their link.`,
    trigger: { on: "stage", type, stage: o.out_stage },
    steps: [
      { id: "send", kind: "service", connection: conn, operation: "submissions.create", input: { body: { template_id: o.template_id, send_email: false, submitters: [{ email: { expr: `trigger.${email}` }, ...(name ? { name: { expr: `trigger.${name}` } } : {}) }] } } },
      { id: "mark", kind: "update", type, record: { expr: "trigger.id" }, set: { [field]: { expr: `text(${first}.submission_id)` } } },
      { id: "link", kind: "call", action: "comms.send", resource: "vyre://space/comms", input: { via: "email", to: { expr: `trigger.${email}` }, subject: o.subject || "Your document is ready to sign",
        body: { expr: `"Your document is ready to sign: ${base}/sign/" + text(${first}.submission_id) + "/" + ${first}.slug` } } },
    ],
  };
  const signed = {
    format: 1, name: `signed_${type}`, label: `Move a signed ${type} on`, authorship: "human",
    description: `When Documents says a document was signed, move the ${type} that asked for it to ${o.signed_stage}.`,
    trigger: { on: "event", event: "documents.signed" },
    steps: [
      { id: "who", kind: "find", type, where: `record.${field} == text(trigger.submission)` },
      { id: "move", kind: "stage", type, record: { expr: "steps.who.rows[0].id" }, to: o.signed_stage },
    ],
  };
  return { send, signed };
}
