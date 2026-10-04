// @ts-check
// "I already have a name" (ui-ux, UX-AUDIT "Getting an existing name onto a new or wiped phone"): the words, the refusals and the checks for bringing a name onto a new or wiped phone. Pure.
import { codeLooksRight } from "../../src/identity/recovery.js";

export const HAVE = {
  title: "Welcome back",
  lostKeyTitle: "This iPhone no longer has your key",
  line: "Choose how to bring your name to this iPhone.",
  lostKeyLine: "Vyre keeps your key only on the device that made it. Bring your name back with another device or your recovery code.",
  addTitle: "Add this phone from another device",
  addLine: "Open Vyre on a device that has your name and choose Add a device.",
  codeTitle: "Use my recovery code",
  codeLine: "The code you saved when you made your name.",
  scanTitle: "Scan from your other device",
  scanLine: "Open Vyre on a device that has your name and choose Add a device. Scan the code it shows with this camera, or paste its long code here.",
  wordsLine: "Say yes on your other device only if it shows the same three words.",
  recoverTitle: "Use your recovery code",
  nameLabel: "Your Vyre name",
  nameHelp: ".vyre.run goes after it",
  codeLabel: "Recovery code",
  codeHelp: "26 letters and numbers, with or without dashes.",
  passwordLabel: "Recovery password",
  passwordHelp: "Only if you set one.",
  go: "Bring my name here",
  busy: "Checking",
  rather: "I would rather add this phone from another device",
  // Unshown until wink-2 and tailnet verify the peer door admits an unpaired recovered key (windows: the enrolment decision is tested, the door is not). "Should", not "will".
  spacesLine: "This iPhone should join your spaces on its own. It can take up to a minute.",
};

/** Each refusal's own sentence; the screen never shows the server's or the directory's text. @param {string | undefined} code */
export function recoverRefusal(code) {
  switch (code) {
    case "bad_format": return "That does not look like a recovery code. It has 26 letters and numbers.";
    case "not_found": return "No one has that name.";
    case "not_a_person": return "That name does not belong to a person.";
    case "wrong_code": return "That code, or the password, is not the one for this name. Nothing was changed.";
    case "unreachable": return "Cannot reach the names directory right now. Nothing was changed. Try again.";
    case "rolled_back": return "The names directory is showing an older version of this name than this device has already seen, so Vyre will not trust it. Nothing was changed. Try again later, or add this phone from another device that has your name.";
    case "exists": return "This iPhone already holds a different Vyre name, so it cannot take this one. Nothing was changed.";
    case "not_built": return "This is not available in this build yet. Nothing was changed.";
    case "rate_limited": return "Too many tries from here. Try again later.";
    case "newcomer": return "A phone added in the last 24 hours cannot do that yet. Use an older device, or wait.";
    default: return "Nothing was changed. Try again.";
  }
}

/** What is wrong with the form before anything is asked, or null. @param {{ name: string, code: string }} f */
export function recoverCheck(f) {
  const name = f.name.trim().toLowerCase().replace(/\.vyre\.run$/, "");
  if (!name) return { code: "not_found", say: recoverRefusal("not_found") };
  if (!codeLooksRight(f.code)) return { code: "bad_format", say: recoverRefusal("bad_format") };
  return null;
}

/** The name as the directory keys it: no domain, lower case. @param {string} raw */
export const nameOf = (raw) => raw.trim().toLowerCase().replace(/\.vyre\.run$/, "");

/** Where a failure to bring a name here leaves the person: the same step, the refusal above the fields. */
export const successToast = (/** @type {string} */ name) => `Welcome back, ${name}.`;
