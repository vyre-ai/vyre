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
 * HD-6/6b: a control is observable only when its WHOLE name is one the hands know to be harmless (a verb for moving, showing or selecting, alone or with a short fixed noun) and no word that
 * grants, accepts, sends, saves or leaves appears anywhere in it. Passive roles (an entry, a tab, a row) are observable only when the name also passes the veto, because the page picks its
 * own role. A page that hands the hands native facts (`submit`, `type`, `href`) is believed over its own words: a submit control, or a link that matches oauth, authorize, consent, checkout
 * or delete, is consequential whatever it is called.
 */
const VERBS = "back|forward|next|previous|prev|up|down|left|right|home|top|bottom|go|go back|go forward|close|cancel|dismiss|hide|collapse|show|expand|open|view|preview|details|more|less|help|menu|search|filter|sort|refresh|reload|skip|scroll|select|focus|tab";
const NOUNS = "page|tab|step|slide|item|result|results|menu|details|filters|sidebar|panel|list|all|more|less|section|image|photo|gallery|message|messages|folder|file|files";
export const OBSERVABLE = [
  new RegExp(`^(?:the\\s+)?(?:${VERBS})$`, "i"),
  new RegExp(`^(?:${VERBS})\\s+(?:${NOUNS})$`, "i"),
  new RegExp(`^(?:show|see|read|learn)\\s+(?:more|less)$`, "i"),
  /^\d{1,4}$/,
  /^page\s+\d{1,4}$/i,
];
/** Words that make any name consequential, whatever comes before or after them. */
export const VETO = /(?:^|[^a-z])(?:authori[sz]e|allow|accept|agree|grant|consent|continue|proceed|enable|apply|order|yes|ok|okay|connect|install|approve|confirm|send|log\s?in|login|sign|pay|buy|checkout|purchase|subscribe|delete|remove|submit|save|done|finish|complete|start|trust|unlock|share|invite|publish|post|merge|push|deploy|release|transfer|upgrade|activate|verify|reset|clear|erase|discard|revoke|disconnect|unsubscribe)/i;
/** A link that leaves for a consent, sign-in, payment or deletion page. */
export const RISKY_HREF = /oauth|authori[sz]e|consent|checkout|payment|delete|logout|signout|sign-out|billing|grant/i;
/** Controls that hold a value or a place and do nothing by themselves; the page names the role, so this alone decides nothing. */
export const PASSIVE_ROLES = /^(?:entry|textbox|text field|text|searchbox|search field|combobox|combo box|tab|tab list|tabpanel|listbox|list box|option|list item|row|cell|column header|tree item|scroll bar|scrollbar|slider|label|heading)$/i;

/**
 * What kind of action is this?
 *
 * The default for something that cannot be read is consequential, not observable. That is the
 * important direction of the error: treating a send button as safe costs the user a message they
 * did not write, and treating a back button as dangerous costs one extra step.
 * @param {{ name?: string, nameless?: boolean }} ctl
 */
export function of(ctl) {
  // HD-6: observable only when it is passive or its name is on OBSERVABLE; the CONSEQUENTIAL list below still vetoes.
  // Trimmed, because " " is truthy, matches none of the patterns, and would fall through to
  // observable: the one direction this function must never fail in.
  const name = String(ctl.name || "").trim();
  if (!name || ctl.nameless) return { consequential: true, why: "cannot read what this control does, so it is treated as one that matters" };
  for (const re of CONSEQUENTIAL) {
    if (re.test(name)) return { consequential: true, why: JSON.stringify(name) + " looks like an action that cannot be undone by doing it again" };
  }
  if (ctl && (ctl.submit === true || String(ctl.type || "").toLowerCase() === "submit")) return { consequential: true, why: JSON.stringify(name) + " submits a form" };
  if (ctl && typeof ctl.href === "string" && RISKY_HREF.test(ctl.href)) return { consequential: true, why: JSON.stringify(name) + " leads to a consent, sign-in, payment or deletion page" };
  if (VETO.test(name)) return { consequential: true, why: JSON.stringify(name) + " names an action that grants, accepts, sends or leaves" };
  if ((ctl && PASSIVE_ROLES.test(String(ctl.role || "").trim())) || OBSERVABLE.some(re => re.test(name))) return { consequential: false, why: "navigating, focusing or selecting" };
  return { consequential: true, why: JSON.stringify(name) + " is not a control the hands know to be harmless, so it is treated as one that matters" };
}

/** May this action be tried a second time if the first appeared to miss? */
export const retryable = ctl => !of(ctl).consequential;
