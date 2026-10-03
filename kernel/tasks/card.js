// kernel/tasks/card.js: the approval card, built by the kernel from the canonical payload (contract 9.4, R6-3, T37).
// What the doer wrote (title, reason, suggested fix, notes) goes in a separate "from <doer>" block: labelled,
// length-capped, with no links or buttons inside it. A sealed part is shown masked, with its class and recipient.

const CAP = 400;
const strip = (/** @type {string} */ s) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/https?:\/\/\S+/gi, "[link removed]").replace(/\s+/g, " ").trim().slice(0, CAP);

/**
 * @param {any} task @param {any} payload the canonical outbound payload the approval is bound to (never the doer's words)
 * @param {{ doer_label?: string }} [opts]
 */
export function buildCard(task, payload, opts = {}) {
  const outward = task.output && task.output.kind === "sent";
  const recipients = payload && Array.isArray(payload.recipients) ? payload.recipients.map((/** @type {any} */ r) => ({ address: String(r.address), verified: r.verified === true, record: r.record || null })) : [];
  const sealed = payload && Array.isArray(payload.sealed_slots) ? payload.sealed_slots.map((/** @type {any} */ s) => ({ class: String(s.class), slot: String(s.slot), masked: true, recipient: String(s.recipient || ""), record: String(s.record || "") })) : [];
  return Object.freeze({
    kind: outward ? "send" : "check",
    // The title is the kernel's, from the output kind and the record: the doer's title is only in the block below.
    title: outward ? `Send ${payload && payload.what ? String(payload.what).slice(0, 80) : "this"} outside` : `Check ${task.output.kind}`,
    record: task.record || null,
    recipients,
    unverified_recipients: recipients.filter((/** @type {any} */ r) => !r.verified).length,
    attachments: payload && Array.isArray(payload.attachments) ? payload.attachments.map((/** @type {any} */ a) => ({ name: String(a.name).slice(0, 80), hash: String(a.hash) })) : [],
    template: payload && payload.template ? { id: String(payload.template.id), version: Number(payload.template.version) } : null,
    account: payload && payload.account ? String(payload.account) : null,
    sealed,
    payload_hash: task.payload ? task.payload.payload_hash : null,
    trust: task.labels ? task.labels.trust : "member",
    buttons: Object.freeze(["approve", "reject"]),
    from_doer: Object.freeze({ label: opts.doer_label || `${task.doer.kind}:${task.doer.id}`, title: strip(task.title), note: strip(task.note), buttons: Object.freeze([]) }),
  });
}
