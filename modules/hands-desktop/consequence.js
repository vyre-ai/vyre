// @ts-check
// consequence: which actions may be retried, and which may only be done once.
//
// The usual verification technique for agents is: do the thing, check whether it worked, and
// replay it if unsure. That works on benchmarks because benchmark tasks are resettable. The
// user's are not. Replaying "send the update" sends it twice.
//
// So every action is classified before it is taken. Observable actions (navigating, focusing,
// selecting, opening) may be verified by doing and checking, and retried when they miss.
// Consequential actions are never replayed, and until the Gate exists to hold them for the
// user's approval, the hands refuse them outright.

// Matched against the control's name, case-insensitively, as whole words where it matters.
// "Resend" contains "send" and must still be consequential; "Sender" as a column header is a
// label, not a button, and is filtered by role rather than by this list.
export const CONSEQUENTIAL = [
  /\bsend\b|\bresend\b/i,
  /\bpost\b|\bpublish\b|\bshare\b/i,
  /\bpay\b|\bcharge\b|\bpurchase\b|\bcheckout\b|\bsubscribe\b/i,
  /\bdelete\b|\bremove\b|\btrash\b|\berase\b|\bdiscard\b/i,
  /\bsubmit\b|\bconfirm\b|\bapprove\b|\bplace order\b/i,
  /\bmerge\b|\bpush\b|\bdeploy\b|\brelease\b/i,
  /\bsign\b|\bsign out\b|\blog out\b/i,
  /\binvite\b|\badd member\b/i,
  /\$\s?\d/, // any button with a price on it
];

/**
 * What kind of action is this?
 *
 * The default for something that cannot be read is consequential, not observable. That is the
 * important direction of the error: treating a send button as safe costs the user a message they
 * did not write, and treating a back button as dangerous costs one extra step.
 * @param {{ name?: string, nameless?: boolean }} ctl
 */
export function of(ctl) {
  // Trimmed, because " " is truthy, matches none of the patterns, and would fall through to
  // observable: the one direction this function must never fail in.
  const name = String(ctl.name || "").trim();
  if (!name || ctl.nameless) return { consequential: true, why: "cannot read what this control does, so it is treated as one that matters" };
  for (const re of CONSEQUENTIAL) {
    if (re.test(name)) return { consequential: true, why: JSON.stringify(name) + " looks like an action that cannot be undone by doing it again" };
  }
  return { consequential: false, why: "navigating, focusing or selecting" };
}

/** May this action be tried a second time if the first appeared to miss? */
export const retryable = ctl => !of(ctl).consequential;
