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

/**
 * The word for how a person proves it is them on THIS device, for lines that must be true on every platform: Android says fingerprint, an iPhone Face ID or Touch ID, a Mac window Touch ID,
 * and a browser passkey. @param {string} [os] Platform.OS: "ios", "android", "web" or "macos" @param {boolean} [shell] a Mac window of Vyre
 */
export const howWord = (os = "web", shell = typeof window !== "undefined" && Boolean(/** @type {any} */ (window).__vyreShell)) =>
  os === "android" ? "fingerprint" : os === "ios" ? "Face ID or Touch ID" : shell ? "Touch ID" : "passkey";

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
  if (/^spaces\.host-here/.test(t)) return "Make this space in Vyre on your phone.";
  if (/^wink\./.test(t)) return "Pair it in Vyre on your phone.";
  if (/^onboard\./.test(t)) return "Connect it in Vyre on your phone.";
  if (/^vault\.account\.unlock/.test(t)) return "Unlock it in Vyre on your phone.";
  // No restore control exists in the app yet (the space Drive has no screen): this file names an action only when a control for it exists.
  return ON_PHONE;
}

/** The refusal for a presence proof made with a software key (platform: code `software_key` on a release server). The words are ours, never the server's. @param {"touchid" | "phone"} [how] */
export const softwareKeyLine = (how = howApprove()) => said("Approve this in Vyre on your phone.", how);

/**
 * Why the box refused a proof on an approval (tasks.decide, a move to ready, an invite accept): error.detail.reason beside needs_presence (vault, 4 Oct). The words are ours, never the server's.
 * @param {string | undefined} reason @param {"touchid" | "phone"} [how]
 */
export function reasonLine(reason, how = howApprove()) {
  switch (reason) {
    case "no_proof": return said("Approve this in Vyre on your phone.", how);
    case "wrong_decision": return "That approval was for a different request. Approve this one again.";
    case "wrong_payload": return "The request changed after you approved it. Approve it again.";
    case "unknown_key": return said("This device cannot approve yet. Approve this in Vyre on your phone.", how);
    case "bad_signature": return "That approval did not check out. Approve it again.";
    case "expired": return "That approval ran out. Approve it again.";
    case "replayed": return "That approval was already used. Approve it again.";
    case "software_key": return softwareKeyLine(how);
    case "needs_bind": return "Pair this device with your server first, then approve it again.";
    case "unavailable": return "Approving is not available right now. Try again in a moment.";
    case "refused": return "That was not approved. Nothing was changed.";
    default: return null;
  }
}
