// kernel/tasks/card.js: the approval card, built by the kernel from the canonical payload (contract 9.4, R6-3, T37).
// What the doer wrote (title, reason, suggested fix, notes) goes in a separate "from <doer>" block: labelled,
// length-capped, with no links or buttons inside it. A sealed part is shown masked, with its class and recipient.

const CAP = 400;
const strip = (/** @type {string} */ s) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/https?:\/\/\S+/gi, "[link removed]").replace(/\s+/g, " ").trim().slice(0, CAP);

/**
 * @param {any} task @param {any} body the canonical body the approval is bound to: `{ action, resource, payload, facts }` for a send (facts are the
 *   kernel's, resolved against the record and the vault, never the doer's), `{ op: "skip", ... }` for the kernel's own skip proposal
 * @param {{ doer_label?: string, action_label?: string }} [opts]
 */
export function buildCard(task, body, opts = {}) {
  if (task.kernel) {
    return Object.freeze({
      kind: "skip", title: `Skip this task: ${strip(body && body.title)}`, record: null, recipients: [], unverified_recipients: 0, attachments: [], template: null, account: null, sealed: [],
      payload_hash: task.payload ? task.payload.payload_hash : null, trust: task.labels ? task.labels.trust : "member", buttons: Object.freeze(["approve", "reject"]),
      from_doer: Object.freeze({ label: "the kernel", title: "", note: strip(body && body.reason), buttons: Object.freeze([]) }),
    });
  }
  const outward = task.output && task.output.kind === "sent";
  const payload = outward && body ? body.payload || {} : {};
  const facts = outward && body && body.facts ? body.facts : { recipients: [], sealed: [] };
  const recipients = facts.recipients.map((/** @type {any} */ r) => ({ address: String(r.address), verified: r.verified === true, record: r.record || null }));
  const sealed = facts.sealed.map((/** @type {any} */ s) => ({ class: String(s.class), slot: String(s.slot), masked: true, recipient: recipients.map((/** @type {any} */ r) => r.address).join(", "), record: String(s.record || "") }));
  return Object.freeze({
    kind: outward ? "send" : "check",
    // The title is the kernel's: the action's own label, and the doer's `what` only as capped plain text.
    title: outward ? `${strip(opts.action_label || (body && body.action) || "Send")}: ${strip(payload.what) || "this"}` : `Check ${task.output.kind}`,
    action: outward && body ? { action: String(body.action), resource: String(body.resource) } : null,
    record: task.record || null,
    recipients,
    unverified_recipients: recipients.filter((/** @type {any} */ r) => !r.verified).length,
    attachments: Array.isArray(payload.attachments) ? payload.attachments.map((/** @type {any} */ a) => ({ name: String(a.name).slice(0, 80), hash: String(a.hash) })) : [],
    template: payload.template ? { id: String(payload.template.id), version: Number(payload.template.version) } : null,
    account: payload.account ? String(payload.account) : null,
    sealed,
    payload_hash: task.payload ? task.payload.payload_hash : null,
    trust: task.labels ? task.labels.trust : "member",
    buttons: Object.freeze(["approve", "reject"]),
    from_doer: Object.freeze({ label: opts.doer_label || `${task.doer.kind}:${task.doer.id}`, title: strip(task.title), note: strip(task.note), buttons: Object.freeze([]) }),
  });
}
