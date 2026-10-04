// @ts-check
// A device the server locked after three wrong sign-in answers (wink-2, work/wink-session): the owner's phone shows it and lets it sign in again before the lock lifts by itself.
// Reads presence.person.locked -> { locked: [{ device, until }] }; the control is presence.person.renew-allow { device } with the owner's presence. Pure.

/** The lock on one device, or null when it is not locked (or the lock already ended). @param {any} answer @param {string} device @param {number} now */
export function lockOf(answer, device, now) {
  const rows = Array.isArray(answer?.locked) ? answer.locked : [];
  const r = rows.find((/** @type {any} */ x) => x && String(x.device) === String(device) && Number(x.until) > now);
  return r ? { until: Number(r.until) } : null;
}

/** "Unlocks by itself at 14:32." @param {number} until @param {number} now */
export function unlockLine(until, now) {
  const mins = Math.max(1, Math.ceil((until - now) / 60_000));
  const at = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Unlocks by itself at ${at}, in ${mins} ${mins === 1 ? "minute" : "minutes"}.`;
}

export const LOCK_TITLE = "Locked after wrong answers";
export const LOCK_HELP = "This device answered its sign-in wrongly three times. Let it sign in again if that was you.";
export const LOCK_CONTROL = "Let it sign in again";
export const lockedToast = (/** @type {string} */ device) => `${device} can sign in again.`;

/** The words for a refused unlock. The server's text is never shown. @param {string | undefined} code */
export function unlockRefusal(code) {
  if (code === "not_allowed" || code === "denied" || code === "forbidden") return "Only the owner can let a device sign in again.";
  if (code === "presence_required" || code === "needs_presence") return "That needs you. Approve on this device, then try again.";
  if (code === "no_such_tool") return "This box cannot lift a lock yet.";
  if (code === "on_phone") return "Do this in Vyre on your phone.";
  return "That did not work. Nothing was changed.";
}
