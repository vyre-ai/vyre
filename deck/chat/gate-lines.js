// @ts-check
// The sentences a held or settled Gate item says, from gate.get's fields. Pure, so each is tested without a DOM.
// Plain words only: no tool names, no internal ids.

/** Where a held send stands after the sender failed. `reached` is the sender's own read of it, when it can tell.
 * "maybe" means it may have gone out anyway, so the person looks before trying again. @param {string} error @param {string|undefined|null} reached */
export function failureLine(error, reached) {
  const why = String(error || "the sender failed").trim();
  if (reached === "maybe") return `Not confirmed: ${why}. It may have gone out anyway. Check the app before you send again.`;
  if (reached === "no") return `Not sent: ${why}. It did not go out. Send tries again.`;
  return `Not sent: ${why}. It is still held. Send tries again.`;
}

/** What a settled item says under "Sent" or "Discarded", beyond the word itself. @param {any} it gate.get's answer @returns {string[]} */
export function settledLines(it) {
  const out = [];
  const to = Array.isArray(it.to) ? it.to.map(String).filter(Boolean) : [];
  if (it.state === "sent") {
    if (to.length) out.push(`To ${to.join(", ")}`);
    if (it.said) out.push("You said to, so it went without asking.");
    const n = (it.diff?.removed?.length || 0) + (it.diff?.added?.length || 0);
    if (n > 0 && !it.said) out.push("You changed it before it went. What went out is what you saw.");
  }
  if (it.state === "rejected") out.push("Nothing was sent.");
  return out;
}
