// @ts-check
// RC1: what a browser says when the box asks for the person's own proof. The proof is made on the phone, so the browser never offers a button that would not work.

export const ON_PHONE = "Do this in Vyre on your phone.";

/** Is this refusal the box asking for the person's own proof (presence or approval)? @param {{ code?: string } | null | undefined} error */
export const needsPerson = (error) => Boolean(error) && ["presence_required", "needs_presence", "needs_approval"].includes(String(error?.code));

/** The refusal in a browser, naming what the person is asked to do on the phone. @param {string} tool */
/**
 * How this person can give the proof here (the lead's revised ruling, 4 Oct: presence is by METHOD): in a Mac window of Vyre it is Touch ID, anywhere else the phone.
 * A browser passkey with user verification also counts; this build does not offer it yet, so a browser still says the phone. @returns {"touchid" | "phone"}
 */
export const howApprove = () => (typeof window !== "undefined" && /** @type {any} */ (window).__vyreShell ? "touchid" : "phone");

/** A line that ends "in Vyre on your phone." said for the method the person has. @param {string} line @param {"touchid" | "phone"} how */
const said = (line, how) => (how === "touchid" ? line.replace(/ in Vyre on your phone\.$/, " with Touch ID.") : line);

/** @param {string} tool @param {"touchid" | "phone"} [how] */
export function onPhoneFor(tool, how = howApprove()) {
  return said(lineFor(tool), how);
}

/** @param {string} tool */
function lineFor(tool) {
  const t = String(tool);
  if (/reveal/.test(t)) return "Reveal it in Vyre on your phone.";
  if (/^tasks\.decide/.test(t)) return "Approve it in Vyre on your phone.";
  if (/^(grants|spaces\.roles|spaces\.members)\./.test(t)) return "Change who can use this in Vyre on your phone.";
  if (/^wink\./.test(t)) return "Pair it in Vyre on your phone.";
  if (/^onboard\./.test(t)) return "Connect it in Vyre on your phone.";
  if (/^vault\.account\.unlock/.test(t)) return "Unlock it in Vyre on your phone.";
  // No restore control exists in the app yet (the space Drive has no screen): this file names an action only when a control for it exists.
  return ON_PHONE;
}
