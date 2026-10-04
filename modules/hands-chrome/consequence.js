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


/** Names that only move, show or select: the one list a control must match to be observable (HD-6: an allow-list, so Authorize, Allow, Accept, Save, Continue, Grant, Enable, Apply, Order and Log in are consequential by omission). */
export const OBSERVABLE = [
  /^(?:the\s+)?(?:back|forward|next|previous|prev|up|down|left|right|home|top|bottom|go|go back|go forward|go home)(?:\s+(?:page|tab|step|slide|item|result|button))?$/i,
  /^(?:close|cancel|dismiss|hide|collapse|show|expand|open|view|preview|details|more|less|show more|show less|see more|see less|read more|learn more|help|menu|search|filter|sort|refresh|reload|skip|scroll|select|focus|tab|expand all|collapse all)(?:\s+[\w .\-]{0,40})?$/i,
  /^\d{1,4}$/,                 // a page or tab number
  /^page\s+\d{1,4}$/i,
];
/** Controls that hold a value or a place and do nothing by themselves: typing in them or moving between them is observable. */
export const PASSIVE_ROLES = /^(?:entry|textbox|text field|text|searchbox|search field|combobox|combo box|tab|tab list|tabpanel|listbox|list box|option|list item|row|cell|column header|tree item|scroll bar|scrollbar|slider|label|heading|link-text)$/i;

/**
 * What kind of action is this? The default for something unreadable is CONSEQUENTIAL. That is
 * the important direction of the error: treating a send button as safe costs someone a message
 * they did not write; treating a back button as dangerous costs one take-over.
 * @param {{ name?: string, nameless?: boolean }} ctl
 */
export function of(ctl) {
  // HD-6: observable only when it is passive or its name is on OBSERVABLE; the CONSEQUENTIAL list below still vetoes.
  // Trimmed: a name of " " is exactly as unreadable as no name, and untrimmed it is truthy,
  // matches nothing below and falls through to observable, the one way this must never fail.
  const name = String((ctl && ctl.name) || "").trim();
  if (!name || (ctl && ctl.nameless)) return { consequential: true, why: "cannot read what this control does, so it is treated as one that matters" };
  for (const re of CONSEQUENTIAL) {
    if (re.test(name)) return { consequential: true, why: JSON.stringify(name) + " looks like an action that cannot be undone by doing it again" };
  }
  if ((ctl && PASSIVE_ROLES.test(String(ctl.role || "").trim())) || OBSERVABLE.some(re => re.test(name))) return { consequential: false, why: "navigating, focusing or selecting" };
  return { consequential: true, why: JSON.stringify(name) + " is not a control the hands know to be harmless, so it is treated as one that matters" };
}

/** May this action be tried a second time if the first appeared to miss? */
export const retryable = ctl => !of(ctl).consequential;
