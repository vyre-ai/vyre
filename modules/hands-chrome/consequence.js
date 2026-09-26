// @ts-check
// consequence: which actions may be retried, and which may only be done once.
//
// "Do it, check, replay if unsure" works where tasks are resettable. A person's are not:
// replaying "send the update" sends it twice. So every action is classified before it is taken.
// Observable actions (navigating, focusing, selecting, opening) may be tried and checked.
// Consequential ones are, for now, not done by the hands at all: until the Gate exists to hold
// them for a person's approval, the hands refuse and say to take over in Glass instead.

// Matched against the control's name, case-insensitively, as whole words where it matters.
// "Resend" contains "send" and must still be consequential.
export const CONSEQUENTIAL = [
  /\bsend\b|\bresend\b/i,
  /\bpost\b|\bpublish\b|\bshare\b/i,
  /\bpay\b|\bcharge\b|\bpurchase\b|\bcheckout\b|\bsubscribe\b|\bbuy\b/i,
  /\bdelete\b|\bremove\b|\btrash\b|\berase\b|\bdiscard\b/i,
  /\bsubmit\b|\bconfirm\b|\bapprove\b|\bplace order\b/i,
  /\bmerge\b|\bpush\b|\bdeploy\b|\brelease\b/i,
  /\bsign\b|\bsign out\b|\blog out\b/i,
  /\binvite\b|\badd member\b/i,
  /\$\s?\d/,               // any button with a price on it
];

/**
 * What kind of action is this? The default for something unreadable is CONSEQUENTIAL. That is
 * the important direction of the error: treating a send button as safe costs someone a message
 * they did not write; treating a back button as dangerous costs one take-over.
 * @param {{ name?: string, nameless?: boolean }} ctl
 */
export function of(ctl) {
  // Trimmed: a name of " " is exactly as unreadable as no name, and untrimmed it is truthy,
  // matches nothing below and falls through to observable, the one way this must never fail.
  const name = String((ctl && ctl.name) || "").trim();
  if (!name || (ctl && ctl.nameless)) return { consequential: true, why: "cannot read what this control does, so it is treated as one that matters" };
  for (const re of CONSEQUENTIAL) {
    if (re.test(name)) return { consequential: true, why: JSON.stringify(name) + " looks like an action that cannot be undone by doing it again" };
  }
  return { consequential: false, why: "navigating, focusing or selecting" };
}

/** May this action be tried a second time if the first appeared to miss? */
export const retryable = ctl => !of(ctl).consequential;
