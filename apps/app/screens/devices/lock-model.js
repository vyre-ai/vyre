// @ts-check
import { timeOf } from "../../src/time/show.js";
import { softwareKeyLine } from "../../src/real/on-phone.js";
// A device the server locked after three wrong sign-in answers (wink-2, work/wink-session): the owner's phone shows it and lets it sign in again before the lock lifts by itself.
// Reads presence.person.locked -> { locked: [{ device, until }] }; the control is presence.person.renew-allow { device } with the owner's presence. Pure.

/** The lock on one device, or null when it is not locked (or the lock already ended). @param {any} answer @param {string} device @param {number} now */
export function lockOf(answer, device, now) {
  const rows = Array.isArray(answer?.locked) ? answer.locked : [];
  const r = rows.find((/** @type {any} */ x) => x && String(x.device) === String(device) && Number(x.until) > now);
  return r ? { until: Number(r.until) } : null;
}

/** The time of day a lock lifts, as the caption shows it. @param {number} until */
export const lockTime = (until) => timeOf(new Date(until).getTime());

/** "Unlocks by itself at 14:32, in 12 minutes." @param {number} until @param {number} now */
export function unlockLine(until, now) {
  const mins = Math.max(1, Math.ceil((until - now) / 60_000));
  return `Unlocks by itself at ${lockTime(until)}, in ${mins} ${mins === 1 ? "minute" : "minutes"}.`;
}

export const LOCK_TITLE = "Locked after failed sign-ins";
export const LOCK_HELP = "This device failed to sign in three times in a row, so the server locked it. If that was you, let it sign in again. If it was not, leave it locked and remove it in Access.";
export const LOCK_CONTROL = "Let it sign in again";
export const lockedToast = (/** @type {string} */ device) => `${device} can sign in again.`;

/** The words for a refused unlock. The server's text is never shown. @param {string | undefined} code @param {string} [until] the time the lock lifts by itself, as shown ("14:20") */
export function unlockRefusal(code, until) {
  if (code === "not_allowed" || code === "denied" || code === "forbidden") return "Only the owner can let a device sign in again.";
  if (code === "presence_required" || code === "needs_presence") return softwareKeyLine();
  if (code === "no_such_tool") return `Your home cannot lift a lock yet.${until ? ` It unlocks by itself at ${until}.` : " It unlocks by itself."}`;
  if (code === "on_phone") return "Let it sign in again in Vyre on your phone.";
  return "That did not work. Nothing was changed.";
}
